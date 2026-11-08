import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { createServiceClient, readServiceConfig, systemClock } from '../db';
import type { ServerDeps } from '../db';
import {
  attemptLesenPath,
  attemptPath,
  choicePath,
} from '../../features/training/attempt-client';
import { findOwnedActive } from '../attempts/read';
import { GUEST_COOKIE } from '../guest-session/cookie';
import { PILOT_EXAM_SLUG } from '../material/published';
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

// The exam of the legacy addresses `/practice` and `/practice/lesen` only: the
// configured pilot by default. The guest entry goes through the library
// (`/exams`) and never uses it. It never chooses the exam of an attempt
// already started.
export const readDefaultExamSlug = (): string =>
  process.env.PRACTICE_EXAM_SLUG || PILOT_EXAM_SLUG;

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

// Where a guest enters an exam: their own active attempt of it, in the block
// where they stopped, or the choice. Nothing is created or started here.
export const resolveExamEntry = async (
  deps: ServerDeps,
  guest: GuestContext | null,
  examSlug: string,
  block: 'hoeren' | 'lesen' | null = null,
): Promise<string> => {
  if (!guest) return choicePath(examSlug);
  const active = await findOwnedActive(deps, guest, examSlug);
  if (!active) return choicePath(examSlug);
  const isLesen = (block ?? active.progress?.block) === 'lesen';
  return isLesen
    ? attemptLesenPath(active.examSlug, active.attemptId)
    : attemptPath(active.examSlug, active.attemptId);
};
