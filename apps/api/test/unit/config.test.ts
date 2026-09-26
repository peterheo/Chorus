import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config.ts';

const KEY = randomBytes(32).toString('base64');
const base = {
  DATABASE_URL_APP: 'postgres://chorus_app:x@localhost:5432/chorus',
  CHORUS_SECRETS_KEY: KEY,
};
const problem = (env: Record<string, string>) => {
  try {
    loadConfig(env);
  } catch (error) {
    return error instanceof ConfigError ? error.message : String(error);
  }
  return undefined;
};

describe('config.startup_guards (unit)', () => {
  it('applies the documented development defaults', () => {
    const config = loadConfig(base);
    expect(config).toMatchObject({
      env: 'development',
      host: '127.0.0.1',
      port: 18080,
      publicBaseUrl: 'http://127.0.0.1:18080',
      leaseDurationSeconds: 900,
      gitCommit: 'unknown',
      sharednetBaseUrl: 'https://www.sharednet.ai',
    });
    expect(config.secretsKey).toHaveLength(32);
    expect(config.secretsKeyId).toMatch(/^[0-9a-f]{8}$/);
  });

  it('requires PUBLIC_BASE_URL (https, no trailing slash) in production', () => {
    expect(problem({ ...base, CHORUS_ENV: 'production' })).toMatch(/PUBLIC_BASE_URL is required/);
    expect(
      problem({ ...base, CHORUS_ENV: 'production', PUBLIC_BASE_URL: 'http://x.example' }),
    ).toMatch(/https/);
    expect(problem({ ...base, PUBLIC_BASE_URL: 'https://x.example/' })).toMatch(/trailing slash/);
    expect(problem({ ...base, PUBLIC_BASE_URL: 'not a url' })).toMatch(/absolute URL/);
    expect(
      loadConfig({ ...base, CHORUS_ENV: 'production', PUBLIC_BASE_URL: 'https://chorus.example' })
        .publicBaseUrl,
    ).toBe('https://chorus.example');
  });

  it('requires DATABASE_URL_APP and a valid CHORUS_SECRETS_KEY', () => {
    expect(problem({ CHORUS_SECRETS_KEY: KEY })).toMatch(/DATABASE_URL_APP is required/);
    expect(problem({ DATABASE_URL_APP: base.DATABASE_URL_APP })).toMatch(
      /CHORUS_SECRETS_KEY is required/,
    );
    expect(problem({ ...base, CHORUS_SECRETS_KEY: randomBytes(16).toString('base64') })).toMatch(
      /exactly 32 bytes/,
    );
    expect(problem({ ...base, CHORUS_SECRETS_KEY: 'not base64!!' })).toMatch(/exactly 32 bytes/);
  });

  it('validates PORT, CHORUS_ENV, GIT_COMMIT, LEASE_DURATION_SECONDS and SHAREDNET_BASE_URL', () => {
    for (const port of ['0', '70000', 'abc', '80.5'])
      expect(problem({ ...base, PORT: port }), port).toMatch(/PORT/);
    expect(problem({ ...base, CHORUS_ENV: 'staging' })).toMatch(/CHORUS_ENV/);
    expect(problem({ ...base, GIT_COMMIT: 'zzz' })).toMatch(/GIT_COMMIT/);
    expect(loadConfig({ ...base, GIT_COMMIT: 'abc1234' }).gitCommit).toBe('abc1234');
    for (const lease of ['0', '90000', 'x'])
      expect(problem({ ...base, LEASE_DURATION_SECONDS: lease }), lease).toMatch(
        /LEASE_DURATION_SECONDS/,
      );
    expect(loadConfig({ ...base, LEASE_DURATION_SECONDS: '60' }).leaseDurationSeconds).toBe(60);
    expect(problem({ ...base, SHAREDNET_BASE_URL: 'nope' })).toMatch(/SHAREDNET_BASE_URL/);
    expect(
      loadConfig({ ...base, SHAREDNET_BASE_URL: 'http://127.0.0.1:9/' }).sharednetBaseUrl,
    ).toBe('http://127.0.0.1:9');
  });

  it('has no OPERATOR_CONTACT setting anywhere', () => {
    expect(Object.keys(loadConfig(base))).not.toContain('operatorContact');
  });
});
