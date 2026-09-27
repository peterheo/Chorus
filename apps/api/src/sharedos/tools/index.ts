import type { ToolHandler } from '@aicoo/sharedos';
import { defineChorusTool, type ToolDeps } from './define.ts';
import { roomTools } from './room.ts';
import { sessionTools } from './session.ts';
import { workTools } from './work.ts';

/** Every `chorus.*` tool (P1 domain commands and reads only; nothing is stubbed). */
export function chorusTools(deps: ToolDeps): ToolHandler[] {
  return [...roomTools, ...sessionTools, ...workTools].map((spec) => defineChorusTool(spec, deps));
}
