import 'server-only';
import { cache } from 'react';
import type { ServerDeps } from '../db';
import type { GuestContext } from '../guest-session/session';
import { openPractice } from './attempts';

// The practice of one guest, opened once per request: the shared layout and
// the block page read the same attempt. The arguments are the per-request
// deps and guest, so the cache is not shared between requests.
export const getOpenedPractice = cache(
  (deps: ServerDeps, guest: GuestContext, slug: string | undefined) =>
    openPractice(deps, guest, slug),
);
