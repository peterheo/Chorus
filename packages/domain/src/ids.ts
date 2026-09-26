declare const brand: unique symbol;

/** A lowercase canonical UUID. Branded so raw strings cannot be passed where an id is expected. */
export type Uuid = string & { readonly [brand]: 'Uuid' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isUuid(value: unknown): value is Uuid {
  return typeof value === 'string' && UUID.test(value);
}

/** Validates and canonicalizes (lowercases) a UUID string; returns undefined if it is not one. */
export function parseUuid(value: string): Uuid | undefined {
  const lower = value.toLowerCase();
  return isUuid(lower) ? lower : undefined;
}

/**
 * Ascending, de-duplicated order. Canonical lowercase UUID strings sort exactly as PostgreSQL's
 * uuid type does (bytewise), so locking in this order matches `ORDER BY id`.
 */
export function sortedUniqueUuids(ids: readonly Uuid[]): Uuid[] {
  return [...new Set(ids)].sort();
}
