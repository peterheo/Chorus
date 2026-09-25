// npm run replay -- <fixture.json> [--llm gemini|claude] [--mode facilitate]
//
// Replays a fixture through Chorus with a virtual clock and prints the state
// timeline (spec §58). --llm gemini (needs GEMINI_API_KEY) or --llm claude
// (needs Anthropic credentials) uses that LLM extractor/confirmer instead of
// the deterministic ones; --claude is shorthand for --llm claude.

import { readFileSync } from "node:fs";
import { defaultConfig, type Mode } from "../config.ts";
import { extractorKind, llmComponents } from "../extract/select.ts";
import { formatTrace, replay } from "../replay.ts";

const args = process.argv.slice(2);
const llmIdx = args.indexOf("--llm");
const file = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--mode" && args[i - 1] !== "--llm");
if (!file) {
  console.error("usage: npm run replay -- <fixture.json> [--llm gemini|claude] [--mode observe|assist|facilitate]");
  process.exit(2);
}
const modeIdx = args.indexOf("--mode");
const mode = modeIdx >= 0 ? (args[modeIdx + 1] as Mode) : undefined;
const kind = extractorKind({
  ...process.env,
  CHORUS_EXTRACTOR: args.includes("--claude") ? "claude" : llmIdx >= 0 ? args[llmIdx + 1] : "heuristic",
});

const fixture = JSON.parse(readFileSync(file, "utf8"));
if (mode) fixture.mode = mode;
const log = (m: string) => console.error(`[llm] ${m}`);
const llm = llmComponents(kind, process.env, { log });

const result = await replay(fixture, {
  config: defaultConfig,
  extractor: llm?.extractor,
  confirmer: llm?.confirmer,
});

console.log(formatTrace(result));
console.log("\n── Room log ──");
for (const m of result.transport.log) {
  const who = m.authorName ?? m.authorId;
  const [first, ...rest] = m.text.split("\n");
  console.log(`#${String(m.seq).padEnd(3)} ${who}: ${first}`);
  for (const r of rest) console.log(`     ${" ".repeat(who.length)}  ${r}`);
}
