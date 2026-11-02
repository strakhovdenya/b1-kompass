import 'server-only';
import { cache } from 'react';
import type { ServerDeps } from '../db';
import type { GuestContext } from '../guest-session/session';
import { readAttemptPage } from './read';

// The attempt of one address, read once per request: the shared layout and
// the block page read the same attempt. The arguments are the per-request
// deps and guest, so the cache is not shared between requests. Reading never
// creates an attempt.
export const getOpenedAttempt = cache(
  (
    deps: ServerDeps,
    guest: GuestContext,
    examSlug: string,
    attemptId: string,
  ) => readAttemptPage(deps, guest, examSlug, attemptId),
);
