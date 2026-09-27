import { readFileSync } from 'node:fs';
import type { FastifyInstance, FastifyReply } from 'fastify';

export interface StaticPagesConfig {
  readonly publicBaseUrl: string;
  readonly billingEnabled: boolean;
}

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'public, max-age=300',
} as const;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return character;
    }
  });
}

function renderTemplate(template: string, publicBaseUrl: string, billingEnabled: boolean): string {
  const withBilling = template
    .replace(/{{#billing}}([\s\S]*?){{\/billing}}/g, (_block, content: string) =>
      billingEnabled ? content : '',
    )
    .replace(/{{\^billing}}([\s\S]*?){{\/billing}}/g, (_block, content: string) =>
      billingEnabled ? '' : content,
    )
    .replaceAll('{{PUBLIC_BASE_URL}}', () => publicBaseUrl);
  if (withBilling.includes('{{')) {
    throw new Error('Static page template contains an unsupported token.');
  }
  return withBilling;
}

function addSecurityHeaders(reply: FastifyReply): FastifyReply {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    reply.header(name, value);
  }
  return reply;
}

export function registerStaticPages(app: FastifyInstance, config: StaticPagesConfig): void {
  const indexTemplate = readFileSync(new URL('../static/index.html', import.meta.url), 'utf8');
  const llmsTemplate = readFileSync(new URL('../static/llms.txt', import.meta.url), 'utf8');
  const renderedHtml = renderTemplate(
    indexTemplate,
    escapeHtml(config.publicBaseUrl),
    config.billingEnabled,
  );
  const renderedLlms = renderTemplate(llmsTemplate, config.publicBaseUrl, config.billingEnabled);

  app.get('/', (_request, reply) => {
    return addSecurityHeaders(reply).type('text/html; charset=utf-8').send(renderedHtml);
  });
  app.get('/llms.txt', (_request, reply) => {
    return addSecurityHeaders(reply).type('text/plain; charset=utf-8').send(renderedLlms);
  });
}
