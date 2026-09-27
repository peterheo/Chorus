/**
 * CC-2 similarity (spec §4): Jaccard over content tokens. Used by the engine (repeated questions, superseding
 * decisions, conflicts) and the rules (duplicate commitments). Pure and deterministic.
 */
import type { ContentTokens, Jaccard } from './events.ts';

/**
 * English function words that carry no content. CC-1 has no stopword list, so this is the canonical one.
 * Contraction stems (`don` from "don't", `ll` from "I'll") are included because the tokenizer splits on `'`.
 */
export const STOPWORDS: ReadonlySet<string> = new Set(
  (
    'a about above after again against all am an and any are aren as at be because been before being below ' +
    'between both but by can couldn could did didn do does doesn doing don down during each few for from ' +
    'further had hadn has hasn have haven having he her here hers herself him himself his how i if in into is ' +
    'isn it its itself just ll me more most my myself no nor not now of off on once only or other our ours ' +
    'ourselves out over own re same shan she should shouldn so some such than that the their theirs them ' +
    'themselves then there these they this those through to too under until up ve very was wasn we were weren ' +
    'what when where which while who whom why will with won would wouldn you your yours yourself yourselves'
  ).split(' '),
);

/**
 * Lowercased `[a-z0-9]+` runs, without stopwords and without single letters (the leftovers of contractions
 * such as the `s` of "it's"); single DIGITS are kept ("step 2" ≠ "step 3"). De-duplicated, in order of first
 * appearance, so a token count is a count of distinct content words.
 */
export const contentTokens: ContentTokens = (text) => {
  const seen = new Set<string>();
  for (const token of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (STOPWORDS.has(token) || /^[a-z]$/.test(token)) continue;
    seen.add(token);
  }
  return [...seen];
};

/** |A ∩ B| / |A ∪ B| over the two lists as sets; two empty lists → 0 (never NaN). */
export const jaccard: Jaccard = (a, b) => {
  const left = new Set(a);
  const right = new Set(b);
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  const union = left.size + right.size - shared;
  return union === 0 ? 0 : shared / union;
};
