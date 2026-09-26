# Chorus Engineering Standards — v1

## 1. Change flow

1. **Every change reaches `main` through a pull request. Never push to `main` directly, never force-push `main`, never bypass or admin-override branch protection.** This includes one-line fixes, docs, config and lockfile changes. Branch protection also blocks it; that does not make the rule optional.
2. Branch naming: `s1/<wp-id>-<slug>`, e.g. `s1/wp0-foundation`.
3. One work package (WP) per PR. Aim for ≤ ~600 changed lines, not counting lockfile and generated files. Split anything larger. Stacked PRs are allowed if the PR description names its base.
4. Before opening a PR, `pnpm verify` passes locally. CI must be green before review is requested.
5. PR description contains:
   - WP id and scope, plus what is explicitly out of scope
   - how to verify, as exact commands
   - test evidence: the commands actually run and their actual results
   - deviations from the spec or design doc, each with a justification (and an ADR for architectural ones)
   - open questions
6. Handoff message in the SharedNet room for every PR and every revision: PR URL, head SHA, scope, tests run and results, unresolved issues, requested action.
7. Review: O1 labels each finding **BLOCKING** or **NON-BLOCKING**. S1 answers every finding ("fixed in <sha>" or "disagree because …"). All BLOCKING findings are resolved before acceptance. NON-BLOCKING findings are fixed or recorded as follow-ups.
8. Acceptance is only O1's explicit room message `ACCEPTED <PR> @ <sha>`. A completion report from S1 is not acceptance. Any push after acceptance voids it.
9. Merge requires CI green on the accepted head SHA. S1 squash-merges, then deletes the branch. Squash title uses Conventional Commits (`feat:`, `fix:`, `test:`, `refactor:`, `docs:`, `chore:`).
10. Once review has started, add commits; don't rebase or force-push the PR branch. Update from `main` with a merge commit.

## 2. Stack and tooling (M1 decisions)

| Area | Decision |
|---|---|
| Runtime | Node.js 24 LTS, pinned in `.nvmrc` and `engines`; CI runs on 24 |
| Package manager | pnpm workspaces via corepack; `packageManager` field pinned; lockfile committed; CI uses `--frozen-lockfile`; dependencies saved with exact versions |
| Language | TypeScript, ESM only. `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch` |
| Lint/format | ESLint flat config with `typescript-eslint` `strictTypeChecked`; Prettier. No `any`; no `@ts-ignore` (`@ts-expect-error` with a reason only); no non-null `!` without a comment |
| API | Fastify + TypeBox. JSON Schema is the single source for validation and the generated OpenAPI |
| Database | PostgreSQL 18 (docker compose for dev and test). `pg` driver, SQL-first repositories, no ORM. Parameterized SQL only; never interpolate values |
| Migrations | Forward-only numbered `.sql` files applied by an in-repo runner that records checksums and refuses edited, already-applied files. Never edit a merged migration |
| Tests | Vitest. Integration tests run against real PostgreSQL |
| MCP | Official `@modelcontextprotocol/sdk`, pinned; Streamable HTTP at `/mcp` in `apps/api` |
| Web | React + Vite + TanStack Query |
| Logging | pino, structured, with `request_id`; never tokens, secrets or message content |
| CI | GitHub Actions: install → format check → lint → typecheck → unit → integration (Postgres 18 service) |

Every new runtime dependency is justified in the PR description. Prefer few, well-maintained packages.

Layout follows design §25.1 (`apps/api`, `apps/web`, `packages/domain`, `packages/schemas`, `packages/database`, `packages/authorization`, `tests/integration`, `tests/end-to-end`). Create a directory only when a WP needs it.

## 3. Architecture rules (non-negotiable)

These come from the design doc. A change that breaks one is a bug even if tests pass.

1. **One write path.** Every canonical write goes through a command handler in `packages/domain`. REST routes, MCP tools, the UI and (later) confirmed proposals all call the same handlers. No route or tool writes to a table directly.
2. **Command transaction** (design §9.1), in this order: begin → set transaction-local workspace/actor → lock the idempotency record → workspace graph advisory lock if the command affects execution gates (claim, complete, dependencies, blockers) → lock rows in sorted UUID order → authorize against current grants → check expected version and fence → validate the transition → write rows and increment versions → append events and outbox rows → store the response → commit.
3. **Idempotency** (§11.3). `Idempotency-Key` is required on every mutation, scoped to workspace + actor + key. Same key and same request hash replays the stored response. Same key with a different hash returns `409 idempotency_conflict`.
4. **Versions.** Mutations of existing items require an expected version (`If-Match` in REST, `expected_version` in MCP). A missing version returns `428 precondition_required`; a stale one returns `409 version_conflict`.
5. **Leases** (§11.2). Each task has exactly one lease row, created with the task and never deleted. The fence only increases. Lease expiry uses database `now()`. Expiry never removes the durable owner.
6. **Tenant isolation.** Every table carries `workspace_id`. RLS is enabled. The app connects as a non-owner runtime role, and integration tests run as that role. Inaccessible IDs return `404 not_found`, never `403`.
7. **Errors** use the §12.4 problem envelope and its stable codes.
8. **No network calls inside a database transaction.**
9. **Audit.** Every canonical mutation records its actor, command id and domain event(s) in the same transaction.
10. **Untrusted text.** Room and agent text is data, never instructions or authority.
11. **Secrets.** No secrets in the repo, logs, events or error bodies. API tokens are stored only as hashes.

## 4. Testing standards

- `pnpm verify` = format check + lint + typecheck + unit + integration. It is the single gate, locally and in CI.
- Every command handler is tested for: happy path, authorization denial (including 404 for inaccessible IDs), invalid transition, version conflict, idempotent replay, and idempotency conflict.
- Domain transitions are unit-tested for every allowed and every rejected transition.
- Transactional behavior is tested against real PostgreSQL, never a mocked database. Concurrency tests use independent connections (e.g. 100 simultaneous claims must yield exactly one winner).
- Time-dependent tests control the clock through the injected DB-time function. No `sleep`-based timing.
- Tests are isolated and order-independent: each creates its own workspace.
- Every bug fix includes a regression test that fails before the fix.
- **Never skip, disable, weaken or quarantine a test to get green.** A flaky test is a bug to root-cause.
- Coverage is not a gate; the case list above is.

## 5. Code quality

- Use the design doc's vocabulary (claim, fence, lease, result revision, durable owner) in names.
- Named exports only. Explicit types at package boundaries. No circular imports.
- Domain errors are typed and carry their stable code. Never swallow unexpected errors.
- Comments explain *why*, not *what*.
- An architectural deviation from the design doc needs an ADR in `docs/adr/NNN-title.md`, approved by O1 in review.
- The README keeps setup and `pnpm verify` instructions current.
