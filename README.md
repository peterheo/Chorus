# Chorus

A conversation coordination layer for multi-agent rooms. See [`docs/chorus-spec.md`](docs/chorus-spec.md).

Chorus sits in a room as one more member. It tracks questions, commitments, factual claims and conflicts, and speaks up only when coordination breaks down: duplicate work, a question nobody answered, two agents contradicting each other.

## Quick start

Requires Node 22+.

```bash
npm install
npm test                                        # acceptance, handoff, persistence, extractor tests
npm run replay -- tests/fixtures/milestone.json # the §82 milestone, with a state timeline
```

### Run it in a SharedNet room

Join the room once with the SharedNet CLI (`npx -y sharednet@latest join '…'`), then point Chorus at that seat:

```bash
SHAREDNET_SEAT_FILE=~/.config/sharednet/rooms/<room>/<member>.json \
CHORUS_MODE=assist npm start
```

Or set `SHAREDNET_ROOM` and `SHAREDNET_TOKEN` (the seat's `sni_…` token) directly. Messages from Chorus's own seat are ignored, so talk to it from a different seat.

State is saved to SQLite (`.chorus/chorus.db`, override with `CHORUS_DB`) after every message. On restart Chorus resumes from the last message it finished; on a first run it starts after the room's latest message so it does not re-announce history (`--after N` overrides both).

| Variable | Values |
|---|---|
| `CHORUS_MODE` | `observe` (silent), `assist` (default: commands + confirmed conflicts), `facilitate` (all interventions) |
| `CHORUS_EXTRACTOR` | `heuristic` (default, deterministic) or `claude` (needs Anthropic credentials) |
| `LLM_MODEL` | model for the Claude extractor; default `claude-opus-5` |
| `CHORUS_DB` | SQLite state file; default `.chorus/chorus.db` |
| `CHORUS_API_PORT` | serve the state API and event stream on this port (off by default) |
| `CHORUS_API_TOKEN` | bearer token for the API; generated and printed at startup if unset |

In the room: `@chorus status`, `open`, `commitments`, `conflicts`, `decisions`, `what-am-i-waiting-on`, `close-check`, `mode <m>`, and feedback `resolved <id>`, `ignore <id>`, `wrong [id]`, `correct [id]`, `reopen <D…>` (permission-checked, spec §60).

### State API and event stream (spec §31–32)

With `CHORUS_API_PORT` set, other agents can read room state directly instead of asking in chat. Every route needs `Authorization: Bearer $CHORUS_API_TOKEN`.

| Route | Returns |
|---|---|
| `GET /v1/rooms/:room/state` | counts of open questions, commitments, handoffs, conflicts, dependencies, decisions; `coordination_complete` |
| `GET /v1/rooms/:room/open-items` | every open question, commitment, handoff, conflict and dependency, with age and source message |
| `GET /v1/rooms/:room/decisions` | current and superseded decisions |
| `GET /v1/rooms/:room/agents/:agent/context` | one agent's commitments, handoffs to and from them, what they wait on, their questions |
| `GET /v1/rooms/:room/objects/:id/history` | an object with its full transition log and source messages (§41) |
| `GET /v1/rooms/:room/events` | Server-Sent Events: `question.opened`, `commitment.completed`, `conflict.detected`, `dependency.resolved`, `room.ready_to_close`, … |

Each event's SSE `id` is its position in the room's transition log, which is persisted, so a client resumes with `Last-Event-ID` (or `?after=N`) even across Chorus restarts.

```bash
curl -H "authorization: Bearer $CHORUS_API_TOKEN" localhost:8787/v1/rooms/rom_…/open-items
curl -N -H "authorization: Bearer $CHORUS_API_TOKEN" localhost:8787/v1/rooms/rom_…/events
```

## What is built (spec §44 items 1–10)

| Area | Where | Notes |
|---|---|---|
| Schemas (LLM layer + domain) | `src/schemas/llm.ts`, `src/state/types.ts` | Zod v4; LLM output is snake_case with agent names, mapped to IDs by the engine |
| Replay transport + virtual clock | `src/transport/replay.ts`, `src/replay.ts`, `src/clock.ts` | Fixtures per §47; ticks simulated between messages |
| Extraction | `src/extract/heuristic.ts`, `src/extract/claude.ts` | Deterministic rules by default; Claude via structured output with one retry |
| State engine | `src/state/engine.ts` | Questions, requests, handoffs, commitments, claims, conflicts, decisions, dependencies; §40 confidence bands; transition log |
| Rules | `src/rules/rules.ts` | All nine §27 intervention types: duplicate work (two-stage), unanswered (count OR wall-clock), missing handoff acknowledgement, stale commitment, conflicts (grouped), repeated question, decision reminder, dependency resolved, completion |
| Persistence | `src/store.ts`, `src/state/room.ts` | SQLite snapshot + resume cursor committed per message; message and intervention audit log; deterministic post idempotency keys (§35) |
| Policy | `src/policy.ts` | §26 score, mode filter, dedup, rate limits, queue TTL |
| Commands + feedback | `src/commands.ts` | §29 commands, §60 permissions |
| State API + SSE | `src/api/views.ts`, `src/api/server.ts` | §31 routes, §32 events with resumable IDs, §41 history; node:http, bearer auth |
| SharedNet transport | `src/transport/sharednet.ts` | Raw API `wait` loop, idempotent posts, roster |

**Not built yet:** intervention merging (§51), dependency deadlock detection (§26), embeddings (stage 1 is lexical overlap instead, see `src/similarity.ts`), raw LLM-response logging (§48), receipts (§54). Persistence stores a full snapshot per message, which is fine at hackathon scale but should become incremental for long rooms. The Claude extractor has not been run against the live API from this environment (no credentials).

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
