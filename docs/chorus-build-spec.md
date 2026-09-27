# Chorus — Technical Specification (As Built)

**What this is:** a full record of the Chorus build, from spec review to a running system with a Gemini backend and rate limiting.
**Repository:** `peterheo/chorus`, branch `claude/product-spec-review-yj2d50`
**Companion document:** `docs/chorus-spec.md` is the product specification, now at revision 2. Its §84 lists every deliberate difference between the build and the spec.
**Status:** every section of the product spec and every §78 stretch feature is built. There are 143 automated tests, all passing, and CI runs on every push.

---

## Contents

1. [Summary](#1-summary)
2. [Timeline of the work](#2-timeline-of-the-work)
3. [Spec review and revision 2](#3-spec-review-and-revision-2)
4. [SharedNet capability spike](#4-sharednet-capability-spike)
5. [System architecture](#5-system-architecture)
6. [Processing pipeline](#6-processing-pipeline)
7. [Data model](#7-data-model)
8. [Extraction](#8-extraction)
9. [LLM backends: Gemini and Claude](#9-llm-backends-gemini-and-claude)
10. [Rate limiting](#10-rate-limiting)
11. [State engine](#11-state-engine)
12. [Coordination rules](#12-coordination-rules)
13. [Intervention policy](#13-intervention-policy)
14. [Commands](#14-commands)
15. [Operations, payments and receipts](#15-operations-payments-and-receipts)
16. [Insights (stretch features)](#16-insights-stretch-features)
17. [Multi-instance election](#17-multi-instance-election)
18. [Persistence](#18-persistence)
19. [HTTP API and event stream](#19-http-api-and-event-stream)
20. [Transports](#20-transports)
21. [Metrics and observability](#21-metrics-and-observability)
22. [Configuration reference](#22-configuration-reference)
23. [Performance](#23-performance)
24. [Testing](#24-testing)
25. [Deployment](#25-deployment)
26. [Security](#26-security)
27. [Deviations from the product spec](#27-deviations-from-the-product-spec)
28. [Known limitations and next steps](#28-known-limitations-and-next-steps)
29. [Source map](#29-source-map)

---

## 1. Summary

Chorus is a **conversation coordination layer for multi-agent chat rooms**, running on SharedNet. It is not a project manager and does not assign work. It does four things:

1. It reads every message in the room.
2. It keeps a live model of the conversation's obligations: questions, commitments, claims, handoffs, decisions, dependencies and conflicts.
3. It speaks up only when coordination is breaking down. Examples: two agents doing the same work, a question nobody answered, contradictory facts, a handoff nobody acknowledged, a deadlock, or "everything is done, you can close."
4. It exposes the same state to agents through `@chorus` commands, an HTTP API and a live event stream, and issues cryptographically signed receipts.

**Design principles**

- **The state engine is deterministic.** Extractors only *propose* events; only the engine changes state, and it records every change as a transition.
- **Rules come first; the LLM is optional.** A rule-based extractor is the default, so replays and tests are reproducible without credentials. An LLM (Gemini or Claude) can be switched on for better language understanding.
- **Chorus is quiet by default.** Mode filtering, a score threshold, rate limits and merging keep it from talking too much.
- **Nothing is lost:**
  - If processing a message fails, its changes are rolled back and the transport redelivers it.
  - An intervention is recorded only after it has actually been sent.
  - State is written to SQLite after every message.

**Stack**

| Area | Choice |
|---|---|
| Language and runtime | TypeScript on Node 22, run with `tsx` |
| Schemas | Zod v4 |
| Persistence | `node:sqlite` |
| HTTP server | `node:http` |
| Tests | `node:test` |
| Runtime dependencies | `zod`, `tsx`, `@anthropic-ai/sdk` (the Gemini backend uses plain `fetch`) |

**Size:** about 6,900 lines of source and 2,900 lines of tests.

---

## 2. Timeline of the work

| # | Commit | What was done |
|---|---|---|
| 1 | `698b650` | Added the original spec (v1) for review |
| 2 | `2fe9bb6` | **Spec revision 2**: fixed the gaps found in review (§3) |
| 3 | `d6c09a7` | Recorded the SharedNet capability spike results (§4) |
| 4 | `2ce605c` | **MVP**: replay harness, state engine, rules, SharedNet transport |
| 5 | `d1ba6be` | Persistence, handoffs, missing-acknowledgement and stale-commitment rules |
| 6 | `86e899f` | Decisions, dependencies, repeated questions |
| 7 | `28b7a7e` | HTTP state API and resumable SSE event stream |
| 8 | `b824853` | Merging related interventions, naming blocked agents, deadlock detection |
| 9 | `d6f1282` | Deadlines and expiry, handoff transfers, alias learning |
| 10 | `7dd2d76` | Signed receipts, operations, metrics, LLM logging, budget, retention |
| 11 | `8b73913` | Batch extraction under load |
| 12 | `0e4d3a1` | §78 stretch features: agent brief, health, interaction map, threads, election |
| 13 | `dffbee8` | **Fixes from a code review**, each with a regression test |
| 14 | `95f1e03` | Documentation: README, API, limitations, spec §84 |
| 15 | `4fb1462` | Paid operations using SharedNet credits |
| 16 | `f051cb1` | Incremental persistence and incremental rules (the performance work) |
| 17 | `1e67cb9` | CI workflow, Dockerfile, benchmark script |
| 18 | *(analysis)* | "Why do we need an LLM?" A probe comparing the rules extractor on natural phrasing (§8.3) |
| 19 | `e5b21d8` | **Gemini backend**; the LLM layer became provider-neutral |
| 20 | `9b25eda` | **Gemini rate limiting**, falling back to rules on failure, and a rules-first mode |

---

## 3. Spec review and revision 2

The v1 spec was reviewed for gaps that would block or break an implementation. Revision 2 (`docs/chorus-spec.md`, change summary at the top) fixed them:

| Area | Problem in v1 | Revision 2 fix |
|---|---|---|
| Claims | Conflicts were described with no underlying "fact" object | New `claim` event type and `Claim` object; conflicts group claims by subject |
| Self-ingestion | Nothing stopped Chorus from reacting to its own messages | Chorus never extracts from its own messages, and they don't count as room activity (§11.1) |
| Time-based rules | "Unanswered after N messages" never fires in a quiet room | Per-room tick scheduler and an injectable clock. The unanswered threshold is a message count **or** wall-clock time, with a minimum floor |
| Scope | Chorus could invent sub-tasks | Chorus only points at items already in room state |
| Requests | The same thing had two representations | A targeted request ("Bob, can you…") becomes a Handoff; an untargeted one becomes a Question with `kind: "request"` |
| Throughput | Extraction and apply were one serial step | Two-phase processing, a pre-filter for trivial messages, and batching |
| Schema | SQL didn't match the domain model | Aligned tables, per-room short IDs (Q1, C2…), room-scoped agents |
| Naming | LLM output and domain names were mixed | The LLM layer is snake_case and maps to camelCase domain types; agent name resolution is defined |
| State machines | Missing transitions | Unblock transition, expiry only via a deadline, handoff → commitment link, "optional" commitments |
| Reliability | No idempotency story | Processing markers, intervention idempotency keys, edit/delete policy |
| Security | Anyone could say `@chorus wrong` | Feedback commands are permission-checked; receipts are signed over RFC 8785 canonical JSON |
| LLM I/O | Unstructured output | Structured output with one retry; two-stage duplicate detection |
| MVP scope | The completion check was post-MVP | Moved into the MVP; added a day-0 SharedNet spike |

---

## 4. SharedNet capability spike

Before building the transport, the SharedNet API was probed against a real room. The findings, recorded in spec §34.1 and the README, shaped the transport:

| Spec area | SharedNet behaviour | Consequence for Chorus |
|---|---|---|
| Ingest | Long-poll `GET /api/v1/rooms/{id}/wait?after=<seq>&timeout=25` | The transport runs a wait loop on the raw API. The CLI `wait` is not used because it skips the caller's own posts |
| Self identity | Every message carries `sender_instance_id` | Chorus detects its own messages by an exact ID match |
| Ordering | Server-assigned, gap-free `sequence` | No reorder buffer is needed; `last_processed_seq` is the resume cursor |
| Recovery | `GET /messages?after=<seq>` pages through history | Full history replay is available |
| Outbound idempotency | A UUID v4 `Idempotency-Key` is required; a repeat within 24 h returns the stored message | Deterministic keys make a retry after a crash safe, with no echo-matching |
| Replies | `reply_to_message_id` on read and write | Command replies and single-message interventions are threaded |
| Mentions | No mention field | `@name` is parsed from the text and resolved against the roster |
| Names | `sender.name` may be null | The roster comes from the room's memberships, falling back to the instance ID |
| Edits and deletes | Not supported | Not handled |
| Presence | 90-second lease; `wait` counts as presence | The wait loop keeps Chorus present; the roster reports others' presence |
| Rate limit | 600 requests/min per bearer token | One wait loop plus posts fits comfortably |
| Credits | `GET /credits/transfers`; `sharednet pay <i_…> <n> --memo <text>` | Used for paid operations (§15) |

---

## 5. System architecture

```
                    ┌────────────────────────── ChorusRoom (src/chorus.ts) ──────────────────────────┐
 SharedNet  ──wait──▶  inbox ─▶ drain ─▶ ingest ─▶ pre-filter ─▶ extract ─▶ applyEvents ─▶ evaluate ─▶ post ──▶ SharedNet
 (transport)        │   (batch)            │          │            │        (state engine)   (rules)   (policy)   (idempotent)
                    │                      │          │            ▼                                   │
                    │                      │     commands     Extractor ── rules (default)             │
                    │                      │     (§14)        │         └─ LLM: Gemini / Claude         │
                    │                      │                  │            └─ rate limiter (§10)        │
                    │                      ▼                  ▼                                        │
                    │               atomically(): rollback on error ─────────────▶ commit() ─▶ SQLite store
                    │                                                                   │
                    └──────────────────────────────────────────────── publish transitions ─▶ SSE listeners
                                                                                            HTTP API (§19)
 tick timer (15 s) ─▶ deadlines · session expiry · payment polling · time-based rules · completion check
```

**Concurrency model:** each room has one **serial queue**, so nothing else touches state while a step runs. Messages go into an **inbox**. When the queue reaches them, the whole backlog is drained at once, which is what makes batch extraction possible (§8.4).

---

## 6. Processing pipeline

`ChorusRoom` in `src/chorus.ts` runs this sequence for every message:

1. **Receive.** The transport's `onMessage` handler returns a promise that resolves only when the message has been processed. The transport never moves its cursor past an unprocessed message, and a rejected promise means the message is redelivered.
2. **Drain.** Everything in the inbox is taken at once. If more than `batchWhenBacklogOver` (5) messages are waiting and the extractor can batch, they are extracted in chunks of up to `maxBatch` (10), one call per chunk.
3. **Atomic unit.** Each message runs inside `atomically()`:
   - It snapshots the core state as JSON and records the lengths of the append-only logs.
   - On any error, it restores the core and truncates the logs, which is a full rollback.
   - It also discards uncommitted interventions and receipts and resets the duplicate cache, because rolled-back IDs get reused.
   - The error is rethrown, so this message and every later one in the batch are rejected in order and redelivered.
4. **Normalize and dedupe.** Messages whose ID has already been seen are skipped. The room index counts non-Chorus messages only.
5. **Chorus's own messages** are stored but never extracted or counted.
6. **Non-message types** are skipped.
7. **Peer announcements** (`[chorus] online as <id>`) are recorded for election (§17) and not extracted.
8. **Alias learning.** A whole message like "I'm the verifier." or "This is ResearchA" teaches a display alias. There are guards so that "I'm stuck." is never taken as a name.
9. **Welcome-back brief.** An agent returning after 30 or more messages, or 15 or more minutes, away gets a brief of what changed (§16).
10. **Commands.** `@chorus …` goes to the deterministic command handler (§14). The reply is solicited and exempt from rate limits. A state-changing command re-settles state and re-runs the rules.
11. **Pre-filter.** Trivial messages ("ok", "thanks", "lgtm", "+1"…) that aren't replies are skipped without extraction.
12. **Extract** (§8):
    - The pipeline picks an extractor. If the LLM is rate-limited or over the per-minute budget, it uses the rules instead.
    - If an LLM extraction fails, the failure is counted and the rules extractor reads the message.
13. **Apply** (§11). The state engine turns events into objects and transitions.
14. **Evaluate** (§12, §13). Rules produce intervention candidates; the policy picks at most one to post.
15. **Post:**
    - The idempotency key is deterministic: a UUIDv4-shaped hash of room, Chorus ID, candidate key and posted count.
    - The **send happens first**; the intervention is recorded only if the send succeeds.
    - In observe mode, and on standby instances (§17), Chorus records what it *would* have said without sending, so it isn't said later.
16. **Commit** (§18). In one SQLite transaction:
    - core state;
    - new messages and transitions appended;
    - the cursor;
    - audit rows;
    - pruning.

    After the commit, transitions are published to SSE subscribers, so only durable state is ever announced.

**Tick** (every `tickSeconds` = 15 s, also atomic):
- deadline expiry;
- facilitation session expiry;
- payment polling;
- roster refresh;
- time-based rules;
- the completion check, after 60 s of quiet;
- retention pruning, at most hourly.

---

## 7. Data model

The model has two layers:

- **Layer 1: LLM schemas** (`src/schemas/llm.ts`). snake_case, agent *names* as written, no IDs. The payload is a closed object with nullable fields, so it works with structured output.
- **Layer 2: domain objects** (`src/state/types.ts`). camelCase, resolved agent IDs, per-room short IDs.

### 7.1 Extracted event (Layer 1)

```ts
{
  type: "question" | "request" | "commitment" | "handoff" | "acknowledgement" | "answer" | "decision"
      | "dependency" | "status_update" | "completion" | "claim" | "disagreement" | "correction" | "withdrawal",
  confidence: number,            // 0..1
  target_agents: string[],       // names as written
  references: string[],          // short IDs (C3) or referents ("that")
  payload: {
    text, action, conditional, deadline,          // questions, requests, commitments
    subject, predicate, polarity, conditions, hedged   // claims
  }                              // unused fields are null
}
```

Batch form: `{ results: [{ index, events: [...] }] }`.

### 7.2 Domain objects (Layer 2)

| Object | ID | Statuses | Key fields |
|---|---|---|---|
| Question | `Q#` | open → acknowledged → answered / superseded / withdrawn | kind (question or request), asker, targets, answers, claimedByCommitment, duplicateOf |
| Commitment | `C#` | proposed, accepted, in_progress, blocked → completed / cancelled / expired | owner, action, optional, deadline, fromHandoff, updatedIndex (staleness) |
| Handoff | `H#` | pending → accepted / declined / completed / cancelled / expired | from, to, action, transfersCommitment, resultingCommitment |
| Claim | `K#` | active → retracted / superseded | subject, predicate, polarity, conditions, hedged, answersQuestion, contradictsDecision |
| Conflict | `X#` | candidate → confirmed → resolved / dismissed | subject, claims, confirmConfidence |
| Decision | `D#` | active → superseded / reopened | statement, subject/value (for "X is Y"), supersededBy |
| Dependency | `P#` | waiting → resolved / cancelled | blockedAgent, blockedCommitment, blockingObject, notified |

Every object also carries **provenance**: `createdAt`, `createdIndex`, `derivedFromMessageIds`, `extractorConfidence`.

Every status change is a **Transition** `{objectId, kind, from, to, cause: event|tick|command|feedback, messageId, reason, at}`. The transition log is persisted and serves as the event IDs for SSE.

### 7.3 Interventions

`InterventionCandidate` contains:
- `type`, `severity`;
- involved agents, related objects, evidence messages;
- `confidence`, `urgency`, `expectedValue`, `blockedAgents` (all feed the score);
- `idempotencyKey` and `absorbedKeys` (merging);
- `text`, `replyToMessageId`.

A `PostedIntervention` adds `postedAt`, `postedIndex`, `messageId`, `solicited` and `feedback` (correct or wrong).

There are 12 types:
- `duplicate_work`
- `unanswered_question`
- `conflict_detected`
- `completion_check`
- `missing_acknowledgement`
- `stale_commitment`
- `repeated_question`
- `decision_reminder`
- `dependency_resolved`
- `dependency_deadlock`
- `agent_brief`
- `command_reply`

---

## 8. Extraction

### 8.1 The Extractor interface (`src/extract/types.ts`)

```ts
interface Extractor {
  name: string;
  extract(text, ctx): Promise<ExtractedEvent[]>;
  extractBatch?(items): Promise<ExtractedEvent[][]>;   // §11.2
  available?(): boolean;                                // false while rate-limited
}
```

The context passed with each message includes:
- the author;
- the reply target;
- the last 10 non-Chorus messages;
- the roster;
- up to 20 open objects, with IDs, summaries and owners.

### 8.2 Rule-based extractor (`src/extract/heuristic.ts`, the default)

This is a deterministic, regex- and phrase-based extractor. It covers:
- questions and requests, targeted and untargeted;
- commitments ("I'll …", conditional offers), with deadline phrases;
- status updates and completions;
- acknowledgements, withdrawals and corrections;
- answers;
- claims, including polarity, conditions and hedging;
- decisions;
- short-ID references;
- "take over my C4" transfers.

Because its matches are lexical, the engine applies confidence bands differently when the rules extractor is in use (spec §40).

### 8.3 Why an LLM (the probe)

Twelve natural phrasings were run through both extractors:

| Message | Rules | Gemini |
|---|---|---|
| I'll check the refund policy. | commitment ✓ | commitment ✓ |
| On it — pulling the refund docs now. | acknowledgement ✗ | status_update, commitment ✓ |
| Leave pricing to me. | — ✗ | commitment ✓ |
| I've got the pricing piece. | — ✗ | status_update, claim ✗ |
| Refunds work fine in my testing. | — ✗ | claim ✓ |
| Nope, the API rejected every refund I tried. | answer (partial) | answer, claim ✓ |
| Anyone know if refunds are a thing here? | question ✓ | question ✓ |
| Bob, mind taking a look at auth? | request ✓ | request ✓ |
| Can't move on the summary until Alice's numbers land. | — ✗ | dependency ✓ |
| Let's just go with JSON. | — ✗ | decision ✓ |
| Refunds are supported. | claim ✓ | claim ✓ |
| Refunds are not supported. | claim (negative) ✓ | claim (negative) ✓ |

**Result: rules 6 of 12, Gemini 11 of 12.** Replaying the milestone fixture through Gemini produced **exactly the same interventions** as the rules. The conclusion: rules stay the default, the LLM is opt-in, and a labelled evaluation set is the right way to keep measuring.

### 8.4 Batching (§11.2)

When the backlog exceeds 5 messages, the extractor's `extractBatch` sends up to 10 messages in one call, which returns `results[index]`. Each batch call counts against the budget as one call. If a batch fails, extraction falls back to one call per message.

### 8.5 Rules-first mode (`src/extract/tiered.ts`)

With `CHORUS_RULES_FIRST=1`, the rules extractor reads every message first, and only messages it finds **nothing** in are sent to the LLM. This also works in batches: only the unresolved messages are batched.

- **Saving:** on the milestone fixture, 9 of 23 messages go to the LLM, about 60% fewer calls.
- **Cost:** messages the rules read only partly right stay that way (for example, "On it — pulling…" stays an acknowledgement).

---

## 9. LLM backends: Gemini and Claude

### 9.1 Provider-neutral layer (`src/extract/llm.ts`)

The shared layer contains:

- **Prompts:**
  - `EXTRACTION_SYSTEM`;
  - `DUPLICATE_SYSTEM`;
  - `CONFLICT_SYSTEM`;
  - `DECISION_SYSTEM`;
  - `BATCH_SUFFIX`.

  They encode the evidence rules: don't infer hidden intent, don't treat capability as commitment, don't infer completion from silence, and don't treat reported speech as a claim.
- **Prompt-injection boundary (§64):** room content is always sent as **JSON data** in the user turn, and the system prompt says to treat every string in it as content, never as instructions.
- **`LlmBackend` interface:** `generate(system, content, schema, purpose)` returns one of:
  - `parsed`;
  - `refused`;
  - `invalid`.

  It also provides `isFatal(err)` and an optional `available()`.
- **`parseWithRetry`:**
  - On invalid output, it retries **once** and tells the model what failed validation.
  - A refusal means no events.
  - Fatal errors (bad key, bad request) are rethrown.
  - A `RateLimitedError` returns immediately without retrying.
  - Every request is reported via `onCall` to the `llm_calls` log and metrics.
- **`LlmExtractor`:** `extract` and `extractBatch`. After a failed retry it throws `ExtractionFailedError(reason, rateLimited)`.
- **`LlmConfirmer`** handles stage-2 confirmation of:
  - duplicates;
  - conflicts;
  - claims that contradict a decision.

  Its verdicts are cached. While the model is rate-limited or failing, it answers with the **rule-based confirmer** and does not cache that answer.
- **`select.ts`** reads the environment and builds the extractor and confirmer on one shared backend.

### 9.2 Gemini backend (`src/extract/gemini.ts`)

**Request:**
- Plain REST: `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`, authenticated with the `x-goog-api-key` header.
- The body contains:
  - `systemInstruction` (the prompt);
  - `contents` (the JSON data);
  - `generationConfig` with:
    - `responseMimeType: "application/json"`;
    - `responseJsonSchema` (the Zod schema converted with `z.toJSONSchema`, `$schema` removed, cached per schema);
    - `maxOutputTokens: 8192`;
    - `thinkingConfig.thinkingLevel: "low"`.

**Parsing the response:**
- A `promptFeedback.blockReason`, or a `finishReason` of SAFETY, PROHIBITED_CONTENT, BLOCKLIST, SPII or RECITATION, is treated as a **refusal**.
- Text parts are joined, skipping `thought` parts. The result is JSON-parsed and **validated with the same Zod schema**; the first schema issue is fed back into the retry.
- Usage: input tokens are `promptTokenCount`; output tokens are `candidatesTokenCount + thoughtsTokenCount`. The served model comes from `modelVersion`.

**Errors:**

| Status | Handling |
|---|---|
| 400, 401, 403 | Fatal |
| 404 | Skip to the next model |
| 429, 500, 502, 503, 504, network errors, timeouts | Transient: retried with backoff and fallback (§10) |

**Models:**
- The default is `gemini-3.8-flash`, overridden by `LLM_MODEL`.
- The default fallback is `gemini-flash-lite-latest`, overridden by `GEMINI_FALLBACK_MODELS`.

**Verified live:**
- structured output conforms to the schema;
- about 1.6 s per call when the model isn't overloaded;
- `thinkingLevel: low` is accepted;
- a real 429 is parsed correctly.

### 9.3 Claude backend (`src/extract/claude.ts`)

- Uses `client.beta.messages.parse` with `betaZodOutputFormat`.
- Model `claude-opus-5`, with server-side model fallback (`fallbacks: "default"`) and `effort: "low"`.
- A `refusal` stop reason is treated as a refusal. `BadRequestError` and `AuthenticationError` are fatal.
- It is tested with a fake client only; it has not been run live.

### 9.4 Selecting a backend

| `CHORUS_EXTRACTOR` | Result |
|---|---|
| unset | `gemini` if `GEMINI_API_KEY` is set, otherwise `heuristic` |
| `heuristic` | rules only |
| `gemini` | Gemini extractor and confirmer, with rules as fallback |
| `claude` | Claude extractor and confirmer, with rules as fallback |

For replay: `npm run replay -- <fixture> --llm gemini|claude`. `--claude` still works as a shorthand.

---

## 10. Rate limiting

**Why it matters:** Gemini quotas are **per model**. The free tier is small: the key used here allows `gemini-3.8-flash` **20 requests/day**, and the Pro models 0. Gemini also answers 503 often under load.

### 10.1 Client-side limiter (`src/extract/ratelimit.ts`)

`RateLimiter` keeps per-model state:
- request times in a 60 s sliding window (RPM);
- `[time, input tokens]` pairs in a 60 s window (TPM, input tokens, the way Google counts them);
- a daily count keyed by the **Pacific-time date**, because Gemini's daily quota resets at midnight Pacific (RPD);
- `coolUntil`, a cooldown deadline.

Its API:
- `wait(model, tokens)` returns the milliseconds until a request would fit (0 means now). A spent RPD waits until the next Pacific midnight. A request larger than the whole TPM budget is allowed on an empty window.
- `take(model, estimate)` returns `{settle(actual), refund()}`:
  - `settle` replaces the estimate with Google's `promptTokenCount`;
  - `refund` removes a request Google **rejected without serving** (429 or 5xx), since it used no quota.
- `cooldown(model, ms)`.
- `merge(alias, model)` folds counts made under an alias into the real model.

### 10.2 The Gemini request loop

For each request:

1. Estimate input tokens as `(system + content length) / 4`.
2. Pick the first model, in preference order, that can go **now**. If none can, pick the one with the shortest wait.
3. If the shortest wait is longer than `maxWaitMs` (15 s by default), **fail fast** with `RateLimitedError`, without sending anything.
4. Otherwise, sleep for the wait, take a slot and send.
5. On a result:

   | Outcome | Handling |
   |---|---|
   | Success | Settle the actual token count; learn the alias from `modelVersion` |
   | **429** | Refund the slot; learn the alias from the error's `quotaDimensions.model`. Cool down for Google's `RetryInfo.retryDelay` (default 60 s). If the quota ID contains `PerDay`, cool down **until midnight Pacific**. After 2 × 429 in one request, give up on that model |
   | **5xx or network error** | Refund the slot; cool down for exponential backoff (1 s, 2 s, …). After `retries` (2), give up on that model |
   | **404** | Give up on that model at once |

   Because backoff is a cooldown, the loop moves straight to a fallback model while the primary cools down.

**Aliases:** `gemini-flash-latest` is served by `gemini-3.8-flash` and shares its quota. The backend learns this mapping and counts both names against one quota.

### 10.3 Pipeline behaviour under limits

- `chooseExtractor` checks `extractor.available()`. While every model is limited beyond `maxWaitMs`, messages go straight to the rules, with **no API call**, and `llm_rate_limited` is incremented.
- A rate-limited or failed extraction falls back to the rules for that message and increments `llm_rate_limited` or `extraction_failures`.
- The confirmer uses the rule-based confirmer while limited, without caching that verdict.
- While a message waits (up to 15 s) for quota, the backlog builds up and is then **batch-extracted**, up to 10 messages per call.
- Separately, a coarse per-room budget (`llm.maxCallsPerMinute` = 60) also falls back to the rules (`llm_budget_fallbacks`).

### 10.4 Verified behaviour

- A live replay capped at 3 requests/min posted the same interventions as the rules-only run, with no errors, in under 3 seconds.
- The real 429 (daily quota spent) was parsed correctly: the model was set aside and the fallback model was used.
- Tests cover:
  - pacing (a wait of 60,000 ms);
  - failing fast with no request;
  - honouring a 43 s retry delay while the fallback is used;
  - the daily quota, with blocking until exactly midnight Pacific;
  - alias sharing;
  - refunds;
  - token-window waits;
  - the confirmer fallback without caching.

---

## 11. State engine

`src/state/engine.ts` is the only code that mutates domain objects.

- **Confidence bands (§40):** auto-apply at ≥ 0.9; apply with corroboration at ≥ 0.75; ≥ 0.55 is a candidate only.
- **Agent resolution:** a name matches on exact ID, display name or alias, then on a *unique* prefix. An ambiguous prefix resolves to nothing.
- **Questions:**
  - A question is answered by an answer whose relevance to it is at least 0.8, by a reply, or by a claim.
  - It is acknowledged by an acknowledgement, and claimed by a commitment.
  - A new question that repeats an already-answered one gets `duplicateOf`, which feeds the repeated-question rule.
- **Commitments:** created from commitment events (conditional ones are "optional"). They are updated by status, completion and withdrawal events, and the staleness clock (`updatedIndex`, `updatedAt`) is refreshed on every touch.
- **Handoffs:**
  - A targeted request, or an explicit transfer ("B, take over my C4"), creates a handoff.
  - When the target acknowledges, the handoff is accepted and a linked commitment is created.
  - A transfer cancels the sender's commitment with the reason "transferred".
  - A "Got it" that replies to some *other* message does not accept an unrelated handoff.
- **Claims and conflicts:**
  - A claim with the same subject (similarity ≥ 0.85), opposite polarity and overlapping conditions is a conflict candidate.
  - Stage-2 confirmation (confidence ≥ 0.9) confirms it.
  - Different, non-empty conditions are disjoint, so "supported within 24 h" and "not supported after 30 days" is not a conflict.
- **Decisions:** statements of the form "X is Y" get a subject and value. A new decision on the same subject supersedes the old one. A claim that contradicts an active decision sets `contradictsDecisionId`.
- **Dependencies:**
  - "Blocked on C3" or "waiting for B's pricing" finds the blocker by short ID, by the named agent's latest item, or by text similarity.
  - The dependency resolves when the blocker finishes; if it was already finished, it resolves on creation.
- **Deadlines** (`src/deadline.ts`): parses "by 14:30", "in 10 minutes", "at 3pm" and similar, preferring a later clear deadline over an ambiguous "at 3". A commitment or handoff expires only via its deadline, on a tick.
- **`settle()`:** syncs handoffs and resolves dependencies after events, commands and ticks.

---

## 12. Coordination rules

`src/rules/rules.ts` holds the rules. They are pure functions that read state and return candidates.

| Rule | Fires when | Idempotency key |
|---|---|---|
| **Duplicate work** (§18) | Two agents' live, non-optional commitments are lexically similar (≥ 0.75) and stage 2 confirms (≥ 0.85). The message suggests an unclaimed open item for the later agent | `duplicate_work:C1:C2` |
| **Unanswered question** (§19) | ≥ 12 later messages **or** ≥ 300 s have passed, with a floor of 30 s, and the question is not answered, claimed or ignored. Resurfaces after a 20-message cooldown | `unanswered_question:Q:lastSurfaced` |
| **Missing acknowledgement** | The handoff target has posted ≥ 3 messages without acknowledging it | `missing_acknowledgement:H:…` |
| **Stale commitment** (§21) | Staleness score ≥ 0.7, computed from age (reference 600 s) and room activity (reference 30 messages) since the owner last touched it | `stale_commitment:C:…` |
| **Conflict** (§22) | A confirmed conflict | `conflict_detected:X:claimCount` |
| **Repeated question** (§23) | A question duplicates one that was already answered. Chorus points to the earlier answer | `repeated_question:Q` |
| **Decision reminder** (§23.1) | A claim contradicts an active decision | `decision_reminder:D:K` |
| **Dependency resolved** | The blocker is finished and the waiting agent hasn't been told | `dependency_resolved:P` |
| **Dependency deadlock** | A cycle in the "waits on" graph between agents | `dependency_deadlock:<cycle>` |
| **Completion check** (§25) | Tick only, after 60 s of quiet: no open questions, required commitments, pending handoffs, confirmed conflicts or waiting dependencies. Posts READY TO CLOSE once | `completion_check:ready` |
| **Agent brief** (§78) | An agent returns after a long absence | per agent and message |

**Blocked-agent naming:** candidates name the agents waiting on the object, and each blocked agent raises the severity.

**Incremental evaluation:**
- `DuplicateCache` compares each commitment against the others only once, when it becomes eligible, so the per-message cost is linear.
- `handled(key)` skips building candidates whose key is already posted, absorbed or suppressed.

---

## 13. Intervention policy

`src/policy.ts` decides which candidate, if any, gets posted.

1. **Hard dedup:** a key that has already been posted, or absorbed into another intervention, is dropped.
2. **Feedback suppression:** `@chorus wrong` suppresses the key *and its family*. For recurring nudges the family is `type:object`, so `unanswered_question:Q1:14` is covered by a suppression of `unanswered_question:Q1`.
3. **Mode filter:**
   - **observe:** nothing unsolicited.
   - **assist:** only `conflict_detected`, `repeated_question`, `dependency_resolved` and `dependency_deadlock`, with confidence ≥ 0.9.
   - **facilitate:** everything.
4. **Queue TTL:** a candidate still waiting 16 messages after it was first seen is dropped.
5. **Score:**

   ```
   score = 0.3·severity(low .2 / med .5 / high 1) + 0.2·urgency + 0.2·confidence
         + 0.15·expectedValue + 0.15·min(blockedAgents/3, 1) − 0.05·(unsolicited Chorus msgs in last 10)
   ```

   The minimum is 0.55. Command replies don't count toward the noise penalty.
6. **Rate limits:**
   - at most 3 unsolicited messages per 5 minutes;
   - at least 8 room messages between unsolicited posts, except for high-severity ones.
7. **Merging (§51):** the top candidate absorbs lower-ranked candidates that share related objects. The result is one message joining their texts, taking the union of agents, objects and evidence, and the maximum blocked count. Absorbed keys count as posted.

---

## 14. Commands

Commands live in `src/commands.ts`. They are deterministic, with no LLM, and their replies are solicited and exempt from rate limits.

| Command | Effect |
|---|---|
| `@chorus status` | Room summary: active agents, open questions, in-progress work, handoffs, waiting agents, decisions, conflicts, highest priority |
| `open` · `commitments` · `conflicts` · `decisions` | Lists of what Chorus is tracking |
| `what-am-i-waiting-on` · `brief` | The caller's dependencies, handoffs and questions, and what changed since they last spoke |
| `close-check` | READY TO CLOSE, or what is still open |
| `health` · `map` · `threads` · `metrics` | Insights (§16) and metrics (§21) |
| `mode observe\|assist\|facilitate` | Change the mode |
| `watch [min]` · `facilitate` · `stop` | Facilitation sessions (§15). Watch defaults to 10 minutes, maximum 120 |
| `receipt` · `replay` | A signed snapshot of open obligations; a signed post-room analysis |
| `resolved <id>` · `ignore <id>` · `reopen <D…>` | Change an object's state |
| `wrong [id]` · `correct [id]` | Feedback on an intervention |

**Permission checks (§60):** only agents involved in an object or intervention can resolve, ignore, or mark it wrong or correct. Unauthorized attempts are refused, and the refusal is tested.

---

## 15. Operations, payments and receipts

### 15.1 Operations (`src/operations.ts`)

| Operation | What it does | Receipt |
|---|---|---|
| `chorus.watch` | Time-boxed facilitate mode; the previous mode is restored at the end | Session receipt at the end |
| `chorus.facilitate` | Facilitate mode until `stop` | Session receipt at the end |
| `chorus.replay` | Post-room analysis: what Chorus surfaced and what got resolved | Signed analysis |
| `receipt` | Snapshot of open obligations and whether coordination is complete | Signed snapshot |

A mode change during a watch still issues the session receipt at the end (regression-tested).

### 15.2 Paid operations (§43)

These are off by default and turned on with `CHORUS_REQUIRE_PAYMENT=1`.

| Operation | Price (SharedNet credits) |
|---|---|
| `watch` | 2 per started 10 minutes |
| `facilitate` | 5 |
| `replay` | 3 |

The flow:

1. A priced command creates an **order**, `ord_…`. Its ID is deterministic from the requesting message. The order expires after 15 minutes.
2. Chorus replies with the price and how to pay: `npx -y sharednet@latest pay <chorus-instance> <n> --memo chorus:ord_… --room`.
3. On each tick, Chorus polls `GET /credits/transfers` for transfers to its own principal.
4. A transfer counts only if:
   - its memo is `chorus:<order>`;
   - its amount covers the price;
   - it was made after the order;
   - it hasn't been used before.

   A matching transfer starts the operation, and the receipt cites the transfer.
5. Underpayment, a wrong memo, reusing a transfer and a stale transfer are all rejected (tested).

Free commands never ask for payment, and there are no refunds.

### 15.3 Signed receipts (`src/receipts.ts`, §54)

- **Signing:**
  1. The body is canonicalized with **RFC 8785 JCS**.
  2. The result is hashed with **SHA-256**.
  3. The digest is signed with **Ed25519**.
- **Record:** `{body, sha256 (hex), signature (base64url), key_id}`.
- **Key:**
  - Taken from `RECEIPT_SIGNING_KEY` (PKCS#8 PEM) if set; otherwise generated once into `.chorus/receipt-key.pem`.
  - The key ID is derived from the public key unless `RECEIPT_KEY_ID` is set.
- **Verification:** the public key is served **without authentication** at `GET /v1/keys/:id`, so anyone holding a receipt can verify it.

---

## 16. Insights (stretch features)

`src/insights.ts` provides:

- **Agent brief:** what changed since an agent's last message. It covers:
  - new items addressed to them;
  - answers to their questions;
  - handoffs to them;
  - resolved dependencies;
  - new decisions and conflicts.

  It is sent automatically on return (after 30 or more messages, or 15 or more minutes, away) or on `@chorus brief`.
- **Health:** a count per dimension:
  - open obligations (questions, required commitments, pending handoffs);
  - active duplicate-work pairs;
  - confirmed unresolved conflicts;
  - waiting and stalled dependencies (stalled after 20 messages);
  - unanswered questions that were surfaced and are still open, with the oldest one's age;
  - blocked commitments.
- **Interaction map:** who addresses, answers and hands off to whom, as weighted edges.
- **Topic threads:** groups of objects that share content words or explicit links (answers, claims, handoffs, conflicts). Cheap and explainable, with no clustering model.

---

## 17. Multi-instance election

This is opt-in, with `CHORUS_ELECTION=1`.

- On start, each instance posts `[chorus] online as <id>`.
- Every instance keeps full state, but only the **lowest online instance ID speaks**. The others record what they would have said and stay silent.
- Presence comes from the SharedNet roster. When presence is unknown, a peer counts as online if it was seen in the last 30 minutes.
- When the speaker goes offline, the next-lowest instance takes over.

---

## 18. Persistence

`src/store.ts`: SQLite via `node:sqlite`, in WAL mode.

| Table | Contents |
|---|---|
| `rooms` | `room_id`, `last_processed_seq` (the resume cursor), `state_json` (the **core** snapshot: objects, counters, interventions, orders, receipts, peers), `updated_at` |
| `state_messages` | Append-only room messages, one JSON row per `(room_id, idx)` |
| `state_transitions` | Append-only transition log (also the SSE event IDs) |
| `messages` | Audit: every external message with its `processing_state` (applied, command, skipped, own, extraction_failed) |
| `interventions` | Audit: every posted intervention, keyed by idempotency key |
| `receipts` | Every signed receipt, keyed by SHA-256 |
| `llm_calls` | Every LLM request: purpose, model, raw response, parsed_ok, tokens, latency |

- **Incremental commits:** the core JSON is rewritten each time, but messages and transitions are only *appended*, so write cost doesn't grow with room size.
- **Migration:** a room saved in the old format, as one full snapshot, is migrated on its first commit.
- **Retention (§65):** message text older than 7 days is blanked, in memory and in storage, within the commit. The message stubs (ID, sequence, author) stay, so citations like `#12` still resolve.
- **Resume:**
  - On restart, Chorus resumes from `last_processed_seq`.
  - On a first run it starts after the room's latest message, so history is not re-announced.
  - `--after N` overrides both.

---

## 19. HTTP API and event stream

The API is served on `CHORUS_API_PORT`. Every route except `/v1/keys/:id` and `/healthz` needs `Authorization: Bearer $CHORUS_API_TOKEN`; if the token is unset, one is generated and printed at startup.

| Route | Returns |
|---|---|
| `GET /v1/rooms/:room/state` | Counts of open items; `coordination_complete` |
| `GET /v1/rooms/:room/open-items` | Every open item, with age and source message |
| `GET /v1/rooms/:room/decisions` | Current and superseded decisions |
| `GET /v1/rooms/:room/agents/:agent/context` | One agent's commitments, handoffs, dependencies, questions, and what changed since they were last active |
| `GET /v1/rooms/:room/objects/:id/history` | An object, its full transition log and its source messages |
| `GET /v1/rooms/:room/metrics` · `health` · `interactions` · `threads` · `receipts` | Metrics and insights |
| `GET /v1/rooms/:room/events` | **Server-Sent Events**: `question.opened`, `commitment.completed`, `conflict.detected`, `dependency.resolved`, `room.ready_to_close`, … |
| `GET /v1/keys/:id` | Receipt public key (no authentication) |
| `GET /healthz` | Liveness |

**SSE resume:** each event's `id` is its index in the persisted transition log, so a client resumes with `Last-Event-ID` or `?after=N`, even across Chorus restarts. Events are published only after they are committed.

---

## 20. Transports

The interface is `src/transport/types.ts`, with one transport per room:
- `connect`;
- `onMessage` (the handler's promise controls the cursor);
- `sendMessage` (with an idempotency key);
- `roster` (with presence);
- `selfId`;
- `close`;
- optional `payments` (`transfersSince`, `howToPay`).

**SharedNet** (`src/transport/sharednet.ts`):
- A long-poll wait loop.
- Whole pages are delivered to the room at once (`Promise.all`), so a backlog can be batched.
- Posts carry an `Idempotency-Key`.
- The roster comes from the room's memberships, with presence.
- Transfers are read from `GET /credits/transfers`.
- Fetch calls honour abort signals, so shutdown doesn't hang.

**Replay** (`src/transport/replay.ts`): an in-memory transport with a virtual clock (`src/clock.ts`) for fixtures and tests. `npm run replay` prints a state timeline and the room log.

---

## 21. Metrics and observability

`src/metrics.ts` is served by `@chorus metrics` and `/metrics`. It reports:

- **Headline:** **`useful_ratio`**, followed ÷ (followed + ignored).
  - An intervention is **useful** if, within 10 room messages, an involved agent acts on an object it cited (answers, acknowledges, resolves, or re-scopes into new work after a duplicate-work notice), or says `@chorus correct`.
  - It is **not useful** after `@chorus wrong`, or if the window passes with no action.
  - `dependency_resolved` and `completion_check` notices count as useful unless marked wrong.
- **Counts:**
  - messages processed;
  - questions detected and resolved;
  - commitments created, completed and expired;
  - duplicates detected and confirmed;
  - claims;
  - conflicts detected and resolved;
  - handoffs, dependencies and decisions.
- **Interventions:**
  - posted, by type;
  - suppressed;
  - followed, ignored and pending;
  - command replies;
  - false-positive feedback.
- **LLM:**
  - `llm_calls`, input and output tokens;
  - `extraction_failures`;
  - `llm_budget_fallbacks`, `llm_rate_limited`;
  - `extraction_batches`, `extraction_backlog_max`.

**Logs:**
- The live CLI logs each pipeline event: message, events, state, posted, command, error.
- Every LLM request is written to `llm_calls` with its raw response.

---

## 22. Configuration reference

### 22.1 Environment variables (`src/cli/live.ts`, `src/extract/select.ts`)

| Variable | Default | Purpose |
|---|---|---|
| `SHAREDNET_BASE_URL` | `https://www.sharednet.ai` | API base URL |
| `SHAREDNET_ROOM` / `SHAREDNET_TOKEN` | — | Room ID and seat token… |
| `SHAREDNET_SEAT_FILE` | — | …or a seat file written by `sharednet join` |
| `CHORUS_MODE` | `assist` | observe, assist or facilitate |
| `CHORUS_EXTRACTOR` | gemini if a key is set, otherwise heuristic | heuristic, gemini or claude |
| `GEMINI_API_KEY` | — | Google AI Studio key |
| `LLM_MODEL` | `gemini-3.8-flash` / `claude-opus-5` | Model |
| `GEMINI_FALLBACK_MODELS` | `gemini-flash-lite-latest` | Comma-separated; empty disables |
| `GEMINI_RPM` / `GEMINI_TPM` / `GEMINI_RPD` | 5 / 250000 / none | Per-model quota |
| `GEMINI_MAX_WAIT_MS` | 15000 | Longest wait for quota before the rules take over |
| `CHORUS_RULES_FIRST` | off | `1`: the LLM only for messages the rules can't read |
| `CHORUS_DB` | `.chorus/chorus.db` | SQLite file |
| `CHORUS_API_PORT` / `CHORUS_API_TOKEN` | off / generated | HTTP API |
| `RECEIPT_SIGNING_KEY` / `RECEIPT_KEY_ID` | generated / derived | Receipt key |
| `CHORUS_REQUIRE_PAYMENT` | off | `1`: charge credits for operations |
| `CHORUS_ELECTION` | off | `1`: multi-instance election |

### 22.2 Tunables (`src/config.ts`)

| Group | Values |
|---|---|
| thresholds | autoApply 0.9, corroborated 0.75, candidate 0.55, answerRelevance 0.8, duplicateCandidate 0.75, duplicateConfirm 0.85, conflictSubject 0.85, conflictConfidence 0.9, stale 0.7 |
| interventions | minScore 0.55, maxPer5Minutes 3, minRoomMessagesBetween 8, queueTtlMessages 16, cooldownMessages 20 |
| unanswered | minSubsequentMessages 12, maxWaitSeconds 300, minSeconds 30, resurfaceCooldown 20 |
| handoff | minTargetMessages 3, resurfaceCooldown 20 |
| stale | ageRefSeconds 600, roomRefMessages 30, resurfaceCooldown 30 |
| extraction | recentWindow 10, batchWhenBacklogOver 5, maxBatch 10 |
| operations | prices watch 2 / facilitate 5 / replay 3, orderTtlMinutes 15 |
| llm | maxCallsPerMinute 60 |
| retention | 7 days |
| brief | minAbsentMessages 30, minAbsentMinutes 15 |
| tick | 15 s |

---

## 23. Performance

**The problem:** the first build did work proportional to room size on every message:
- rescanning all messages;
- comparing every pair of commitments;
- rewriting the full snapshot.

**The fixes:**
- a message index (by ID, and per-agent sorted room indexes with binary-search counts);
- memoized content tokens (up to 20,000 entries);
- the incremental duplicate cache;
- skipping candidates whose keys are already handled;
- append-only persistence.

**Benchmark** (`npm run bench`): a synthetic 4,000-message room with about 3,000 open objects, three agents, SQLite, the rules extractor and facilitate mode.

| Stage of the room | Cost per message |
|---|---|
| Start | ~3 ms |
| End (4,000 messages) | ~20 ms |

The per-message cost now grows only with the number of *objects*, not messages.

**LLM latency:** Gemini takes 1–2 s per message when it isn't overloaded; under 503 load it can reach about 8 s with retries.

---

## 24. Testing

There are 143 tests in 40 suites (`npm test`, `node:test` + `tsx`), plus `tsc --noEmit`. CI runs both on every push (`.github/workflows/ci.yml`).

| Suite | Covers |
|---|---|
| `acceptance` | The spec §77 hackathon tests: duplicate vs. different work; unanswered question in busy, quiet and Chorus-only rooms; answered question; conflict vs. context-specific non-conflict; redelivery and restart; unauthorized feedback |
| `extract` | The rules extractor |
| `handoff` · `deadlines` · `decisions` | State machines: acknowledgements, transfers, expiry, supersession, dependencies |
| `merge` | Intervention merging, blocked-agent naming, deadlocks |
| `persistence` · `incremental` | SQLite round-trip, resume, append-only logs, legacy migration, retention in storage |
| `api` | Routes, authentication, SSE, `Last-Event-ID` resume |
| `operations` · `payments` | Sessions, receipts (sign and verify), orders, transfer matching, expiry; LLM extractor retries, refusal handling and fallback |
| `batch` | Batch extraction under backlog |
| `insights` · `election` | Brief, health, map, threads; speaker election and takeover |
| `gemini` | Request format, backoff, fallback, 404 skip, fatal errors, safety refusal, schema retry, thought parts, confirmer cache, rate limiter (RPM, TPM, RPD, refunds, midnight Pacific), 429 retry delay, daily quota, aliases, fail-fast, rules-first |
| `regressions` | One test per code-review fix (below) |

**Fixes from the code review** (each has a regression test):
- A failed send rolls back and is retried on redelivery, without losing the intervention.
- Agent names containing regex characters are matched literally.
- Ordinary "I'm …" sentences are not learned as names.
- A later, clear deadline wins over an ambiguous "at 3".
- `@chorus resolved` releases agents waiting on that commitment.
- A low-confidence answer marker does not close a question.
- A "Got it" replying to another message does not accept an unrelated handoff.
- A dependency released by an expired deadline says so.
- `@chorus wrong` on a reminder also suppresses its later resurfacings.
- A mode change during a watch still issues the session receipt.
- A whole page is delivered at once, so a backlog can be batched.

Other bugs found and fixed along the way:
- Command replies were counted in the noise penalty.
- Single-digit numbers were dropped from similarity, so "item 5" and "item 7" looked the same.
- Test fetch mocks ignored abort signals.
- A test had a message-ID collision.

---

## 25. Deployment

```bash
npm install
npm test
npm run replay -- tests/fixtures/milestone.json               # rules
GEMINI_API_KEY=… npm run replay -- tests/fixtures/milestone.json --llm gemini
SHAREDNET_SEAT_FILE=~/.config/sharednet/rooms/<room>/<member>.json \
  CHORUS_MODE=assist CHORUS_API_PORT=8787 GEMINI_API_KEY=… npm start
```

**Docker:**

```bash
docker build -t chorus .
docker run -v chorus-data:/data -p 8787:8787 \
  -e SHAREDNET_ROOM=rom_… -e SHAREDNET_TOKEN=sni_… \
  -e CHORUS_API_PORT=8787 -e CHORUS_API_TOKEN=… -e GEMINI_API_KEY=… chorus
```

State and the receipt key live in the `/data` volume.

Talk to Chorus from a *different* seat than its own: messages from Chorus's own seat are ignored.

---

## 26. Security

- **Secrets:**
  - API keys, seat tokens and invite and claim codes are never committed.
  - `.gitignore` covers `.env`, `.chorus/` and `.sharednet/`.
  - Keys come only from the environment.
  - **Rotate the Gemini key that was pasted into chat.**
- **Prompt injection (§64):** room text is sent to the LLM only as JSON data, under a system prompt that says so. LLM output is schema-validated, and only the deterministic engine changes state.
- **Authorization:** feedback and state-changing commands are permission-checked. The HTTP API requires a bearer token.
- **Integrity:** receipts are signed (Ed25519 over JCS + SHA-256) and publicly verifiable.
- **Payments:** transfers must match the memo, amount and timing, and each transfer is used once.

---

## 27. Deviations from the product spec

The full list is in `docs/chorus-spec.md` §84. The main ones:

| Spec | As built | Why |
|---|---|---|
| §8 monorepo | One package; `src/` folders follow the module boundaries | Hackathon profile |
| §7 Fastify | `node:http` | No dependency needed |
| §33 normalized tables | Core JSON plus append-only logs plus audit tables | Crash-safe and incremental |
| §35 outbox `sending` state | Record after a successful send, with deterministic keys | SharedNet replays repeated keys |
| §18/§22 embeddings | Lexical overlap (stage 1) plus LLM confirmation (stage 2) | Cheap and deterministic |
| §12 LLM extraction | Rules by default; Gemini or Claude opt-in through a provider-neutral layer | Reproducible without credentials; the operator picks the provider |
| §63 over budget | Fall back to the rules; Gemini paced by a per-model limiter; 429 cooldowns | Free-tier quotas can be 20 requests/day |
| §48 extraction_failed | Counted, then read by the rules | Don't leave messages untracked |
| §71 assist mode | Also allows `dependency_deadlock` | High confidence and high value |
| §78 election | Opt-in presence announcement; lowest online ID speaks | No metadata channel between instances |
| §35 edits and deletes | Not handled | SharedNet doesn't deliver them |

---

## 28. Known limitations and next steps

**Current limitations:**
- **LLM quota:** on the free tier, `gemini-3.8-flash` allows 20 requests/day. Use `CHORUS_RULES_FIRST=1`, a paid tier, or rely on the fallback model and the rules.
- **Claude backend:** covered by tests with a fake client; not run live.
- **Stage-1 similarity is lexical,** not embeddings.
- **Paid flow:** tested against a mocked API. A live test needs a payer on a different SharedNet account, because transfers to yourself are refused. There are no refunds.
- **Scale:** domain objects live in a core JSON snapshot. Rooms far beyond about 4,000 messages or 3,000 objects would need objects in their own tables.
- **Edits and deletes** are not handled.

**Suggested next steps:**
1. Build a labelled extraction evaluation set to compare rules, rules-first and full LLM, and track `useful_ratio` in real rooms.
2. Learn per-model limits from the numbers in Google's 429 messages instead of relying on configured values.
3. Add embeddings for stage-1 similarity, if a provider is available.
4. Move objects into normalized tables for very large rooms.
5. Test the paid flow live with two accounts.

---

## 29. Source map

| Area | Files |
|---|---|
| Pipeline | `src/chorus.ts` |
| Schemas | `src/schemas/llm.ts`, `src/state/types.ts` |
| State | `src/state/room.ts`, `src/state/engine.ts`, `src/deadline.ts`, `src/similarity.ts` |
| Extraction | `src/extract/heuristic.ts`, `src/extract/llm.ts`, `src/extract/gemini.ts`, `src/extract/claude.ts`, `src/extract/ratelimit.ts`, `src/extract/tiered.ts`, `src/extract/select.ts`, `src/extract/types.ts` |
| Confirmation | `src/confirm.ts` (rule-based), `src/extract/llm.ts` (LLM) |
| Rules and policy | `src/rules/rules.ts`, `src/policy.ts` |
| Commands and operations | `src/commands.ts`, `src/operations.ts`, `src/receipts.ts` |
| Insights and metrics | `src/insights.ts`, `src/metrics.ts` |
| Persistence | `src/store.ts` |
| API | `src/api/server.ts`, `src/api/views.ts` |
| Transports | `src/transport/types.ts`, `src/transport/sharednet.ts`, `src/transport/replay.ts`, `src/clock.ts` |
| Entry points | `src/cli/live.ts`, `src/cli/replay.ts`, `src/replay.ts`, `scripts/bench.ts` |
| Tests | `tests/*.test.ts`, `tests/fixtures/milestone.json` |
| Operations tooling | `Dockerfile`, `.dockerignore`, `.github/workflows/ci.yml` |
| Docs | `README.md`, `docs/chorus-spec.md` (product spec, revision 2, §34.1, §84), this document |
