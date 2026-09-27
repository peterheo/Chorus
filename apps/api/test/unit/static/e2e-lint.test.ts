import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { runE2E } from '../../../../../tests/deployed/e2e.mjs';
import { forbiddenMatches } from '../../../../../tests/deployed/lib/forbidden.mjs';
import { buildPageExamples } from '../../../../../tests/deployed/lib/examples.mjs';
import { redact } from '../../../../../tests/deployed/lib/redact.mjs';

describe('deployed E2E evidence redaction', () => {
  it('starts seat A enrollment in E2 when E1 did not provide its challenge', async () => {
    const source = await readFile(
      new URL('../../../../../tests/deployed/e2e.mjs', import.meta.url),
      'utf8',
    );
    const e2Start = source.indexOf("await step('E2'");
    const e3Start = source.indexOf('if (!paidMode)', e2Start);
    expect(e2Start).toBeGreaterThanOrEqual(0);
    expect(e3Start).toBeGreaterThan(e2Start);
    const e2Source = source.slice(e2Start, e3Start);
    expect(e2Source).toContain("label === 'A' && ctx.startedA !== undefined");
    expect(e2Source).toMatch(/:\s*await startEnrollment\(baseUrl, roomId, seats\[label\]/u);
  });

  it('requires run-one IDs before making a paid-mode network request', async () => {
    vi.stubEnv('CHORUS_URL', 'https://chorus.example.test');
    vi.stubEnv('EXPECTED_COMMIT', 'a'.repeat(40));
    vi.stubEnv('E2E_ROOM', 'rom_ExampleRoom01');
    vi.stubEnv('E2E_SEATS_FILE', '/secure/seats.json');
    vi.stubEnv('E2E_PAID', '1');
    vi.stubEnv('E2E_SESSION_ID', '');
    vi.stubEnv('E2E_SESSION2_ID', '');
    vi.stubEnv('E2E_BOARD_ID', '');
    const fetch = vi.fn(() => {
      throw new Error('network_called_before_paid_id_validation');
    });
    vi.stubGlobal('fetch', fetch);
    try {
      await expect(runE2E()).rejects.toThrow('paid_mode_requires_run1_ids');
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it('exempts only evidence links on the unavailable line', () => {
    expect(forbiddenMatches('Not yet available: evidence links')).toEqual([]);
    expect(
      forbiddenMatches('Not yet available: evidence links and sni_secret').map(
        (pattern) => pattern.source,
      ),
    ).toContain('sni_');
  });

  it('builds page examples with placeholders and a short fixed content sample', () => {
    const examples = buildPageExamples(
      [
        {
          name: 'chorus.submit_result',
          request: {
            session_id: '01923b00-0000-7000-8000-000000000001',
            task_id: '01923b00-0000-7000-8000-000000000002',
            idempotency_key: '01923b00-0000-7000-8000-000000000003',
            actor_id: '01923b00-0000-7000-8000-000000000004',
            content: 'private run content '.repeat(8),
            nested: {
              seat: 'sni_private-seat',
              chorus: 'cht_private-chorus',
              challenge: 'cvs_private-challenge',
              invite: 'rit_private-invite',
            },
          },
          response: { content_sha256: 'a'.repeat(64) },
        },
      ],
      {
        '01923b00-0000-7000-8000-000000000001': '<session_id>',
        '01923b00-0000-7000-8000-000000000002': '<task_id>',
      },
    );
    const serialized = JSON.stringify(examples);
    expect(examples[0]?.name).toBe('chorus.submit_result');
    expect(examples[0]?.request).toMatchObject({
      session_id: '<session_id>',
      task_id: '<task_id>',
      idempotency_key: '<uuid>',
      content: 'Both acceptance criteria are met.',
    });
    expect(examples[0]?.response).toEqual({ content_sha256: '<sha256>' });
    expect((examples[0]?.request as { content: string }).content.length).toBeLessThanOrEqual(80);
    expect(serialized).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/iu,
    );
    expect(serialized).not.toMatch(/(?:sni_|cht_|cvs_|rit_)[^\s"'<>),;]+/iu);
    expect(serialized).not.toContain('private run content');
  });

  it('removes seat, Chorus, enrollment, and invite tokens recursively', () => {
    expect(
      redact({
        token: 'sni_seat-secret',
        nested: ['cht_chorus-secret', { challenge: 'cvs_enrollment-secret' }],
        invite: 'rit_invite-secret',
      }),
    ).toEqual({
      token: '<redacted>',
      nested: ['<redacted>', { challenge: '<redacted>' }],
      invite: '<redacted>',
    });
  });

  it('removes authorization headers and result content', () => {
    expect(
      redact({
        Authorization: 'Bearer sni_secret',
        result: { content: 'private result body', tool: 'chorus.review' },
        line: 'Authorization: Bearer cht_secret',
      }),
    ).toEqual({
      Authorization: '<redacted>',
      result: { content: '<redacted>', tool: 'chorus.review' },
      line: 'Authorization: <redacted>',
    });
  });
});
