import { readFileSync } from 'node:fs';
import pg from 'pg';
import { buildApp } from './app.ts';
import { ConfigError, loadConfig } from './config.ts';
import { assertRuntimeRole } from './runtime-role.ts';
import { SharedNetClient } from './sharednet/client.ts';
import { RoomWatcher } from './watcher.ts';

const version = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const pool = new pg.Pool({ connectionString: config.databaseUrlApp, max: 20 });
  pool.on('error', () => undefined);
  await assertRuntimeRole(pool);

  const app = await buildApp({ config, pool, version });
  const watcher = new RoomWatcher({
    pool,
    secretsKey: config.secretsKey,
    client: new SharedNetClient({ baseUrl: config.sharednetBaseUrl }),
    logger: {
      info: (obj, msg) => {
        app.log.info(obj, msg);
      },
      warn: (obj, msg) => {
        app.log.warn(obj, msg);
      },
    },
  });

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    await watcher.stop();
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: config.host, port: config.port });
  await watcher.start();
}

main().catch((error: unknown) => {
  console.error(error instanceof ConfigError ? `Configuration error: ${error.message}` : error);
  process.exit(1);
});
