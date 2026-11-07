import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { buildSyntheticPilot } from '@b1k/domain';
import type { ExamContent } from '@b1k/domain';
import { publishFullPilot } from './publish-pilot';
import { preparePilot } from './prepare-pilot/prepare-pilot';

// Any use of the client fails: a rejected set must never reach the database.
const forbiddenClient = new Proxy(
  {},
  {
    get: () => {
      throw new Error('database must not be touched');
    },
  },
) as unknown as SupabaseClient;

const withTeil = (content: ExamContent, id: string, teil: number) => ({
  ...content,
  questions: content.questions.map((q) => (q.id === id ? { ...q, teil } : q)),
});

const audio = { contentType: 'audio/mpeg' as const, bytes: new Uint8Array(1) };

describe('pilot publisher', () => {
  it('pilot publisher uses common complete DTZ validation', async () => {
    const { content, keys } = buildSyntheticPilot();
    const wrong = withTeil(content, 'lesen-25', 4);
    await expect(
      publishFullPilot(forbiddenClient, { content: wrong, keys, audio }),
    ).rejects.toThrow(/Pilot is not complete.*teil-mismatch:lesen:teil-4/);
  });

  it('prepare pilot applies full DTZ structure policy', () => {
    const { content, keys } = buildSyntheticPilot();
    expect(preparePilot({ content, keys }).problems).toEqual([]);
    const twoTracks = {
      ...content,
      questions: content.questions.map((q) =>
        q.id === 'hoeren-1' ? { ...q, trackId: 'track-other' } : q,
      ),
    };
    const { problems } = preparePilot({ content: twoTracks, keys });
    expect(problems.map((p) => p.code)).toContain('multiple-hoeren-tracks');
  });
});
