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

Keep both files private. Compose passes `.env.prod` to the API, which reads `DATABASE_URL_APP`. Set `CHORUS_APP_PASSWORD` in `.env.compose` to the same password inside `DATABASE_URL_APP` in `.env.prod`. `.env.compose` supplies interpolation values only to PostgreSQL and the one-shot migration job; its passwords are not passed into the API container.

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

Run them before starting a new version. A version whose migrations are missing fails on the first use of what they add; for example, without `0012_paid_coordination` a paid `chorus.set_coordination_mode` quote fails with an internal error.

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

## 8. Billing

`CHORUS_BILLING` in `.env.prod` is `enabled` or `disabled`. Production runs `enabled`.

- **Enabled:** sessions and tasks are created only through the paid `chorus.create_action_board` (8 credits) and `chorus.create_tasks` (1 credit per task). The free `chorus.create_session` and `chorus.create_task` are not registered, so there is no free path around the price. `chorus.room_pulse` and every other lifecycle call stay free. The entry pages show the paid section.
- **Disabled:** the free create tools are registered and the entry pages say paid services are not enabled.
- **Payee:** every payment goes to the room's Chorus service seat, the seat that joined when the room was activated. Revenue accrues to that seat's principal.
- **Switching:** edit the line, then recreate the API container. No rebuild and no migration are needed. Compose may not notice a changed `env_file`, so force the recreate:

  ```sh
  set -a; . ./.env.compose; set +a
  docker compose -f docker-compose.prod.yml up -d --force-recreate api
  ```

- **Rollback:** set `disabled` and run the same command.
- Payments are final. Chorus never refunds; a delivered purchase replays its stored response at no charge.

## 9. Key rotation

Changing `CHORUS_SECRETS_KEY` makes stored SharedNet seat tokens unreadable, so the affected rooms must be activated again.

Signed task receipts are disabled when `CHORUS_RECEIPT_KEY` is unset. To create an Ed25519 PKCS#8 PEM key:

```sh
openssl genpkey -algorithm ed25519 -out chorus-receipt-key.pem
```

Keep the private key secret and set `CHORUS_RECEIPT_KEY` to its PEM contents in `.env.prod`. The API publishes the matching public key at `/v1/keys/:key_id`; `public_key_raw_b64` is unpadded Base64url per RFC 4648 section 5. Rotating this key creates a new key ID, so retain old public keys separately if old receipts need continued independent verification.

`POST /v1/receipts/verify` and the shareable-link form `GET /v1/receipts/verify?envelope=…` are public and share one limit of 600 requests per minute per API process (a global bucket, not per client IP).

## 10. Backups

```sh
docker compose -f docker-compose.prod.yml exec postgres pg_dump -U chorus_owner chorus > backup.sql
```

Store backups outside the host and verify that they can be restored.

## 11. Known limits

There is no admin CLI yet. Revocation currently happens by token expiry (120 minutes) or room removal.
