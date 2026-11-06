import { describe, expect, it } from 'vitest';
import type { ExamContent } from '@b1k/domain';
import {
  parsePinnedDurations,
  toLifecycleState,
  toPracticeState,
} from './projection';
import type { AttemptRunView } from './projection';

const option = (id: string) => ({ id, text: `Antwort ${id}` });

const content: ExamContent = {
  source: {
    publisher: 'Test',
    title: 'Test',
    url: 'https://example.test/',
    page: 1,
  },
  questions: [
    {
      id: 'hoeren-1',
      number: 1,
      kind: 'single-choice',
      skill: 'hoeren',
      teil: 1,
      prompt: 'Hören eins?',
      options: [option('a'), option('b')],
      trackId: 'track-1',
    },
    {
      id: 'lesen-1',
      number: 1,
      kind: 'single-choice',
      skill: 'lesen',
      teil: 1,
      prompt: 'Lesen eins?',
      options: [option('a'), option('b')],
      textId: 'text-1',
    },
    {
      id: 'lesen-2',
      number: 2,
      kind: 'single-choice',
      skill: 'lesen',
      teil: 1,
      prompt: 'Lesen zwei?',
      options: [option('a'), option('b')],
      textId: 'text-2',
    },
  ],
  texts: [
    { id: 'text-1', title: 'Eins', body: 'Text eins' },
    { id: 'text-2', title: 'Zwei', body: 'Text zwei' },
  ],
  groups: [
    {
      id: 'pair-1',
      kind: 'pair',
      teil: 3,
      trackId: 'track-1',
      questionIds: ['hoeren-1'],
    },
  ],
};

const view = (questionIds: string[]): AttemptRunView => ({
  attemptId: '00000000-0000-4000-8000-000000000001',
  examId: '00000000-0000-4000-8000-000000000002',
  examSlug: 'test',
  versionId: '00000000-0000-4000-8000-000000000003',
  scope: 'short-set',
  status: 'active',
  mode: 'training',
  purpose: 'normal',
  selection: 'lesen',
  sourceAttemptId: null,
  questionIds,
  acceptedAt: '2026-11-01T10:00:00.000Z',
  durations: {},
  isClosedByDeadline: false,
});

const project = (questionIds: string[]) =>
  toPracticeState({
    view: view(questionIds),
    examTitle: 'Test',
    content,
    selections: {},
    revisions: {},
    trackIds: ['track-1'],
    review: null,
    progress: null,
  });

describe('toPracticeState', () => {
  it('keeps only the assigned tasks with their texts', () => {
    const state = project(['lesen-1']);
    expect(state.questions.map((item) => item.id)).toEqual(['lesen-1']);
    expect(state.texts.map((item) => item.id)).toEqual(['text-1']);
  });

  it('gives a Lesen-only attempt no recording and no Hören group', () => {
    const state = project(['lesen-1', 'lesen-2']);
    expect(state.trackIds).toEqual([]);
    expect(state.groups).toEqual([]);
  });

  it('keeps the recording and its group for a Hören attempt', () => {
    const state = project(['hoeren-1']);
    expect(state.trackIds).toEqual(['track-1']);
    expect(state.groups.map((item) => item.id)).toEqual(['pair-1']);
    expect(state.texts).toEqual([]);
  });
});

const ACCEPTED_MS = Date.parse('2026-11-01T10:00:00.000Z');

const pinned = {
  revisionId: '00000000-0000-4000-8000-000000000009',
  hoerenSeconds: 1500,
  transitionSeconds: 60,
  lesenSeconds: 2700,
};

const timedView = (
  selection: 'hoeren' | 'lesen',
  status = 'active',
): AttemptRunView => ({
  ...view(['hoeren-1']),
  mode: 'timed-block',
  selection,
  status,
  durations: parsePinnedDurations(pinned) ?? {},
});

describe('toLifecycleState', () => {
  it('gives a timed block the deadline of its pinned skill duration', () => {
    const hoeren = toLifecycleState(timedView('hoeren'), ACCEPTED_MS + 60_000);
    expect(hoeren).toMatchObject({
      mode: 'timed-block',
      phase: 'hoeren',
      phaseRevision: 0,
      deadlineMs: ACCEPTED_MS + 1_500_000,
      remainingMs: 1_440_000,
      openSkills: ['hoeren'],
    });
    const lesen = toLifecycleState(timedView('lesen'), ACCEPTED_MS);
    expect(lesen?.deadlineMs).toBe(ACCEPTED_MS + 2_700_000);
    // At the deadline the block is closed, a millisecond before it open:
    // the same boundary as the database.
    const atDeadline = toLifecycleState(
      timedView('hoeren'),
      ACCEPTED_MS + 1_500_000,
    );
    expect(atDeadline).toMatchObject({ phase: 'closed', remainingMs: 0 });
    expect(
      toLifecycleState(timedView('hoeren'), ACCEPTED_MS + 1_499_999)?.phase,
    ).toBe('hoeren');
    // A closed run is closed whatever the moment.
    expect(
      toLifecycleState(timedView('hoeren', 'submitted'), ACCEPTED_MS)?.phase,
    ).toBe('closed');
  });

  it('keeps a free or legacy run without deadline and refuses a broken pin', () => {
    const free = toLifecycleState(view(['lesen-1']), ACCEPTED_MS + 1e9);
    expect(free).toMatchObject({
      mode: 'training',
      phase: 'open',
      deadlineMs: null,
      remainingMs: null,
    });
    expect(parsePinnedDurations(null)).toEqual({});
    expect(parsePinnedDurations(pinned)).toEqual({
      hoerenMs: 1_500_000,
      transitionMs: 60_000,
      lesenMs: 2_700_000,
    });
    for (const broken of [
      { ...pinned, hoerenSeconds: 0 },
      { ...pinned, lesenSeconds: '2700' },
      [],
      'pinned',
    ]) {
      expect(parsePinnedDurations(broken)).toBeNull();
    }
    // A timed run without durations has no deadline to show: refused.
    expect(
      toLifecycleState({ ...timedView('hoeren'), durations: {} }, ACCEPTED_MS),
    ).toBeNull();
  });
});
