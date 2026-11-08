import { buildSyntheticPilot } from '@b1k/domain';
import { describe, expect, it } from 'vitest';
import { attachStates, listLibrary, projectCatalog } from './catalog';
import type { CatalogRow } from './catalog';
import type { ServerDeps } from '../db';
import type { GuestContext } from '../guest-session/session';

const full = buildSyntheticPilot().content;
const short = {
  ...full,
  questions: full.questions.filter((question) => question.skill === 'hoeren'),
};

const row = (
  exam: { slug: string; title: string; format?: string },
  ...versions: [number, unknown][]
): CatalogRow => ({
  id: `id-${exam.slug}`,
  format: 'DTZ',
  ...exam,
  exam_versions: versions.map(([version, content]) => ({ version, content })),
});

describe('catalog projection', () => {
  it('catalog projection sorts stably and counts full DTZ', () => {
    const entries = projectCatalog([
      row({ slug: 'b-slug', title: 'Same' }, [1, full]),
      row({ slug: 'z-slug', title: 'Alpha' }, [1, full]),
      row({ slug: 'a-slug', title: 'Same' }, [1, full]),
    ]);
    expect(entries.map((entry) => entry.slug)).toEqual([
      'z-slug',
      'a-slug',
      'b-slug',
    ]);
    expect(entries[0]).toMatchObject({
      format: 'DTZ',
      hoerenCount: 20,
      lesenCount: 25,
      totalCount: 45,
    });
  });

  it('catalog projection drops invalid short and superseded versions', () => {
    const entries = projectCatalog([
      row({ slug: 'invalid', title: 'Invalid' }, [1, { broken: true }]),
      row({ slug: 'short', title: 'Short' }, [1, short]),
      row({ slug: 'other', title: 'Other', format: 'DTÖ' }, [1, full]),
      row({ slug: 'superseded', title: 'Superseded' }, [1, full], [2, short]),
      row({ slug: 'upgraded', title: 'Upgraded' }, [1, short], [2, full]),
      row({ slug: 'empty', title: 'Without version' }),
    ]);
    expect(entries.map((entry) => entry.slug)).toEqual(['upgraded']);
  });
});

// A database that answers every query of a table with fixed rows and counts
// the queries; the filters themselves are proven against the real database in
// the E2E specs.
const fakeDeps = (tables: Record<string, unknown[]>) => {
  const calls: string[] = [];
  const reply = (table: string) => {
    const builder: Record<string, unknown> = {};
    const chain = new Proxy(builder, {
      get: (_target, key) => {
        if (key === 'then') {
          return (done: (value: unknown) => unknown) =>
            done({ data: tables[table] ?? [], error: null });
        }
        return () => chain;
      },
    });
    return chain;
  };
  const deps = {
    db: {
      from: (table: string) => {
        calls.push(table);
        return reply(table);
      },
    },
  } as unknown as ServerDeps;
  return { deps, calls };
};

const guest = { sessionId: 'session-1' } as GuestContext;

describe('catalog states', () => {
  it('catalog state read is batched for many exams', async () => {
    const reads = async (count: number) => {
      const exams = Array.from({ length: count }, (_, index) => ({
        ...row({ slug: `exam-${index}`, title: `Exam ${index}` }, [1, full]),
        exam_versions: [{ version: 1, content: full }],
      }));
      const { deps, calls } = fakeDeps({ exams });
      const cards = await listLibrary(deps, guest);
      expect(cards).toHaveLength(count);
      return calls;
    };
    const two = await reads(2);
    const forty = await reads(40);
    expect(forty).toEqual(two);
    expect(forty.filter((table) => table === 'attempts')).toHaveLength(1);
    expect(forty.filter((table) => table === 'attempt_results')).toHaveLength(
      1,
    );
  });

  it('latest result follows computed_at and keeps legacy completed', async () => {
    const exams = [
      { ...row({ slug: 'a', title: 'A' }, [1, full]) },
      { ...row({ slug: 'b', title: 'B' }, [1, full]) },
    ];
    // Deliberately not in time order: the choice must not rely on row order.
    const results = [
      {
        attempt_id: 'older-a',
        computed_at: '2026-11-08T10:00:00Z',
        attempts: { exam_id: 'id-a', attempt_runs: { purpose: 'normal' } },
      },
      {
        attempt_id: 'repeat-a',
        computed_at: '2026-11-08T12:00:00Z',
        attempts: {
          exam_id: 'id-a',
          attempt_runs: { purpose: 'error-repeat' },
        },
      },
      {
        attempt_id: 'newer-a',
        computed_at: '2026-11-08T11:00:00Z',
        attempts: { exam_id: 'id-a', attempt_runs: { purpose: 'normal' } },
      },
      {
        attempt_id: 'legacy-b',
        computed_at: '2026-11-01T10:00:00Z',
        attempts: { exam_id: 'id-b', attempt_runs: null },
      },
    ];
    const active = [
      {
        id: 'active-b',
        exam_id: 'id-b',
        progress: { block: 'lesen' },
        created_at: '2026-11-08T09:00:00Z',
      },
    ];
    const { deps } = fakeDeps({
      exams,
      attempt_results: results,
      attempts: active,
    });
    const [cardA, cardB] = await listLibrary(deps, guest);
    expect(cardA).toMatchObject({
      continueHref: null,
      resultHref: '/practice/a/attempts/newer-a',
    });
    expect(cardB).toMatchObject({
      continueHref: '/practice/b/attempts/active-b/lesen',
      resultHref: '/practice/b/attempts/legacy-b',
    });
  });

  it('cards of exams without own attempts offer no steps', () => {
    const entries = projectCatalog([row({ slug: 'x', title: 'X' }, [1, full])]);
    const [card] = attachStates(entries, new Map());
    expect(card).toMatchObject({ continueHref: null, resultHref: null });
    expect(card).not.toHaveProperty('id');
  });
});
