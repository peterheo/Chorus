import { createHash } from 'node:crypto';
import { resolveLeaseDurationSeconds } from '@chorus/domain';

/** Startup configuration, read once from the environment. Any problem is a `ConfigError`; the process exits 1. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export interface Config {
  readonly env: 'development' | 'production';
  readonly host: string;
  readonly port: number;
  readonly databaseUrlApp: string;
  readonly publicBaseUrl: string;
  readonly leaseDurationSeconds: number;
  readonly gitCommit: string;
  /** 32-byte AES-256-GCM key for seat tokens at rest. */
  readonly secretsKey: Buffer;
  readonly secretsKeyId: string;
  readonly sharednetBaseUrl: string;
  /** `enabled`: only the paid create tools exist (the free create_session / create_task are not registered). */
  readonly billing: 'enabled' | 'disabled';
}

type Env = Readonly<Record<string, string | undefined>>;

export function loadConfig(env: Env): Config {
  const mode = env['CHORUS_ENV'] ?? 'development';
  if (mode !== 'development' && mode !== 'production') {
    throw new ConfigError('CHORUS_ENV must be "development" or "production".');
  }
  const production = mode === 'production';

  const portRaw = env['PORT'] ?? '18080';
  const port = Number(portRaw);
  if (!/^\d+$/.test(portRaw) || port < 1 || port > 65535) {
    throw new ConfigError('PORT must be an integer between 1 and 65535.');
  }

  const databaseUrlApp = env['DATABASE_URL_APP'];
  if (databaseUrlApp === undefined || databaseUrlApp === '') {
    throw new ConfigError('DATABASE_URL_APP is required (the chorus_app runtime role).');
  }

  let publicBaseUrl = env['PUBLIC_BASE_URL'];
  if (publicBaseUrl === undefined || publicBaseUrl === '') {
    if (production) throw new ConfigError('PUBLIC_BASE_URL is required in production.');
    publicBaseUrl = 'http://127.0.0.1:18080';
  }
  if (publicBaseUrl.endsWith('/')) {
    throw new ConfigError('PUBLIC_BASE_URL must not have a trailing slash.');
  }
  let parsed: URL;
  try {
    parsed = new URL(publicBaseUrl);
  } catch {
    throw new ConfigError('PUBLIC_BASE_URL must be an absolute URL.');
  }
  if (production && parsed.protocol !== 'https:') {
    throw new ConfigError('PUBLIC_BASE_URL must be an https:// URL in production.');
  }

  const keyB64 = env['CHORUS_SECRETS_KEY'];
  if (keyB64 === undefined || keyB64 === '') {
    throw new ConfigError('CHORUS_SECRETS_KEY is required (base64 of 32 random bytes).');
  }
  const secretsKey = Buffer.from(keyB64, 'base64');
  if (secretsKey.length !== 32 || secretsKey.toString('base64') !== keyB64) {
    throw new ConfigError('CHORUS_SECRETS_KEY must be the base64 encoding of exactly 32 bytes.');
  }

  const commit = env['GIT_COMMIT'] ?? 'unknown';
  if (commit !== 'unknown' && !/^[0-9a-f]{7,40}$/i.test(commit)) {
    throw new ConfigError('GIT_COMMIT must be 7-40 hex characters or "unknown".');
  }

  const leaseRaw = env['LEASE_DURATION_SECONDS'];
  let leaseDurationSeconds: number;
  try {
    leaseDurationSeconds = resolveLeaseDurationSeconds(
      leaseRaw === undefined ? undefined : Number(leaseRaw),
    );
  } catch {
    throw new ConfigError('LEASE_DURATION_SECONDS must be an integer between 1 and 86400.');
  }

  const sharednetBaseUrl = env['SHAREDNET_BASE_URL'] ?? 'https://www.sharednet.ai';
  try {
    new URL(sharednetBaseUrl);
  } catch {
    throw new ConfigError('SHAREDNET_BASE_URL must be an absolute URL.');
  }

  const billing = env['CHORUS_BILLING'] ?? 'disabled';
  if (billing !== 'enabled' && billing !== 'disabled') {
    throw new ConfigError('CHORUS_BILLING must be "enabled" or "disabled".');
  }

  return {
    env: mode,
    host: env['HOST'] ?? '127.0.0.1',
    port,
    databaseUrlApp,
    publicBaseUrl,
    leaseDurationSeconds,
    gitCommit: commit,
    secretsKey,
    secretsKeyId: createHash('sha256').update(secretsKey).digest('hex').slice(0, 8),
    sharednetBaseUrl: sharednetBaseUrl.replace(/\/$/, ''),
    billing,
  };
}
