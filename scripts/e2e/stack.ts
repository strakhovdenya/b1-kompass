import { CLEANUP_TABLES, E2E_BUCKET } from './constants';

// The operations on the attested E2E stack (#96): cleanup of test data in
// PostgreSQL and Storage, and the migration preflight. Real implementations
// of the ports are in real.ts; the logic that decides what may be touched is
// here and is tested against fakes.

export interface AppliedMigration {
  version: string;
  name: string;
}

export interface StackDb {
  // Every table outside the schemas of Supabase itself, as `schema.table`.
  tables: () => string[];
  // One transaction: switches the user triggers of the tables off, empties
  // them, switches the triggers on again and fails if any trigger state
  // differs from before.
  wipe: (tables: readonly string[]) => void;
  appliedMigrations: () => AppliedMigration[];
}

export interface StackStorage {
  buckets: () => Promise<string[]>;
  // Removes every object of the bucket, the bucket itself stays.
  emptyBucket: (bucket: string) => Promise<void>;
  // Objects left in the bucket according to the database of Storage.
  objectCount: (bucket: string) => Promise<number>;
}

export interface CleanReport {
  tables: number;
}

// Empties the allowlisted test data and nothing else. Any table or bucket
// that the allowlist does not know stops the cleanup before the first write.
export const cleanTestData = async (
  db: StackDb,
  storage: StackStorage,
): Promise<CleanReport> => {
  const present = new Set(db.tables());
  const allowed = new Set(CLEANUP_TABLES);
  const unknown = [...present].filter((table) => !allowed.has(table));
  if (unknown.length > 0) {
    throw new Error(
      `cleanup refused: tables outside the allowlist: ${unknown.join(', ')}`,
    );
  }
  const missing = CLEANUP_TABLES.filter((table) => !present.has(table));
  if (missing.length > 0) {
    throw new Error(
      `cleanup refused: allowlisted tables are missing: ${missing.join(', ')}`,
    );
  }
  const buckets = await storage.buckets();
  const foreign = buckets.filter((bucket) => bucket !== E2E_BUCKET);
  if (foreign.length > 0 || !buckets.includes(E2E_BUCKET)) {
    throw new Error(
      `cleanup refused: unexpected Storage buckets: ${buckets.join(', ') || 'none'}`,
    );
  }

  db.wipe(CLEANUP_TABLES);
  await storage.emptyBucket(E2E_BUCKET);
  const left = await storage.objectCount(E2E_BUCKET);
  if (left !== 0) {
    throw new Error(`cleanup incomplete: ${left} Storage objects remain`);
  }
  return { tables: CLEANUP_TABLES.length };
};

export interface MigrationCli {
  // `supabase migration up --db-url <the E2E database>`: a constant URL.
  up: () => void;
}

export type MigrationOutcome = 'current' | 'applied';

export class MigrationDrift extends Error {
  constructor(reason: string) {
    super(`migration drift: ${reason}`);
    this.name = 'MigrationDrift';
  }
}

const describe = (items: readonly AppliedMigration[]): string =>
  items.map((item) => item.version).join(',') || 'none';

// The installed history must be a prefix of the canonical files. Equal: no
// schema replay. A prefix: only the missing files are applied. Anything else
// is drift: the stack is never reset to repair it.
export const checkMigrations = (
  local: readonly AppliedMigration[],
  db: Pick<StackDb, 'appliedMigrations'>,
  cli: MigrationCli,
): MigrationOutcome => {
  const compare = (
    applied: readonly AppliedMigration[],
  ): 'equal' | 'behind' => {
    if (applied.length > local.length) {
      throw new MigrationDrift(
        `the database has ${applied.length} migrations, the repository ${local.length} (${describe(applied)})`,
      );
    }
    applied.forEach((item, index) => {
      const file = local[index];
      if (!file || file.version !== item.version || file.name !== item.name) {
        throw new MigrationDrift(
          `${item.version}_${item.name} is not the repository migration at position ${index + 1}`,
        );
      }
    });
    return applied.length === local.length ? 'equal' : 'behind';
  };

  if (compare(db.appliedMigrations()) === 'equal') return 'current';
  cli.up();
  if (compare(db.appliedMigrations()) !== 'equal') {
    throw new MigrationDrift('migrations are still pending after the update');
  }
  return 'applied';
};
