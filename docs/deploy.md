# Deploy Chorus

## 1. Prerequisites

- Docker Engine with the Compose plugin.
- A host with port 18080 available on loopback.
- An existing SharedNet room for Chorus to join.

## 2. Configure

Copy `.env.prod.example` to `.env.prod` and `.env.compose.example` to `.env.compose`. Replace the `CHANGE_ME_` placeholders with unique values. Generate `CHORUS_SECRETS_KEY` with:

```sh
openssl rand -base64 32
```

Use long random hexadecimal values for both database passwords so they are safe in the connection URL. Load the Compose-only values in the shell used for the commands below:

```sh
set -a
. ./.env.compose
set +a
```

Keep both files private. Compose passes `.env.prod` to the API, which reads `DATABASE_URL_APP`. `.env.compose` supplies interpolation values only to PostgreSQL and the one-shot migration job; its passwords are not passed into the API container.

## 3. Build

```sh
GIT_COMMIT=$(git rev-parse HEAD) docker compose -f docker-compose.prod.yml build
```

The image installs production dependencies for the whole workspace. It runs the API directly from the workspace TypeScript sources with Node 24.

## 4. Migrate

```sh
docker compose -f docker-compose.prod.yml --profile tools run --rm migrate
```

Migrations are an explicit step and do not run automatically during startup.

## 5. Start, stop, and logs

```sh
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml logs -f api
docker compose -f docker-compose.prod.yml stop
```

Run `up -d` again to start the stopped services. `docker compose down` removes the containers and network while retaining the named database volume.

## 6. Verify

```sh
curl -s 127.0.0.1:18080/healthz
```

Compose starts the API asynchronously. If curl cannot connect immediately, retry after a moment.
The response must have `status: "ok"` and `commit` equal to the deployed Git SHA.

## 7. Public URL

The public URL is fronted by a Cloudflare Worker relay to a tunnel on this host. The API binds only to `127.0.0.1:18080`; configure the relay and tunnel on the host separately.

## 8. Key rotation

Changing `CHORUS_SECRETS_KEY` makes stored SharedNet seat tokens unreadable, so the affected rooms must be activated again.

## 9. Backups

```sh
docker compose -f docker-compose.prod.yml exec postgres pg_dump -U chorus_owner chorus > backup.sql
```

Store backups outside the host and verify that they can be restored.

## 10. Known limits

There is no admin CLI yet. Revocation currently happens by token expiry (120 minutes) or room removal.
