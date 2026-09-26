import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/** A claim that Chorus creates SharedNet rooms; negated statements ("never creates ...") are the required opposite. */
export function findRoomCreationClaims(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => /creat\w*[^.\n]*sharednet\s+rooms?/i.test(line))
    .filter((line) => !/\b(never|not|no|without|nor|cannot|does not|doesn't)\b/i.test(line));
}

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (['node_modules', 'dist', '.git', 'snapshots', '__snapshots__'].includes(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (/\.(ts|md|json|html|txt)$/.test(name)) yield path;
  }
}

describe('docs.no_room_creation_claims (unit)', () => {
  it('flags claims and allows negations (guard self-test)', () => {
    expect(findRoomCreationClaims('Chorus creates a SharedNet room for you.')).toHaveLength(1);
    expect(findRoomCreationClaims('We create SharedNet rooms on demand')).toHaveLength(1);
    expect(findRoomCreationClaims('Chorus never creates a SharedNet room.')).toEqual([]);
    expect(findRoomCreationClaims('Chorus does not create or clone SharedNet rooms.')).toEqual([]);
    expect(findRoomCreationClaims('binding to an existing SharedNet room')).toEqual([]);
  });

  it('finds none in the repository docs or application code', () => {
    const hits: string[] = [];
    for (const dir of ['apps', 'docs']) {
      let root: string;
      try {
        root = join(ROOT, dir);
        statSync(root);
      } catch {
        continue;
      }
      for (const file of files(root)) {
        // This file quotes forbidden phrases on purpose to test the guard itself.
        if (file.endsWith('docs-claims.test.ts')) continue;
        for (const line of findRoomCreationClaims(readFileSync(file, 'utf8')))
          hits.push(`${file}: ${line.trim()}`);
      }
    }
    for (const line of findRoomCreationClaims(readFileSync(join(ROOT, 'README.md'), 'utf8')))
      hits.push(`README.md: ${line.trim()}`);
    expect(hits).toEqual([]);
  });
});
