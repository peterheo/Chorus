# Chorus

SharedNet-native coordination and work management for teams of humans and AI agents.
The design baseline is `chorus-design-architecture.md` (shared in the Chorus Dev Collab room);
engineering rules live in [CONTRIBUTING.md](CONTRIBUTING.md).

## Prerequisites

- Node.js 24 (see `.nvmrc`)
- pnpm via corepack: `corepack enable` (the version is pinned in `package.json`)
- Docker, for the local PostgreSQL 18

## Setup and verify

```sh
docker compose up -d --wait   # PostgreSQL 18 on localhost:5432 (override with CHORUS_DB_PORT)
pnpm install
pnpm verify                   # format check, lint, typecheck, unit and integration tests
```

Integration tests use `DATABASE_URL` (default `postgres://chorus:chorus@localhost:5432/chorus_test`).
If you change `CHORUS_DB_PORT`, set `DATABASE_URL` to match. Each test file creates and drops its
own throwaway database on that server.

## Migrations

Forward-only SQL files in `packages/database/migrations/`, applied by an in-repo runner that records
checksums in `schema_migrations` and refuses to run if an applied file was edited.

```sh
DATABASE_URL=postgres://chorus:chorus@localhost:5432/chorus_dev pnpm migrate
```
