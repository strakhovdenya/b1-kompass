'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { isLocale } from '@b1k/domain';
import type {
  FinishAttemptResult,
  SaveAnswerResult,
  SaveProgressResult,
} from '@b1k/domain';
import { finishAttempt, saveAnswer, saveProgress } from '../attempts/attempts';
import { resolveAttemptAudio } from '../audio/audio';
import type { AudioAccessResult } from '../audio/audio';
import {
  createGuestSession,
  resolveGuestSession,
  setGuestLocale,
} from '../guest-session/session';
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
