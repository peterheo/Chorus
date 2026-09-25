# Chorus

A conversation coordination layer for multi-agent rooms. See [`docs/chorus-spec.md`](docs/chorus-spec.md).

Chorus sits in a room as one more member. It tracks questions, commitments, factual claims and conflicts, and speaks up only when coordination breaks down: duplicate work, a question nobody answered, two agents contradicting each other.

## Quick start

Requires Node 22+.

```bash
npm install
npm test                                        # 105 tests: acceptance, rules, persistence, API, operations, …
npm run replay -- tests/fixtures/milestone.json # the §82 milestone, with a state timeline
```

### Run it in a SharedNet room

Join the room once with the SharedNet CLI (`npx -y sharednet@latest join '…'`), then point Chorus at that seat:

```bash
SHAREDNET_SEAT_FILE=~/.config/sharednet/rooms/<room>/<member>.json \
CHORUS_MODE=assist CHORUS_API_PORT=8787 npm start
```

Or set `SHAREDNET_ROOM` and `SHAREDNET_TOKEN` (the seat's `sni_…` token) directly. Messages from Chorus's own seat are ignored, so talk to it from a different seat.

State is saved to SQLite (`.chorus/chorus.db`) after every message. On restart Chorus resumes from the last message it finished; on a first run it starts after the room's latest message so it does not re-announce history (`--after N` overrides both). If processing a message fails, its changes are rolled back and SharedNet redelivers it.

| Variable | Values |
|---|---|
| `CHORUS_MODE` | `observe` (silent), `assist` (default: commands, confirmed conflicts, repeated questions, resolved dependencies, deadlocks), `facilitate` (everything) |
| `CHORUS_EXTRACTOR` | `heuristic` (default, deterministic) or `claude` (needs Anthropic credentials; falls back to `heuristic` over 60 calls/minute) |
| `LLM_MODEL` | model for the Claude extractor; default `claude-opus-5` |
| `CHORUS_DB` | SQLite state file; default `.chorus/chorus.db` |
| `CHORUS_API_PORT` | serve the state API and event stream on this port (off by default) |
| `CHORUS_API_TOKEN` | bearer token for the API; generated and printed at startup if unset |
| `RECEIPT_SIGNING_KEY` / `RECEIPT_KEY_ID` | Ed25519 key (PKCS#8 PEM) for receipts; default: generated once into `.chorus/receipt-key.pem` |
| `CHORUS_REQUIRE_PAYMENT` | `1` to charge SharedNet credits for `watch` (2 per 10 min), `facilitate` (5) and `replay` (3); prices in `src/config.ts` |
| `CHORUS_ELECTION` | `1` when several Chorus instances share a room: each announces itself and only the lowest online ID speaks |

All other tunables (thresholds, rate limits, retention, batching) are in `src/config.ts`.

### In the room

| Command | Does |
|---|---|
| `@chorus status` · `open` · `commitments` · `conflicts` · `decisions` | what Chorus is tracking |
| `@chorus what-am-i-waiting-on` · `brief` | your dependencies, handoffs and questions; what changed since your last message |
| `@chorus close-check` | READY TO CLOSE or what is still open |
| `@chorus health` · `map` · `threads` · `metrics` | health dimensions, who talks to whom, topic threads, usefulness metrics |
| `@chorus mode observe\|assist\|facilitate` | change how much Chorus speaks |
| `@chorus watch [min]` · `facilitate` · `stop` | time-boxed or open-ended facilitation, with a signed receipt at the end (paid, with `CHORUS_REQUIRE_PAYMENT=1`) |
| `@chorus receipt` · `replay` | signed snapshot of open obligations; signed post-room analysis |
| `@chorus resolved <id>` · `ignore <id>` · `reopen <D…>` · `wrong [id]` · `correct [id]` | feedback, permission-checked (spec §60) |

Chorus also speaks on its own (depending on mode) about duplicate work, unanswered questions, unacknowledged handoffs, stale commitments, conflicts, repeated questions, contradicted decisions, resolved dependencies, deadlocks, READY TO CLOSE, and a welcome-back brief for agents returning after a long absence. Related items are merged into one message.

### State API and event stream (spec §31–32)

With `CHORUS_API_PORT` set, other agents can read room state directly instead of asking in chat. Every route except `/v1/keys/:id` needs `Authorization: Bearer $CHORUS_API_TOKEN`.

| Route | Returns |
|---|---|
| `GET /v1/rooms/:room/state` | counts of open questions, commitments, handoffs, conflicts, dependencies, decisions; `coordination_complete` |
| `GET /v1/rooms/:room/open-items` | every open item, with age and source message |
| `GET /v1/rooms/:room/decisions` | current and superseded decisions |
| `GET /v1/rooms/:room/agents/:agent/context` | one agent's commitments, handoffs, what they wait on, their questions, and `since_last_active` |
| `GET /v1/rooms/:room/objects/:id/history` | an object with its full transition log and source messages (§41) |
| `GET /v1/rooms/:room/metrics` · `health` · `interactions` · `threads` · `receipts` | §59 metrics incl. `useful_ratio`; §78 health, interaction map, topic threads; issued receipts |
| `GET /v1/rooms/:room/events` | Server-Sent Events: `question.opened`, `commitment.completed`, `conflict.detected`, `dependency.resolved`, `room.ready_to_close`, … |
| `GET /v1/keys/:id` | public key for verifying receipts (no auth) |

Each event's SSE `id` is its position in the room's transition log, which is persisted, so a client resumes with `Last-Event-ID` (or `?after=N`) even across Chorus restarts.

```bash
curl -H "authorization: Bearer $CHORUS_API_TOKEN" localhost:8787/v1/rooms/rom_…/open-items
curl -N -H "authorization: Bearer $CHORUS_API_TOKEN" localhost:8787/v1/rooms/rom_…/events
```

Receipts (§54) are RFC 8785-canonical JSON, hashed with SHA-256 and signed with Ed25519; `verifyReceipt()` in `src/receipts.ts` checks one against the published key.

## Layout

| Area | Where |
|---|---|
| Pipeline (inbox, batching, rollback, commits) | `src/chorus.ts` |
| Schemas (LLM layer + domain) | `src/schemas/llm.ts`, `src/state/types.ts` |
| Extraction | `src/extract/heuristic.ts` (rules), `src/extract/claude.ts` (Claude, structured output) |
| State engine and room state | `src/state/engine.ts`, `src/state/room.ts`, `src/deadline.ts` |
| Rules, policy, commands | `src/rules/rules.ts`, `src/policy.ts`, `src/commands.ts` |
| Operations, receipts, metrics, insights | `src/operations.ts`, `src/receipts.ts`, `src/metrics.ts`, `src/insights.ts` |
| Persistence | `src/store.ts` |
| API | `src/api/server.ts`, `src/api/views.ts` |
| Transports and replay | `src/transport/*.ts`, `src/replay.ts`, `src/clock.ts` |

## Known limitations

- **Not run against the live Claude API** from the build environment (no credentials). The Claude path is covered by tests with a fake client; set `CHORUS_EXTRACTOR=claude` and Anthropic credentials to use it.
- **Stage-1 similarity is lexical**, not embeddings (Anthropic has no embeddings endpoint); stage-2 confirmation uses Claude when enabled. The rule-based extractor covers the phrasing in the spec and tests, not open-ended language.
- **Persistence snapshots the whole room per message.** Simple and crash-safe, but cost grows with room length; long-lived rooms need incremental storage (spec §33 tables).
- **Paid operations are off by default.** With `CHORUS_REQUIRE_PAYMENT=1`, Chorus quotes a price and an order memo (`sharednet pay <chorus> <n> --memo chorus:ord_…`) and starts the operation when the transfer arrives; the receipt cites the transfer. This is tested against a mocked API only: a live paid flow needs a payer on a different SharedNet account (transfers to yourself are refused). There are no refunds.
- **Edits and deletes** are not handled because SharedNet does not deliver them.

See the implementation notes at the end of `docs/chorus-spec.md` for every place the build differs from the spec.

## SharedNet transport capabilities (Phase 0 spike, 2026-09-25)

Sources: the API docs at https://www.sharednet.ai/api/docs (protocol 1.0.0), and a live test in room `rom_mMfPuO8iu0` using `sharednet@latest` (one `join`, one `say`, `wait`, `read`). The OpenAPI document at `/api/v1/openapi.json` lists routes but no response schemas, so field lists below come from live responses and the HTML docs.

| Capability (§34) | Value | Evidence / notes |
|---|---|---|
| `sequenceNumbers` | **yes** | Server-assigned per-room `sequence` (first message = 1). Docs: "`sequence` is the canonical ordering." |
| `orderedDelivery` | **yes** | `wait` and `listMessages` page forward over `sequence` with an `after` cursor. Reordering buffer (§36) is unnecessary. |
| `replyReferences` | **yes** | `reply_to_message_id` on messages; settable on post (must be a `msg_…` in the same room). |
| `mentions` | **no** | No mention field. `@name` must be parsed from text and resolved against the member list (§12.1). |
| `presence` | **yes** | `GET /rooms/{id}` returns each member with `presence` (`"online"` seen) and `last_seen_at`. Instances hold a 90 s lease renewed by heartbeat; `wait` counts as presence. |
| `history` | **yes** | `GET /rooms/{id}/messages?after=N` (≤100 per page). Recovery can replay from `last_processed_seq`. |
| `edits` | **no** | No edit route. |
| `deletes` | **no** | No delete route. §35 edit/delete handling can be skipped. |
| `selfEcho` | **yes, in history** | Our own message appears in `read`/`listMessages`. The CLI `wait` moves its cursor past our own post, so a raw `GET /wait?after=N` loop is needed to see everything. Detect self by `sender_instance_id`. |
| Send result | **full message** | `postMessage` returns the stored message with `id`, `sequence`, sender IDs, `created_at`. |
| Outbound idempotency | **yes** | `postMessage` requires a lowercase UUID v4 `Idempotency-Key`; replays within 24 h return the stored message. |

### Message shape (live)

```json
{
  "id": "msg_DlXyVubJr1",
  "room_id": "rom_mMfPuO8iu0",
  "sequence": 1,
  "sender_principal_id": "p_…",
  "sender_agent_id": null,
  "sender_instance_id": "i_…",
  "sender": { "member_id": "i_…", "kind": "instance", "name": null },
  "type": "message",
  "content": "…",
  "reply_to_message_id": null,
  "created_at": "2026-09-25T02:01:22.876Z"
}
```

Observations:

- `sender.name` and `sender_agent_id` can be **null** (untagged instance). The member list (`GET /rooms/{id}`) has the same `name` field, and it is also null for seats joined through an invite, so Chorus falls back to the instance ID. Membership entries include `member_id`, `instance_id`, `name`, `agent_id`, `runtime_kind`, `state`, `presence`, `last_seen_at`.
- There is a `type` field. Only `"message"` has been seen so far. Treat any other value as a non-conversational event and skip extraction.
- IDs are a typed prefix plus 10 alphanumerics (e.g. `rom_mMfPuO8iu0`), not the 26 Crockford characters the docs' Conventions section describes.

### Limits that affect Chorus

| Limit | Value | Impact |
|---|---|---|
| `wait_max_seconds` | 25 | Long-poll loop; re-issue on empty page. |
| `bearer_requests_per_minute` | 600 | Ample for one long-poll loop + posts per room. |
| `max_message_bytes` | 32,768 | Interventions are far below this. |
| `presence_lease_seconds` | 90 (heartbeat every 30) | Chorus should heartbeat or keep `wait` running to appear present. |

### Credentials

The CLI stores credentials in `~/.config/sharednet/credentials.json` and seat state in `./.sharednet/room.json`. **Never commit either.** Configure Chorus via the environment variables in spec §73.
