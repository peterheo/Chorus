import { fileURLToPath } from 'node:url';

/** Absolute path of the repository's SQL migrations. */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
