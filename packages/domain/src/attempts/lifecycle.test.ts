import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { admitOperation, resolveLifecycle } from '@b1k/domain';
import type {
  AttemptProgress,
  AttemptOperation,
  LifecycleInput,
  LifecycleState,
} from '@b1k/domain';

// Synthetic oracle (not a real recording profile): Hören 25 min,
// transition 60 s, Lesen 45 min.
const HOEREN_MS = 1_500_000;
const TRANSITION_MS = 60_000;
const LESEN_MS = 2_700_000;
const TRANSITION_END_MS = 1_560_000;
const EXAM_END_MS = 4_260_000;

const examInput: LifecycleInput = {
  mode: 'exam',
  selection: 'all',
  status: 'active',
  startedAtMs: 0,
  durations: {
    hoerenMs: HOEREN_MS,
    transitionMs: TRANSITION_MS,
    lesenMs: LESEN_MS,
  },
  closedSkills: [],
  lesenStartedAtMs: null,
};

const trainingInput: LifecycleInput = {
  mode: 'training',
  selection: 'all',
  status: 'active',
  startedAtMs: 0,
  durations: {},
  closedSkills: [],
  lesenStartedAtMs: null,
};

const timedInput = (selection: 'hoeren' | 'lesen'): LifecycleInput => ({
  mode: 'timed-block',
  selection,
  status: 'active',
  startedAtMs: 1000,
  durations:
    selection === 'hoeren' ? { hoerenMs: 600_000 } : { lesenMs: 900_000 },
  closedSkills: [],
  lesenStartedAtMs: null,
});

const resolve = (input: LifecycleInput, atMs: number): LifecycleState => {
  const result = resolveLifecycle(input, atMs);
  if (!result.ok) throw new Error(`unexpected error ${result.error}`);
  return result.state;
};

const answer = (skill: string): AttemptOperation => ({ kind: 'answer', skill });
const submit: AttemptOperation = { kind: 'submit' };
const cancel: AttemptOperation = { kind: 'cancel' };
const beginLesen: AttemptOperation = { kind: 'begin-lesen' };

const deepFreeze = <T extends object>(value: T): T => {
  for (const child of Object.values(value)) {
    if (typeof child === 'object' && child !== null) deepFreeze(child);
  }
  return Object.freeze(value);
};

// Type-checks a consumer snippet against the real public package, so a
// compile error is observed without any suppression comment in the test.
const MISSING_PROPERTY_CODE = 2741;
const DOMAIN_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
).replaceAll('\\', '/');
const CONSUMER_FILE = `${DOMAIN_DIR}/src/attempts/consumer.virtual.ts`;

const compileConsumer = (
  lines: readonly string[],
): readonly ts.Diagnostic[] => {
  const source = lines.join('\n');
  const configPath = `${DOMAIN_DIR}/tsconfig.json`;
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    DOMAIN_DIR,
  );
  const host = ts.createCompilerHost(parsed.options);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (name) => name === CONSUMER_FILE || fileExists(name);
  host.readFile = (name) => (name === CONSUMER_FILE ? source : readFile(name));
  host.getSourceFile = (name, languageVersion, onError) =>
    name === CONSUMER_FILE
      ? ts.createSourceFile(name, source, languageVersion)
      : getSourceFile(name, languageVersion, onError);
  const program = ts.createProgram([CONSUMER_FILE], parsed.options, host);
  const sourceFile = program.getSourceFile(CONSUMER_FILE);
  if (!sourceFile) throw new Error('consumer snippet was not compiled');
  return program.getSemanticDiagnostics(sourceFile);
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('lifecycle', () => {
  it('calculates training block and full exam phases', () => {
    const training = resolve(trainingInput, 999_999_999);
    expect(training.phase).toBe('open');
    expect(training.deadlineMs).toBeNull();
    expect(training.endsAtMs).toBeNull();
    expect(training.remainingMs).toBeNull();
    expect(training.openSkills).toEqual(['hoeren', 'lesen']);

    const block = resolve(timedInput('lesen'), 500_000);
    expect(block.phase).toBe('lesen');
    expect(block.deadlineMs).toBe(901_000);
    expect(block.endsAtMs).toBe(901_000);
    expect(block.remainingMs).toBe(401_000);
    expect(block.openSkills).toEqual(['lesen']);

    expect(resolve(examInput, 0).phase).toBe('hoeren');
    expect(resolve(examInput, 1_499_999).phase).toBe('hoeren');
    expect(resolve(examInput, 1_500_000).phase).toBe('transition');
    expect(resolve(examInput, 1_559_999).phase).toBe('transition');
    const lesen = resolve(examInput, TRANSITION_END_MS);
    expect(lesen.phase).toBe('lesen');
    expect(lesen.deadlineMs).toBe(EXAM_END_MS);
    expect(resolve(examInput, 4_259_999).phase).toBe('lesen');
    const closed = resolve(examInput, EXAM_END_MS);
    expect(closed.phase).toBe('closed');
    expect(closed.deadlineMs).toBeNull();
    expect(closed.remainingMs).toBe(0);
  });

  it('early lesen and automatic transition retain full duration', () => {
    const early = resolve(
      { ...examInput, lesenStartedAtMs: 1_530_000 },
      1_530_000,
    );
    expect(early.phase).toBe('lesen');
    expect(early.lesenStartedAtMs).toBe(1_530_000);
    expect(early.deadlineMs).toBe(4_230_000);
    expect(early.remainingMs).toBe(LESEN_MS);

    const accepted = admitOperation(examInput, beginLesen, 1_530_000);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.changed).toBe(true);
    expect(accepted.state.lesenStartedAtMs).toBe(1_530_000);
    expect(accepted.state.deadlineMs).toBe(4_230_000);
    expect(accepted.state.phaseRevision).toBe(2);

    const automatic = resolve(examInput, TRANSITION_END_MS);
    expect(automatic.lesenStartedAtMs).toBeNull();
    expect(automatic.deadlineMs).toBe(EXAM_END_MS);
    expect(automatic.remainingMs).toBe(LESEN_MS);
  });

  it('catches up across transition and final deadline', () => {
    const inTransition = resolve(examInput, 1_530_000);
    expect(inTransition.phase).toBe('transition');
    expect(inTransition.remainingMs).toBe(30_000);
    expect(inTransition.deadlineMs).toBe(TRANSITION_END_MS);

    const afterTransition = resolve(examInput, 2_000_000);
    expect(afterTransition.phase).toBe('lesen');
    expect(afterTransition.remainingMs).toBe(2_260_000);
    expect(afterTransition.closedSkills).toEqual(['hoeren']);

    const afterAll = resolve(examInput, 9_000_000);
    expect(afterAll.phase).toBe('closed');
    expect(afterAll.closedSkills).toEqual(['hoeren', 'lesen']);
    expect(afterAll.phaseRevision).toBe(3);
  });

  it('lifecycle is deterministic and does not mutate input', () => {
    const input = deepFreeze({
      ...examInput,
      closedSkills: ['hoeren'],
      durations: { ...examInput.durations },
    });
    const snapshot = structuredClone(input);
    const first = resolveLifecycle(input, 1_530_000);
    const second = resolveLifecycle(input, 1_530_000);
    expect(first).toEqual(second);
    expect(input).toEqual(snapshot);
    const admitted = admitOperation(input, beginLesen, 1_530_000);
    expect(admitted).toEqual(admitOperation(input, beginLesen, 1_530_000));
    expect(input).toEqual(snapshot);
  });

  it('active open phase admits timely assigned answer operations', () => {
    const hoeren = admitOperation(examInput, answer('hoeren'), 1_499_999);
    expect(hoeren.ok).toBe(true);
    const lesen = admitOperation(examInput, answer('lesen'), TRANSITION_END_MS);
    expect(lesen.ok).toBe(true);
    const timed = admitOperation(
      timedInput('hoeren'),
      answer('hoeren'),
      600_999,
    );
    expect(timed.ok).toBe(true);
    const training = admitOperation(trainingInput, answer('lesen'), 5e12);
    expect(training.ok).toBe(true);

    const wrongSkill = admitOperation(examInput, answer('lesen'), 100);
    expect(wrongSkill).toMatchObject({ ok: false, reason: 'skill-not-open' });
    const closedHoeren = admitOperation(examInput, answer('hoeren'), 2_000_000);
    expect(closedHoeren).toMatchObject({ ok: false, reason: 'skill-not-open' });
    const otherBlock = admitOperation(
      timedInput('lesen'),
      answer('hoeren'),
      5000,
    );
    expect(otherBlock).toMatchObject({ ok: false, reason: 'skill-not-open' });
    const onlyHoeren = { ...trainingInput, selection: 'hoeren' };
    expect(admitOperation(onlyHoeren, answer('lesen'), 5000)).toMatchObject({
      ok: false,
      reason: 'skill-not-open',
    });
  });

  it('valid operation matrix admits training answers and timely submission or cancellation', () => {
    const cases: [string, LifecycleInput, number, AttemptOperation][] = [
      ['training answer hoeren', trainingInput, 10, answer('hoeren')],
      ['training answer lesen', trainingInput, 10, answer('lesen')],
      ['training submit', trainingInput, 10, submit],
      ['training cancel', trainingInput, 10, cancel],
      ['timed submit', timedInput('lesen'), 900_999, submit],
      ['timed cancel', timedInput('hoeren'), 600_999, cancel],
      ['exam hoeren answer', examInput, 1_499_999, answer('hoeren')],
      ['exam hoeren submit', examInput, 1_499_999, submit],
      ['exam hoeren cancel', examInput, 1_499_999, cancel],
      ['exam transition submit', examInput, 1_500_000, submit],
      ['exam transition cancel', examInput, 1_559_999, cancel],
      ['exam lesen answer', examInput, 1_560_000, answer('lesen')],
      ['exam lesen submit', examInput, 4_259_999, submit],
      ['exam lesen cancel', examInput, 4_259_999, cancel],
    ];
    for (const [label, input, atMs, operation] of cases) {
      const result = admitOperation(input, operation, atMs);
      expect(result.ok, label).toBe(true);
    }
    for (const skill of ['hoeren', 'lesen']) {
      const result = admitOperation(examInput, answer(skill), 1_500_000);
      expect(result, `transition answer ${skill}`).toMatchObject({
        ok: false,
        reason: 'skill-not-open',
      });
    }
  });

  it('public lifecycle export and legacy dto remain usable', () => {
    const progress: AttemptProgress = { block: 'hoeren', positionSeconds: 12 };
    const state = resolve(examInput, 100);
    expect(state.openSkills).toContain(progress.block);
    expect(progress).toEqual({ block: 'hoeren', positionSeconds: 12 });
  });

  it('begin lesen in active reading is accepted without restarting', () => {
    const first = admitOperation(examInput, beginLesen, 1_530_000);
    if (!first.ok) throw new Error('first begin refused');
    expect(first.changed).toBe(true);
    const stored: LifecycleInput = {
      ...examInput,
      lesenStartedAtMs: first.state.lesenStartedAtMs,
    };
    const before = resolve(stored, 2_000_000);
    const again = admitOperation(stored, beginLesen, 2_000_000);
    const other = admitOperation(stored, beginLesen, 3_000_000);
    expect(again).toEqual({ ok: true, changed: false, state: before });
    if (!other.ok) throw new Error('second begin refused');
    expect(other.changed).toBe(false);
    expect(other.state.lesenStartedAtMs).toBe(1_530_000);
    expect(other.state.deadlineMs).toBe(4_230_000);
    expect(other.state.phaseRevision).toBe(2);

    const auto = admitOperation(examInput, beginLesen, 2_000_000);
    expect(auto).toMatchObject({ ok: true, changed: false });
    if (!auto.ok) return;
    expect(auto.state.lesenStartedAtMs).toBeNull();
    expect(auto.state.deadlineMs).toBe(EXAM_END_MS);
  });
});

describe('lifecycle refusals', () => {
  it('refuses exact and past deadline', () => {
    const cases: [LifecycleInput, number, AttemptOperation][] = [
      [timedInput('hoeren'), 600_999, answer('hoeren')],
      [timedInput('hoeren'), 601_000, answer('hoeren')],
      [timedInput('lesen'), 901_000, answer('lesen')],
      [timedInput('lesen'), 5_000_000, answer('lesen')],
      [examInput, EXAM_END_MS, answer('lesen')],
      [examInput, EXAM_END_MS + 1, answer('lesen')],
    ];
    const results = cases.map(([input, atMs, operation]) =>
      admitOperation(input, operation, atMs),
    );
    expect(results[0]?.ok).toBe(true);
    for (const result of results.slice(1)) {
      expect(result).toMatchObject({ ok: false, reason: 'closed-phase' });
      if (result.ok || result.reason === 'invalid-input') continue;
      expect(result.state.phase).toBe('closed');
      expect(result.state.deadlineMs).toBeNull();
    }
  });

  it('cannot reopen a closed phase or move lesen start', () => {
    const started: LifecycleInput = {
      ...examInput,
      lesenStartedAtMs: 1_530_000,
    };
    const earlier = resolve(started, 1_510_000);
    expect(earlier.phase).toBe('lesen');
    expect(earlier.lesenStartedAtMs).toBe(1_530_000);
    expect(earlier.deadlineMs).toBe(4_230_000);

    const repeated = admitOperation(started, beginLesen, 1_540_000);
    if (!repeated.ok) throw new Error('repeat refused');
    expect(repeated.state.lesenStartedAtMs).toBe(1_530_000);

    const hoerenClosed: LifecycleInput = {
      ...examInput,
      closedSkills: ['hoeren'],
    };
    const rewound = resolve(hoerenClosed, 100);
    expect(rewound.phase).toBe('transition');
    expect(rewound.openSkills).toEqual([]);
    expect(admitOperation(hoerenClosed, answer('hoeren'), 100)).toMatchObject({
      ok: false,
      reason: 'skill-not-open',
    });

    const lesenClosed: LifecycleInput = {
      ...examInput,
      closedSkills: ['lesen'],
    };
    expect(resolve(lesenClosed, 100).phase).toBe('closed');
    const timedClosed: LifecycleInput = {
      ...timedInput('lesen'),
      closedSkills: ['lesen'],
    };
    expect(resolve(timedClosed, 1001).phase).toBe('closed');
  });

  it('rejects unknown modes and invalid durations', () => {
    const bad = (patch: Partial<LifecycleInput>) =>
      resolveLifecycle({ ...examInput, ...patch }, 100);
    expect(bad({ mode: 'blitz' })).toEqual({
      ok: false,
      error: 'unknown-mode',
    });
    expect(bad({ selection: 'speaking' })).toEqual({
      ok: false,
      error: 'unknown-selection',
    });
    expect(bad({ status: 'paused' })).toEqual({
      ok: false,
      error: 'unknown-status',
    });
    expect(bad({ selection: 'lesen' })).toEqual({
      ok: false,
      error: 'invalid-combination',
    });
    const duration = { ok: false, error: 'invalid-duration' };
    expect(bad({ durations: { ...examInput.durations, hoerenMs: 0 } })).toEqual(
      duration,
    );
    expect(bad({ durations: { ...examInput.durations, lesenMs: -5 } })).toEqual(
      duration,
    );
    expect(
      bad({ durations: { hoerenMs: HOEREN_MS, lesenMs: LESEN_MS } }),
    ).toEqual(duration);
    expect(
      resolveLifecycle({ ...timedInput('hoeren'), selection: 'all' }, 2000),
    ).toEqual({ ok: false, error: 'invalid-combination' });
    expect(
      resolveLifecycle({ ...timedInput('lesen'), durations: {} }, 2000),
    ).toEqual(duration);
  });

  it('terminal and submitted states refuse answer operations', () => {
    for (const status of ['submitted', 'completed', 'cancelled']) {
      const inputs = [
        { ...trainingInput, status },
        { ...timedInput('hoeren'), status },
        { ...examInput, status },
      ];
      for (const input of inputs) {
        for (const operation of [
          answer('hoeren'),
          answer('lesen'),
          submit,
          cancel,
        ]) {
          const result = admitOperation(input, operation, 1500);
          expect(
            result,
            `${status} ${input.mode} ${operation.kind}`,
          ).toMatchObject({
            ok: false,
            reason: 'closed-phase',
          });
        }
      }
    }
  });

  it('catch up at transition boundaries never grants a new interval', () => {
    const start = resolve(examInput, 1_500_000);
    expect(start.phase).toBe('transition');
    expect(start.remainingMs).toBe(TRANSITION_MS);
    const last = resolve(examInput, 1_559_999);
    expect(last.remainingMs).toBe(1);
    const lesen = resolve(examInput, 1_560_000);
    expect(lesen.phase).toBe('lesen');
    expect(lesen.remainingMs).toBe(LESEN_MS);
    expect(lesen.phaseRevision).toBe(2);
    const jumped = resolve(examInput, 4_000_000);
    expect(jumped.phase).toBe('lesen');
    expect(jumped.remainingMs).toBe(260_000);
    expect(jumped.deadlineMs).toBe(EXAM_END_MS);
    const final = resolve(examInput, 4_260_000);
    expect(final.phase).toBe('closed');
    expect(final.phaseRevision).toBe(3);
    expect(admitOperation(examInput, beginLesen, 4_260_000)).toMatchObject({
      ok: false,
      reason: 'closed-phase',
    });
  });

  it('frozen inputs and hostile ambient clocks cannot affect lifecycle', () => {
    const input = deepFreeze({
      ...examInput,
      durations: { ...examInput.durations },
      closedSkills: [] as string[],
    });
    const baseline = resolveLifecycle(input, 1_530_000);
    const baselineAdmission = admitOperation(input, beginLesen, 1_530_000);
    const now = vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('ambient clock read');
    });
    const construct = vi.spyOn(globalThis, 'Date').mockImplementation(() => {
      throw new Error('ambient Date constructed');
    });
    expect(resolveLifecycle(input, 1_530_000)).toEqual(baseline);
    expect(admitOperation(input, beginLesen, 1_530_000)).toEqual(
      baselineAdmission,
    );
    expect(now).not.toHaveBeenCalled();
    expect(construct).not.toHaveBeenCalled();
  });

  it('invalid phase actions and nonfinite time cannot be admitted', () => {
    expect(admitOperation(examInput, answer('lesen'), 100)).toMatchObject({
      ok: false,
      reason: 'skill-not-open',
    });
    expect(admitOperation(examInput, answer('speaking'), 100)).toEqual({
      ok: false,
      reason: 'invalid-input',
      error: 'invalid-operation',
    });
    expect(admitOperation(examInput, beginLesen, 100)).toMatchObject({
      ok: false,
      reason: 'phase-not-open',
    });
    for (const atMs of [Number.NaN, Infinity, -Infinity]) {
      expect(resolveLifecycle(examInput, atMs)).toEqual({
        ok: false,
        error: 'invalid-time',
      });
      expect(admitOperation(examInput, submit, atMs)).toEqual({
        ok: false,
        reason: 'invalid-input',
        error: 'invalid-time',
      });
    }
    const badStart = { ...examInput, startedAtMs: Number.NaN };
    expect(resolveLifecycle(badStart, 10)).toEqual({
      ok: false,
      error: 'invalid-time',
    });
    const badLesen = { ...examInput, lesenStartedAtMs: Infinity };
    expect(resolveLifecycle(badLesen, 10)).toEqual({
      ok: false,
      error: 'invalid-time',
    });
    const badDuration = {
      ...examInput,
      durations: { ...examInput.durations, lesenMs: Infinity },
    };
    expect(resolveLifecycle(badDuration, 10)).toEqual({
      ok: false,
      error: 'invalid-duration',
    });
    const outOfRange = { ...examInput, lesenStartedAtMs: 100 };
    expect(resolveLifecycle(outOfRange, 200)).toEqual({
      ok: false,
      error: 'invalid-state',
    });
  });

  it('begin lesen before transition is a business refusal without state changes', () => {
    const before = resolve(examInput, 1_000_000);
    const refused = admitOperation(examInput, beginLesen, 1_000_000);
    expect(refused).toEqual({
      ok: false,
      reason: 'phase-not-open',
      state: before,
    });
    if (refused.ok || refused.reason === 'invalid-input') return;
    expect(refused.state.lesenStartedAtMs).toBeNull();
    expect(refused.state.deadlineMs).toBe(HOEREN_MS);
    expect(refused.state.closedSkills).toEqual([]);
    expect(refused.state.openSkills).toEqual(['hoeren']);
    expect(refused.state.phaseRevision).toBe(0);

    const control = admitOperation(examInput, beginLesen, 1_500_000);
    expect(control).toMatchObject({ ok: true, changed: true });
  });

  it('late or terminal submit and cancel cannot bypass pure admission', () => {
    const lateCases: [string, LifecycleInput, number[]][] = [
      ['timed hoeren', timedInput('hoeren'), [601_000, 601_001, 9_000_000]],
      ['timed lesen', timedInput('lesen'), [901_000, 901_001, 9_000_000]],
      ['exam', examInput, [EXAM_END_MS, EXAM_END_MS + 1, 9_000_000]],
    ];
    for (const [label, input, lateTimes] of lateCases) {
      for (const operation of [submit, cancel]) {
        const name = `${label} ${operation.kind}`;
        const timely = admitOperation(input, operation, 2000);
        expect(timely, `timely ${name}`).toEqual({
          ok: true,
          changed: false,
          state: resolve(input, 2000),
        });
        for (const atMs of lateTimes) {
          const late = admitOperation(input, operation, atMs);
          expect(late, `late ${name} at ${atMs}`).toEqual({
            ok: false,
            reason: 'closed-phase',
            state: resolve(input, atMs),
          });
          const closed = resolve(input, atMs);
          expect(closed.phase).toBe('closed');
          expect(closed.deadlineMs).toBeNull();
          expect(closed.remainingMs).toBe(0);
        }
      }
    }

    const terminalInputs = [
      trainingInput,
      timedInput('hoeren'),
      timedInput('lesen'),
      examInput,
    ];
    for (const status of ['submitted', 'completed', 'cancelled']) {
      for (const base of terminalInputs) {
        const input = { ...base, status };
        for (const operation of [submit, cancel]) {
          const name = `${status} ${input.mode} ${input.selection} ${operation.kind}`;
          const refused = admitOperation(input, operation, 2000);
          expect(refused, name).toEqual({
            ok: false,
            reason: 'closed-phase',
            state: resolve(input, 2000),
          });
          expect(resolve(input, 2000).phase, name).toBe('closed');
        }
      }
    }
    expect(admitOperation(trainingInput, submit, 1e13)).toMatchObject({
      ok: true,
    });
    expect(admitOperation(trainingInput, cancel, 1e13)).toMatchObject({
      ok: true,
    });
  });

  it('public legacy dto preserves mandatory field boundary', () => {
    const importLine = "import type { AttemptProgress } from '@b1k/domain';";
    const legacy = compileConsumer([
      importLine,
      "export const legacy: AttemptProgress = { block: 'lesen' };",
    ]);
    expect(legacy).toEqual([]);

    const missing = compileConsumer([
      importLine,
      'export const missing: AttemptProgress = { positionSeconds: 3 };',
    ]);
    expect(missing).toHaveLength(1);
    expect(missing[0]?.code).toBe(MISSING_PROPERTY_CODE);
    const message = ts.flattenDiagnosticMessageText(
      missing[0]?.messageText ?? '',
      ' ',
    );
    expect(message).toContain("'block'");
  });

  it('active reading no op cannot admit early or closed transition', () => {
    const early = admitOperation(examInput, beginLesen, 600_000);
    expect(early).toMatchObject({ ok: false, reason: 'phase-not-open' });
    for (const status of ['completed', 'cancelled', 'submitted']) {
      const stored: LifecycleInput = {
        ...examInput,
        status,
        lesenStartedAtMs: 1_530_000,
      };
      const closed = admitOperation(stored, beginLesen, 2_000_000);
      expect(closed, status).toMatchObject({
        ok: false,
        reason: 'closed-phase',
      });
    }
    const active: LifecycleInput = {
      ...examInput,
      lesenStartedAtMs: 1_530_000,
    };
    expect(admitOperation(active, beginLesen, 2_000_000)).toMatchObject({
      ok: true,
      changed: false,
    });
  });
});

describe('lifecycle review regressions', () => {
  it('begin lesen after an early hoeren close before the transition window is refused', () => {
    const closed: LifecycleInput = { ...examInput, closedSkills: ['hoeren'] };
    const result = admitOperation(closed, beginLesen, 600_000);
    expect(result).toMatchObject({ ok: false, reason: 'phase-not-open' });
  });

  it('training does not reopen a skill recorded as closed', () => {
    const input: LifecycleInput = {
      ...trainingInput,
      closedSkills: ['hoeren'],
    };
    expect(admitOperation(input, answer('hoeren'), 10)).toMatchObject({
      ok: false,
      reason: 'skill-not-open',
    });
    expect(admitOperation(input, answer('lesen'), 10).ok).toBe(true);
  });

  it('a missing operation is invalid input and does not throw', () => {
    const result = admitOperation(examInput, null as never, 10);
    expect(result).toEqual({
      ok: false,
      reason: 'invalid-input',
      error: 'invalid-operation',
    });
  });
});

describe('lifecycle schedule bounds', () => {
  it('finite inputs whose schedule overflows are rejected', () => {
    const overflowing: LifecycleInput[] = [
      {
        ...examInput,
        durations: {
          hoerenMs: Number.MAX_VALUE,
          transitionMs: Number.MAX_VALUE,
          lesenMs: 1,
        },
      },
      {
        ...timedInput('hoeren'),
        startedAtMs: Number.MAX_VALUE,
        durations: { hoerenMs: Number.MAX_VALUE },
      },
    ];
    for (const input of overflowing) {
      const atMs = input.startedAtMs;
      expect(resolveLifecycle(input, atMs)).toEqual({
        ok: false,
        error: 'invalid-duration',
      });
      expect(admitOperation(input, submit, atMs)).toEqual({
        ok: false,
        reason: 'invalid-input',
        error: 'invalid-duration',
      });
    }
    expect(resolveLifecycle(examInput, 0).ok).toBe(true);
  });
});
