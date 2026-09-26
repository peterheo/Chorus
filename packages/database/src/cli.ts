import { fileURLToPath } from 'node:url';
import { migrate } from './migrate.ts';

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined || databaseUrl === '') {
  console.error('DATABASE_URL is required.');
  process.exit(2);
}

const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url));

try {
  const { applied } = await migrate({ databaseUrl, migrationsDir });
  console.log(
    applied.length === 0 ? 'Database is up to date.' : `Applied migrations: ${applied.join(', ')}`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
