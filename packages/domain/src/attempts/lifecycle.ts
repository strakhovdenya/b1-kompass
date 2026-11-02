import {
  ATTEMPT_MODES,
  ATTEMPT_SELECTIONS,
  ATTEMPT_STATUSES,
  SKILLS,
} from './contracts';
import type {
  AdmissionResult,
  AttemptMode,
  AttemptOperation,
  AttemptPhase,
  AttemptSelection,
  AttemptStatus,
  LifecycleError,
  LifecycleInput,
  LifecycleResult,
  LifecycleState,
  Skill,
} from './contracts';

interface Parsed {
  readonly mode: AttemptMode;
  readonly selection: AttemptSelection;
  readonly status: AttemptStatus;
  readonly startedAtMs: number;
  readonly hoerenMs: number;
  readonly transitionMs: number;
  readonly lesenMs: number;
  readonly lesenStartedAtMs: number | null;
  readonly closedSkills: readonly Skill[];
  readonly atMs: number;
}

type ParseResult =
  { ok: true; parsed: Parsed } | { ok: false; error: LifecycleError };

interface Resolved {
  readonly phase: AttemptPhase;
  readonly phaseRevision: number;
  readonly deadlineMs: number | null;
  readonly endsAtMs: number | null;
  readonly lesenStartedAtMs: number | null;
  readonly closedByPhase: readonly Skill[];
}

const EXAM_CLOSED = 3;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isPositive = (value: unknown): value is number =>
  isFiniteNumber(value) && value > 0;

const isOneOf = <T extends string>(
  values: readonly T[],
  value: unknown,
): value is T => values.some((item) => item === value);

const fail = (error: LifecycleError): ParseResult => ({ ok: false, error });

const skillsOf = (selection: AttemptSelection): readonly Skill[] =>
  selection === 'all' ? SKILLS : [selection];

const requiredDurations = (
  mode: AttemptMode,
  selection: AttemptSelection,
): readonly (keyof LifecycleInput['durations'])[] => {
  if (mode === 'exam') return ['hoerenMs', 'transitionMs', 'lesenMs'];
  if (mode === 'timed-block') {
    return selection === 'hoeren' ? ['hoerenMs'] : ['lesenMs'];
  }
  return [];
};

const isCombinationValid = (
  mode: AttemptMode,
  selection: AttemptSelection,
): boolean => {
  if (mode === 'exam') return selection === 'all';
  if (mode === 'timed-block') return selection !== 'all';
  return true;
};

const parseDurations = (
  input: LifecycleInput,
  mode: AttemptMode,
  selection: AttemptSelection,
): LifecycleError | null => {
  const { durations } = input;
  const given = [durations.hoerenMs, durations.transitionMs, durations.lesenMs];
  if (given.some((value) => value !== undefined && !isPositive(value))) {
    return 'invalid-duration';
  }
  const required = requiredDurations(mode, selection);
  if (required.some((key) => durations[key] === undefined)) {
    return 'invalid-duration';
  }
  return null;
};

const parseSkills = (values: readonly string[]): readonly Skill[] | null => {
  if (!Array.isArray(values)) return null;
  if (!values.every((value) => isOneOf(SKILLS, value))) return null;
  return SKILLS.filter((skill) => values.includes(skill));
};

const parse = (input: LifecycleInput, atMs: number): ParseResult => {
  const { mode, selection, status } = input;
  if (!isOneOf(ATTEMPT_MODES, mode)) return fail('unknown-mode');
  if (!isOneOf(ATTEMPT_SELECTIONS, selection)) {
    return fail('unknown-selection');
  }
  if (!isOneOf(ATTEMPT_STATUSES, status)) return fail('unknown-status');
  if (!isCombinationValid(mode, selection)) return fail('invalid-combination');

  const { startedAtMs, lesenStartedAtMs } = input;
  if (!isFiniteNumber(startedAtMs) || !isFiniteNumber(atMs)) {
    return fail('invalid-time');
  }
  if (atMs < startedAtMs) return fail('invalid-time');
  if (lesenStartedAtMs !== null && !isFiniteNumber(lesenStartedAtMs)) {
    return fail('invalid-time');
  }

  const durationError = parseDurations(input, mode, selection);
  if (durationError) return fail(durationError);
  const { hoerenMs = 0, transitionMs = 0, lesenMs = 0 } = input.durations;
  const latestEndMs = startedAtMs + hoerenMs + transitionMs + lesenMs;
  if (!Number.isFinite(latestEndMs)) return fail('invalid-duration');

  const closedSkills = parseSkills(input.closedSkills);
  if (!closedSkills) return fail('invalid-state');

  if (lesenStartedAtMs !== null) {
    const transitionStartMs = startedAtMs + hoerenMs;
    const transitionEndMs = transitionStartMs + transitionMs;
    const isInTransition =
      lesenStartedAtMs >= transitionStartMs &&
      lesenStartedAtMs <= transitionEndMs;
    if (mode !== 'exam' || !isInTransition) return fail('invalid-state');
  }

  return {
    ok: true,
    parsed: {
      mode,
      selection,
      status,
      startedAtMs,
      hoerenMs,
      transitionMs,
      lesenMs,
      lesenStartedAtMs,
      closedSkills,
      atMs,
    },
  };
};

const examPhaseOf = (rank: number): AttemptPhase => {
  if (rank === 0) return 'hoeren';
  if (rank === 1) return 'transition';
  if (rank === 2) return 'lesen';
  return 'closed';
};

const examRankByTime = (parsed: Parsed): number => {
  const { atMs, startedAtMs, hoerenMs, transitionMs, lesenMs } = parsed;
  const hoerenEndMs = startedAtMs + hoerenMs;
  const transitionEndMs = hoerenEndMs + transitionMs;
  const lesenStartMs = parsed.lesenStartedAtMs ?? transitionEndMs;
  if (atMs < hoerenEndMs) return 0;
  if (parsed.lesenStartedAtMs === null && atMs < transitionEndMs) return 1;
  return atMs < lesenStartMs + lesenMs ? 2 : EXAM_CLOSED;
};

// What is already recorded keeps its phase even if `at` is earlier than
// the moment it closed: a closed phase never reopens.
const examRankByRecord = (parsed: Parsed): number => {
  if (parsed.closedSkills.includes('lesen')) return EXAM_CLOSED;
  if (parsed.lesenStartedAtMs !== null) return 2;
  return parsed.closedSkills.includes('hoeren') ? 1 : 0;
};

const resolveExam = (parsed: Parsed): Resolved => {
  const { startedAtMs, hoerenMs, transitionMs, lesenMs } = parsed;
  const hoerenEndMs = startedAtMs + hoerenMs;
  const transitionEndMs = hoerenEndMs + transitionMs;
  const lesenStartMs = parsed.lesenStartedAtMs ?? transitionEndMs;
  const lesenEndMs = lesenStartMs + lesenMs;
  const rank =
    parsed.status === 'active'
      ? Math.max(examRankByTime(parsed), examRankByRecord(parsed))
      : EXAM_CLOSED;
  const deadlines = [hoerenEndMs, transitionEndMs, lesenEndMs, null];
  let closedByPhase: readonly Skill[] = [];
  if (rank >= EXAM_CLOSED) closedByPhase = SKILLS;
  else if (rank >= 1) closedByPhase = ['hoeren'];
  return {
    phase: examPhaseOf(rank),
    phaseRevision: rank,
    deadlineMs: deadlines[rank] ?? null,
    endsAtMs: lesenEndMs,
    lesenStartedAtMs: parsed.lesenStartedAtMs,
    closedByPhase,
  };
};

const resolveTimedBlock = (parsed: Parsed): Resolved => {
  const skill: Skill = parsed.selection === 'hoeren' ? 'hoeren' : 'lesen';
  const durationMs = skill === 'hoeren' ? parsed.hoerenMs : parsed.lesenMs;
  const endsAtMs = parsed.startedAtMs + durationMs;
  const isOpen =
    parsed.status === 'active' &&
    !parsed.closedSkills.includes(skill) &&
    parsed.atMs < endsAtMs;
  return {
    phase: isOpen ? skill : 'closed',
    phaseRevision: isOpen ? 0 : 1,
    deadlineMs: isOpen ? endsAtMs : null,
    endsAtMs,
    lesenStartedAtMs: null,
    closedByPhase: isOpen ? [] : [skill],
  };
};

const resolveTraining = (parsed: Parsed): Resolved => {
  const isOpen = parsed.status === 'active';
  return {
    phase: isOpen ? 'open' : 'closed',
    phaseRevision: isOpen ? 0 : 1,
    deadlineMs: null,
    endsAtMs: null,
    lesenStartedAtMs: null,
    closedByPhase: isOpen ? [] : skillsOf(parsed.selection),
  };
};

const resolvers: Record<AttemptMode, (parsed: Parsed) => Resolved> = {
  training: resolveTraining,
  'timed-block': resolveTimedBlock,
  exam: resolveExam,
};

const openSkillsOf = (
  phase: AttemptPhase,
  selection: AttemptSelection,
): readonly Skill[] => {
  if (phase === 'open') return skillsOf(selection);
  if (phase === 'hoeren' || phase === 'lesen') return [phase];
  return [];
};

const toState = (parsed: Parsed): LifecycleState => {
  const resolved = resolvers[parsed.mode](parsed);
  const { deadlineMs, phase } = resolved;
  let remainingMs: number | null = null;
  if (phase === 'closed') remainingMs = 0;
  else if (deadlineMs !== null) {
    remainingMs = Math.max(0, deadlineMs - parsed.atMs);
  }
  const closedSkills = SKILLS.filter(
    (skill) =>
      resolved.closedByPhase.includes(skill) ||
      parsed.closedSkills.includes(skill),
  );
  return {
    mode: parsed.mode,
    selection: parsed.selection,
    status: parsed.status,
    phase,
    phaseRevision: resolved.phaseRevision,
    openSkills: openSkillsOf(phase, parsed.selection).filter(
      (skill) => !closedSkills.includes(skill),
    ),
    closedSkills,
    startedAtMs: parsed.startedAtMs,
    lesenStartedAtMs: resolved.lesenStartedAtMs,
    deadlineMs,
    endsAtMs: resolved.endsAtMs,
    remainingMs,
  };
};

// Pure: the phase and the remaining time at the explicitly given `atMs`.
export const resolveLifecycle = (
  input: LifecycleInput,
  atMs: number,
): LifecycleResult => {
  const result = parse(input, atMs);
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, state: toState(result.parsed) };
};

const admitBeginLesen = (
  parsed: Parsed,
  state: LifecycleState,
): AdmissionResult => {
  if (parsed.mode !== 'exam' || state.phase === 'hoeren') {
    return { ok: false, reason: 'phase-not-open', state };
  }
  if (state.phase === 'lesen') return { ok: true, changed: false, state };
  const transitionStartMs = parsed.startedAtMs + parsed.hoerenMs;
  if (parsed.atMs < transitionStartMs) {
    return { ok: false, reason: 'phase-not-open', state };
  }
  const started = { ...parsed, lesenStartedAtMs: parsed.atMs };
  return { ok: true, changed: true, state: toState(started) };
};

const admitAnswer = (skill: string, state: LifecycleState): AdmissionResult => {
  const isOpen = state.openSkills.some((open) => open === skill);
  if (isOpen) return { ok: true, changed: false, state };
  return { ok: false, reason: 'skill-not-open', state };
};

const isOperation = (operation: AttemptOperation): boolean => {
  if (typeof operation !== 'object' || operation === null) return false;
  if (operation.kind === 'answer') return isOneOf(SKILLS, operation.skill);
  return ['submit', 'cancel', 'begin-lesen'].includes(operation.kind);
};

// Pure admission by mode, status, skill, phase and time. It does not
// authorize the guest, the owner or the assigned question: the server does.
export const admitOperation = (
  input: LifecycleInput,
  operation: AttemptOperation,
  atMs: number,
): AdmissionResult => {
  const result = parse(input, atMs);
  if (!result.ok) {
    return { ok: false, reason: 'invalid-input', error: result.error };
  }
  if (!isOperation(operation)) {
    return { ok: false, reason: 'invalid-input', error: 'invalid-operation' };
  }
  const { parsed } = result;
  const state = toState(parsed);
  if (state.phase === 'closed') {
    return { ok: false, reason: 'closed-phase', state };
  }
  if (operation.kind === 'begin-lesen') return admitBeginLesen(parsed, state);
  if (operation.kind === 'answer') return admitAnswer(operation.skill, state);
  return { ok: true, changed: false, state };
};
