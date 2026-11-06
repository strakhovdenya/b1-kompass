import { describe, expect, it } from 'vitest';
import type { ExamQuestion } from '@b1k/domain';
import type { AttemptSummary, SkillSummary } from './attempt-client';
import { confirmationOf } from './useAttemptSubmission';

// The confirmation of an early submission of a full exam (#45): the page
// knows only the visible phase, the server's numbers cover the hidden Lesen.

const question = (id: string, skill: 'hoeren' | 'lesen'): ExamQuestion => ({
  id,
  number: 1,
  kind: 'single-choice',
  skill,
  teil: 1,
  prompt: `Frage ${id}?`,
  options: [{ id: 'a', text: 'Erste' }],
});

const range = (skill: 'hoeren' | 'lesen', count: number): ExamQuestion[] =>
  Array.from({ length: count }, (_, index) =>
    question(`${skill}-${index + 1}`, skill),
  );

const HOEREN = range('hoeren', 20);
const LESEN = range('lesen', 25);

const part = (
  assigned: number,
  answered: number,
  state: SkillSummary['state'],
): SkillSummary => ({ assigned, answered, state });

const summaryOf = (
  hoeren: SkillSummary,
  lesen: SkillSummary,
): AttemptSummary => ({ totalAssigned: 45, skills: { hoeren, lesen } });

const answer = (questionId: string, revision = 1) => ({
  questionId,
  optionId: 'a',
  revision,
});

const NONE: ReadonlySet<string> = new Set();

describe('confirmationOf for a full exam', () => {
  it('counts all 45 as skipped in Hören with nothing answered', () => {
    const confirmation = confirmationOf({
      questions: HOEREN,
      answers: [],
      phaseRevision: 0,
      stored: NONE,
      summary: summaryOf(part(20, 0, 'open'), part(25, 0, 'unopened')),
    });
    expect(confirmation).toEqual({
      phaseRevision: 0,
      skipped: 45,
      unanswered: { hoeren: 20, lesen: 25 },
      unopened: 25,
    });
  });

  it('counts hidden Lesen tasks it never received as skipped', () => {
    // Three Hören answers on this page, one of them still in flight; the 25
    // Lesen tasks are not on the page at all.
    const confirmation = confirmationOf({
      questions: HOEREN,
      answers: [answer('hoeren-1'), answer('hoeren-2'), answer('hoeren-3', 2)],
      phaseRevision: 0,
      stored: new Set(['hoeren-1']),
      summary: summaryOf(part(20, 1, 'open'), part(25, 0, 'unopened')),
    });
    expect(confirmation.skipped).toBe(42);
    expect(confirmation.unanswered).toEqual({ hoeren: 17, lesen: 25 });
    expect(confirmation.unopened).toBe(25);
  });

  it('ignores late pending choices of a closed Hören in the transition', () => {
    // The page still holds two Hören choices the server refused after the
    // deadline; only the 4 answers the server accepted in time count.
    const confirmation = confirmationOf({
      questions: HOEREN,
      answers: [answer('hoeren-1'), answer('hoeren-19'), answer('hoeren-20')],
      phaseRevision: 1,
      stored: new Set(['hoeren-1']),
      summary: summaryOf(part(20, 4, 'closed'), part(25, 0, 'unopened')),
    });
    expect(confirmation).toEqual({
      phaseRevision: 1,
      skipped: 41,
      unanswered: { hoeren: 16, lesen: 25 },
      unopened: 25,
    });
  });

  it('counts the open Lesen with pending choices and the frozen Hören', () => {
    const confirmation = confirmationOf({
      questions: LESEN,
      answers: [answer('lesen-1'), answer('lesen-2'), answer('hoeren-5', 9)],
      phaseRevision: 2,
      stored: NONE,
      summary: summaryOf(part(20, 18, 'closed'), part(25, 0, 'open')),
    });
    expect(confirmation).toEqual({
      phaseRevision: 2,
      skipped: 25,
      unanswered: { hoeren: 2, lesen: 23 },
      unopened: 0,
    });
  });

  it('renews a stale confirmation with the phase the server reported', () => {
    // The page confirmed in Hören; the server answered stale-confirmation
    // because the transition began. The renewal names the new phase and the
    // server's numbers, so the same confirmation is not sent forever.
    const before = confirmationOf({
      questions: HOEREN,
      answers: [answer('hoeren-1'), answer('hoeren-2')],
      phaseRevision: 0,
      stored: NONE,
      summary: summaryOf(part(20, 0, 'open'), part(25, 0, 'unopened')),
    });
    const renewed = confirmationOf({
      questions: HOEREN,
      answers: [answer('hoeren-1'), answer('hoeren-2')],
      phaseRevision: 1,
      stored: new Set(['hoeren-1']),
      summary: summaryOf(part(20, 1, 'closed'), part(25, 0, 'unopened')),
    });
    expect(before).toMatchObject({ phaseRevision: 0, skipped: 43 });
    expect(renewed).toMatchObject({ phaseRevision: 1, skipped: 44 });
    expect(renewed.phaseRevision).not.toBe(before.phaseRevision);
  });

  it('keeps the free training count of the tasks on the page', () => {
    const questions = [...HOEREN.slice(0, 2), ...LESEN.slice(0, 1)];
    const free = confirmationOf({
      questions,
      answers: [answer('hoeren-1')],
      phaseRevision: 0,
      stored: NONE,
      summary: null,
    });
    expect(free).toEqual({
      phaseRevision: 0,
      skipped: 2,
      unanswered: { hoeren: 1, lesen: 1 },
      unopened: 0,
    });
    const withSummary = confirmationOf({
      questions,
      answers: [answer('hoeren-1')],
      phaseRevision: 0,
      stored: NONE,
      summary: {
        totalAssigned: 3,
        skills: { hoeren: part(2, 0, 'open'), lesen: part(1, 0, 'open') },
      },
    });
    expect(withSummary).toEqual(free);
  });
});
