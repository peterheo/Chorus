import { ChorusError } from './errors.ts';

/** Default task lease: 15 minutes. Renewal is the executing agent's responsibility. */
export const DEFAULT_LEASE_DURATION_SECONDS = 900;
export const MAX_LEASE_DURATION_SECONDS = 24 * 60 * 60;

/** The one place a lease length is decided, so claim and renew can never disagree. */
export function resolveLeaseDurationSeconds(configured: number | undefined): number {
  if (configured === undefined) return DEFAULT_LEASE_DURATION_SECONDS;
  if (!Number.isInteger(configured) || configured < 1 || configured > MAX_LEASE_DURATION_SECONDS) {
    throw new ChorusError(
      'internal_error',
      `leaseDurationSeconds must be an integer between 1 and ${String(MAX_LEASE_DURATION_SECONDS)}.`,
    );
  }
  return configured;
}
