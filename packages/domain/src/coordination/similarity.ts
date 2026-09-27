/**
 * CC-2 §4: content-token Jaccard similarity, used for repeated questions, superseding decisions/claims,
 * conflict detection and duplicate commitments. Pure, no I/O.
 */

// A short, deliberately conservative stopword list: removing too much would make unrelated sentences look
// similar (a false conflict or duplicate); keeping single digits (spec) means "3" and "port 3" stay comparable.
const STOPWORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'if',
  'then',
  'else',
  'of',
  'to',
  'in',
  'on',
  'for',
  'with',
  'at',
  'by',
  'from',
  'up',
  'down',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'am',
  'i',
  'you',
  'we',
  'they',
  'he',
  'she',
  'it',
  'this',
  'that',
  'these',
  'those',
  'my',
  'your',
  'our',
  'their',
  'his',
  'her',
  'its',
  'do',
  'does',
  'did',
  'will',
  'would',
  'can',
  'could',
  'should',
  'shall',
  'not',
  'no',
  'so',
  'as',
  'about',
  'into',
  'over',
  'after',
  'before',
  'when',
  'once',
  'just',
  'also',
  'me',
  'us',
  'them',
  'have',
  'has',
  'had',
  'get',
  'got',
]);

/** Content tokens of `text`: lowercased `[a-z0-9]+` runs, stopwords removed, de-duplicated. */
export function contentTokens(text: string): readonly string[] {
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return [...new Set(words.filter((word) => !STOPWORDS.has(word)))];
}

/** Jaccard similarity of two token sets (0 when both are empty). */
export function jaccard(a: readonly string[], b: readonly string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Jaccard of the content tokens of two texts directly. */
export function textSimilarity(a: string, b: string): number {
  return jaccard(contentTokens(a), contentTokens(b));
}
