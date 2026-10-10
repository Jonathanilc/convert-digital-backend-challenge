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
IMAGE_CHAT ?= convert-digital/chat-server:local
CHAT_PORT  ?= 3001
export APP_PORT REDIS_PORT IMAGE IMAGE_CHAT CHAT_PORT

COMPOSE      := docker compose
COMPOSE_PROD := docker compose -f compose.prod.yaml
PKG          := @challenge/rate-limiter

# Fly.io: the CLI is `fly` locally but the GitHub action installs it as `flyctl`.
FLY           ?= $(shell command -v fly 2>/dev/null || echo flyctl)
# One set of targets serves both apps: the chat variants override FLY_CONFIG/FLY_TARGET/SMOKE_SERVICE.
FLY_CONFIG    ?= fly.toml
FLY_TARGET    ?= runtime
SMOKE_SERVICE ?= smoke
FLY_APP       ?= $(shell sed -n 's/^app *= *"\(.*\)"/\1/p' $(FLY_CONFIG))
GIT_SHA       ?= $(shell git rev-parse --short HEAD)
FLY_IMAGE     ?= registry.fly.io/$(FLY_APP):$(GIT_SHA)
APP_URL       ?= https://$(FLY_APP).fly.dev

.PHONY: help dev up down logs shell redis test test-watch check fmt openapi-types image prod-up prod-down prod-logs smoke smoke-remote smoke-remote-chat deploy deploy-chat fly-status fly-logs clean

help: ## List available targets
	@awk 'BEGIN {FS = ":.*## "; printf "\nUsage: make <target> [APP_PORT=3100] [REDIS_PORT=6380] [IMAGE=tag]\n"} /^##@/ {printf "\n%s\n", substr($$0, 5)} /^[a-zA-Z0-9_-]+:.*## / {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)
	@echo

##@ Development
dev: ## Rate limiter (APP_PORT) + chat server (CHAT_PORT) with hot reload + Redis, logs in the foreground
	$(COMPOSE) up --build

up: ## Same stack, detached
	$(COMPOSE) up --build -d app chat

down: ## Stop the development stack
	$(COMPOSE) down

logs: ## Follow logs of both apps
	$(COMPOSE) logs -f app chat

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
image: ## Build and tag both runtime images (IMAGE=..., IMAGE_CHAT=...)
	docker build --target runtime -t $(IMAGE) .
	docker build --target runtime-chat -t $(IMAGE_CHAT) .

prod-up: ## Run both production images with Redis and wait until healthy
	$(COMPOSE_PROD) up --build --wait app chat

prod-down: ## Stop the production stack and remove its volumes
	$(COMPOSE_PROD) down -v

prod-logs: ## Follow production logs of both apps
	$(COMPOSE_PROD) logs -f app chat

smoke: ## Build + start both production images, run both black-box smoke suites, tear down
	$(COMPOSE_PROD) up --build --wait app chat
	$(COMPOSE_PROD) run --rm --build smoke || { $(COMPOSE_PROD) logs app; $(COMPOSE_PROD) down -v; exit 1; }
	$(COMPOSE_PROD) run --rm chat-smoke || { $(COMPOSE_PROD) logs chat; $(COMPOSE_PROD) down -v; exit 1; }
	$(COMPOSE_PROD) down -v

##@ Fly.io (requires `fly auth login`; CI uses FLY_API_TOKEN)
deploy: ## Build the rate limiter image for amd64, push it to the Fly registry, deploy that exact image (1 Machine)
	$(FLY) auth docker
	docker build --platform linux/amd64 --target $(FLY_TARGET) -t $(FLY_IMAGE) .
	docker push $(FLY_IMAGE)
	$(FLY) deploy --config $(FLY_CONFIG) --app $(FLY_APP) --image $(FLY_IMAGE) --ha=false --wait-timeout 5m

deploy-chat: FLY_CONFIG := fly.chat.toml
deploy-chat: FLY_TARGET := runtime-chat
deploy-chat: deploy ## Same for the chat server (fly.chat.toml, runtime-chat image)

smoke-remote: ## Run the rate limiter's black-box smoke suite against APP_URL (default: the Fly app); needs ADMIN_TOKEN
	$(COMPOSE) run --rm --build --no-deps -e APP_URL=$(APP_URL) -e ADMIN_TOKEN=$(ADMIN_TOKEN) -e SMOKE_VERIFY_CLIENT_IP=true test npm run test:smoke -w $(PKG)

smoke-remote-chat: FLY_CONFIG := fly.chat.toml
smoke-remote-chat: ## Run the chat server's black-box smoke suite against APP_URL (default: the chat Fly app)
	$(COMPOSE) run --rm --build --no-deps -e APP_URL=$(APP_URL) test npm run test:smoke -w @challenge/chat-server

fly-status: ## Machines, health and recent releases (FLY_CONFIG=fly.chat.toml for the chat app)
	$(FLY) status --app $(FLY_APP)
	$(FLY) releases --app $(FLY_APP) | head -8

fly-logs: ## Tail the Fly app logs (FLY_CONFIG=fly.chat.toml for the chat app)
	$(FLY) logs --app $(FLY_APP)

##@ Housekeeping
clean: ## Stop both stacks, remove volumes, delete build and coverage output
	-$(COMPOSE) down -v --remove-orphans
	-$(COMPOSE_PROD) down -v --remove-orphans
	rm -rf packages/*/dist packages/*/coverage
