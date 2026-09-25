// Rules first, LLM for the rest: stretches a small LLM quota. Messages the
// rule-based extractor reads are taken as it reads them; only messages it
// finds nothing in (most unusual phrasing: "Leave pricing to me", "Can't move
// on until…") go to the LLM. Costs some accuracy on messages the rules read
// partly right; see README.

import type { ExtractedEvent } from "../schemas/llm.ts";
import type { ExtractionContext, Extractor } from "./types.ts";

export class RulesFirstExtractor implements Extractor {
  readonly name: string;
  /** messages the rules handled without an LLM call */
  savedCalls = 0;

  constructor(
    private readonly rules: Extractor,
    private readonly llm: Extractor,
  ) {
    this.name = llm.name;
  }

  available(): boolean {
    return this.llm.available?.() ?? true;
  }

  async extract(text: string, ctx: ExtractionContext): Promise<ExtractedEvent[]> {
    const events = await this.rules.extract(text, ctx);
    if (events.length > 0) {
      this.savedCalls++;
      return events;
    }
    return this.llm.extract(text, ctx);
  }

  async extractBatch(items: Array<{ text: string; ctx: ExtractionContext }>): Promise<ExtractedEvent[][]> {
    const out = await Promise.all(items.map((it) => this.rules.extract(it.text, it.ctx)));
    const rest = items.map((it, i) => ({ it, i })).filter(({ i }) => out[i]!.length === 0);
    this.savedCalls += items.length - rest.length;
    if (rest.length === 0) return out;
    const llm = this.llm.extractBatch
      ? await this.llm.extractBatch(rest.map((r) => r.it))
      : await Promise.all(rest.map((r) => this.llm.extract(r.it.text, r.it.ctx)));
    rest.forEach((r, j) => (out[r.i] = llm[j] ?? []));
    return out;
  }
}
