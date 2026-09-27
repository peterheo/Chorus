# Deployed end-to-end run

`node tests/deployed/e2e.mjs` exercises the public Chorus HTTP and MCP surfaces from enrollment through review and audit. It uses Node 24 built-in `fetch` and crypto only; it is intentionally not part of `pnpm verify`.

## Inputs

Set these environment variables before starting the process. The script does not accept command-line arguments, so credentials do not appear in process listings.

| Variable                | Meaning                                                                                                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CHORUS_URL`            | Public base URL without a trailing slash.                                                                                                                                                                                |
| `EXPECTED_COMMIT`       | Full 40-character Git SHA expected from `/healthz` and `chorus.whoami`.                                                                                                                                                  |
| `E2E_ROOM`              | Existing SharedNet room id (`rom_…`) enrolled by all four seats.                                                                                                                                                         |
| `E2E_SEATS_FILE`        | Path outside this repository to a JSON file with `A`, `B`, `C`, and `D` objects, each containing `member_id` and `token`. Keep the file private; tokens stay in process memory and are never written to evidence.        |
| `SHAREDNET_URL`         | Optional SharedNet base URL; defaults to `https://www.sharednet.ai`.                                                                                                                                                     |
| `E2E_ACTIVATION_INVITE` | Optional invite used only when the enrollment probe reports `room_not_available`.                                                                                                                                        |
| `E2E_PAID`              | Set to `1` for the paid P0–P6 run against the same database after redeploying with `CHORUS_BILLING=enabled`.                                                                                                             |
| `E2E_SESSION_ID`        | Paid run only: S1's `session_id` from the E9 record in the successful unpaid run.                                                                                                                                        |
| `E2E_SESSION2_ID`       | Paid run only: S2's `session2_id` from the E9 record in the successful unpaid run.                                                                                                                                       |
| `E2E_BOARD_ID`          | Paid run only: S1's `board_id` from the E9 record in the successful unpaid run.                                                                                                                                          |
| `E2E_PAGE_EXAMPLES`     | Optional. Set to `1` on a successful unpaid run to write a separate, placeholder-only `page-examples-<run id>.json` from E6.                                                                                             |
| `E2E_CONVERSATION`      | Paid run only. Set to `1` when the deployed commit ships the CC-1 conversation tools: adds E10 (A asks, B commits, C scans that window, B buys the suggested task, C links it) and spends one more credit from B.        |
| `E2E_COORDINATION`      | Paid run with `E2E_CONVERSATION=1` only. Set to `1` when the deployed commit ships CC-2 conversation coordination: adds E11a–E11f on E10's session and task. Spends no credits.                                          |
| `E2E_ASSIST`            | Optional, with `E2E_COORDINATION=1` only. Set to `1` to run E11d, which turns coordination mode `assist` on for E10's session, waits up to 60 s for one Chorus conflict note in the room, and turns the mode back `off`. |

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

Run S2-5b in two passes against the same database. Run 1 must use the unpaid E0–E9 flow with billing disabled because E5/E6 create sessions; set `E2E_PAGE_EXAMPLES=1`, then retain the E9 session and board IDs and the separate page examples file. Redeploy that database with `CHORUS_BILLING=enabled`, then run with `E2E_PAID=1` and set `E2E_SESSION_ID`, `E2E_SESSION2_ID`, and `E2E_BOARD_ID` from the first run's E9 record. Paid mode re-enrolls all four seats, checks E0/E2/E4, then runs P0–P6; it skips E1/E3 and E5–E8 because the prior run created and joined the sessions. Missing or malformed run-one IDs fail before any network request. Paid mode spends exactly one credit from B, or two with `E2E_CONVERSATION=1`. `E2E_COORDINATION=1` adds no spending. Missing `E2E_CONVERSATION=1` for `E2E_COORDINATION=1`, or `E2E_COORDINATION=1` for `E2E_ASSIST=1`, fails before any network request.

The first failing step stops the run; E9 records the session, board, and task IDs without deleting evidence records. Every run writes `tests/deployed/out/evidence-<run id>.json`, which is ignored by Git. Evidence and stdout omit credentials, authorization headers, and result content. Each step prints one redacted pass/fail line; a step that cannot apply prints a `SKIP` line with its reason instead and does not fail the run. Evidence records the error-code source for each MCP tool error seen in a step (`structuredContent.error.code`, `content.error.code`, `content.code`, or `missing`). An unpaid run with `E2E_PAGE_EXAMPLES=1` also writes `page-examples-<run id>.json` with IDs and digests replaced by placeholders, idempotency keys replaced by `<uuid>`, and only the fixed short sample in `content`; this file is separate from evidence. Exit status is zero only when every step for the selected mode passes.

## What the run proves

E0 checks the deployed SHA, both entry pages, their four security headers, and the forbidden-string scan. The unpaid mode runs E1–E9: activation if needed, enrollment and theft guard, identity and discovery, session visibility, lifecycle, negative cases, audit access, and ID recording. Paid mode runs E0, E2, E4, and P0–P6 using the existing sessions from the unpaid run: billing tool switch, free pulse, quote, one-credit transfer, delivery, replay/conflict, and a cross-seat payment attempt. `E2E_CONVERSATION=1` adds E10 (a scanned conversation window becomes a paid, linked task). `E2E_COORDINATION=1` adds E11: the inferred coordination model (handoff, commitment, conflict, dependency) built from a real room window, its correction by the people involved only, its next actions in the pulse, optionally one rate-limited assist note that carries nothing session-private, a signed completion receipt that verifies and fails when altered, and consistent board counts.

With `E2E_COORDINATION=1`, E11 runs after E10 on the same session. Every sub-step prints its own line and the first failure stops the run:

| Step | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E11a | Seats post five fixed texts (A hands the backup check to B by B's member id, B accepts, A and D contradict each other about the deploy, C is blocked on B). C scans exactly that window; `chorus.coordination_status` shows the accepted handoff, B's commitment, the two claims, a detected conflict with its `conflict` signal and the waiting dependency, with `inferred: true`. A rescan applies nothing.                                                                     |
| E11b | C, who is not involved, gets `action_forbidden` resolving B's commitment; B resolves it with `chorus.update_conversation_object`, the dependency becomes resolved and a `dependency_resolved` signal appears.                                                                                                                                                                                                                                                                     |
| E11c | B's `room_pulse` lists at least one `conversation_*` next action.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| E11d | Only with `E2E_ASSIST=1` (otherwise `SKIP`): the administrator settles the scanned conflict, sets mode `assist`, A and D post a fresh contradiction, and within 60 s the Chorus seat posts exactly one `[chorus] Resolve conflict …` note. No Chorus note may contain a session id, board id, task id, session name, board name or task title known to the run. The mode is always set back to `off`.                                                                             |
| E11e | E10's task is completed (B claims and submits, C approves), `chorus.get_receipt` returns an Ed25519 envelope bound to that task, `GET /v1/keys/<key_id>` serves a 43-character base64url raw key, the envelope verifies both locally and with `POST /v1/receipts/verify`, and the same envelope with `receipt.result.content_sha256` altered is `valid: false`. When receipts are disabled (`temporarily_unavailable`, cause `receipts_disabled`) the step is `SKIP`, not `FAIL`. |
| E11f | `chorus.board_summary` for the run-one board has the five counts, at least the tasks this run knows in each state, at least one extra done task (run one's E6 task), E11e's task in `recent_done`, and `not_found` for a board outside the session.                                                                                                                                                                                                                               |

E11 evidence holds only refs, kinds, statuses, counts and ids; it never records room text (E11d records the fixed sample `[chorus] Resolve conflict …`), tokens or receipt signatures.

A local-stack run with the S1-3 fake SharedNet verifies the application flow and evidence redaction. Only a run against the real public deployment proves external routing, the deployed SHA, and real SharedNet seat/invite and payment behavior. P3 spends one final credit; run paid mode only with the user's explicit deployment and funded test-seat setup.
