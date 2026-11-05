import { ruleViolation } from '../db';
import type { ServiceClient } from '../db';
import type {
  BudgetItem,
  BudgetKind,
  CacheRow,
  CacheTarget,
  DictionaryStore,
  ProviderName,
  ReserveResult,
} from './dictionary';

// The shared dictionary cache and budget in Supabase, reached only through
// the service client of the server. Neither table nor the function is open
// to anon or authenticated; no row carries a session id except the guest's
// own budget scope, which is purged with the old windows.

interface CacheRecord {
  provider: string;
  version: number;
  word: string;
  target: string;
  state: string;
  payload: unknown;
  fetched_at: string;
  expires_at: string;
}

const CACHE_COLUMNS =
  'provider, version, word, target, state, payload, fetched_at, expires_at';
const PROVIDERS: readonly ProviderName[] = ['mymemory', 'openthesaurus'];
const TARGETS: readonly CacheTarget[] = ['en', 'ru', 'de'];
const BUDGET_KINDS: readonly BudgetKind[] = [
  'guest',
  'mymemory',
  'openthesaurus',
];

const toRow = (record: CacheRecord): CacheRow | null => {
  const provider = PROVIDERS.find((item) => item === record.provider);
  const target = TARGETS.find((item) => item === record.target);
  const isState = record.state === 'found' || record.state === 'not-found';
  if (!provider || !target || !isState) return null;
  return {
    provider,
    version: record.version,
    word: record.word,
    target,
    state: record.state as CacheRow['state'],
    payload: record.payload,
    fetchedAt: new Date(record.fetched_at),
    expiresAt: new Date(record.expires_at),
  };
};

const toRecord = (row: CacheRow): CacheRecord => ({
  provider: row.provider,
  version: row.version,
  word: row.word,
  target: row.target,
  state: row.state,
  payload: row.payload,
  fetched_at: row.fetchedAt.toISOString(),
  expires_at: row.expiresAt.toISOString(),
});

const kindOf = (details: unknown): BudgetKind | null =>
  BUDGET_KINDS.find((kind) => kind === details) ?? null;

export const createSupabaseDictionaryStore = (
  db: ServiceClient,
): DictionaryStore => ({
  readCache: async (word: string, now: Date): Promise<CacheRow[]> => {
    const { data, error } = await db
      .from('dictionary_cache')
      .select(CACHE_COLUMNS)
      .eq('word', word)
      .gt('expires_at', now.toISOString())
      .returns<CacheRecord[]>();
    if (error)
      throw new Error('Dictionary cache read failed', { cause: error });
    return data.map(toRow).filter((row) => row !== null);
  },

  writeCache: async (rows: readonly CacheRow[]): Promise<void> => {
    const { error } = await db
      .from('dictionary_cache')
      .upsert(rows.map(toRecord), {
        onConflict: 'provider,version,word,target',
      });
    if (error) throw error;
  },

  reserve: async (
    sessionId: string,
    items: readonly BudgetItem[],
  ): Promise<ReserveResult> => {
    const { error } = await db.rpc('reserve_dictionary_budget', {
      p_session_id: sessionId,
      p_items: items,
    });
    if (!error) return { ok: true };
    const hint = ruleViolation(error);
    if (hint === 'guest_session_invalid') {
      return { ok: false, reason: 'session-invalid' };
    }
    if (hint === 'dictionary_budget_exhausted') {
      return { ok: false, reason: 'exhausted', kind: kindOf(error.details) };
    }
    throw new Error('Dictionary budget was not reserved', { cause: error });
  },
});
