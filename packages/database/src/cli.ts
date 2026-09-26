import pg from 'pg';
import { setAppRolePassword } from './app-role.ts';
import { migrate } from './migrate.ts';
import { MIGRATIONS_DIR } from './paths.ts';

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined || databaseUrl === '') {
  console.error('DATABASE_URL is required.');
  process.exit(2);
}

try {
  const { applied } = await migrate({ databaseUrl, migrationsDir: MIGRATIONS_DIR });
  const appPassword = process.env['CHORUS_APP_PASSWORD'];
  if (appPassword !== undefined && appPassword !== '') {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await setAppRolePassword(client, appPassword);
      console.log('Set the chorus_app login password.');
    } finally {
      await client.end();
    }
  }
  console.log(
    applied.length === 0 ? 'Database is up to date.' : `Applied migrations: ${applied.join(', ')}`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
