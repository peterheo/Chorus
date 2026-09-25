// Stage-2 confirmation interface (spec §18, §22) and its deterministic
// implementation. The Claude implementation lives in extract/claude.ts.

import type { ConflictVerdict, DuplicateVerdict } from "./schemas/llm.ts";
import { conditionsOverlap, contentTokens, overlap } from "./similarity.ts";

export interface ClaimView {
  subject: string;
  predicate: string;
  polarity: "positive" | "negative";
  conditions: string[];
  hedged: boolean;
}

export interface Confirmer {
  duplicate(a: string, b: string): Promise<DuplicateVerdict>;
  conflict(a: ClaimView, b: ClaimView): Promise<ConflictVerdict>;
}

export class HeuristicConfirmer implements Confirmer {
  async duplicate(a: string, b: string): Promise<DuplicateVerdict> {
    const score = overlap(contentTokens(a), contentTokens(b));
    if (score >= 0.99) return { verdict: "same", confidence: 0.92 };
    if (score >= 0.75) return { verdict: "overlapping", confidence: 0.86 };
    return { verdict: "different", confidence: 0.9 };
  }

  async conflict(a: ClaimView, b: ClaimView): Promise<ConflictVerdict> {
    const samePredicate = overlap(contentTokens(a.predicate), contentTokens(b.predicate)) >= 0.99;
    if (!samePredicate) return { verdict: "unclear", confidence: 0.5, reason: "different predicates" };
    if (a.polarity === b.polarity) return { verdict: "not_conflict", confidence: 0.95, reason: "same polarity" };
    if (!conditionsOverlap(a.conditions, b.conditions)) {
      return { verdict: "not_conflict", confidence: 0.9, reason: "different conditions" };
    }
    return { verdict: "conflict", confidence: 0.95, reason: "direct contradiction" };
  }
}
