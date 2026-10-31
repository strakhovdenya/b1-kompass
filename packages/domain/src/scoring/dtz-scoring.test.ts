import { describe, expect, it } from 'vitest';
import {
  buildSyntheticPilot,
  gradeDtzTotal,
  selectAttemptScope,
  selectScoringPolicy,
} from '../index';
import type { ExamContent, ExamQuestion, Selections } from '../index';

const pilot = buildSyntheticPilot();
const { questions } = pilot.content;
const { keys } = pilot;

const ofSkill = (skill: ExamQuestion['skill']) =>
  questions.filter((question) => question.skill === skill);

const wrongOption = (question: ExamQuestion): string => {
  const wrong = question.options.find((o) => o.id !== keys[question.id]);
  if (!wrong) throw new Error(`no wrong option for ${question.id}`);
  return wrong.id;
};

interface SkillPlan {
  correct: number;
  incorrect: number;
}

// The first tasks of each skill are answered right, the next ones wrong, the
// rest is skipped.
const selectionsFor = (hoeren: SkillPlan, lesen: SkillPlan): Selections => {
  const selections: Record<string, string> = {};
  const plan = (skill: ExamQuestion['skill'], counts: SkillPlan) => {
    const answered = counts.correct + counts.incorrect;
    for (const [index, question] of ofSkill(skill).entries()) {
      if (index < counts.correct) {
        selections[question.id] = keys[question.id] ?? '';
      } else if (index < answered) {
        selections[question.id] = wrongOption(question);
      }
    }
  };
  plan('hoeren', hoeren);
  plan('lesen', lesen);
  return selections;
};

const fullExam = () => {
  const policy = selectScoringPolicy('DTZ', 'full-exam');
  if (!policy) throw new Error('full-exam policy is missing');
  return policy;
};

const scoreFull = (hoeren: SkillPlan, lesen: SkillPlan) =>
  fullExam().score({
    questions,
    keys,
    selections: selectionsFor(hoeren, lesen),
  });

const withQuestions = (list: ExamQuestion[]): ExamContent => ({
  ...pilot.content,
  questions: list,
});

describe('full DTZ scoring policy', () => {
  it('full dtz scores hoeren lesen and total separately', () => {
    const result = scoreFull(
      { correct: 12, incorrect: 5 },
      { correct: 10, incorrect: 9 },
    );
    expect(result).toMatchObject({
      scope: 'full-exam',
      score: 22,
      maxScore: 45,
      correct: 22,
      incorrect: 14,
      skipped: 9,
      skills: {
        hoeren: { score: 12, maxScore: 20 },
        lesen: { score: 10, maxScore: 25 },
      },
    });
    expect(result.items).toHaveLength(45);
    const outcomeOf = (id: string) =>
      result.items.find((item) => item.questionId === id)?.outcome;
    expect(outcomeOf('hoeren-1')).toBe('correct');
    expect(outcomeOf('hoeren-13')).toBe('incorrect');
    expect(outcomeOf('hoeren-20')).toBe('skipped');
    expect(outcomeOf('lesen-11')).toBe('incorrect');
    expect(outcomeOf('lesen-25')).toBe('skipped');
  });

  it('dtz boundary scores use integer totals', () => {
    const levelFor = (hoeren: number, lesen: number) =>
      scoreFull(
        { correct: hoeren, incorrect: 0 },
        { correct: lesen, incorrect: 0 },
      );
    expect(levelFor(10, 9)).toMatchObject({ score: 19, level: 'below-A2' });
    expect(levelFor(10, 10)).toMatchObject({ score: 20, level: 'A2' });
    expect(levelFor(16, 16)).toMatchObject({ score: 32, level: 'A2' });
    expect(levelFor(16, 17)).toMatchObject({ score: 33, level: 'B1' });
    expect(gradeDtzTotal(0)).toBe('below-A2');
    expect(gradeDtzTotal(45)).toBe('B1');
    expect(() => gradeDtzTotal(32.5)).toThrow(RangeError);
  });

  it('out of range total has no grade', () => {
    expect(() => gradeDtzTotal(-1)).toThrow(RangeError);
    expect(() => gradeDtzTotal(46)).toThrow(RangeError);
  });

  it('fifteen plus eighteen returns thirty three and B1', () => {
    const result = scoreFull(
      { correct: 15, incorrect: 3 },
      { correct: 18, incorrect: 7 },
    );
    expect(result).toMatchObject({
      score: 33,
      maxScore: 45,
      percent: 73.3,
      level: 'B1',
      skills: {
        hoeren: { score: 15, maxScore: 20 },
        lesen: { score: 18, maxScore: 25 },
      },
    });
  });

  it('nonfull and nonDTZ scopes have no official DTZ grade', () => {
    const shortSet = selectScoringPolicy('DTZ', 'short-set');
    expect(shortSet?.showsLevel).toBe(false);
    const short = shortSet?.score({
      questions,
      keys,
      selections: selectionsFor(
        { correct: 20, incorrect: 0 },
        { correct: 25, incorrect: 0 },
      ),
    });
    expect(short).toMatchObject({ score: 45, skills: null, level: null });
    expect(selectScoringPolicy('DTÖ', 'full-exam')).toBeNull();
    expect(selectScoringPolicy('DTÖ', 'short-set')).toBeNull();
    expect(fullExam().showsLevel).toBe(true);
  });

  it('missing key refuses full exam scoring', () => {
    const { 'lesen-7': _missing, ...partial } = keys;
    let result: unknown = null;
    expect(() => {
      result = fullExam().score({ questions, keys: partial, selections: {} });
    }).toThrow(/lesen-7/);
    expect(result).toBeNull();
    expect(() =>
      fullExam().score({
        questions: questions.slice(0, 44),
        keys,
        selections: {},
      }),
    ).toThrow(/Full DTZ/);
  });

  it('attempt scope follows version inventory', () => {
    expect(selectAttemptScope('DTZ', pilot.content)).toBe('full-exam');
    const fourTasks = withQuestions(ofSkill('hoeren').slice(0, 4));
    expect(selectAttemptScope('DTZ', fourTasks)).toBe('short-set');
    const oneLesenShort = withQuestions(
      questions.filter((question) => question.id !== 'lesen-25'),
    );
    expect(selectAttemptScope('DTZ', oneLesenShort)).toBe('short-set');
    expect(selectAttemptScope('DTÖ', pilot.content)).toBe('short-set');
  });
});
