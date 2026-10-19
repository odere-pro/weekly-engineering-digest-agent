# syntax=docker/dockerfile:1
# One image for every command; the default command is the in-process scheduler (`digest serve`).
# The base image is pinned by digest (supply chain). To bump it:
#   docker buildx imagetools inspect node:24-slim   (copy the top-level Digest)
ARG NODE_IMAGE=node:24-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5

FROM ${NODE_IMAGE} AS base
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml ./

# Production dependencies only: dist/artifacts/cli.js keeps its packages external.
FROM base AS prod-deps
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod

FROM base AS build
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
COPY evals ./evals
RUN pnpm build

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
# Debian security fixes the pinned base does not have yet (CI's image scan fails on a fixable HIGH
# or CRITICAL). npm and corepack go: the image runs node only, and their bundled packages are
# otherwise the scan's npm findings.
RUN apt-get update \
  && apt-get upgrade -y --no-install-recommends \
  && rm -rf /var/lib/apt/lists/* \
    /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
# The program lives in /opt/eng-digest. /app is the working folder: digest.config.json, .env,
# evals and dist/, the data folder (dataDir defaults to dist), where runs, fetched data and logs go.
# Compose bind-mounts ./dist over /app/dist, which is why the CLI cannot sit in /app/dist/artifacts.
WORKDIR /opt/eng-digest
COPY package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist/artifacts ./dist/artifacts
WORKDIR /app
# `digest eval` reads the recorded weeks and labeled cases from here.
COPY evals ./evals
# Compose ignores this ownership (its bind mount wins), so Linux hosts set DIGEST_UID/DIGEST_GID
# instead (see docker-compose.yml). Run without Compose, the files stay inside the container.
RUN mkdir -p /app/dist && chown node:node /app/dist
USER node
ENTRYPOINT ["node", "/opt/eng-digest/dist/artifacts/cli.js"]
CMD ["serve"]
