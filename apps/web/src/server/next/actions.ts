'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { isLocale } from '@b1k/domain';
import { resolveAttemptAudio } from '../audio/audio';
import type { AudioAccessResult } from '../audio/audio';
import { preflightTimedStart } from '../attempts/start';
import {
  createGuestSession,
  replaceGuestSession,
  resolveGuestSession,
  setGuestLocale,
} from '../guest-session/session';
import type { GuestReplacementAnswer } from '../../features/training/attempt-client';
import {
  getServerDeps,
  readDefaultExamSlug,
  readGuestSessionsPerMinute,
  readGuestToken,
  resolveExamEntry,
  writeGuestCookie,
} from './request';

// Over the site-wide limit no session and no cookie are created; the home
// page shows the busy notice instead.
export const continueAsGuest = async (): Promise<void> => {
  const deps = getServerDeps();
  const current = await resolveGuestSession(deps, await readGuestToken());
  if (!current) {
    const result = await createGuestSession(deps, readGuestSessionsPerMinute());
    if (result.status === 'rate-limited') redirect('/?busy=1');
    await writeGuestCookie(result.created);
  }
  redirect(await resolveExamEntry(deps, current, readDefaultExamSlug()));
};

// Saves, the submission, the cancel and the status are independent HTTP
// commands under app/api/attempts: none of them waits in the queue of server
// actions.

export const resolveAudioAction = async (
  input: unknown,
): Promise<AudioAccessResult> =>
  resolveAttemptAudio(getServerDeps(), await readGuestToken(), input);

export const setLocaleAction = async (locale: unknown): Promise<boolean> => {
  if (!isLocale(locale)) return false;
  const deps = getServerDeps();
  const guest = await resolveGuestSession(deps, await readGuestToken());
  if (!guest) return false;
  const isSaved = await setGuestLocale(deps, guest, locale);
  if (isSaved) revalidatePath('/', 'layout');
  return isSaved;
};

// The explicit replacement of a guest too short for a timed block (#44).
// The consent is the user's intent, not an authority: the old session comes
// from the httpOnly cookie only, and the read-only preflight of the very
// start runs again here. A new guest and cookie exist only when that
// preflight itself says guest-too-short and the site-wide limit allows one.
// The chosen block is then started by a separate request with the new cookie.
const replacementInput = z.strictObject({
  consent: z.literal(true),
  start: z.unknown(),
});

export const replaceGuestAction = async (
  input: unknown,
): Promise<GuestReplacementAnswer> => {
  const parsed = replacementInput.safeParse(input);
  if (!parsed.success) return { status: 'refused', failure: 'invalid-input' };
  const deps = getServerDeps();
  const token = await readGuestToken();
  try {
    const result = await replaceGuestSession(
      deps,
      readGuestSessionsPerMinute(),
      () => preflightTimedStart(deps, token, parsed.data.start),
    );
    if (result.status !== 'created') return result;
    await writeGuestCookie(result.created);
    revalidatePath('/', 'layout');
    return { status: 'replaced' };
  } catch (error) {
    console.error({ error });
    return { status: 'refused', failure: 'unavailable' };
  }
};
