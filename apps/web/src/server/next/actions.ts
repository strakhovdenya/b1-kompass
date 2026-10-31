'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { isLocale } from '@b1k/domain';
import type {
  FinishAttemptResult,
  SaveAnswerResult,
  SaveProgressResult,
} from '@b1k/domain';
import {
  finishAttempt,
  readActiveProgress,
  saveAnswer,
  saveProgress,
} from '../attempts/attempts';
import type { ServerDeps } from '../db';
import { resolveAttemptAudio } from '../audio/audio';
import type { AudioAccessResult } from '../audio/audio';
import type { GuestContext } from '../guest-session/session';
import {
  createGuestSession,
  resolveGuestSession,
  setGuestLocale,
} from '../guest-session/session';
import {
  getServerDeps,
  readGuestSessionsPerMinute,
  readGuestToken,
  writeGuestCookie,
} from './request';

const LESEN_PATH = '/practice/lesen';

// A returning guest enters the block where they stopped. Anything but an
// active attempt with a stored Lesen place opens Hoeren, as before.
const practiceEntry = async (
  deps: ServerDeps,
  guest: GuestContext | null,
): Promise<string> => {
  if (!guest) return '/practice';
  const progress = await readActiveProgress(deps, guest);
  return progress?.block === 'lesen' ? LESEN_PATH : '/practice';
};

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
  redirect(await practiceEntry(deps, current));
};

export const saveAnswerAction = async (
  input: unknown,
): Promise<SaveAnswerResult> =>
  saveAnswer(getServerDeps(), await readGuestToken(), input);

export const saveProgressAction = async (
  input: unknown,
): Promise<SaveProgressResult> =>
  saveProgress(getServerDeps(), await readGuestToken(), input);

export const finishAttemptAction = async (
  input: unknown,
): Promise<FinishAttemptResult> =>
  finishAttempt(getServerDeps(), await readGuestToken(), input);

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
