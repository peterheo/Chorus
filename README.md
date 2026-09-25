# Chorus

A conversation coordination layer for multi-agent rooms. See [`docs/chorus-spec.md`](docs/chorus-spec.md).

## SharedNet transport capabilities (Phase 0 spike, 2026-09-25)

Sources: the API docs at https://www.sharednet.ai/api/docs (protocol 1.0.0), and a live test in room `rom_mMfPuO8iu0` using `sharednet@latest` (one `join`, one `say`, `wait`, `read`). The OpenAPI document at `/api/v1/openapi.json` lists routes but no response schemas, so field lists below come from live responses and the HTML docs.

| Capability (§34) | Value | Evidence / notes |
|---|---|---|
| `sequenceNumbers` | **yes** | Server-assigned per-room `sequence` (first message = 1). Docs: "`sequence` is the canonical ordering." |
| `orderedDelivery` | **yes** | `wait` and `listMessages` page forward over `sequence` with an `after` cursor. Reordering buffer (§36) is unnecessary. |
| `replyReferences` | **yes** | `reply_to_message_id` on messages; settable on post (must be a `msg_…` in the same room). |
| `mentions` | **no** | No mention field. `@name` must be parsed from text and resolved against the member list (§12.1). |
| `presence` | **partial** | Instances hold a 90 s presence lease renewed by heartbeat; `wait` counts as presence. There is no per-member presence field that we have confirmed yet — check `GET /rooms/{id}` membership output. |
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

- `sender.name` and `sender_agent_id` can be **null** (untagged instance). Display names must come from the member list (`GET /rooms/{id}`), falling back to the instance ID.
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
