export class MigrationError extends Error {
  override readonly name: string = 'MigrationError';
}

/** An already-applied migration file no longer matches the checksum recorded when it ran. */
export class MigrationChecksumError extends MigrationError {
  override readonly name = 'MigrationChecksumError';
  readonly version: number;
  readonly migrationName: string;
  readonly recordedChecksum: string;
  readonly currentChecksum: string;

  constructor(
    version: number,
    migrationName: string,
    recordedChecksum: string,
    currentChecksum: string,
  ) {
    super(
      `Migration ${formatVersion(version)}_${migrationName} was edited after it was applied ` +
        `(recorded ${recordedChecksum}, on disk ${currentChecksum}). Never edit a merged migration; add a new one.`,
    );
    this.version = version;
    this.migrationName = migrationName;
    this.recordedChecksum = recordedChecksum;
    this.currentChecksum = currentChecksum;
  }
}

/** A migration failed while running. Its transaction was rolled back. */
export class MigrationFailedError extends MigrationError {
  override readonly name = 'MigrationFailedError';
  readonly version: number;
  readonly migrationName: string;

  constructor(version: number, migrationName: string, cause: unknown) {
    super(`Migration ${formatVersion(version)}_${migrationName} failed and was rolled back.`, {
      cause,
    });
    this.version = version;
    this.migrationName = migrationName;
  }
}

export function formatVersion(version: number): string {
  return String(version).padStart(4, '0');
}
