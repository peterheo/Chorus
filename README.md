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

## Database roles and isolation

- **Owner role** (`DATABASE_URL`): runs migrations and operator tooling. It must be a superuser or hold
  `BYPASSRLS`, because tenant tables use `FORCE ROW LEVEL SECURITY` and the `SECURITY DEFINER` functions
  (`chorus_resolve_token`, `chorus_redeem_invite`, `chorus_visible_rooms`) run as it. Locally and in CI
  this is the compose `chorus` superuser.
- **Runtime role** `chorus_app` (`DATABASE_URL_APP`): created by migration `0003`, not a superuser, no
  `BYPASSRLS`, owns nothing, least-privilege grants. All application traffic and all domain integration
  tests use it, so row-level security applies to them.
- The migration creates `chorus_app` **without a password**. Set one out of band; never commit it:

  ```sh
  CHORUS_APP_PASSWORD='<secret>' DATABASE_URL=<owner url> pnpm migrate   # migrates, then sets the password
  ```

  Tests set their own throwaway password on the local test cluster, and refuse to run unless
  `DATABASE_URL` names a database ending in `_test`.

- `ALTER ROLE ... PASSWORD` can appear in server logs when `log_statement` is `ddl` or `all`. Prefer
  passing a pre-hashed SCRAM verifier (a value starting with `SCRAM-SHA-256$`) as
  `CHORUS_APP_PASSWORD`; PostgreSQL stores such values as given.

- Transactions set `chorus.workspace_id` and `chorus.actor_id` (transaction-local) through `runCommand`
  and `withReadTx`; with neither set the runtime role sees nothing.
