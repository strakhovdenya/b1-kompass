import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  admitOperation,
  buildAssignment,
  buildRepeatAssignment,
  scoreAssignment,
  selectScoringPolicy,
  toBeginLesenResult,
  toPublicContext,
} from '@b1k/domain';
import type {
  AnswerKeys,
  AttemptAssignment,
  AttemptScore,
  BeginLesenOutcome,
  ExamContent,
  ExamQuestion,
  LifecycleInput,
  RunTechnicalFailure,
  SaveAnswerError,
  Selections,
  StartOutcome,
  SubmitOutcome,
} from '@b1k/domain';

const VERSION = 'version-a';
const FOREIGN_VERSION = 'version-b';

const question = (
  skill: 'hoeren' | 'lesen',
  index: number,
  number: number,
): ExamQuestion => ({
  id: `${skill}-${index}`,
  number,
  kind: 'single-choice',
  skill,
  teil: 1,
  prompt: `Frage ${number}?`,
  options: [
    { id: 'a', text: 'A' },
    { id: 'b', text: 'B' },
    { id: 'c', text: 'C' },
  ],
});

// Hören 1..hoeren, then Lesen 1..lesen; the correct option is always "a".
const makeContent = (
  hoeren: number,
  lesen: number,
  groups: ExamContent['groups'] = undefined,
): ExamContent => ({
  source: {
    publisher: 'Test',
    title: 'Synthetic',
    url: 'https://example.org/synthetic',
    page: 1,
  },
  questions: [
    ...Array.from({ length: hoeren }, (_, i) =>
      question('hoeren', i + 1, i + 1),
    ),
    ...Array.from({ length: lesen }, (_, i) =>
      question('lesen', i + 1, hoeren + i + 1),
    ),
  ],
  ...(groups ? { groups } : {}),
});

const keysOf = (content: ExamContent): AnswerKeys =>
  Object.fromEntries(content.questions.map((q) => [q.id, 'a']));

// "a" for the ids in `correct`, "b" for every other question.
const answers = (content: ExamContent, correct: readonly string[]) =>
  Object.fromEntries(
    content.questions.map((q) => [q.id, correct.includes(q.id) ? 'a' : 'b']),
  );

const idsOf = (content: ExamContent, skill?: 'hoeren' | 'lesen'): string[] =>
  content.questions.filter((q) => !skill || q.skill === skill).map((q) => q.id);

const full = makeContent(20, 25);
const fullKeys = keysOf(full);

const assign = (content: ExamContent, selection = 'all'): AttemptAssignment => {
  const result = buildAssignment({
    format: 'DTZ',
    versionId: VERSION,
    content,
    selection,
  });
  if (!result.ok) throw new Error(`unexpected error ${result.error}`);
  return result.assignment;
};

const scoreOf = (
  assignment: AttemptAssignment,
  content: ExamContent,
  selections: Selections,
): AttemptScore => {
  const result = scoreAssignment({
    assignment,
    versionId: VERSION,
    content,
    keys: keysOf(content),
    selections,
  });
  if (!result.ok) throw new Error(`unexpected error ${result.error}`);
  return result.score;
};

const DOMAIN_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
).replaceAll('\\', '/');
const CONSUMER_FILE = `${DOMAIN_DIR}/src/attempts/consumer.virtual.ts`;
const NOT_ASSIGNABLE_CODE = 2322;
const MISSING_PROPERTY_CODE = 2741;

// Type-checks a consumer snippet against the real public package.
const compileConsumer = (
  lines: readonly string[],
): readonly ts.Diagnostic[] => {
  const source = lines.join('\n');
  const config = ts.readConfigFile(
    `${DOMAIN_DIR}/tsconfig.json`,
    ts.sys.readFile,
  );
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

const messageOf = (diagnostic: ts.Diagnostic): string =>
  ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');

const lineOf = (diagnostic: ts.Diagnostic): number => {
  const { file, start } = diagnostic;
  if (!file || start === undefined) throw new Error('diagnostic has no place');
  return file.getLineAndCharacterOfPosition(start).line;
};

// Business outcomes each command may report (INV-10).
const COMMAND_OUTCOMES = {
  StartOutcome: ['accepted', 'conflict'],
  SubmitOutcome: [
    'accepted',
    'result-pending',
    'result-ready',
    'conflict',
    'closed-phase',
    'stale-confirmation',
  ],
  CancelOutcome: ['accepted', 'conflict', 'closed-phase', 'stale-confirmation'],
  BeginLesenOutcome: ['accepted', 'phase-not-open', 'closed-phase'],
} as const;

const ALL_OUTCOMES = [...new Set(Object.values(COMMAND_OUTCOMES).flat())];

const DTO_IMPORT =
  "import type { BeginLesenOutcome, CancelOutcome, LifecycleState, RunTechnicalFailure, StartOutcome, SubmitOutcome } from '@b1k/domain';";
const STATE_LINE = 'declare const state: LifecycleState;';

const dtoLiteral = (type: string, outcome: string): string => {
  const extra = type === 'BeginLesenOutcome' && outcome === 'accepted';
  const changed = extra ? ', changed: true' : '';
  return `{ outcome: '${outcome}', attemptId: 'a', state${changed} }`;
};

const examInput: LifecycleInput = {
  mode: 'exam',
  selection: 'all',
  status: 'active',
  startedAtMs: 0,
  durations: { hoerenMs: 1_500_000, transitionMs: 60_000, lesenMs: 2_700_000 },
  closedSkills: [],
  lesenStartedAtMs: null,
};

describe('assignment', () => {
  it('selects all and individual skills without scoring context', () => {
    const everything = assign(full);
    expect(everything).toMatchObject({
      scope: 'full-exam',
      selection: 'all',
      purpose: 'normal',
      versionId: VERSION,
      contextIds: [],
    });
    expect(everything.questionIds).toEqual(idsOf(full));
    expect(everything.questionIds).toHaveLength(45);

    const hoeren = assign(full, 'hoeren');
    expect(hoeren.questionIds).toEqual(idsOf(full, 'hoeren'));
    expect(hoeren.questionIds).toHaveLength(20);
    const lesen = assign(full, 'lesen');
    expect(lesen.questionIds).toEqual(idsOf(full, 'lesen'));
    expect(lesen.questionIds).toHaveLength(25);
    expect(hoeren.scope).toBe('short-set');
    expect(lesen.scope).toBe('short-set');

    const unknown = buildAssignment({
      format: 'DTZ',
      versionId: VERSION,
      content: full,
      selection: 'speaking',
    });
    expect(unknown).toEqual({ ok: false, error: 'unknown-selection' });
  });

  it('selects errors and skips inside source assignment', () => {
    const pair = [
      {
        id: 'pair-1',
        kind: 'pair' as const,
        teil: 3,
        trackId: 'track-1',
        questionIds: ['hoeren-1', 'hoeren-2'],
      },
    ];
    const content = makeContent(20, 25, pair);
    const source = assign(content, 'hoeren');
    const correct = idsOf(content).filter(
      (id) => id !== 'hoeren-1' && id !== 'hoeren-3' && id !== 'lesen-7',
    );
    const selections = answers(content, correct);
    delete selections['hoeren-3'];
    const result = buildRepeatAssignment({
      assignment: source,
      versionId: VERSION,
      content,
      keys: keysOf(content),
      selections,
    });
    if (!result.ok) throw new Error(`unexpected error ${result.error}`);
    const repeat = result.assignment;
    expect(repeat.questionIds).toEqual(['hoeren-1', 'hoeren-3']);
    expect(repeat).toMatchObject({
      versionId: VERSION,
      purpose: 'error-repeat',
      selection: 'hoeren',
      scope: 'short-set',
      contextIds: ['hoeren-2'],
    });
    const context = toPublicContext(content, repeat);
    expect(context.map((item) => item.questionId)).toEqual(['hoeren-2']);
  });

  it('source scope and empty repeat are preserved', () => {
    const source = assign(full, 'hoeren');
    const lesenOnlyWrong = answers(full, idsOf(full, 'hoeren'));
    const input = {
      assignment: source,
      versionId: VERSION,
      content: full,
      keys: fullKeys,
    };
    expect(
      buildRepeatAssignment({ ...input, selections: lesenOnlyWrong }),
    ).toEqual({ ok: false, error: 'empty' });

    const oneWrong = answers(
      full,
      idsOf(full).filter((id) => id !== 'hoeren-5'),
    );
    const repeat = buildRepeatAssignment({ ...input, selections: oneWrong });
    expect(repeat).toMatchObject({
      ok: true,
      assignment: { questionIds: ['hoeren-5'] },
    });
  });

  it('skill and repeat scores exclude every unassigned answer', () => {
    const allCorrect = answers(full, idsOf(full));
    const hoerenWrong = answers(
      full,
      idsOf(full).filter((id) => !['hoeren-1', 'hoeren-2'].includes(id)),
    );
    const hoeren = scoreOf(assign(full, 'hoeren'), full, hoerenWrong);
    expect(hoeren).toMatchObject({
      maxScore: 20,
      score: 18,
      correct: 18,
      incorrect: 2,
      skipped: 0,
    });
    expect(hoeren.items.map((item) => item.questionId)).toEqual(
      idsOf(full, 'hoeren'),
    );

    const lesenSkips = { ...allCorrect };
    delete lesenSkips['lesen-1'];
    const lesen = scoreOf(assign(full, 'lesen'), full, lesenSkips);
    expect(lesen).toMatchObject({ maxScore: 25, correct: 24, skipped: 1 });

    const repeat = buildRepeatAssignment({
      assignment: assign(full),
      versionId: VERSION,
      content: full,
      keys: fullKeys,
      selections: hoerenWrong,
    });
    if (!repeat.ok) throw new Error('repeat expected');
    const repeated = scoreOf(repeat.assignment, full, allCorrect);
    expect(repeated).toMatchObject({ maxScore: 2, score: 2, correct: 2 });
    expect(repeated.items.map((item) => item.questionId)).toEqual([
      'hoeren-1',
      'hoeren-2',
    ]);
  });

  it('repeat of forty five and single skill never receives level', () => {
    const allWrong = answers(full, []);
    const source = assign(full);
    const repeat = buildRepeatAssignment({
      assignment: source,
      versionId: VERSION,
      content: full,
      keys: fullKeys,
      selections: allWrong,
    });
    if (!repeat.ok) throw new Error('repeat expected');
    expect(repeat.assignment.questionIds).toHaveLength(45);
    const repeated = scoreOf(
      repeat.assignment,
      full,
      answers(full, idsOf(full)),
    );
    expect(repeated).toMatchObject({
      scope: 'short-set',
      maxScore: 45,
      score: 45,
      level: null,
      skills: null,
    });
    const skill = scoreOf(
      assign(full, 'lesen'),
      full,
      answers(full, idsOf(full)),
    );
    expect(skill.level).toBeNull();
    expect(skill.skills).toBeNull();
  });

  it('rejects invalid assignments and missing keys', () => {
    const base = assign(full, 'hoeren');
    const selections = answers(full, idsOf(full));
    const attempt = (assignment: AttemptAssignment, keys = fullKeys) =>
      scoreAssignment({
        assignment,
        versionId: VERSION,
        content: full,
        keys,
        selections,
      });
    const unknown = { ...base, questionIds: [...base.questionIds, 'ghost-1'] };
    expect(attempt(unknown)).toEqual({ ok: false, error: 'unknown-question' });
    const duplicate = { ...base, questionIds: ['hoeren-1', 'hoeren-1'] };
    expect(attempt(duplicate)).toEqual({
      ok: false,
      error: 'duplicate-question',
    });
    const { 'hoeren-3': removed, ...withoutKey } = fullKeys;
    expect(removed).toBe('a');
    expect(attempt(base, withoutKey)).toEqual({
      ok: false,
      error: 'missing-key',
    });
    const overlap = { ...base, contextIds: ['hoeren-1'] };
    const strayContext = { ...base, contextIds: ['ghost-9'] };
    expect(attempt(strayContext)).toEqual({
      ok: false,
      error: 'invalid-assignment',
    });
    expect(
      buildAssignment({
        format: 'DTO',
        versionId: VERSION,
        content: full,
        selection: 'all',
      }),
    ).toEqual({ ok: false, error: 'unsupported-format' });
    expect(attempt(overlap)).toEqual({
      ok: false,
      error: 'invalid-assignment',
    });
    const empty = { ...base, questionIds: [] };
    expect(attempt(empty)).toEqual({ ok: false, error: 'empty' });
    expect(attempt({ ...base, format: 'DTO' })).toEqual({
      ok: false,
      error: 'unsupported-format',
    });
  });

  it('legacy short set does not acquire a grade', () => {
    const legacy: AttemptAssignment = {
      format: 'DTZ',
      versionId: VERSION,
      scope: 'short-set',
      selection: 'all',
      purpose: 'normal',
      questionIds: idsOf(full),
      contextIds: [],
    };
    const selections = Object.freeze(answers(full, idsOf(full)));
    const before = { ...selections };
    const score = scoreOf(legacy, full, selections);
    expect(score).toMatchObject({
      scope: 'short-set',
      score: 45,
      maxScore: 45,
      level: null,
      skills: null,
    });
    expect(selections).toEqual(before);
  });

  it('normal all on incomplete versions remains ungraded short set', () => {
    for (const [hoeren, lesen] of [
      [1, 0],
      [20, 24],
    ] as const) {
      const content = makeContent(hoeren, lesen);
      const assignment = assign(content);
      expect(assignment.scope).toBe('short-set');
      expect(assignment.questionIds).toHaveLength(hoeren + lesen);
      const score = scoreOf(
        assignment,
        content,
        answers(content, idsOf(content)),
      );
      expect(score).toMatchObject({
        scope: 'short-set',
        maxScore: hoeren + lesen,
        level: null,
        skills: null,
      });
    }
  });

  it('invalid inventory foreign version and keyed context cannot widen score', () => {
    const wrong = makeContent(19, 26);
    const assignment = assign(wrong);
    expect(assignment.scope).toBe('short-set');
    expect(
      scoreOf(assignment, wrong, answers(wrong, idsOf(wrong))).level,
    ).toBeNull();
    const forged: AttemptAssignment = { ...assignment, scope: 'full-exam' };
    expect(
      scoreAssignment({
        assignment: forged,
        versionId: VERSION,
        content: wrong,
        keys: keysOf(wrong),
        selections: answers(wrong, idsOf(wrong)),
      }),
    ).toEqual({ ok: false, error: 'invalid-scope' });

    expect(
      scoreAssignment({
        assignment: assign(full),
        versionId: FOREIGN_VERSION,
        content: full,
        keys: fullKeys,
        selections: answers(full, idsOf(full)),
      }),
    ).toEqual({ ok: false, error: 'foreign-version' });

    const keyedNeighbour = {
      ...question('hoeren', 2, 2),
      correctOptionId: 'a',
    };
    const pair = [
      {
        id: 'pair-1',
        kind: 'pair' as const,
        teil: 3,
        trackId: 'track-1',
        questionIds: ['hoeren-1', 'hoeren-2'],
      },
    ];
    const content: ExamContent = {
      ...makeContent(1, 0, pair),
      questions: [question('hoeren', 1, 1), keyedNeighbour],
    };
    const partial: AttemptAssignment = {
      ...assign(content),
      questionIds: ['hoeren-1'],
      contextIds: ['hoeren-2'],
    };
    const score = scoreOf(partial, content, {
      'hoeren-1': 'a',
      'hoeren-2': 'a',
    });
    expect(score.maxScore).toBe(1);
    expect(score.items.map((item) => item.questionId)).toEqual(['hoeren-1']);
    const serialized = JSON.stringify(toPublicContext(content, partial));
    expect(serialized).toContain('hoeren-2');
    expect(serialized).not.toContain('correctOptionId');
  });

  it('legacy public contracts remain source compatible', () => {
    const questions = [question('hoeren', 1, 1)];
    const policy = selectScoringPolicy('DTZ', 'short-set');
    if (!policy) throw new Error('policy expected');
    const score: AttemptScore = policy.score({
      questions,
      keys: { 'hoeren-1': 'a' },
      selections: { 'hoeren-1': 'a' },
    });
    expect(score).toMatchObject({ score: 1, maxScore: 1, level: null });
    const exhaustive = (error: SaveAnswerError): string => {
      switch (error) {
        case 'invalid-input':
        case 'session-invalid':
        case 'attempt-not-found':
        case 'option-not-allowed':
        case 'unavailable':
          return error;
        default:
          return error satisfies never;
      }
    };
    expect(exhaustive('unavailable')).toBe('unavailable');
  });

  it('mode command dto consumers and legacy calls remain typed and usable', () => {
    const describeSubmit = (outcome: SubmitOutcome): string => {
      switch (outcome.outcome) {
        case 'accepted':
        case 'result-pending':
        case 'conflict':
        case 'closed-phase':
        case 'stale-confirmation':
          return `${outcome.outcome}:${outcome.state.phase}`;
        case 'result-ready':
          return `ready:${outcome.attemptId}`;
        default:
          return outcome satisfies never;
      }
    };
    const startOutcome: StartOutcome = {
      outcome: 'conflict',
      attemptId: 'a1',
      state: {
        mode: 'training',
        selection: 'all',
        status: 'active',
        phase: 'open',
        phaseRevision: 0,
        openSkills: ['hoeren', 'lesen'],
        closedSkills: [],
        startedAtMs: 0,
        lesenStartedAtMs: null,
        deadlineMs: null,
        endsAtMs: null,
        remainingMs: null,
      },
    };
    expect(describeSubmit({ ...startOutcome, outcome: 'accepted' })).toBe(
      'accepted:open',
    );
    expect(describeSubmit({ outcome: 'result-ready', attemptId: 'a1' })).toBe(
      'ready:a1',
    );
    const legacy = selectScoringPolicy('DTZ', 'full-exam');
    expect(legacy?.showsLevel).toBe(true);
    const graded = legacy?.score({
      questions: full.questions,
      keys: fullKeys,
      selections: answers(full, idsOf(full).slice(0, 33)),
    });
    expect(graded).toMatchObject({ score: 33, maxScore: 45, level: 'B1' });
  });

  it('legacy dto boundary compiles without new required fields or error variants', () => {
    const control = compileConsumer([
      "import type { AttemptScore, ReviewItem, SaveAnswerError, ScoringInput } from '@b1k/domain';",
      "export const item: ReviewItem = { questionId: 'q', selectedOptionId: null, correctOptionId: 'a', outcome: 'skipped' };",
      "export const score: AttemptScore = { scope: 'short-set', score: 0, maxScore: 1, percent: 0, correct: 0, incorrect: 0, skipped: 1, skills: null, level: null, items: [item] };",
      'export const input: ScoringInput = { questions: [], keys: {}, selections: {} };',
      'export const check = (error: SaveAnswerError): string => {',
      '  switch (error) {',
      "    case 'invalid-input': case 'session-invalid': case 'attempt-not-found': case 'option-not-allowed': case 'unavailable': return error;",
      '    default: return error satisfies never;',
      '  }',
      '};',
    ]);
    expect(control.map(messageOf)).toEqual([]);
  });

  it('unassigned answers and impossible command outcomes cannot widen results', () => {
    const lesen = assign(full, 'lesen');
    const withOutside = answers(full, idsOf(full));
    const inside = scoreOf(lesen, full, withOutside);
    const clean = scoreOf(lesen, full, answers(full, idsOf(full, 'lesen')));
    expect(inside).toEqual(clean);
    expect(inside.maxScore).toBe(25);

    const negatives: string[] = [];
    const lines: string[] = [DTO_IMPORT, STATE_LINE];
    for (const [type, allowed] of Object.entries(COMMAND_OUTCOMES)) {
      for (const outcome of ALL_OUTCOMES) {
        if ((allowed as readonly string[]).includes(outcome)) continue;
        negatives.push(`${type}:${outcome}`);
        const literal = dtoLiteral(type, outcome);
        lines.push(`export const n${lines.length}: ${type} = ${literal};`);
      }
    }
    const diagnostics = compileConsumer(lines);
    expect(diagnostics).toHaveLength(negatives.length);
    diagnostics.forEach((diagnostic, index) => {
      const pair = negatives[index] ?? '';
      const outcome = pair.split(':')[1] ?? '';
      expect(lineOf(diagnostic) - 2, pair).toBe(index);
      expect(diagnostic.code, pair).toBe(NOT_ASSIGNABLE_CODE);
      expect(messageOf(diagnostic), pair).toContain(`"${outcome}"`);
    });
    for (const pair of [
      'CancelOutcome:result-ready',
      'StartOutcome:result-ready',
      'BeginLesenOutcome:result-ready',
      'StartOutcome:stale-confirmation',
      'BeginLesenOutcome:stale-confirmation',
    ]) {
      expect(negatives).toContain(pair);
    }
  });

  it('early transition outcome stays in business channel and command matrix', () => {
    const early = admitOperation(examInput, { kind: 'begin-lesen' }, 600_000);
    const result = toBeginLesenResult('a1', early);
    expect(result).toMatchObject({
      ok: true,
      result: { outcome: 'phase-not-open', attemptId: 'a1' },
    });
    expect(Object.hasOwn(result, 'failure')).toBe(false);
    for (const type of ['StartOutcome', 'SubmitOutcome', 'CancelOutcome']) {
      expect(
        COMMAND_OUTCOMES[type as keyof typeof COMMAND_OUTCOMES],
      ).not.toContain('phase-not-open');
    }
    expect(COMMAND_OUTCOMES.BeginLesenOutcome).toContain('phase-not-open');
    const technical: RunTechnicalFailure[] = [
      'invalid-input',
      'session-invalid',
      'not-found',
      'unavailable',
      'not-enabled',
    ];
    expect(technical).not.toContain('phase-not-open');
    const invalid = admitOperation(
      { ...examInput, mode: 'bogus' },
      { kind: 'begin-lesen' },
      0,
    );
    expect(toBeginLesenResult('a1', invalid)).toEqual({
      ok: false,
      failure: 'invalid-input',
    });
  });

  it('legacy mandatory fields cannot be weakened by mode dto changes', () => {
    const cases: [string, string, string][] = [
      [
        'AttemptScore',
        "{ scope: 'short-set', score: 0, maxScore: 1, percent: 0, correct: 0, incorrect: 0, skipped: 1, skills: null, items: [] }",
        "'level'",
      ],
      ['ScoringInput', '{ questions: [], keys: {} }', "'selections'"],
      [
        'ReviewItem',
        "{ questionId: 'q', selectedOptionId: null, outcome: 'skipped' }",
        "'correctOptionId'",
      ],
    ];
    for (const [type, literal, field] of cases) {
      const found = compileConsumer([
        `import type { ${type} } from '@b1k/domain';`,
        `export const value: ${type} = ${literal};`,
      ]);
      expect(found, type).toHaveLength(1);
      expect(found[0]?.code, type).toBe(MISSING_PROPERTY_CODE);
      expect(messageOf(found[0] as ts.Diagnostic), type).toContain(field);
    }
  });

  it('phase not open cannot leak into unrelated or technical outcomes', () => {
    const lines = [DTO_IMPORT, STATE_LINE];
    const targets = [
      'StartOutcome',
      'SubmitOutcome',
      'CancelOutcome',
      'RunTechnicalFailure',
    ];
    for (const type of targets) {
      const value =
        type === 'RunTechnicalFailure'
          ? "'phase-not-open'"
          : dtoLiteral(type, 'phase-not-open');
      lines.push(`export const bad${lines.length}: ${type} = ${value};`);
    }
    lines.push(
      `export const closedTechnical: RunTechnicalFailure = 'closed-phase';`,
      `export const conflictTechnical: RunTechnicalFailure = 'conflict';`,
      `export const control: BeginLesenOutcome = ${dtoLiteral('BeginLesenOutcome', 'phase-not-open')};`,
    );
    const diagnostics = compileConsumer(lines);
    expect(diagnostics).toHaveLength(targets.length + 2);
    diagnostics.forEach((diagnostic, index) => {
      expect(lineOf(diagnostic) - 2, String(index)).toBe(index);
      expect(diagnostic.code).toBe(NOT_ASSIGNABLE_CODE);
    });
    const control: BeginLesenOutcome = {
      outcome: 'phase-not-open',
      attemptId: 'a1',
      state: toState(),
    };
    expect(control.outcome).toBe('phase-not-open');
  });

  it('transition dto preserves active reading no op and phase refusals', () => {
    const active: LifecycleInput = {
      ...examInput,
      lesenStartedAtMs: 1_530_000,
    };
    const atMs = 2_000_000;
    const before = JSON.stringify(active);
    const noOp = toBeginLesenResult(
      'a1',
      admitOperation(active, { kind: 'begin-lesen' }, atMs),
    );
    expect(JSON.stringify(active)).toBe(before);
    expect(noOp).toMatchObject({
      ok: true,
      result: {
        outcome: 'accepted',
        changed: false,
        state: {
          phase: 'lesen',
          lesenStartedAtMs: 1_530_000,
          deadlineMs: 4_230_000,
        },
      },
    });

    const hoeren = toBeginLesenResult(
      'a1',
      admitOperation(examInput, { kind: 'begin-lesen' }, 100),
    );
    expect(hoeren).toMatchObject({
      ok: true,
      result: { outcome: 'phase-not-open', state: { phase: 'hoeren' } },
    });
    for (const status of ['completed', 'cancelled', 'submitted']) {
      const closed = toBeginLesenResult(
        'a1',
        admitOperation({ ...active, status }, { kind: 'begin-lesen' }, atMs),
      );
      expect(closed, status).toMatchObject({
        ok: true,
        result: { outcome: 'closed-phase', state: { phase: 'closed' } },
      });
    }
  });
});

const toState = () => {
  const admitted = admitOperation(examInput, { kind: 'begin-lesen' }, 100);
  if (admitted.ok) throw new Error('refusal expected');
  if (admitted.reason === 'invalid-input') throw new Error('state expected');
  return admitted.state;
};
