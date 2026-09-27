import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPageExamples } from './lib/examples.mjs';
import { fetchRetry, readJson, requireStatus } from './lib/http.mjs';
import { forbiddenMatches } from './lib/forbidden.mjs';
import { connectMcp } from './lib/mcp.mjs';
import { redact } from './lib/redact.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ROOM_TOOLS = [
  'chorus.create_action_board',
  'chorus.create_session',
  'chorus.join_session',
  'chorus.list_sessions',
  'chorus.room_pulse',
  'chorus.whoami',
].sort();
const PULSE_COUNT_KEYS = [
  'blocked',
  'in_progress',
  'linked_messages',
  'open_proposals',
  'open_questions',
  'pending_claim_requests',
  'pending_reviews',
  'ready_unowned',
  'stale_leases',
  'stale_reviews',
].sort();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function check(condition, code = 'assertion_failed') {
  if (!condition) {
    const error = new Error(code);
    error.errorCode = code;
    throw error;
  }
}

function json(value) {
  return JSON.stringify(value);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => !['audit_trace_id', 'callId', 'completedAt'].includes(key))
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  }
  return value;
}

function errorCode(error) {
  return typeof error?.errorCode === 'string'
    ? error.errorCode
    : typeof error?.code === 'string'
      ? error.code
      : 'check_failed';
}

async function responseJson(url, init, expected) {
  const response = await fetchRetry(url, init);
  requireStatus(response, expected);
  return { response, body: await readJson(response) };
}

async function sharedNetCurrent(sharednetUrl, token, memberId) {
  const { body } = await responseJson(
    `${sharednetUrl}/api/v1/instances/current`,
    { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } },
    [200],
  );
  const principalId = body?.principal?.id;
  check(
    body?.instance?.id === memberId &&
      body?.instance?.principal_id === principalId &&
      typeof principalId === 'string' &&
      /^p_[A-Za-z0-9]{6,64}$/u.test(principalId) &&
      body?.instance?.revoked_at === null,
    'sharednet_instance_contract',
  );
  return principalId;
}

async function sharedNetBalance(sharednetUrl, token) {
  const { body } = await responseJson(
    `${sharednetUrl}/api/v1/credits`,
    { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } },
    [200],
  );
  check(Number.isSafeInteger(body?.credits?.balance), 'sharednet_balance_contract');
  return body.credits.balance;
}

async function postRoomMessage(sharednetUrl, roomId, token, content) {
  const response = await fetchRetry(
    `${sharednetUrl}/api/v1/rooms/${encodeURIComponent(roomId)}/messages`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: json({ content }),
    },
  );
  check(response.ok, 'sharednet_post_failed');
  return response.status;
}

async function startEnrollment(baseUrl, roomId, seat, label) {
  const { response, body } = await responseJson(
    `${baseUrl}/v1/enroll/start`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: json({
        sharednet_room_id: roomId,
        member_id: seat.member_id,
        display_name: label,
      }),
    },
    [201, 404],
  );
  if (response.status === 404) return { status: 404, body };
  check(
    typeof body?.enrollment_id === 'string' &&
      typeof body?.secret === 'string' &&
      typeof body?.post_this_message === 'string',
    'enroll_start_contract',
  );
  return { status: 201, body };
}

async function completeEnrollment(baseUrl, started, waitMs = 120_000) {
  const deadline = Date.now() + waitMs;
  do {
    const { response, body } = await responseJson(
      `${baseUrl}/v1/enroll/complete`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: json({ enrollment_id: started.enrollment_id, secret: started.secret }),
      },
      [200, 202],
    );
    if (response.status === 200) {
      check(
        body?.status === 'issued' &&
          body?.token_type === 'Bearer' &&
          typeof body?.token === 'string' &&
          typeof body?.actor_id === 'string' &&
          typeof body?.instance_id === 'string' &&
          typeof body?.token_expires_at === 'string',
        'enroll_complete_contract',
      );
      return body;
    }
    check(body?.status === 'pending', 'enroll_pending_contract');
    if (Date.now() + 3_000 > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  } while (Date.now() < deadline);
  const error = new Error('enrollment_timeout');
  error.errorCode = 'enrollment_timeout';
  throw error;
}

async function toolOk(client, name, args = {}, mutation = false, examples) {
  const input = mutation ? { ...args, idempotency_key: randomUUID() } : args;
  const result = await client.call(name, input);
  check(!result.isError && result.data?.error === undefined, `tool_failed_${name}`);
  if (examples !== undefined) examples.push({ name, request: input, response: result.data });
  return result.data;
}

async function toolError(client, name, args, code, reason) {
  const result = await client.call(name, args);
  check(result.isError === true, `expected_tool_error_${name}`);
  check(result.errorCode === code, `wrong_error_code_${name}_${result.errorCode ?? 'missing'}`);
  if (reason !== undefined) {
    check(result.data.error.details?.reason === reason, `wrong_error_reason_${name}`);
  }
  return result.data;
}

async function toolErrorOneOf(client, name, args, codes) {
  const result = await client.call(name, args);
  check(result.isError === true, `expected_tool_error_${name}`);
  check(
    codes.includes(result.errorCode),
    `wrong_error_code_${name}_${result.errorCode ?? 'missing'}`,
  );
  return result.data;
}

async function createTask(client, sessionId, boardId, title, criteria, examples) {
  return toolOk(
    client,
    'chorus.create_task',
    {
      session_id: sessionId,
      board_id: boardId,
      title,
      acceptance_criteria: criteria,
    },
    true,
    examples,
  );
}

async function claimTask(client, sessionId, task, examples) {
  return toolOk(
    client,
    'chorus.claim',
    { session_id: sessionId, task_id: task.id, expected_version: task.version },
    true,
    examples,
  );
}

async function submitTask(
  client,
  sessionId,
  taskId,
  lease,
  content,
  criteriaMapping,
  key,
  examples,
) {
  return toolOk(
    client,
    'chorus.submit_result',
    {
      session_id: sessionId,
      task_id: taskId,
      expected_version: lease.version,
      fence: lease.fence,
      content,
      content_type: 'text/markdown',
      criteria_mapping: criteriaMapping,
      idempotency_key: key ?? randomUUID(),
    },
    false,
    examples,
  );
}

async function runPaidSteps(ctx, step, runId, ids) {
  await step('P0', 'Check billing tool switch', async () => {
    const listed = await ctx.clients.A.listTools();
    const names = new Set((listed.tools ?? []).map((tool) => tool.name));
    check(!names.has('chorus.create_session'), 'free_create_session_registered');
    check(!names.has('chorus.create_task'), 'free_create_task_registered');
    for (const name of ['chorus.room_pulse', 'chorus.create_action_board', 'chorus.create_tasks']) {
      check(names.has(name), `arena_tool_missing_${name}`);
    }
    const arenaTools = [...names]
      .filter((name) =>
        ['chorus.room_pulse', 'chorus.create_action_board', 'chorus.create_tasks'].includes(name),
      )
      .sort();
    check(
      json(arenaTools) ===
        json(['chorus.room_pulse', 'chorus.create_action_board', 'chorus.create_tasks'].sort()),
      'arena_tool_set',
    );
    return { ids: { arena_tools: arenaTools } };
  });

  await step('P1', 'Check free room pulse', async () => {
    const pulse = await toolOk(ctx.clients.B, 'chorus.room_pulse');
    check(pulse.coverage === 'chorus_state_only', 'pulse_coverage');
    const session = (pulse.sessions ?? []).find((item) => item.session_id === ctx.sessionId);
    check(
      session !== undefined &&
        session.counts !== null &&
        typeof session.counts === 'object' &&
        json(Object.keys(session.counts).sort()) === json(PULSE_COUNT_KEYS) &&
        Object.values(session.counts).every((count) => Number.isSafeInteger(count) && count >= 0),
      'pulse_missing_session_counts',
    );
    check(
      !(pulse.sessions ?? []).some((session) => session.session_id === ctx.session2Id),
      'pulse_includes_outsider_session',
    );
    return { ids: { sessions: [ctx.sessionId] } };
  });

  const taskArgs = {
    request_id: `${runId}-p`,
    session_id: ctx.sessionId,
    board_id: ctx.boardId,
    tasks: [
      {
        title: `${runId}-paid-task`,
        acceptance_criteria: ['Paid E2E task persists.'],
      },
    ],
  };
  await step('P2', 'Quote one paid task', async () => {
    const quote = await toolError(
      ctx.clients.B,
      'chorus.create_tasks',
      taskArgs,
      'payment_required',
    );
    const details = quote.error?.details;
    check(
      details?.state === 'PAYMENT_REQUIRED' &&
        details.service === 'create_tasks' &&
        details.request_id === taskArgs.request_id &&
        typeof details.purchase_id === 'string' &&
        details.amount === 1 &&
        details.currency === 'sharednet_credits' &&
        /^chorus:v1:create_tasks:[0-9a-f-]{36}$/u.test(details.memo) &&
        details.pay_from_seat === ctx.seats.B.member_id,
      'payment_quote_contract',
    );
    const instruction = details.instruction;
    check(
      instruction?.method === 'POST' &&
        instruction.url === `${ctx.sharednetUrl}/api/v1/credits/transfers` &&
        instruction.headers?.['Content-Type'] === 'application/json' &&
        instruction.body?.to === details.payee?.member_id &&
        instruction.body?.amount === 1 &&
        instruction.body?.memo === details.memo &&
        instruction.body?.room_id === ctx.roomId,
      'payment_instruction_contract',
    );
    ctx.paidArguments = taskArgs;
    ctx.paidInstruction = instruction;
    ctx.paidPurchaseId = details.purchase_id;
    return { ids: { purchase_id: details.purchase_id } };
  });

  await step('P3', 'Pay from B seat', async () => {
    const balanceBefore = await sharedNetBalance(ctx.sharednetUrl, ctx.seats.B.token);
    const idempotencyKey = randomUUID();
    const response = await fetchRetry(ctx.paidInstruction.url, {
      method: ctx.paidInstruction.method,
      headers: {
        authorization: `Bearer ${ctx.seats.B.token}`,
        'Idempotency-Key': idempotencyKey,
        'Content-Type': ctx.paidInstruction.headers['Content-Type'],
        accept: 'application/json',
      },
      body: json(ctx.paidInstruction.body),
    });
    requireStatus(response, [201]);
    const body = await readJson(response);
    const txnId = body?.transfer?.id;
    check(/^txn_[A-Za-z0-9]{6,64}$/u.test(txnId ?? ''), 'payment_transfer_id_missing');
    const balanceAfter = await sharedNetBalance(ctx.sharednetUrl, ctx.seats.B.token);
    check(balanceBefore - balanceAfter === 1, 'payment_balance_delta');
    ctx.paidTxnId = txnId;
    ctx.paidBalanceAfter = balanceAfter;
    return {
      http_status: response.status,
      ids: { transfer_id: txnId },
      balance_before: balanceBefore,
      balance_after: balanceAfter,
    };
  });

  await step('P4', 'Deliver the paid task', async () => {
    const deliveryArgs = { ...ctx.paidArguments, payment_txn_id: ctx.paidTxnId };
    const delivered = await toolOk(ctx.clients.B, 'chorus.create_tasks', deliveryArgs);
    check(
      delivered.state === 'DELIVERED' &&
        delivered.request_id === ctx.paidArguments.request_id &&
        delivered.amount === 1 &&
        delivered.txn_id === ctx.paidTxnId &&
        Array.isArray(delivered.result?.tasks) &&
        delivered.result.tasks.length === 1,
      'paid_delivery_contract',
    );
    const task = delivered.result.tasks[0];
    check(typeof task?.id === 'string', 'paid_task_id_missing');
    ids.tasks.push(task.id);
    const stored = await toolOk(ctx.clients.B, 'chorus.get_task', {
      session_id: ctx.sessionId,
      task_id: task.id,
    });
    check(stored.id === task.id, 'paid_task_not_persisted');
    ctx.paidDeliveryArgs = deliveryArgs;
    ctx.paidDelivery = delivered;
    ctx.paidTaskId = task.id;
    return { ids: { task_id: task.id, purchase_id: ctx.paidPurchaseId } };
  });

  await step('P5', 'Check replay and request conflict', async () => {
    const replay = await toolOk(ctx.clients.B, 'chorus.create_tasks', ctx.paidDeliveryArgs);
    check(json(stable(replay)) === json(stable(ctx.paidDelivery)), 'paid_replay_changed');
    const replayBalance = await sharedNetBalance(ctx.sharednetUrl, ctx.seats.B.token);
    check(replayBalance === ctx.paidBalanceAfter, 'paid_replay_charged_again');
    const changed = {
      ...ctx.paidArguments,
      tasks: [{ ...ctx.paidArguments.tasks[0], title: `${runId}-changed-title` }],
    };
    await toolError(ctx.clients.B, 'chorus.create_tasks', changed, 'request_conflict');
    check(
      (await sharedNetBalance(ctx.sharednetUrl, ctx.seats.B.token)) === ctx.paidBalanceAfter,
      'request_conflict_charged',
    );
    return { balance_after_replay: replayBalance };
  });

  await step('P6', 'Reject a receipt from another seat', async () => {
    const foreignArgs = {
      request_id: `${runId}-p6`,
      session_id: ctx.sessionId,
      board_id: ctx.boardId,
      tasks: [{ title: `${runId}-foreign-payment`, acceptance_criteria: ['Not delivered.'] }],
    };
    await toolError(ctx.clients.C, 'chorus.create_tasks', foreignArgs, 'payment_required');
    const result = await ctx.clients.C.call('chorus.create_tasks', {
      ...foreignArgs,
      payment_txn_id: ctx.paidTxnId,
    });
    check(result.isError, 'tampered_payment_was_accepted');
    check(
      ['payment_not_verified', 'payment_already_used'].includes(result.errorCode),
      `tampered_payment_error_${result.errorCode ?? 'missing'}`,
    );
    const reason = result.data.error?.details?.reason;
    if (result.errorCode === 'payment_not_verified') {
      check(['payer_seat', 'memo'].includes(reason), 'tampered_payment_reason');
    }
    check(
      (await sharedNetBalance(ctx.sharednetUrl, ctx.seats.B.token)) === ctx.paidBalanceAfter,
      'tampered_payment_charged',
    );
    return { error_code: result.errorCode, error_reason: reason ?? null };
  });
}

async function writePageExamples(runId, calls, identifiers) {
  const outputPath = resolve(ROOT, 'tests/deployed/out', `page-examples-${runId}.json`);
  await mkdir(dirname(outputPath), { recursive: true });
  const examples = buildPageExamples(calls, identifiers);
  await writeFile(outputPath, `${JSON.stringify(examples, null, 2)}\n`, { mode: 0o600 });
  return outputPath;
}

export async function runE2E() {
  const baseUrl = process.env.CHORUS_URL;
  const expectedCommit = process.env.EXPECTED_COMMIT;
  const roomId = process.env.E2E_ROOM;
  const seatsPath = process.env.E2E_SEATS_FILE;
  const paidMode = process.env.E2E_PAID === '1';
  const pageExamplesEnabled = process.env.E2E_PAGE_EXAMPLES === '1';
  const paidSessionId = process.env.E2E_SESSION_ID;
  const paidSession2Id = process.env.E2E_SESSION2_ID;
  const paidBoardId = process.env.E2E_BOARD_ID;
  const sharednetUrl = (process.env.SHAREDNET_URL ?? 'https://www.sharednet.ai').replace(
    /\/$/u,
    '',
  );
  check(
    typeof baseUrl === 'string' && baseUrl !== '' && !baseUrl.endsWith('/'),
    'invalid_chorus_url',
  );
  check(/^[0-9a-f]{40}$/iu.test(expectedCommit ?? ''), 'expected_commit_must_be_full_sha');
  check(typeof roomId === 'string' && /^rom_[A-Za-z0-9]{6,64}$/u.test(roomId), 'invalid_room_id');
  check(typeof seatsPath === 'string' && seatsPath !== '', 'missing_seats_file');
  if (paidMode) {
    check(
      UUID.test(paidSessionId ?? '') &&
        UUID.test(paidSession2Id ?? '') &&
        UUID.test(paidBoardId ?? ''),
      'paid_mode_requires_run1_ids',
    );
  }
  check(!pageExamplesEnabled || !paidMode, 'page_examples_requires_unpaid_run');

  const absoluteSeatsPath = resolve(seatsPath);
  const relativeSeatsPath = relative(ROOT, absoluteSeatsPath);
  check(
    relativeSeatsPath !== '' &&
      (relativeSeatsPath.startsWith('..') || isAbsolute(relativeSeatsPath)),
    'seats_file_must_be_outside_repository',
  );
  let seats;
  try {
    seats = JSON.parse(await readFile(absoluteSeatsPath, 'utf8'));
  } catch {
    check(false, 'invalid_seats_file');
  }
  for (const label of ['A', 'B', 'C', 'D']) {
    check(
      typeof seats?.[label]?.member_id === 'string' &&
        /^i_[A-Za-z0-9]{6,64}$/u.test(seats[label].member_id) &&
        typeof seats?.[label]?.token === 'string' &&
        /^sni_.+/u.test(seats[label].token),
      `invalid_seat_${label}`,
    );
  }

  const runId = `e2e-${new Date()
    .toISOString()
    .replace(/[-:TZ.]/gu, '')
    .slice(0, 14)}`;
  const evidence = {
    run_id: runId,
    chorus_url: baseUrl,
    expected_commit: expectedCommit,
    observed_commit: null,
    started_at: new Date().toISOString(),
    finished_at: null,
    result: 'fail',
    steps: [],
  };
  const ids = {
    sessions: paidMode ? [paidSessionId, paidSession2Id] : [],
    tasks: [],
    actors: [],
  };
  const ctx = {
    baseUrl,
    roomId,
    sharednetUrl,
    seats,
    actors: {},
    clients: {},
    errorCodeObservations: [],
    currentStepId: null,
    sessionId: paidMode ? paidSessionId : undefined,
    session2Id: paidMode ? paidSession2Id : undefined,
    boardId: paidMode ? paidBoardId : undefined,
    paidMode,
    pageExamplesEnabled,
    e6Calls: [],
  };
  let failure;

  const step = async (id, name, run) => {
    ctx.currentStepId = id;
    const startedAt = new Date().toISOString();
    const start = Date.now();
    try {
      const details = (await run()) ?? {};
      const record = {
        id,
        name,
        started_at: startedAt,
        ms: Date.now() - start,
        pass: true,
        error_code_sources: ctx.errorCodeObservations
          .filter((observation) => observation.step_id === id)
          .map(({ tool, code, source }) => ({ tool, code, source })),
        ...details,
      };
      evidence.steps.push(record);
      process.stdout.write(`${id} PASS ${name} (${record.ms} ms)\n`);
      return details;
    } catch (error) {
      const record = {
        id,
        name,
        started_at: startedAt,
        ms: Date.now() - start,
        pass: false,
        error_code: errorCode(error),
        error_code_sources: ctx.errorCodeObservations
          .filter((observation) => observation.step_id === id)
          .map(({ tool, code, source }) => ({ tool, code, source })),
        ...(error?.httpStatus === undefined ? {} : { http_status: error.httpStatus }),
      };
      evidence.steps.push(record);
      error.step = id;
      failure = error;
      process.stdout.write(`${id} FAIL ${name} (${record.error_code})\n`);
      throw error;
    }
  };

  try {
    await step('E0', 'Entry surface', async () => {
      const health = await responseJson(`${baseUrl}/healthz`, {}, [200]);
      check(health.body?.status === 'ok', 'health_not_ok');
      check(health.body?.commit === expectedCommit, 'health_commit_mismatch');
      evidence.observed_commit = health.body.commit;
      const expectedHeaders = {
        'content-security-policy':
          "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'cache-control': 'public, max-age=300',
      };
      const entryBodies = {};
      for (const [path, contentType] of [
        ['/', 'text/html'],
        ['/llms.txt', 'text/plain'],
      ]) {
        const response = await fetchRetry(`${baseUrl}${path}`);
        requireStatus(response, [200]);
        check(response.headers.get('content-type')?.startsWith(contentType), 'entry_content_type');
        for (const [header, value] of Object.entries(expectedHeaders)) {
          check(response.headers.get(header) === value, 'entry_security_header');
        }
        const text = await response.text();
        check(text !== '', 'entry_body_missing');
        check(forbiddenMatches(text).length === 0, 'entry_forbidden_string');
        entryBodies[path] = text;
      }
      if (paidMode) {
        for (const path of ['/', '/llms.txt']) {
          check(
            ['chorus.room_pulse', 'chorus.create_action_board', 'chorus.create_tasks'].every(
              (tool) => entryBodies[path].includes(tool),
            ) && !entryBodies[path].includes('Paid Arena services are not enabled'),
            'billing_page_arena_section_missing',
          );
        }
      }
      return { http_status: health.response.status };
    });

    if (!paidMode)
      await step('E1', 'Activate room when needed', async () => {
        let probe = await startEnrollment(baseUrl, roomId, seats.A, `${runId}-A`);
        let activated = false;
        if (probe.status === 404) {
          check(probe.body?.error === 'room_not_available', 'unexpected_enrollment_404');
          const invite = process.env.E2E_ACTIVATION_INVITE;
          check(
            typeof invite === 'string' && /^rit_.+/u.test(invite),
            'activation_invite_required',
          );
          const { response, body } = await responseJson(
            `${baseUrl}/v1/rooms/activate`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'application/json' },
              body: json({ sharednet_room_id: roomId, sharednet_invite_token: invite }),
            },
            [200, 201],
          );
          check(
            (response.status === 201 && body?.status === 'active') ||
              (response.status === 200 && body?.status === 'already_active'),
            'activation_response_shape',
          );
          probe = await startEnrollment(baseUrl, roomId, seats.A, `${runId}-A`);
          check(probe.status === 201, 'room_still_unavailable');
          activated = response.status === 201;
        }
        check(probe.status === 201, 'room_not_available');
        ctx.startedA = probe.body;
        return { note: activated ? 'activated' : 'already_active' };
      });

    await step('E2', 'Enroll A, B, C, and D', async () => {
      const enrollments = {};
      for (const label of ['A', 'B', 'C', 'D']) {
        const probe =
          label === 'A' && ctx.startedA !== undefined
            ? { status: 201, body: ctx.startedA }
            : await startEnrollment(baseUrl, roomId, seats[label], `${runId}-${label}`);
        check(probe.status === 201, `enroll_start_failed_${label}`);
        const started = probe.body;
        check(started !== undefined, `enroll_start_missing_${label}`);
        await postRoomMessage(sharednetUrl, roomId, seats[label].token, started.post_this_message);
        const enrolled = await completeEnrollment(baseUrl, started);
        enrollments[label] = enrolled;
        ctx.actors[label] = enrolled;
        ids.actors.push(enrolled.actor_id);
      }
      return { ids: { actors: ids.actors.slice() } };
    });

    if (!paidMode)
      await step('E3', 'Reject another seat posting A’s proof', async () => {
        const started = await startEnrollment(baseUrl, roomId, seats.A, `${runId}-A-theft-guard`);
        check(started.status === 201, 'theft_guard_start_failed');
        await postRoomMessage(sharednetUrl, roomId, seats.D.token, started.body.post_this_message);
        for (let elapsed = 0; elapsed < 15_000; elapsed += 3_000) {
          const { response, body } = await responseJson(
            `${baseUrl}/v1/enroll/complete`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'application/json' },
              body: json({
                enrollment_id: started.body.enrollment_id,
                secret: started.body.secret,
              }),
            },
            [202],
          );
          check(body?.status === 'pending', 'other_seat_proved_enrollment');
          if (response.status === 202 && elapsed < 15_000)
            await new Promise((resolve) => setTimeout(resolve, 3_000));
        }
        await postRoomMessage(sharednetUrl, roomId, seats.A.token, started.body.post_this_message);
        const issued = await completeEnrollment(baseUrl, started.body);
        return { ids: { actor_id: issued.actor_id } };
      });

    await step('E4', 'Check identity, expiry, and room tool discovery', async () => {
      for (const label of ['A', 'B', 'C', 'D']) {
        const actor = ctx.actors[label];
        ctx.clients[label] = await connectMcp(baseUrl, actor.token, ({ tool, code, source }) => {
          ctx.errorCodeObservations.push({
            step_id: ctx.currentStepId,
            tool,
            code: code ?? null,
            source,
          });
        });
        const who = await toolOk(ctx.clients[label], 'chorus.whoami');
        check(who.server_commit === expectedCommit, `whoami_commit_${label}`);
        const expiry = Date.parse(who.token_expires_at);
        const ttl = expiry - Date.now();
        check(
          Number.isFinite(expiry) && ttl >= 115 * 60_000 && ttl <= 125 * 60_000,
          `token_ttl_${label}`,
        );
        check(who.actor_id === actor.actor_id, `whoami_actor_${label}`);
      }
      const listed = await ctx.clients.D.listTools();
      const names = (listed.tools ?? []).map((tool) => tool.name).sort();
      const expectedRoomTools = ROOM_TOOLS.filter(
        (name) => !(paidMode && name === 'chorus.create_session'),
      );
      check(json(names) === json(expectedRoomTools), 'outsider_room_tool_list');
      return { ids: { outsider_tools: names } };
    });

    if (paidMode) {
      await runPaidSteps(ctx, step, runId, ids);
    } else {
      await step('E5', 'Check session visibility and joining', async () => {
        const principalId = await sharedNetCurrent(sharednetUrl, seats.A.token, seats.A.member_id);
        const created = await toolOk(
          ctx.clients.A,
          'chorus.create_session',
          {
            name: `${runId}-open`,
            board_name: `${runId}-board`,
            join_policy: 'open',
            discoverable: true,
          },
          true,
        );
        const hidden = await toolOk(
          ctx.clients.A,
          'chorus.create_session',
          {
            name: `${runId}-listed`,
            board_name: `${runId}-hidden-board`,
            join_policy: 'listed',
            listed_principals: [principalId],
            discoverable: false,
          },
          true,
        );
        check(
          typeof created.session?.id === 'string' && typeof created.board?.id === 'string',
          'session_create_shape',
        );
        check(typeof hidden.session?.id === 'string', 'hidden_session_create_shape');
        ids.sessions.push(created.session.id, hidden.session.id);
        await toolOk(
          ctx.clients.B,
          'chorus.join_session',
          { session_id: created.session.id },
          true,
        );
        await toolOk(
          ctx.clients.C,
          'chorus.join_session',
          { session_id: created.session.id },
          true,
        );
        await toolError(
          ctx.clients.D,
          'chorus.join_session',
          { session_id: hidden.session.id, idempotency_key: randomUUID() },
          'not_found',
        );
        const visible = await toolOk(ctx.clients.D, 'chorus.list_sessions');
        check(
          !(visible.items ?? []).some((session) => session.id === hidden.session.id),
          'hidden_session_visible',
        );
        ctx.sessionId = created.session.id;
        ctx.session2Id = hidden.session.id;
        ctx.boardId = created.board.id;
        return { ids: { sessions: ids.sessions.slice() } };
      });

      await step('E6', 'Complete task through independent review', async () => {
        const e6Calls = [];
        const criteria = ['The first requirement is met.', 'The second requirement is met.'];
        const created = await createTask(
          ctx.clients.A,
          ctx.sessionId,
          ctx.boardId,
          `${runId}-task-main`,
          criteria,
          e6Calls,
        );
        const task = created.task;
        check(typeof task?.id === 'string' && Number.isInteger(task.version), 'task_create_shape');
        ids.tasks.push(task.id);
        const lease = await claimTask(ctx.clients.B, ctx.sessionId, task, e6Calls);
        check(Number.isInteger(lease.fence) && lease.fence >= 1, 'claim_fence');
        const content = `# ${runId}\n\nBoth acceptance criteria are met.\n`;
        const key = randomUUID();
        const mapping = [
          { criterion: 0, note: 'First criterion verified.' },
          { criterion: 1, note: 'Second criterion verified.' },
        ];
        const submitted = await submitTask(
          ctx.clients.B,
          ctx.sessionId,
          task.id,
          lease,
          content,
          mapping,
          key,
          e6Calls,
        );
        const localDigest = createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
        check(submitted.content_sha256 === localDigest, 'submit_digest_mismatch');
        const members = await toolOk(
          ctx.clients.B,
          'chorus.list_members',
          {
            session_id: ctx.sessionId,
          },
          false,
          e6Calls,
        );
        check(
          (members.items ?? []).some((member) => member.actor_id === ctx.actors.C.actor_id),
          'reviewer_not_member',
        );
        const requested = await toolOk(
          ctx.clients.B,
          'chorus.request_review',
          {
            session_id: ctx.sessionId,
            task_id: task.id,
            expected_version: submitted.version,
            revision: 1,
            reviewer_actor_id: ctx.actors.C.actor_id,
          },
          true,
          e6Calls,
        );
        check(typeof requested.review?.id === 'string', 'review_request_shape');
        const reviews = await toolOk(
          ctx.clients.C,
          'chorus.list_my_reviews',
          {
            session_id: ctx.sessionId,
          },
          false,
          e6Calls,
        );
        check(
          (reviews.items ?? []).some((review) => review.id === requested.review.id),
          'review_not_assigned',
        );
        const result = await toolOk(
          ctx.clients.C,
          'chorus.get_result',
          {
            session_id: ctx.sessionId,
            task_id: task.id,
            revision: 1,
          },
          false,
          e6Calls,
        );
        check(result.content_sha256 === localDigest, 'stored_result_digest_mismatch');
        const verdict = await toolOk(
          ctx.clients.C,
          'chorus.review',
          {
            session_id: ctx.sessionId,
            review_id: requested.review.id,
            expected_version: requested.review.version,
            verdict: 'approved',
            content_sha256: localDigest,
          },
          true,
          e6Calls,
        );
        check(verdict.task?.state === 'done', 'approval_did_not_complete');
        check(typeof verdict.audit_trace_id === 'string', 'review_trace_missing');
        const done = await toolOk(
          ctx.clients.B,
          'chorus.get_task',
          {
            session_id: ctx.sessionId,
            task_id: task.id,
          },
          false,
          e6Calls,
        );
        check(done.state === 'done', 'task_not_done');
        ctx.reviewTrace = verdict.audit_trace_id;
        ctx.mainTask = task;
        ctx.submitLease = lease;
        ctx.submitKey = key;
        ctx.submitContent = content;
        ctx.submitMapping = mapping;
        ctx.submitOutput = submitted;
        ctx.e6Calls = e6Calls;
        ctx.e6Identifiers = {
          [ctx.sessionId]: '<session_id>',
          [ctx.session2Id]: '<session2_id>',
          [ctx.boardId]: '<board_id>',
          [task.id]: '<task_id>',
          [requested.review.id]: '<review_id>',
          [verdict.audit_trace_id]: '<trace_id>',
          ...Object.fromEntries(
            Object.values(ctx.actors).map((actor) => [actor.actor_id, '<actor_id>']),
          ),
        };
        return {
          ids: { task_id: task.id, review_id: requested.review.id },
          example_calls: e6Calls.length,
          tool: 'chorus.review',
        };
      });

      await step('E7', 'Check negative cases and idempotency', async () => {
        const occupied = await createTask(
          ctx.clients.A,
          ctx.sessionId,
          ctx.boardId,
          `${runId}-task-occupied`,
          ['one'],
        );
        ids.tasks.push(occupied.task.id);
        const occupiedLease = await claimTask(ctx.clients.B, ctx.sessionId, occupied.task);
        await toolError(
          ctx.clients.C,
          'chorus.claim',
          {
            session_id: ctx.sessionId,
            task_id: occupied.task.id,
            expected_version: occupiedLease.version,
            idempotency_key: randomUUID(),
          },
          'owner_conflict',
        );

        const replayArgs = {
          session_id: ctx.sessionId,
          task_id: ctx.mainTask.id,
          expected_version: ctx.submitLease.version,
          fence: ctx.submitLease.fence,
          content: ctx.submitContent,
          content_type: 'text/markdown',
          criteria_mapping: ctx.submitMapping,
          idempotency_key: ctx.submitKey,
        };
        const replay = await toolOk(ctx.clients.B, 'chorus.submit_result', replayArgs);
        check(json(stable(replay)) === json(stable(ctx.submitOutput)), 'idempotent_replay_differs');
        await toolError(
          ctx.clients.B,
          'chorus.submit_result',
          { ...replayArgs, content: `${ctx.submitContent}changed` },
          'idempotency_conflict',
        );

        const wrongDigestTask = await createTask(
          ctx.clients.A,
          ctx.sessionId,
          ctx.boardId,
          `${runId}-task-digest`,
          ['one'],
        );
        ids.tasks.push(wrongDigestTask.task.id);
        const digestLease = await claimTask(ctx.clients.B, ctx.sessionId, wrongDigestTask.task);
        const digestSubmit = await submitTask(
          ctx.clients.B,
          ctx.sessionId,
          wrongDigestTask.task.id,
          digestLease,
          `${runId} digest`,
          [{ criterion: 0, note: 'done' }],
        );
        const digestReview = await toolOk(
          ctx.clients.B,
          'chorus.request_review',
          {
            session_id: ctx.sessionId,
            task_id: wrongDigestTask.task.id,
            expected_version: digestSubmit.version,
            revision: 1,
            reviewer_actor_id: ctx.actors.C.actor_id,
          },
          true,
        );
        await toolError(
          ctx.clients.C,
          'chorus.review',
          {
            session_id: ctx.sessionId,
            review_id: digestReview.review.id,
            expected_version: digestReview.review.version,
            verdict: 'approved',
            content_sha256: '0'.repeat(64),
            idempotency_key: randomUUID(),
          },
          'subject_digest_mismatch',
        );

        const separationTask = await createTask(
          ctx.clients.A,
          ctx.sessionId,
          ctx.boardId,
          `${runId}-task-separation`,
          ['one'],
        );
        ids.tasks.push(separationTask.task.id);
        const separationLease = await claimTask(ctx.clients.B, ctx.sessionId, separationTask.task);
        const separationSubmit = await submitTask(
          ctx.clients.B,
          ctx.sessionId,
          separationTask.task.id,
          separationLease,
          `${runId} separation`,
          [{ criterion: 0, note: 'done' }],
        );
        await toolError(
          ctx.clients.B,
          'chorus.request_review',
          {
            session_id: ctx.sessionId,
            task_id: separationTask.task.id,
            expected_version: separationSubmit.version,
            revision: 1,
            reviewer_actor_id: ctx.actors.B.actor_id,
            idempotency_key: randomUUID(),
          },
          'action_forbidden',
        );

        const outsider = await toolErrorOneOf(
          ctx.clients.D,
          'chorus.get_session',
          { session_id: ctx.sessionId },
          ['tool_unavailable', 'no_matching_grant'],
        );
        check(
          ['tool_unavailable', 'no_matching_grant'].includes(outsider.error?.code ?? outsider.code),
          'outsider_session_access',
        );

        const badBearer = await fetchRetry(`${baseUrl}/mcp`, {
          method: 'POST',
          headers: { authorization: 'Bearer invalid', 'content-type': 'application/json' },
          body: '{',
        });
        check(badBearer.status === 401, 'bad_bearer_status');
        check(
          badBearer.headers.get('www-authenticate') === 'Bearer realm="chorus"',
          'bad_bearer_challenge',
        );

        const staleTask = await createTask(
          ctx.clients.A,
          ctx.sessionId,
          ctx.boardId,
          `${runId}-task-fence`,
          ['one'],
        );
        ids.tasks.push(staleTask.task.id);
        const firstLease = await claimTask(ctx.clients.B, ctx.sessionId, staleTask.task);
        const staleContent = `${runId} stale fence`;
        const staleDigest = createHash('sha256')
          .update(Buffer.from(staleContent, 'utf8'))
          .digest('hex');
        const staleSubmit = await submitTask(
          ctx.clients.B,
          ctx.sessionId,
          staleTask.task.id,
          firstLease,
          staleContent,
          [{ criterion: 0, note: 'done' }],
        );
        const staleReview = await toolOk(
          ctx.clients.B,
          'chorus.request_review',
          {
            session_id: ctx.sessionId,
            task_id: staleTask.task.id,
            expected_version: staleSubmit.version,
            revision: 1,
            reviewer_actor_id: ctx.actors.C.actor_id,
          },
          true,
        );
        const staleVerdict = await toolOk(
          ctx.clients.C,
          'chorus.review',
          {
            session_id: ctx.sessionId,
            review_id: staleReview.review.id,
            expected_version: staleReview.review.version,
            verdict: 'changes_requested',
            content_sha256: staleDigest,
          },
          true,
        );
        check(staleVerdict.review?.state === 'changes_requested', 'stale_review_verdict');
        const returnedTask = await toolOk(ctx.clients.B, 'chorus.get_task', {
          session_id: ctx.sessionId,
          task_id: staleTask.task.id,
        });
        const secondLease = await claimTask(ctx.clients.B, ctx.sessionId, returnedTask);
        check(secondLease.fence === firstLease.fence + 1, 'stale_fence_did_not_increment');
        await toolError(
          ctx.clients.B,
          'chorus.renew_lease',
          {
            session_id: ctx.sessionId,
            task_id: staleTask.task.id,
            expected_version: secondLease.version,
            fence: firstLease.fence,
            idempotency_key: randomUUID(),
          },
          'lease_lost',
        );
        return {
          ids: { tasks: ids.tasks.slice() },
          note: 'idempotent comparison excludes per-call audit and transport metadata',
        };
      });

      await step('E8', 'Check audit visibility', async () => {
        const auditUrl = `${baseUrl}/v1/audit?trace=${encodeURIComponent(ctx.reviewTrace)}`;
        let ownEvents = [];
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline && ownEvents.length === 0) {
          const { body } = await responseJson(
            auditUrl,
            {
              headers: {
                authorization: `Bearer ${ctx.actors.C.token}`,
                accept: 'application/json',
              },
            },
            [200],
          );
          ownEvents = body?.events ?? [];
          if (ownEvents.length === 0) await new Promise((resolve) => setTimeout(resolve, 500));
        }
        check(
          ownEvents.some(
            (event) =>
              json(event).includes('chorus.review') && json(event).includes(ctx.actors.C.actor_id),
          ),
          'review_audit_event_missing',
        );
        const { body: outsider } = await responseJson(
          auditUrl,
          {
            headers: { authorization: `Bearer ${ctx.actors.D.token}`, accept: 'application/json' },
          },
          [200],
        );
        check(
          Array.isArray(outsider?.events) && outsider.events.length === 0,
          'outsider_audit_visible',
        );
        return { ids: { trace_id: ctx.reviewTrace }, http_status: 200 };
      });
    }
  } catch {
    // The failing step is already recorded with a safe code; raw errors may contain response data.
  } finally {
    const startedAt = new Date().toISOString();
    evidence.steps.push({
      id: 'E9',
      name: 'Record created IDs; retain all records',
      started_at: startedAt,
      ms: 0,
      pass: true,
      ids: {
        session_id: ctx.sessionId ?? null,
        session2_id: ctx.session2Id ?? null,
        board_id: ctx.boardId ?? null,
        sessions: ids.sessions.slice(),
        tasks: ids.tasks.slice(),
      },
      note: 'No records were deleted.',
    });
    process.stdout.write('E9 PASS Record created IDs; retain all records (0 ms)\n');
  }

  evidence.finished_at = new Date().toISOString();
  evidence.result = failure === undefined ? 'pass' : 'fail';
  if (pageExamplesEnabled && evidence.result === 'pass') {
    const examplesPath = await writePageExamples(runId, ctx.e6Calls, ctx.e6Identifiers);
    process.stdout.write(`PAGE EXAMPLES ${runId} file=${relative(ROOT, examplesPath)}\n`);
  }
  const outputPath = resolve(ROOT, 'tests/deployed/out', `evidence-${runId}.json`);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(redact(evidence), null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(
    `${evidence.result.toUpperCase()} ${runId} evidence=${relative(ROOT, outputPath)}\n`,
  );
  if (failure !== undefined) {
    const error = new Error(`${failure.step ?? 'E0'}:${errorCode(failure)}`);
    error.errorCode = errorCode(failure);
    throw error;
  }
  return evidence;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) {
    process.stderr.write(
      'This script takes environment variables only; command-line arguments are not supported.\n',
    );
    process.exitCode = 2;
  } else {
    try {
      await runE2E();
    } catch (error) {
      process.stderr.write(`E2E failed: ${error.message}\n`);
      process.exitCode = 1;
    }
  }
}
