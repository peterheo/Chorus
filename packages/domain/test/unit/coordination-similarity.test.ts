import { describe, expect, it } from 'vitest';
import { contentTokens, jaccard } from '../../src/index.ts';

describe('coordination similarity (CC-2 §4)', () => {
  it('content tokens: lowercased [a-z0-9]+ runs without stopwords, in order, de-duplicated', () => {
    expect(contentTokens('The Deploy is FAILING on the staging-box!')).toEqual([
      'deploy',
      'failing',
      'staging',
      'box',
    ]);
    expect(contentTokens('deploy deploy DEPLOY')).toEqual(['deploy']);
    expect(contentTokens('')).toEqual([]);
    expect(contentTokens('it is what it is')).toEqual([]);
  });

  it('keeps single digits but drops single letters (contraction leftovers)', () => {
    expect(contentTokens("It's step 2, don't skip v2")).toEqual(['step', '2', 'skip', 'v2']);
    expect(contentTokens('a b c 1 2 3')).toEqual(['1', '2', '3']);
    expect(contentTokens("I'll review C3")).toEqual(['review', 'c3']);
  });

  it('ignores non-ASCII letters and punctuation as separators', () => {
    expect(contentTokens('café—naïve ✅ ok')).toEqual(['caf', 'na', 'ok']);
  });

  it('jaccard is set similarity; two empty inputs → 0', () => {
    expect(jaccard([], [])).toBe(0);
    expect(jaccard(['a'], [])).toBe(0);
    expect(jaccard(['a', 'b'], ['a', 'b'])).toBe(1);
    expect(jaccard(['a', 'b'], ['b', 'a', 'a'])).toBe(1);
    expect(jaccard(['a', 'b', 'c'], ['a', 'b', 'd'])).toBe(0.5);
    expect(jaccard(['a'], ['b'])).toBe(0);
    expect(jaccard(['x', 'y', 'z', 'w', 'v'], ['x', 'y', 'z', 'w'])).toBe(0.8);
  });

  it('is symmetric', () => {
    const a = contentTokens('the database migration fails on postgres 18');
    const b = contentTokens('postgres migration works');
    expect(jaccard(a, b)).toBe(jaccard(b, a));
    expect(jaccard(a, b)).toBeCloseTo(2 / 6);
  });
});
