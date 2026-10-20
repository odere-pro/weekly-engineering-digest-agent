.PHONY: install check build test coverage dry-run run doctor eval history docker-init docker-up docker-down tracing-up

install:
	pnpm install --frozen-lockfile
	git config core.hooksPath .githooks

check:
	pnpm check

build:
	pnpm build

test:
	pnpm test

coverage:
	pnpm coverage

dry-run:
	pnpm digest run --dry-run

run:
	pnpm digest run

doctor:
	pnpm digest doctor

eval:
	pnpm digest eval

history:
	pnpm digest history

# The app in a container cannot see the host; tell it which OS/CPU Ollama runs on.
export DIGEST_HOST_OS := $(shell uname -s | tr A-Z a-z)
export DIGEST_HOST_ARCH := $(shell uname -m)

docker-init:
	@[ -e digest.config.json ] || touch digest.config.json
	@[ -e .env ] || (umask 077 && touch .env)
	docker compose run --rm --no-deps digest init

docker-up:
	docker compose up -d

docker-down:
	docker compose down

tracing-up:
	OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318/v1/traces docker compose --profile tracing up -d
