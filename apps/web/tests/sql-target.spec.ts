import { expect, test } from '@playwright/test';
import {
  DEV_STACK,
  E2E_STACK,
  MARKER_VALUE,
} from '../../../scripts/e2e/constants';
import { attestedTarget } from './support/env';
import {
  DB_CONTAINER,
  assertLocalTarget,
  localTarget,
  psql,
} from './support/sql';

// The single SQL helper of the specs talks to the attested test database
// only (#96): the container is fixed by the attestation, never by a literal
// in a spec, and a foreign container or a non-loopback host is refused before
// anything connects.

test('targets only selected isolated container', () => {
  const target = attestedTarget();
  expect(DB_CONTAINER).toBe(target.container);
  expect(localTarget()).toEqual({ url: target.url, container: DB_CONTAINER });

  // Local runs use the isolated E2E stack; only a CI job may use the fresh
  // stack that carries the development project id.
  if (target.mode === 'e2e') {
    expect(DB_CONTAINER).toBe(E2E_STACK.dbContainer);
    expect(DB_CONTAINER).not.toBe(DEV_STACK.dbContainer);
    expect(() =>
      assertLocalTarget({ url: target.url, container: DEV_STACK.dbContainer }),
    ).toThrow(/container/);
    // The marker is read back from this very database.
    expect(psql("select value from e2e_infra.marker where key = 'stack'")).toBe(
      MARKER_VALUE,
    );
  } else {
    expect(DB_CONTAINER).toBe(DEV_STACK.dbContainer);
  }

  for (const container of ['production-db', 'supabase_db_other', '']) {
    expect(
      () => assertLocalTarget({ url: target.url, container }),
      container,
    ).toThrow(/container/);
  }
  for (const url of [
    'https://abcdefghijklmnop.supabase.co',
    'http://localhost.evil.example',
    'http://127.0.0.1.nip.io',
    'http://user@evil.example:54421',
    'not a url',
  ]) {
    expect(
      () => assertLocalTarget({ url, container: DB_CONTAINER }),
      url,
    ).toThrow(/non-local|unparsable/);
  }
  expect(() =>
    psql('select 1', { url: 'https://evil.example', container: DB_CONTAINER }),
  ).toThrow(/non-local/);
});
