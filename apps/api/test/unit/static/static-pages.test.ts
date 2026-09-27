import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { registerStaticPages } from '../../../src/static.ts';
import { chorusTools } from '../../../src/sharedos/tools/index.ts';

const SECTION_TITLES = [
  '1. What Chorus is',
  '2. How it works',
  '3. Prerequisites',
  '4. Activate Chorus in your room (once, any member)',
  '5. Enroll',
  '6. Connect',
  '7. Sessions',
  '8. Arena services',
  '9. Rules',
  '10. Limits',
  '11. Troubleshooting',
];

const BILLING_CONTENT = [
  'chorus.create_action_board',
  'chorus.create_tasks',
  'payment_txn_id',
  'Idempotency-Key',
  'Do not use CLI pay retries',
];

async function fetchPages(
  billingEnabled: boolean,
  publicBaseUrl = 'https://chorus.example.test',
): Promise<{
  readonly html: string;
  readonly llms: string;
  readonly htmlStatus: number;
  readonly llmsStatus: number;
  readonly htmlHeaders: Record<string, string | number | string[] | undefined>;
  readonly llmsHeaders: Record<string, string | number | string[] | undefined>;
}> {
  const app = Fastify({ logger: false });
  registerStaticPages(app, { publicBaseUrl, billingEnabled });
  try {
    const [html, llms] = await Promise.all([
      app.inject({ method: 'GET', url: '/' }),
      app.inject({ method: 'GET', url: '/llms.txt' }),
    ]);
    return {
      html: html.body,
      llms: llms.body,
      htmlStatus: html.statusCode,
      llmsStatus: llms.statusCode,
      htmlHeaders: html.headers,
      llmsHeaders: llms.headers,
    };
  } finally {
    await app.close();
  }
}

function htmlSectionTitles(content: string): string[] {
  return [...content.matchAll(/<h2>(.*?)<\/h2>/gs)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

function llmsSectionTitles(content: string): string[] {
  return [...content.matchAll(/^## (\d+\. .+)$/gm)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

describe('static entry pages', () => {
  it('covers clean-client trial findings in both public pages', async () => {
    const pages = await fetchPages(true);
    for (const page of [pages.html, pages.llms]) {
      const visibleText = page.replace(/<[^>]*>/gu, ' ').replace(/\s+/gu, ' ');
      for (const phrase of [
        'Cloudflare rejects some default library agents such as Python-urllib',
        'retry_after_seconds',
        'chorus.create_tasks',
        'request_id',
        'browser_signature_banned',
        "compare with the tool's",
        'details.field',
        'action_forbidden',
        'from_sequence',
      ]) {
        expect(visibleText).toContain(phrase);
      }
      expect(visibleText).not.toContain('session_required');
    }
  });

  it('documents on-demand conversation scans and suggestion review', async () => {
    const pages = await fetchPages(true);
    for (const page of [pages.html, pages.llms]) {
      const text = page.replace(/<[^>]*>/gu, ' ').replace(/\s+/gu, ' ');
      expect(text).not.toContain('reads only chorus-verify messages');
      expect(text).toContain('chorus.scan_conversation');
      expect(text).toContain('selected window of at most 200 messages');
      expect(text).toContain('source snapshots');
      expect(text).toContain('chorus.list_suggestions');
      expect(text).toContain('chorus.set_coordination_mode');
      expect(text).toContain('reads every new room message');
      expect(text).toContain('3 short coordination notes per 5 minutes');
    }
  });

  it('serves both routes with their content types and security headers', async () => {
    const pages = await fetchPages(true);
    expect(pages.htmlStatus).toBe(200);
    expect(pages.llmsStatus).toBe(200);
    expect(pages.htmlHeaders['content-type']).toBe('text/html; charset=utf-8');
    expect(pages.llmsHeaders['content-type']).toBe('text/plain; charset=utf-8');
    for (const headers of [pages.htmlHeaders, pages.llmsHeaders]) {
      expect(headers['content-security-policy']).toBe(
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      );
      expect(headers['x-content-type-options']).toBe('nosniff');
      expect(headers['referrer-policy']).toBe('no-referrer');
      expect(headers['cache-control']).toBe('public, max-age=300');
    }
  });

  it('renders all eleven sections in order and substitutes only the public base URL', async () => {
    const pages = await fetchPages(true, 'https://chorus.example.test/a?x=1&y=<two>');
    expect(htmlSectionTitles(pages.html)).toEqual(SECTION_TITLES);
    expect(llmsSectionTitles(pages.llms)).toEqual(SECTION_TITLES);
    expect(pages.html).toContain('https://chorus.example.test/a?x=1&amp;y=&lt;two&gt;');
    expect(pages.llms).toContain('https://chorus.example.test/a?x=1&y=<two>');
    expect(pages.html).not.toContain('{{');
    expect(pages.llms).not.toContain('{{');
  });

  it('serves the same parseable E6 examples in both pages using tools registered in both billing modes', async () => {
    let expectedExamples: Array<{ name: string }> | undefined;
    for (const billingEnabled of [false, true]) {
      const pages = await fetchPages(billingEnabled);
      const llmsMatch = pages.llms.match(
        /E6 request\/response examples[^\n]*\n\n```json\n([\s\S]*?)\n```/u,
      );
      const htmlMatch = pages.html.match(
        /E6 request\/response examples[\s\S]*?<pre><code>([\s\S]*?)<\/code><\/pre>/u,
      );
      expect(llmsMatch?.[1]).toBeDefined();
      expect(htmlMatch?.[1]).toBeDefined();
      const htmlJson = (htmlMatch?.[1] ?? '')
        .replace(/&lt;/gu, '<')
        .replace(/&gt;/gu, '>')
        .replace(/&amp;/gu, '&');
      const llmsExamples = JSON.parse(llmsMatch?.[1] ?? 'null') as Array<{ name: string }>;
      const htmlExamples = JSON.parse(htmlJson) as Array<{ name: string }>;
      const toolNames = new Set(
        chorusTools({
          pool: {} as pg.Pool,
          leaseDurationSeconds: 900,
          gitCommit: 'test',
          logger: { error: () => undefined },
          billing: billingEnabled ? 'enabled' : 'disabled',
        }).map((tool) => tool.definition.name),
      );
      expect(htmlExamples).toEqual(llmsExamples);
      expect(llmsExamples.length).toBeGreaterThan(0);
      expect(llmsExamples[0]?.name).toBe('chorus.claim');
      for (const example of llmsExamples) expect(toolNames.has(example.name)).toBe(true);
      if (expectedExamples === undefined) expectedExamples = llmsExamples;
      else expect(llmsExamples).toEqual(expectedExamples);
      const serialized = JSON.stringify(llmsExamples);
      expect(serialized).not.toMatch(
        /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/iu,
      );
      expect(serialized).not.toMatch(/(?:sni_|cht_|cvs_|rit_)[^\s"'<>),;]+/iu);
    }
  });

  it('renders exactly the enabled or disabled billing copy', async () => {
    const enabled = await fetchPages(true);
    const disabled = await fetchPages(false);
    for (const marker of BILLING_CONTENT) expect(enabled.html).toContain(marker);
    for (const marker of BILLING_CONTENT) expect(enabled.llms).toContain(marker);
    expect(enabled.html).not.toContain('Paid Arena services are not enabled on this deployment.');
    expect(enabled.llms).not.toContain('Paid Arena services are not enabled on this deployment.');
    expect(disabled.html).toContain('Paid Arena services are not enabled on this deployment.');
    expect(disabled.llms).toContain('Paid Arena services are not enabled on this deployment.');
    for (const tool of BILLING_CONTENT) {
      expect(disabled.html).not.toContain(tool);
      expect(disabled.llms).not.toContain(tool);
    }
    // chorus.room_pulse is registered in BOTH modes, so it is documented in both, not only under billing.
    for (const page of [enabled.html, enabled.llms, disabled.html, disabled.llms]) {
      expect(page).toContain('chorus.room_pulse');
    }
    // With billing enabled, the free create tools are unregistered: neither page names them
    // (chorus.create_task, not the substring inside chorus.create_tasks).
    const freeCreateTool = /chorus\.create_(session|task)(?![a-z_])/;
    for (const page of [enabled.html, enabled.llms]) {
      expect(page).not.toMatch(freeCreateTool);
    }
    expect(enabled.html).toContain('chorus.create_action_board');
    for (const page of [disabled.html, disabled.llms]) {
      expect(page).toContain('chorus.create_session');
    }
  });

  it('contains none of the forbidden strings in either billing variant', async () => {
    const evidenceLinkPattern = /evidence link/iu;
    const secretPattern = /sni_/u;
    const forbidden = [
      /cht_[^…]/u,
      /cvs_[^…]/u,
      /rit_[^…]/u,
      secretPattern,
      /snk_/u,
      /ev1\./u,
      /trycloudflare/iu,
      /operator/iu,
      /invite code/iu,
      /request access/iu,
      evidenceLinkPattern,
      /Chorus creates/iu,
    ];
    const forbiddenMatches = (content: string) =>
      forbidden.filter((pattern) => {
        const scanned =
          pattern === evidenceLinkPattern
            ? content.replace(/Not yet available:[^\n]*/gu, '')
            : content;
        return pattern.test(scanned);
      });
    expect(forbiddenMatches('Not yet available: evidence links and sni_x')).toContain(
      secretPattern,
    );
    expect(forbiddenMatches('Not yet available: evidence links')).toEqual([]);
    for (const billingEnabled of [true, false]) {
      const pages = await fetchPages(billingEnabled);
      for (const content of [pages.html, pages.llms]) {
        expect(forbiddenMatches(content)).toEqual([]);
      }
    }
  });

  it('renders the connect command as one exact curl friendly line', async () => {
    const pages = await fetchPages(true);
    expect(pages.html).toContain(
      'claude mcp add --transport http chorus https://chorus.example.test/mcp --header "Authorization: Bearer $CHORUS_TOKEN"',
    );
  });

  it('explains tool_unavailable immediately after no_matching_grant', async () => {
    const pages = await fetchPages(true);
    const explanation =
      "You have no role in this room's sessions that allows that tool; check session_id and your roles.";
    expect(pages.llms).toContain(
      "| `tool_unavailable` | You have no role in this room's sessions that allows that tool; check session_id and your roles. |",
    );
    const htmlNoGrant = pages.html.indexOf('sharedos/code no_matching_grant');
    const htmlUnavailable = pages.html.indexOf('tool_unavailable');
    expect(htmlUnavailable).toBeGreaterThan(htmlNoGrant);
    const unavailableRow = pages.html.slice(
      htmlUnavailable,
      pages.html.indexOf('</tr>', htmlUnavailable),
    );
    expect(unavailableRow.replace(/<[^>]*>/gu, ' ').replace(/\s+/gu, ' ')).toContain(explanation);
  });

  it('troubleshoots the same agent-facing error codes in both pages', async () => {
    const codes = [
      'rate_limited',
      'temporarily_unavailable',
      'idempotency_conflict',
      'invalid_transition',
      'lease_conflict',
      'payment_required',
      'payment_not_found',
      'payment_not_verified',
      'payment_already_used',
      'request_conflict',
    ];
    const pages = await fetchPages(true);
    const llmsTable = pages.llms.slice(pages.llms.indexOf('## 11. Troubleshooting'));
    const htmlTable = pages.html.slice(pages.html.indexOf('<h2>11. Troubleshooting</h2>'));
    for (const code of codes) {
      expect(llmsTable).toContain(`| \`${code}\` |`);
      expect(htmlTable).toContain(`<td>${code}</td>`);
    }
  });

  it('tells a buyer to send the quoted payment instruction unchanged from the quoted seat', async () => {
    const pages = await fetchPages(true);
    for (const page of [pages.llms, pages.html]) {
      for (const phrase of [
        'details.instruction',
        'pay_from_seat',
        'transfer.id',
        'Idempotency-Key',
      ]) {
        expect(page).toContain(phrase);
      }
    }
  });

  it('documents only the exact JSON keys in each curl body', async () => {
    const expectedKeySets = [
      ['sharednet_room_id', 'sharednet_invite_token'],
      ['sharednet_room_id', 'member_id', 'display_name'],
      ['content'],
      ['enrollment_id', 'secret'],
    ].map((keys) => keys.sort().join(','));
    for (const billingEnabled of [true, false]) {
      const pages = await fetchPages(billingEnabled);
      for (const content of [pages.html, pages.llms]) {
        const bodies = [...content.matchAll(/-d '(\{[^']+\})'/gu)];
        expect(bodies).toHaveLength(expectedKeySets.length);
        const actualKeySets = bodies.map((match) => {
          const body = match[1];
          if (body === undefined) throw new Error('curl JSON body was not captured.');
          const parsed: unknown = JSON.parse(body);
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            throw new Error('curl body must be a JSON object.');
          }
          return Object.keys(parsed).sort().join(',');
        });
        expect(actualKeySets).toEqual(expectedKeySets);
      }
    }
  });
});
