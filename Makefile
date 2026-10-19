.PHONY: help up dev down logs shell test typecheck build check backfill-quantity rebuild clean

.DEFAULT_GOAL := help

# Export the calling host user for compose interpolation of user: "${UID}:${GID}"
# (bash does not export UID/GID by default).
export UID := $(shell id -u)
export GID := $(shell id -g)

COMPOSE := docker compose
RUN     := $(COMPOSE) run --rm dev

# ---------------------------------------------------------------------------
# Dev container (ticket #22). Everything Node/TS runs in the container; the
# host's node_modules is never used. Production deploys go through helm/recipedb.
#
#   make up      # long-running dev server (Ctrl-C stops it)
#   make test    # one-shot commands use `docker compose run --rm dev ...`
# ---------------------------------------------------------------------------

help:        ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
	  awk 'BEGIN {FS = ":.*?## "; printf "Targets:\n"} {printf "  %-20s %s\n", $$1, $$2}'

up:          ## Start the dev server (foreground; Ctrl-C stops; HOST_PORT=3311 to relocate)
	$(COMPOSE) up

dev: up      ## Alias for `up`

down:        ## Stop the dev container (keeps dev DB + node_modules volumes)
	$(COMPOSE) down

logs:        ## Tail dev server logs
	$(COMPOSE) logs -f

shell:       ## Open a shell in a throwaway dev container
	$(RUN) sh

test:        ## Run Vitest (npm test) in the container
	$(RUN) npm test

typecheck:   ## Run react-router typegen + tsc --noEmit in the container
	$(RUN) npm run typecheck

build:       ## Production build (react-router build + esbuild boot bundle)
	$(RUN) npm run build

check: typecheck test  ## Typecheck, then test

backfill-quantity:  ## Backfill parsed quantities (npm run db:backfill-quantity)
	$(RUN) npm run db:backfill-quantity

rebuild:     ## Rebuild the dev image from scratch (fresh npm ci)
	$(COMPOSE) build --no-cache

clean:       ## Remove build artifacts and drop dev volumes (fresh DB + deps)
	rm -rf build .react-router
	$(COMPOSE) down -v
