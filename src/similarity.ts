// Stage-1 similarity (spec §18, §22, §15). Without an embeddings
// dependency, the hackathon profile uses a lexical overlap coefficient over
// stemmed content words. Stage-2 confirmation (confirm.ts) is where an LLM
// judges meaning; this layer only has to find candidates cheaply.

const STOPWORDS = new Set(
  (
    "a an the and or but of to in on at for with by from into onto about as is are was were be been being " +
    "it its this that these those there here i me my we our you your he she they them their his her " +
    "do does did doing done have has had will would shall should can could may might must " +
    "not no yes too also just now then so very really please ok okay " +
    "someone anyone anybody somebody everyone " +
    // generic work verbs: "check pricing" and "investigate pricing" are the same work
    "check checking checked look looking inspect inspecting investigate investigating verify verifying " +
    "research researching review reviewing find finding figure out handle handling take see test testing " +
    "i'll ill i'm im let lets let's go going get getting"
  ).split(/\s+/),
);

export function stem(word: string): string {
  let w = word.toLowerCase();
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("es") && !w.endsWith("ses")) w = w.slice(0, -1);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  return w;
}

const tokenCache = new Map<string, Set<string>>();
const TOKEN_CACHE_MAX = 20_000;

/** Content tokens of `text`. Memoized: the same texts are compared many times. Treat the result as read-only. */
export function contentTokens(text: string): Set<string> {
  const hit = tokenCache.get(text);
  if (hit) return hit;
  const out = computeTokens(text);
  if (tokenCache.size >= TOKEN_CACHE_MAX) tokenCache.clear();
  tokenCache.set(text, out);
  return out;
}

function computeTokens(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
  const out = new Set<string>();
  for (const w of words) {
    if (STOPWORDS.has(w)) continue;
    const s = stem(w.replace(/'/g, ""));
    // Keep numbers of any length: "item 5" and "item 7" are different work.
    if ((s.length > 1 || /^\d$/.test(s)) && !STOPWORDS.has(s)) out.add(s);
  }
  return out;
}

/** |A∩B| / min(|A|,|B|) — 1.0 when one set's terms are all in the other. */
export function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / Math.min(a.size, b.size);
}

export function textSimilarity(a: string, b: string): number {
  return overlap(contentTokens(a), contentTokens(b));
}

export function normalizeCondition(c: string): string {
  return c.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Conditions overlap when either list is empty (an unconditional claim covers
 * every case) or the lists are identical after normalization. Different
 * non-empty conditions are treated as disjoint; stage 2 can refine this.
 */
export function conditionsOverlap(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return true;
  const na = a.map(normalizeCondition).sort().join("|");
  const nb = b.map(normalizeCondition).sort().join("|");
  return na === nb;
}
