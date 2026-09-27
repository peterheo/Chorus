import type { ToolHandler } from '@aicoo/sharedos';
import { arenaTools, paidCoordinationModeTool } from './arena.ts';
import { conversationTools } from './conversation.ts';
import { defineChorusTool, type ToolDeps } from './define.ts';
import { roomTools } from './room.ts';
import { sessionTools } from './session.ts';
import { workTools } from './work.ts';

/** With billing on, the free ways to create a session or a task are NOT registered: only the paid ones exist. */
const FREE_CREATE_TOOLS: ReadonlySet<string> = new Set([
  'chorus.create_session',
  'chorus.create_task',
]);

/**
 * Every `chorus.*` tool (P1 domain commands and reads, plus the Arena tools; nothing is stubbed). With billing
 * on, `chorus.set_coordination_mode` is the paid variant (raising the mode is a purchase); with billing off it
 * is the free one, exactly as before.
 */
export function chorusTools(deps: ToolDeps): ToolHandler[] {
  const billed = deps.billing === 'enabled';
  const all = [...roomTools, ...sessionTools, ...workTools, ...arenaTools, ...conversationTools];
  return (
    billed
      ? [
          ...all.filter(
            (spec) =>
              !FREE_CREATE_TOOLS.has(spec.name) && spec.name !== paidCoordinationModeTool.name,
          ),
          paidCoordinationModeTool,
        ]
      : all
  ).map((spec) => defineChorusTool(spec, deps));
}
