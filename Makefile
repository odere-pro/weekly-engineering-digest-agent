.PHONY: install check build test coverage dry-run run doctor eval history docker-init docker-up docker-down tracing-up

install:
	pnpm install --frozen-lockfile

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

docker-init:
	docker compose run --rm digest init

docker-up:
	docker compose up -d

docker-down:
	docker compose down

tracing-up:
	docker compose --profile tracing up -d
