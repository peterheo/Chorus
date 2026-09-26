import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { rolesForEnrollment } from '../../src/roles.ts';
import { SERVER_INSTRUCTIONS, TOOL_SPECS } from '../../src/mcp.ts';

describe('mcp.tools.snapshot (unit)', () => {
  it('pins the server instructions text', () => {
    expect(SERVER_INSTRUCTIONS).toMatchSnapshot();
  });

  it('pins every tool name, title, description, annotation and input/output shape', () => {
    const summary = TOOL_SPECS.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      annotations: t.readOnly
        ? { readOnlyHint: true }
        : { readOnlyHint: false, idempotentHint: true },
      input: Object.fromEntries(
        Object.entries(t.input).map(([k, v]) => [
          k,
          `${v.constructor.name}${z.safeParse(v, undefined).success ? '?' : ''}`,
        ]),
      ),
      output: Object.keys(t.output),
    }));
    expect(summary).toMatchSnapshot();
  });

  it('has exactly the 12 documented tools; mutations require an idempotency key, reads never do', () => {
    expect(TOOL_SPECS.map((t) => t.name)).toEqual([
      'chorus_whoami',
      'chorus_list_work',
      'chorus_get_task',
      'chorus_get_result',
      'chorus_list_my_reviews',
      'chorus_create_task',
      'chorus_claim',
      'chorus_renew_lease',
      'chorus_submit_result',
      'chorus_request_review',
      'chorus_review',
      'chorus_complete',
    ]);
    for (const tool of TOOL_SPECS) {
      expect('idempotency_key' in tool.input, tool.name).toBe(!tool.readOnly);
      expect(tool.description.length, tool.name).toBeGreaterThan(40);
      expect(tool.description.split(/(?<=[.!?])\s/).length, tool.name).toBeLessThanOrEqual(3);
    }
    const key = TOOL_SPECS.find((t) => t.name === 'chorus_claim')?.input[
      'idempotency_key'
    ] as z.ZodString;
    expect(key.safeParse('short').success).toBe(false);
    expect(key.safeParse('x'.repeat(16)).success).toBe(true);
    expect(key.safeParse('x'.repeat(129)).success).toBe(false);
    expect(key.safeParse('has space in it 123').success).toBe(false);
  });

  it('grants every verified member exactly executor (interim role policy)', () => {
    expect(rolesForEnrollment({ principalId: 'p_x', workspaceId: 'w', roomId: 'r' })).toEqual([
      'executor',
    ]);
  });
});
