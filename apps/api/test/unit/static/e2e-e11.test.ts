import { generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  EMPTY_STATE,
  applyMessages,
  evaluate,
  type CoordObject,
  type SourceMessage,
} from '@chorus/domain';
import {
  canonicalJson,
  coordinationScript,
  leakedValues,
  runE2E,
  tamperedReceipt,
  verifyReceiptLocally,
} from '../../../../../tests/deployed/e2e.mjs';
import { canonicalJcs, signReceipt } from '../../../src/receipts.ts';

const SCRIPT_URL = new URL('../../../../../tests/deployed/e2e.mjs', import.meta.url);

function stubRunEnv(env: Record<string, string>): ReturnType<typeof vi.fn> {
  vi.stubEnv('CHORUS_URL', 'https://chorus.example.test');
  vi.stubEnv('EXPECTED_COMMIT', 'a'.repeat(40));
  vi.stubEnv('E2E_ROOM', 'rom_ExampleRoom01');
  vi.stubEnv('E2E_SEATS_FILE', '/secure/seats.json');
  vi.stubEnv('E2E_SESSION_ID', '01923b00-0000-7000-8000-000000000001');
  vi.stubEnv('E2E_SESSION2_ID', '01923b00-0000-7000-8000-000000000002');
  vi.stubEnv('E2E_BOARD_ID', '01923b00-0000-7000-8000-000000000003');
  for (const key of ['E2E_PAID', 'E2E_CONVERSATION', 'E2E_COORDINATION', 'E2E_ASSIST'])
    vi.stubEnv(key, env[key] ?? '');
  const fetch = vi.fn(() => {
    throw new Error('network_called_before_coordination_validation');
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

/** The body of `runCoordinationStep`, up to the next top-level function. */
async function e11Source(): Promise<string> {
  const source = await readFile(SCRIPT_URL, 'utf8');
  const start = source.indexOf('async function runCoordinationStep(');
  const end = source.indexOf('\nasync function ', start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

/** Every `return { … }` object literal in a source slice, matched by braces. */
function returnedObjects(source: string): string[] {
  const found: string[] = [];
  for (let at = source.indexOf('return {'); at >= 0; at = source.indexOf('return {', at + 1)) {
    let depth = 0;
    let end = at + 'return '.length;
    for (; end < source.length; end += 1) {
      if (source[end] === '{') depth += 1;
      if (source[end] === '}') depth -= 1;
      if (depth === 0) break;
    }
    found.push(source.slice(at, end + 1));
  }
  return found;
}

describe('deployed E2E step E11 (conversation coordination)', () => {
  it.each([
    [{ E2E_COORDINATION: '1' }, 'coordination_requires_conversation_run'],
    [{ E2E_PAID: '1', E2E_COORDINATION: '1' }, 'coordination_requires_conversation_run'],
    [{ E2E_PAID: '1', E2E_CONVERSATION: '1', E2E_ASSIST: '1' }, 'assist_requires_coordination_run'],
  ])('refuses %o before any network request', async (env, code) => {
    const fetch = stubRunEnv(env);
    try {
      await expect(runE2E()).rejects.toThrow(code);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it('runs E11 only in the paid conversation run, after E10', async () => {
    const source = await readFile(SCRIPT_URL, 'utf8');
    const calls = [...source.matchAll(/await runCoordinationStep\(/gu)];
    expect(calls).toHaveLength(1);
    const paid = source.slice(source.indexOf('await runPaidSteps(ctx, step, runId, ids);'));
    const e10 = paid.indexOf('if (conversationMode) await runConversationStep(');
    const e11 = paid.indexOf('if (coordinationMode) await runCoordinationStep(');
    expect(e10).toBeGreaterThanOrEqual(0);
    expect(e11).toBeGreaterThan(e10);
    expect(paid.indexOf('} else {')).toBeGreaterThan(e11);
    const body = await e11Source();
    for (const id of ['E11a', 'E11b', 'E11c', 'E11d', 'E11e', 'E11f'])
      expect(body).toContain(`step('${id}'`);
    expect(body).toMatch(/if \(!ctx\.assistMode\)/u);
  });

  it('keeps room text, tokens and receipt signatures out of E11 evidence', async () => {
    const body = await e11Source();
    const returns = returnedObjects(body);
    expect(returns.length).toBeGreaterThan(5);
    for (const literal of returns) {
      expect(literal).not.toMatch(/\b(token|signature|content|text|envelope)\b|\breceipt\s*:/u);
    }
    expect(body).not.toMatch(/process\.(stdout|stderr)\.write/u);
    expect(body).not.toMatch(/console\./u);
  });

  it('turns the scripted conversation into the objects and signals E11a/E11b assert', () => {
    const ids = { A: 'i_SeatAlpha01', B: 'i_SeatBravo02', C: 'i_SeatCharl03', D: 'i_SeatDelta04' };
    const names = { A: 'alpha', B: 'bravo', C: 'charlie', D: 'delta' };
    let sequence = 100;
    const message = (seat: keyof typeof ids, content: string): SourceMessage => {
      sequence += 1;
      return {
        message_id: `msg_${String(sequence)}`,
        sequence,
        sender_member_id: ids[seat],
        sender_principal_id: 'p_Principal01',
        sender_name: names[seat],
        content,
        reply_to_message_id: null,
      };
    };
    const ctx = { excludeMemberIds: [] };
    // E10 leaves B with an open commitment, which puts B on an object before E11 addresses B by id.
    const e10 = applyMessages(
      EMPTY_STATE,
      [
        message('A', 'Can someone check why the deploy fails for e2e-1?'),
        message('B', "I'll investigate the deploy failure for e2e-1."),
      ],
      ctx,
    );
    const script = coordinationScript(ids);
    const posted = script.scan.map((line) => message(line.seat, line.content));
    const { state } = applyMessages(e10.state, posted, ctx);
    const bySource = (kind: string, index: number): CoordObject[] =>
      state.objects.filter(
        (o) => o.kind === kind && o.sources[0]?.message_id === posted[index]?.message_id,
      );
    const [handoff] = bySource('handoff', 0);
    expect(handoff).toMatchObject({ status: 'accepted', targets: [{ member_id: ids.B }] });
    const commitment = state.objects.find(
      (o) => o.kind === 'commitment' && o.related.includes(handoff?.ref ?? ''),
    );
    expect(commitment).toMatchObject({ status: 'open', owner: { member_id: ids.B } });
    expect(bySource('claim', 2)).toMatchObject([{ status: 'active', polarity: 'pos' }]);
    expect(bySource('claim', 3)).toMatchObject([{ status: 'active', polarity: 'neg' }]);
    const conflict = state.objects.find((o) => o.kind === 'conflict');
    expect(conflict?.status).toBe('detected');
    const [dependency] = bySource('dependency', 4);
    expect(dependency).toMatchObject({ status: 'waiting', related: [commitment?.ref] });
    const signals = evaluate(state);
    const conflictSignal = signals.find((s) => s.kind === 'conflict');
    expect(conflictSignal?.refs).toContain(conflict?.ref);
    // E11d waits for a room post that starts with exactly this text.
    expect(conflictSignal?.suggested_next_action.startsWith('Resolve conflict ')).toBe(true);

    // E11d's fresh pair conflicts on its own subject and leaves the scanned claims alone.
    const fresh = script.assist.map((line) => message(line.seat, line.content));
    const assisted = applyMessages(state, fresh, ctx).state;
    const conflicts = assisted.objects.filter((o) => o.kind === 'conflict');
    expect(conflicts.map((o) => o.status)).toEqual(['detected', 'detected']);
    expect(
      assisted.objects.filter((o) => o.kind === 'claim').every((o) => o.status === 'active'),
    ).toBe(true);
  });

  it('verifies receipts offline exactly like the server and rejects the E11e tamper', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const receipt = {
      v: 1,
      type: 'chorus.task_completion',
      issuer: 'https://chorus.example.test',
      task: { id: 't', title: 'Ünïcode "title"', criteria_sha256: 'c'.repeat(64) },
      result: { revision: 1, content_sha256: 'a'.repeat(64), submitted_by: { member_id: null } },
      review: null,
    };
    expect(canonicalJson(receipt)).toBe(canonicalJcs(receipt));
    const envelope = signReceipt(receipt, privateKey, '0123456789abcdef');
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(verifyReceiptLocally(envelope, pem)).toBe(true);
    const tampered = tamperedReceipt(envelope);
    expect(tampered.receipt.result).not.toEqual(envelope.receipt.result);
    expect(tampered.signature).toBe(envelope.signature);
    expect(verifyReceiptLocally(tampered, pem)).toBe(false);
    expect(envelope.receipt.result).toEqual(receipt.result);
  });

  it('reports which private values leak into a room post, case-insensitively', () => {
    const post = '[chorus] Resolve conflict X2: alpha and delta disagree on "The staging cache".';
    expect(leakedValues(post, ['01923b00-0000-7000-8000-000000000001', 'e2e-open'])).toEqual([]);
    expect(leakedValues(`${post} E2E-OPEN`, ['01923b00', 'e2e-open', null, 'X2'])).toEqual([1]);
  });
});
