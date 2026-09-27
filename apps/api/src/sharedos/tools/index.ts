import type { ToolHandler } from '@aicoo/sharedos';
import { arenaTools } from './arena.ts';
import { defineChorusTool, type ToolDeps } from './define.ts';
import { roomTools } from './room.ts';
import { sessionTools } from './session.ts';
import { workTools } from './work.ts';

/** With billing on, the free ways to create a session or a task are NOT registered: only the paid ones exist. */
const FREE_CREATE_TOOLS: ReadonlySet<string> = new Set([
  'chorus.create_session',
  'chorus.create_task',
]);

/** Every `chorus.*` tool (P1 domain commands and reads, plus the Arena tools; nothing is stubbed). */
export function chorusTools(deps: ToolDeps): ToolHandler[] {
  return [...roomTools, ...sessionTools, ...workTools, ...arenaTools]
    .filter((spec) => deps.billing !== 'enabled' || !FREE_CREATE_TOOLS.has(spec.name))
    .map((spec) => defineChorusTool(spec, deps));
}
