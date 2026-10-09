# syntax=docker/dockerfile:1.7
# Multi-stage build for the workspace. Targets:
#   dev      hot-reload development image; compose bind-mounts the source over /app and this
#            image is also the test runner (it has every dev dependency)
#   runtime  the deployable image: compiled output + production dependencies, non-root, healthcheck
ARG NODE_IMAGE=node:24-alpine

# ---- deps: install the whole workspace once, cached by the lockfile -------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/rate-limiter/package.json packages/rate-limiter/
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

# ---- dev ------------------------------------------------------------------------------------
FROM deps AS dev
ENV NODE_ENV=development
COPY . .
EXPOSE 3000
CMD ["npm", "run", "dev", "-w", "@challenge/rate-limiter"]

# ---- build: compile, then strip development dependencies ------------------------------------
FROM deps AS build
COPY . .
RUN npm run build \
 && npm prune --omit=dev --no-audit --no-fund \
 && mkdir -p packages/rate-limiter/node_modules

# ---- runtime --------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages/rate-limiter/package.json ./packages/rate-limiter/
COPY --from=build --chown=node:node /app/packages/rate-limiter/node_modules ./packages/rate-limiter/node_modules
COPY --from=build --chown=node:node /app/packages/rate-limiter/dist ./packages/rate-limiter/dist
COPY --from=build --chown=node:node /app/packages/rate-limiter/openapi.yaml ./packages/rate-limiter/
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# node is PID 1 so SIGTERM reaches the graceful-shutdown handler directly.
CMD ["node", "packages/rate-limiter/dist/demo/server.js"]
