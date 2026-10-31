import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { createServiceClient, readServiceConfig, systemClock } from '../db';
import type { ServerDeps } from '../db';
import { GUEST_COOKIE } from '../guest-session/cookie';
import { resolveGuestSession } from '../guest-session/session';
import type { CreatedGuest, GuestContext } from '../guest-session/session';

let deps: ServerDeps | null = null;

export const getServerDeps = (): ServerDeps => {
  if (!deps) {
    const db = createServiceClient(readServiceConfig(process.env));
    deps = { db, clock: systemClock };
  }
  return deps;
};

const DEFAULT_GUEST_SESSIONS_PER_MINUTE = 30;

// The site-wide number of new guest sessions per minute; a missing or
// invalid value falls back to the default.
export const readGuestSessionsPerMinute = (): number => {
  const value = Number(process.env.GUEST_SESSIONS_PER_MINUTE);
  const isValid = Number.isSafeInteger(value) && value > 0;
  return isValid ? value : DEFAULT_GUEST_SESSIONS_PER_MINUTE;
};

export const readGuestToken = async (): Promise<string | null> => {
  const store = await cookies();
  return store.get(GUEST_COOKIE)?.value ?? null;
};

export const writeGuestCookie = async (
  created: CreatedGuest,
): Promise<void> => {
  const store = await cookies();
  store.set(GUEST_COOKIE, created.token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    expires: created.guest.expiresAt,
  });
};

// One verified guest per request, shared by the layout, the locale config
// and pages. An unavailable database must not take down public pages, so a
// failed lookup is logged and treated as "no guest".
export const getCurrentGuest = cache(async (): Promise<GuestContext | null> => {
  const token = await readGuestToken();
  if (!token) return null;
  try {
    return await resolveGuestSession(getServerDeps(), token);
  } catch (error) {
    console.error({ error });
    return null;
  }
});
