import { attestTarget } from '../../../../scripts/e2e/target';
import type { AttestedTarget } from '../../../../scripts/e2e/target';
import { realAttestDeps } from '../../../../scripts/e2e/real';

export interface TestSupabaseEnv {
  url: string;
  publishableKey: string;
  secretKey: string;
}

// The guest session limit is site-wide, so every spec of a run counts against
// it. The e2e server and the direct calls of the specs use this value; the
// limit spec fills the window up to it.
export const TEST_GUEST_SESSIONS_PER_MINUTE = 500;

// Kept on globalThis: the config, the global setup and the specs may load this
// module more than once in one process, and the CI freshness proof must run
// before the fixtures, once.
const ATTESTED = Symbol.for('b1k.e2e.attestedTarget');
type Holder = { [ATTESTED]?: AttestedTarget };

// The database every test entry point talks to. It is attested on first use,
// which happens when playwright.config.ts is loaded: before the global setup,
// the application servers and any fixture. A developer stack, a foreign
// container or a remote URL stops the run here (#96). Nothing is read from
// TEST_SUPABASE_* or any other variable: the target is fixed by the code.
export const attestedTarget = (): AttestedTarget => {
  const holder = globalThis as Holder;
  holder[ATTESTED] ??= attestTarget(realAttestDeps(), {
    requireRunLock: true,
  });
  return holder[ATTESTED];
};

export const readTestSupabaseEnv = (): TestSupabaseEnv => {
  const { url, publishableKey, secretKey } = attestedTarget();
  return { url, publishableKey, secretKey };
};
