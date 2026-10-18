# syntax=docker/dockerfile:1
# One image for every command; the default command is the in-process scheduler (`digest serve`).
# The base image is pinned by digest (supply chain). To bump it:
#   docker buildx imagetools inspect node:24-slim   (copy the top-level Digest)
ARG NODE_IMAGE=node:24-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5

FROM ${NODE_IMAGE} AS base
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml ./

# Production dependencies only: dist/cli.js keeps its packages external.
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
WORKDIR /app
COPY package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# `digest eval` reads the recorded weeks and labeled cases from here.
COPY evals ./evals
# /app/data is a mount point for the state; /app/dist/digests is where the digest files go, because
# delivery.markdown.dir defaults to dist/digests (relative to /app). Compose bind-mounts ./data and
# ./data/digests over them and ignores this ownership, so Linux hosts set DIGEST_UID/DIGEST_GID
# instead (see docker-compose.yml). Run without Compose, the digests stay inside the container.
RUN mkdir -p /app/data /app/dist/digests && chown node:node /app/data /app/dist/digests
USER node
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["serve"]
