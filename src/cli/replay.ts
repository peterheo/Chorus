// npm run replay -- <fixture.json> [--claude] [--mode facilitate]
//
// Replays a fixture through Chorus with a virtual clock and prints the state
// timeline (spec §58). --claude uses the Claude extractor/confirmer instead
// of the deterministic ones (needs Anthropic credentials).

import { readFileSync } from "node:fs";
import { defaultConfig, type Mode } from "../config.ts";
import { ClaudeConfirmer, ClaudeExtractor } from "../extract/claude.ts";
import { formatTrace, replay } from "../replay.ts";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!file) {
  console.error("usage: npm run replay -- <fixture.json> [--claude] [--mode observe|assist|facilitate]");
  process.exit(2);
}
const modeIdx = args.indexOf("--mode");
const mode = modeIdx >= 0 ? (args[modeIdx + 1] as Mode) : undefined;
const useClaude = args.includes("--claude");

const fixture = JSON.parse(readFileSync(file, "utf8"));
if (mode) fixture.mode = mode;
const log = (m: string) => console.error(`[llm] ${m}`);

const result = await replay(fixture, {
  config: defaultConfig,
  extractor: useClaude ? new ClaudeExtractor({ model: process.env.LLM_MODEL, log }) : undefined,
  confirmer: useClaude ? new ClaudeConfirmer({ model: process.env.LLM_MODEL, log }) : undefined,
});

console.log(formatTrace(result));
console.log("\n── Room log ──");
for (const m of result.transport.log) {
  const who = m.authorName ?? m.authorId;
  const [first, ...rest] = m.text.split("\n");
  console.log(`#${String(m.seq).padEnd(3)} ${who}: ${first}`);
  for (const r of rest) console.log(`     ${" ".repeat(who.length)}  ${r}`);
}
