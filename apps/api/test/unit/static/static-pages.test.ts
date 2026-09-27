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
  '10. Limits (RC1)',
  '11. Troubleshooting',
];

const BILLING_CONTENT = [
  'chorus.room_pulse',
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

  it('serves the same parseable E6 examples in both pages using registered tools', async () => {
    const pages = await fetchPages(true);
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
        billing: 'disabled',
      }).map((tool) => tool.definition.name),
    );
    expect(htmlExamples).toEqual(llmsExamples);
    expect(llmsExamples.length).toBeGreaterThan(0);
    for (const example of llmsExamples) expect(toolNames.has(example.name)).toBe(true);
    const serialized = JSON.stringify(llmsExamples);
    expect(serialized).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/iu,
    );
    expect(serialized).not.toMatch(/(?:sni_|cht_|cvs_|rit_)[^\s"'<>),;]+/iu);
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
    for (const tool of BILLING_CONTENT.slice(0, 3)) {
      expect(disabled.html).not.toContain(tool);
      expect(disabled.llms).not.toContain(tool);
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
