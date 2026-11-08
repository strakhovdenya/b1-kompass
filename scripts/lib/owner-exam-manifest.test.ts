import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSyntheticPilot } from '@b1k/domain';
import {
  MANIFEST_MAX_BYTES,
  validateOwnerManifest,
  validateOwnerManifestFile,
} from './owner-exam-manifest';

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'owner-manifest-'));
  await writeFile(path.join(dir, 'track.mp3'), 'audio');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const validManifest = () => {
  const { content, keys } = buildSyntheticPilot();
  return {
    schemaVersion: 1,
    slug: 'fictional-exam',
    title: 'Fictional exam',
    format: 'DTZ',
    source: content.source,
    content,
    keys,
    audio: [{ trackId: 'track-127', file: 'track.mp3' }],
  };
};

const codesOf = async (raw: unknown) =>
  (await validateOwnerManifest(raw, dir)).problems.map((p) => p.code);

describe('owner manifest v1', () => {
  it('accepts a complete manifest and summarises it', async () => {
    const result = await validateOwnerManifest(validManifest(), dir);
    expect(result.problems).toEqual([]);
    expect(result.summary).toEqual({
      slug: 'fictional-exam',
      title: 'Fictional exam',
      hoeren: 20,
      lesen: 25,
      tracks: 1,
    });
  });

  it('manifest parser rejects unknown version fields and format', async () => {
    const version = await validateOwnerManifest(
      { ...validManifest(), schemaVersion: 2 },
      dir,
    );
    expect(version.problems).toContainEqual(
      expect.objectContaining({
        code: 'unsupported-schema-version',
        path: '$.schemaVersion',
      }),
    );
    const extra = await validateOwnerManifest(
      { ...validManifest(), notes: 'x' },
      dir,
    );
    expect(extra.problems).toContainEqual(
      expect.objectContaining({ code: 'unknown-field', path: '$' }),
    );
    const format = await validateOwnerManifest(
      { ...validManifest(), format: 'GOETHE' },
      dir,
    );
    expect(format.problems).toContainEqual(
      expect.objectContaining({ code: 'invalid-format', path: '$.format' }),
    );
    const nested = validManifest();
    const audio = [{ ...nested.audio[0], extra: 1 }];
    expect(await codesOf({ ...nested, audio })).toContain('unknown-field');
  });

  it('reports a source that differs from content.source', async () => {
    const manifest = validManifest();
    const source = { ...manifest.source, page: 99 };
    expect(await codesOf({ ...manifest, source })).toEqual(['source-mismatch']);
  });

  it('rejects control characters in the title', async () => {
    const title = 'Exam\u001b]0;x\nOK fake';
    const result = await validateOwnerManifest(
      { ...validManifest(), title },
      dir,
    );
    expect(result.problems).toContainEqual(
      expect.objectContaining({ code: 'invalid-field', path: '$.title' }),
    );
  });

  it('rejects a duplicate and an invalid track id', async () => {
    const manifest = validManifest();
    const audio = [
      { trackId: 'track-127', file: 'track.mp3' },
      { trackId: 'track-127', file: 'track.mp3' },
      { trackId: 'Bad Track', file: 'track.mp3' },
    ];
    const codes = await codesOf({ ...manifest, audio });
    expect(codes).toContain('audio-track-duplicate');
    expect(codes).toContain('audio-track-invalid');
  });

  it('rejects empty and missing audio files', async () => {
    const manifest = validManifest();
    const audio = [{ trackId: 'track-127', file: 'sub.mp3' }];
    await writeFile(path.join(dir, 'empty.mp3'), '');
    const empty = [{ trackId: 'track-127', file: 'empty.mp3' }];
    expect(await codesOf({ ...manifest, audio: empty })).toEqual([
      'audio-empty',
    ]);
    expect(await codesOf({ ...manifest, audio })).toEqual(['audio-missing']);
  });

  it('reads the manifest file and rejects bad files without quoting them', async () => {
    const file = path.join(dir, 'manifest.json');
    await writeFile(file, JSON.stringify(validManifest()));
    expect((await validateOwnerManifestFile(file)).problems).toEqual([]);
    await writeFile(file, '{"keys": SECRET-TEXT');
    const broken = await validateOwnerManifestFile(file);
    expect(broken.problems.map((p) => p.code)).toEqual([
      'manifest-invalid-json',
    ]);
    expect(JSON.stringify(broken)).not.toContain('SECRET-TEXT');
    await writeFile(file, ' '.repeat(MANIFEST_MAX_BYTES + 1));
    expect((await validateOwnerManifestFile(file)).problems[0]?.code).toBe(
      'manifest-too-large',
    );
    const missing = await validateOwnerManifestFile(path.join(dir, 'none'));
    expect(missing.problems[0]?.code).toBe('manifest-unreadable');
  });
});
