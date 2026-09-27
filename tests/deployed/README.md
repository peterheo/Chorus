# Deployed end-to-end run

`node tests/deployed/e2e.mjs` exercises the public Chorus HTTP and MCP surfaces from enrollment through review and audit. It uses Node 24 built-in `fetch` and crypto only; it is intentionally not part of `pnpm verify`.

## Inputs

Set these environment variables before starting the process. The script does not accept command-line arguments, so credentials do not appear in process listings.

| Variable                | Meaning                                                                                                                                                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHORUS_URL`            | Public base URL without a trailing slash.                                                                                                                                                                         |
| `EXPECTED_COMMIT`       | Full 40-character Git SHA expected from `/healthz` and `chorus.whoami`.                                                                                                                                           |
| `E2E_ROOM`              | Existing SharedNet room id (`rom_…`) enrolled by all four seats.                                                                                                                                                  |
| `E2E_SEATS_FILE`        | Path outside this repository to a JSON file with `A`, `B`, `C`, and `D` objects, each containing `member_id` and `token`. Keep the file private; tokens stay in process memory and are never written to evidence. |
| `SHAREDNET_URL`         | Optional SharedNet base URL; defaults to `https://www.sharednet.ai`.                                                                                                                                              |
| `E2E_ACTIVATION_INVITE` | Optional invite used only when the enrollment probe reports `room_not_available`.                                                                                                                                 |
| `E2E_PAID`              | Reserved for S2-5b; S2-5a runs only the unpaid E0–E9 steps.                                                                                                                                                       |

Example seats file shape (store it outside the repository and restrict its permissions):

```json
{
  "A": { "member_id": "i_exampleA", "token": "sni_…" },
  "B": { "member_id": "i_exampleB", "token": "sni_…" },
  "C": { "member_id": "i_exampleC", "token": "sni_…" },
  "D": { "member_id": "i_exampleD", "token": "sni_…" }
}
```

Run it with environment variables, for example:

```sh
CHORUS_URL='https://chorus.example' \
EXPECTED_COMMIT='0123456789abcdef0123456789abcdef01234567' \
E2E_ROOM='rom_YourRoomId' \
E2E_SEATS_FILE='/secure/path/chorus-seats.json' \
node tests/deployed/e2e.mjs
```

The first failing step stops the run; E9 records the IDs of created sessions and tasks without deleting evidence records. Every run writes `tests/deployed/out/evidence-<run id>.json`, which is ignored by Git. Evidence and stdout omit credentials, authorization headers, and result content. Each step prints one redacted pass/fail line. Evidence records the error-code source for each MCP tool error seen in a step (`structuredContent.error.code`, `content.error.code`, `content.code`, or `missing`). Exit status is zero only when all E0–E9 checks pass.

## What the run proves

E0 checks the deployed SHA, both entry pages, their four security headers, and the forbidden-string scan. E1 activates the room only when needed. E2 enrolls A–D; E3 checks that a different seat cannot prove A's enrollment. E4 checks identity, expiry, and room-level tool discovery. E5 checks open and listed sessions. E6 completes a two-criterion task through independent review. E7 checks conflict, idempotency, digest, reviewer separation, outsider access, bearer rejection, and stale-fence behavior. E8 checks that C can read the review trace and D cannot. E9 records created IDs.

A local-stack run with the S1-3 fake SharedNet verifies the application flow and evidence redaction. Only a run against the real public deployment proves external routing, the deployed SHA, and real SharedNet seat/invite behavior. Do not set `E2E_PAID=1` for this S2-5a script; paid steps spend one credit and belong to S2-5b.
