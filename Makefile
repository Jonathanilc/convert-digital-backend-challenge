# Local development entry points. Everything Docker-related lives here; npm scripts are plain
# Node tasks that run identically on the host and inside the containers.
#
#   make              list targets
#   make dev          app with hot reload + Redis
#   make test         the whole test suite inside Docker
#   make smoke        production image + black-box smoke suite
#
# Variables: APP_PORT (3000), REDIS_PORT (6379), IMAGE (convert-digital/rate-limiter:local)

.DEFAULT_GOAL := help
SHELL := /bin/sh

APP_PORT   ?= 3000
REDIS_PORT ?= 6379
IMAGE      ?= convert-digital/rate-limiter:local
export APP_PORT REDIS_PORT IMAGE

COMPOSE      := docker compose
COMPOSE_PROD := docker compose -f compose.prod.yaml
PKG          := @challenge/rate-limiter

.PHONY: help dev up down logs shell redis test test-watch check fmt openapi-types image prod-up prod-down prod-logs smoke clean

help: ## List available targets
	@awk 'BEGIN {FS = ":.*## "; printf "\nUsage: make <target> [APP_PORT=3100] [REDIS_PORT=6380] [IMAGE=tag]\n"} /^##@/ {printf "\n%s\n", substr($$0, 5)} /^[a-zA-Z0-9_-]+:.*## / {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)
	@echo

##@ Development
dev: ## App with hot reload + Redis, logs in the foreground
	$(COMPOSE) up --build

up: ## Same stack, detached
	$(COMPOSE) up --build -d app

down: ## Stop the development stack
	$(COMPOSE) down

logs: ## Follow app logs
	$(COMPOSE) logs -f app

shell: ## Shell inside the running app container
	$(COMPOSE) exec app sh

redis: ## Only Redis, for host-side runs (npm test on the host)
	$(COMPOSE) up -d redis

##@ Quality
test: ## Full test suite inside the dev image against the compose Redis
	$(COMPOSE) run --rm --build test

test-watch: ## Vitest watch mode inside the container on the bind-mounted source
	$(COMPOSE) run --rm --build test npm run test:watch -w $(PKG)

check: ## Format check + generated-types check + typecheck + tests, inside Docker (what CI runs)
	$(COMPOSE) run --rm --build test npm run check

fmt: ## Prettier --write, inside the container
	$(COMPOSE) run --rm --build --no-deps test npm run format

openapi-types: ## Regenerate TypeScript types from openapi.yaml, inside the container
	$(COMPOSE) run --rm --build --no-deps test npm run openapi:types

##@ Production image
image: ## Build and tag the runtime image only (IMAGE=...)
	docker build --target runtime -t $(IMAGE) .

prod-up: ## Run the production image with Redis and wait until healthy
	$(COMPOSE_PROD) up --build --wait app

prod-down: ## Stop the production stack and remove its volumes
	$(COMPOSE_PROD) down -v

prod-logs: ## Follow production app logs
	$(COMPOSE_PROD) logs -f app

smoke: ## Build + start the production image, run the black-box smoke suite, tear down
	$(COMPOSE_PROD) up --build --wait app
	$(COMPOSE_PROD) run --rm --build smoke || { $(COMPOSE_PROD) logs app; $(COMPOSE_PROD) down -v; exit 1; }
	$(COMPOSE_PROD) down -v

##@ Housekeeping
clean: ## Stop both stacks, remove volumes, delete build and coverage output
	-$(COMPOSE) down -v --remove-orphans
	-$(COMPOSE_PROD) down -v --remove-orphans
	rm -rf packages/*/dist packages/*/coverage
