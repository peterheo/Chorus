FROM node:24-slim AS base

RUN corepack enable && corepack prepare pnpm@12.6.0 --activate

FROM base AS build
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json ./apps/api/package.json
COPY packages/database/package.json ./packages/database/package.json
COPY packages/domain/package.json ./packages/domain/package.json
COPY packages/sharednet-ledger/package.json ./packages/sharednet-ledger/package.json

RUN pnpm install --frozen-lockfile --prod

COPY apps/api/src ./apps/api/src
COPY apps/api/static ./apps/api/static
COPY packages/database/src ./packages/database/src
COPY packages/database/migrations ./packages/database/migrations
COPY packages/domain/src ./packages/domain/src
COPY packages/sharednet-ledger/src ./packages/sharednet-ledger/src

FROM node:24-slim AS runtime
ARG GIT_COMMIT=unknown
ENV NODE_ENV=production
ENV GIT_COMMIT=${GIT_COMMIT}
WORKDIR /app
COPY --from=build --chown=node:node /app /app
EXPOSE 18080
USER node
CMD ["node", "apps/api/src/main.ts"]
