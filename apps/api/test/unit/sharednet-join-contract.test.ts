import { describe, expect, it } from 'vitest';
import {
  MCP_INSTRUCTIONS,
  MCP_INSTRUCTIONS_BILLING,
  mcpInstructions,
} from '../../src/instructions.ts';
import { parseInstance, parseJoin, SharedNetContractError } from '../../src/sharednet/client.ts';

const token = `sni_${'a'.repeat(32)}`;
const goodJoin = { member_token: token, history: { items: [{ sequence: 3 }, { sequence: 7 }] } };
const goodInstance = {
  principal: { id: 'p_Principal01' },
  agent: null,
  instance: { id: 'i_Instance01', principal_id: 'p_Principal01', revoked_at: null },
};
const instanceWith = (
  instance: Record<string, unknown> = {},
  principal: Record<string, unknown> = {},
): Record<string, unknown> => ({
  principal: { ...goodInstance.principal, ...principal },
  agent: null,
  instance: { ...goodInstance.instance, ...instance },
});
const without = (record: Record<string, unknown>, key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));

describe('SharedNet join contract (A-S1.3-3): only documented fields, fail closed on anything else', () => {
  it('reads member_token and the highest history sequence (0 when empty)', () => {
    expect(parseJoin(goodJoin)).toEqual({ memberToken: token, lastSequence: 7 });
    expect(parseJoin({ member_token: token, history: { items: [] } }).lastSequence).toBe(0);
  });

  const badJoins: [string, unknown][] = [
    ['a non-object body', 'nope'],
    ['a missing member_token', { history: { items: [] } }],
    ['a member_token without the sni_ prefix', { ...goodJoin, member_token: 'abc' }],
    ['a non-string member_token', { ...goodJoin, member_token: 5 }],
    ['a missing history', { member_token: token }],
    ['history.items that is not an array', { member_token: token, history: { items: {} } }],
    ['a non-numeric sequence', { member_token: token, history: { items: [{ sequence: '3' }] } }],
    ['a negative sequence', { member_token: token, history: { items: [{ sequence: -1 }] } }],
    ['a fractional sequence', { member_token: token, history: { items: [{ sequence: 1.5 }] } }],
    ['an item that is not an object', { member_token: token, history: { items: [4] } }],
  ];
  it.each(badJoins)('rejects %s', (_label, body) => {
    expect(() => parseJoin(body)).toThrow(SharedNetContractError);
  });

  it('resolves the seat from instance.id and instance.principal_id', () => {
    expect(parseInstance(goodInstance)).toEqual({
      memberId: 'i_Instance01',
      principalId: 'p_Principal01',
    });
  });

  const badInstances: [string, unknown][] = [
    ['a non-object body', null],
    ['a missing instance', without(goodInstance, 'instance')],
    ['a missing principal', without(goodInstance, 'principal')],
    ['a missing instance.id', { ...goodInstance, instance: without(goodInstance.instance, 'id') }],
    ['a malformed instance.id', instanceWith({ id: 'nope' })],
    ['a member id with the p_ prefix', instanceWith({ id: 'p_Instance01' })],
    [
      'a missing instance.principal_id',
      { ...goodInstance, instance: without(goodInstance.instance, 'principal_id') },
    ],
    ['a malformed principal_id', instanceWith({ principal_id: 'x' })],
    [
      'a principal.id that differs from instance.principal_id',
      instanceWith({}, { id: 'p_Different01' }),
    ],
    ['a revoked instance', instanceWith({ revoked_at: '2026-01-01T00:00:00Z' })],
    [
      'a missing revoked_at',
      { ...goodInstance, instance: without(goodInstance.instance, 'revoked_at') },
    ],
  ];
  it.each(badInstances)('rejects %s', (_label, body) => {
    expect(() => parseInstance(body)).toThrow(SharedNetContractError);
  });
});

describe('MCP instructions', () => {
  it('C15 mcp.instructions: the text is stable and names the session-free tools', () => {
    expect(MCP_INSTRUCTIONS).toMatchSnapshot();
    for (const tool of ['whoami', 'list_sessions', 'create_session', 'join_session']) {
      expect(MCP_INSTRUCTIONS).toContain(`chorus.${tool}`);
    }
    expect(MCP_INSTRUCTIONS).toContain('every call takes a session_id except');
  });

  it('with billing on, names only registered tools and the paid way to create', () => {
    expect(mcpInstructions('disabled')).toBe(MCP_INSTRUCTIONS);
    expect(mcpInstructions('enabled')).toBe(MCP_INSTRUCTIONS_BILLING);
    expect(MCP_INSTRUCTIONS_BILLING).toMatchSnapshot();
    expect(MCP_INSTRUCTIONS_BILLING).not.toMatch(/chorus\.create_(session|task)(?![a-z_])/u);
    for (const tool of ['create_action_board', 'create_tasks', 'room_pulse', 'join_session']) {
      expect(MCP_INSTRUCTIONS_BILLING).toContain(`chorus.${tool}`);
    }
    expect(MCP_INSTRUCTIONS_BILLING).toContain('details.instruction');
  });
});
