import { describe, expect, it } from 'vitest';
import { forbiddenMatches } from '../../../../../tests/deployed/lib/forbidden.mjs';
import { redact } from '../../../../../tests/deployed/lib/redact.mjs';

describe('deployed E2E evidence redaction', () => {
  it('exempts only evidence links on the unavailable line', () => {
    expect(forbiddenMatches('Not yet available: evidence links')).toEqual([]);
    expect(
      forbiddenMatches('Not yet available: evidence links and sni_secret').map(
        (pattern) => pattern.source,
      ),
    ).toContain('sni_');
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
