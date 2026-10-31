'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { isLocale } from '@b1k/domain';
import type { FinishAttemptResult, SaveAnswerResult } from '@b1k/domain';
import { finishAttempt, saveAnswer } from '../attempts/attempts';
import { resolveAttemptAudio } from '../audio/audio';
import type { AudioAccessResult } from '../audio/audio';
import {
  createGuestSession,
  resolveGuestSession,
  setGuestLocale,
} from '../guest-session/session';
import { getServerDeps, readGuestToken, writeGuestCookie } from './request';

export const continueAsGuest = async (): Promise<void> => {
  const deps = getServerDeps();
  const current = await resolveGuestSession(deps, await readGuestToken());
  if (!current) await writeGuestCookie(await createGuestSession(deps));
  redirect('/practice');
};

export const saveAnswerAction = async (
  input: unknown,
): Promise<SaveAnswerResult> =>
  saveAnswer(getServerDeps(), await readGuestToken(), input);

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
