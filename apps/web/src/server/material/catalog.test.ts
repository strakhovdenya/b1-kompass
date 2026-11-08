import { buildSyntheticPilot } from '@b1k/domain';
import { describe, expect, it } from 'vitest';
import { projectCatalog } from './catalog';
import type { CatalogRow } from './catalog';

const full = buildSyntheticPilot().content;
const short = {
  ...full,
  questions: full.questions.filter((question) => question.skill === 'hoeren'),
};

const row = (
  exam: { slug: string; title: string; format?: string },
  ...versions: [number, unknown][]
): CatalogRow => ({
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
