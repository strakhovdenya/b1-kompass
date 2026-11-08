import { spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSyntheticPilot } from '@b1k/domain';
import type { ExamContent } from '@b1k/domain';
import type { SupabaseClient } from '@supabase/supabase-js';
import { auditAudio, formatAuditReport } from './lib/audio-audit';
import { AUDIO_MAX_BYTES } from './lib/owner-exam-manifest';
import { runOwnerCli } from './manage-exam-library';
import type { OwnerCliIo } from './manage-exam-library';

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'exam-cli-'));
  await mkdir(path.join(dir, 'pkg'));
  await writeFile(path.join(dir, 'pkg', 'track.mp3'), 'audio');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const pkg = (...parts: string[]) => path.join(dir, 'pkg', ...parts);

const manifestOf = (content: ExamContent, keys: Record<string, string>) => ({
  schemaVersion: 1,
  slug: 'fictional-exam',
  title: 'Fictional exam',
  format: 'DTZ',
  source: content.source,
  content,
  keys,
  audio: [{ trackId: 'track-127', file: 'track.mp3' }],
});

const validManifest = () => {
  const { content, keys } = buildSyntheticPilot();
  return manifestOf(content, { ...keys });
};

const write = async (manifest: unknown, name = 'manifest.json') => {
  const file = pkg(name);
  await writeFile(file, JSON.stringify(manifest));
  return file;
};

const run = async (argv: string[], connect?: OwnerCliIo['connect']) => {
  let out = '';
  let err = '';
  const code = await runOwnerCli(argv, {
    cwd: dir,
    stdout: (text) => (out += text),
    stderr: (text) => (err += text),
    ...(connect ? { connect } : {}),
  });
  return { code, out, err, all: out + err };
};

const files = async () => (await readdir(dir, { recursive: true })).sort();

describe('exam library CLI validate', () => {
  it('validate accepts a complete manifest v1', async () => {
    const file = await write(validManifest());
    const { code, out } = await run(['validate', file]);
    expect(code).toBe(0);
    expect(out).toContain('fictional-exam');
    expect(out).toContain('Fictional exam');
    expect(out).toContain('20 Hören, 25 Lesen, 1 audio track');
  });

  it('manifest v1 supports independent DTZ exams', async () => {
    const first = await write(validManifest(), 'first.json');
    const { content, keys } = buildSyntheticPilot();
    const swap = (text: string) => text.replaceAll('track-127', 'track-200');
    const second = {
      ...manifestOf(JSON.parse(swap(JSON.stringify(content))), { ...keys }),
      slug: 'another-exam',
      title: 'Another exam',
      audio: [{ trackId: 'track-200', file: 'track.mp3' }],
    };
    const secondFile = await write(second, 'second.json');
    for (const [file, slug] of [
      [first, 'fictional-exam'],
      [secondFile, 'another-exam'],
    ] as const) {
      const result = await run(['validate', file]);
      expect(result.code).toBe(0);
      expect(result.out).toContain(slug);
    }
  });

  it('dry run reports all problems of an invalid manifest', async () => {
    const { content, keys } = buildSyntheticPilot();
    const broken: ExamContent = {
      ...content,
      questions: content.questions.map((q) => {
        if (q.id === 'lesen-25') return { ...q, teil: 4 };
        if (q.id === 'hoeren-1') return { ...q, trackId: 'track-zzz' };
        return q;
      }),
    };
    const manifest = {
      ...manifestOf(broken, { ...keys, 'ghost-1': 'a' }),
      audio: [{ trackId: 'track-127', file: 'gone.mp3' }],
    };
    const { code, out, err } = await run(['validate', await write(manifest)]);
    expect(code).toBe(1);
    expect(out).toMatch(/teil-mismatch \$\.content id=lesen:teil-4/);
    expect(out).toMatch(/unknown-key \$\.keys id=ghost-1/);
    expect(out).toMatch(/broken-reference \$\.content id=hoeren-1/);
    expect(out).toMatch(/audio-missing \$\.audio\[0\]\.file id=track-127/);
    expect(err).toContain('problem(s)');
  });

  it('dry run performs no writes and needs no secrets', async () => {
    for (const name of Object.keys(process.env)) {
      if (name.startsWith('SUPABASE') || name.startsWith('NEXT_PUBLIC')) {
        vi.stubEnv(name, '');
      }
    }
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('network used'));
    const file = await write(validManifest());
    const before = await files();
    const { code } = await run(['validate', file]);
    expect(code).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await files()).toEqual(before);
  });

  it('runs as a real process with an empty environment', async () => {
    const file = await write(validManifest());
    const root = path.resolve(import.meta.dirname, '..');
    const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const cli = path.join(root, 'scripts', 'manage-exam-library.ts');
    const env = {
      PATH: process.env.PATH ?? '',
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    };
    const spawn = (manifest: string) =>
      spawnSync(process.execPath, [tsx, cli, 'validate', manifest], {
        env,
        cwd: root,
        encoding: 'utf8',
      });
    const ok = spawn(file);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('fictional-exam');
    const bad = spawn(pkg('none.json'));
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain('manifest-unreadable');
  }, 60_000);

  it('owner dry run refuses unsafe paths and types', async () => {
    const outside = path.join(dir, 'outside.mp3');
    await writeFile(outside, 'secret audio');
    const cases: [string, string][] = [
      ['../outside.mp3', 'audio-path-traversal'],
      ['sub/../track.mp3', 'audio-path-traversal'],
      [outside, 'audio-path-absolute'],
      ['C:\\audio\\track.mp3', 'audio-path-absolute'],
      ['\\\\host\\share\\track.mp3', 'audio-path-absolute'],
      ['https://example.com/track.mp3', 'audio-path-url'],
      ['file:///etc/track.mp3', 'audio-path-url'],
      ['track.flac', 'audio-type-unsupported'],
      ['track', 'audio-type-unsupported'],
    ];
    try {
      await symlink(outside, pkg('link.mp3'), 'file');
      cases.push(['link.mp3', 'audio-path-symlink']);
    } catch {
      // Creating symbolic links may need a privilege (Windows).
    }
    for (const [file, expected] of cases) {
      const manifest = {
        ...validManifest(),
        audio: [{ trackId: 'track-127', file }],
      };
      const result = await run(['validate', await write(manifest)]);
      expect(result.code, file).toBe(1);
      expect(result.out, file).toContain(expected);
      expect(result.all, file).not.toContain(dir);
    }
  });

  it('dry run rejects empty audio and duplicate track ids', async () => {
    await writeFile(pkg('empty.mp3'), '');
    const manifest = {
      ...validManifest(),
      audio: [
        { trackId: 'track-127', file: 'track.mp3' },
        { trackId: 'track-127', file: 'empty.mp3' },
      ],
    };
    const { code, out } = await run(['validate', await write(manifest)]);
    expect(code).toBe(1);
    expect(out).toContain('audio-empty');
    expect(out).toContain('audio-track-duplicate');
  });

  it('rejects audio over the size limit without reading it', async () => {
    await writeFile(pkg('big.mp3'), '');
    await truncate(pkg('big.mp3'), AUDIO_MAX_BYTES + 1);
    const manifest = {
      ...validManifest(),
      audio: [{ trackId: 'track-127', file: 'big.mp3' }],
    };
    const { code, out } = await run(['validate', await write(manifest)]);
    expect(code).toBe(1);
    expect(out).toContain('audio-too-large');
  });

  it('invalid manifest diagnostics redact keys and content', async () => {
    const { content, keys } = buildSyntheticPilot();
    const broken: ExamContent = {
      ...content,
      questions: content.questions.map((q) =>
        q.id === 'hoeren-1' ? { ...q, prompt: 'SECRETPROMPT', teil: 3 } : q,
      ),
    };
    const manifest = {
      ...manifestOf(broken, {
        ...keys,
        'hoeren-2': 'SECRETKEY',
        'hoeren-3': 'zz-second-key',
      }),
      notes: 'SECRETNOTE',
      audio: [{ trackId: 'track-127', file: 'SECRETDIR/gone.mp3' }],
    };
    const file = await write(manifest);
    for (const argv of [
      ['validate', file],
      ['validate', file, '--json'],
    ]) {
      const { code, all } = await run(argv);
      expect(code).toBe(1);
      for (const secret of [
        'SECRETPROMPT',
        'SECRETKEY',
        'zz-second-key',
        'SECRETNOTE',
        'SECRETDIR',
        'Fictional exam',
        'Antwort',
        dir,
      ]) {
        expect(all).not.toContain(secret);
      }
    }
    await writeFile(file, '{"keys": SECRETKEY');
    const garbage = await run(['validate', file]);
    expect(garbage.all).toContain('manifest-invalid-json');
    expect(garbage.all).not.toContain('SECRETKEY');
  });

  it('prints a usage error and exit code 2 for bad arguments', async () => {
    const bad = [
      [],
      ['publish'],
      ['validate'],
      ['validate', 'a', '--new-exam'],
      ['validate', 'a', 'b'],
      ['validate', '--nope'],
    ];
    for (const argv of bad) {
      const result = await run(argv);
      expect(result.code).toBe(2);
      expect(result.err).toContain('Usage');
    }
  });
});

describe('exam library CLI publish', () => {
  const unreachable = () => {
    throw new Error('the database client must not be created');
  };

  const blankSecrets = () => {
    for (const name of Object.keys(process.env)) {
      if (name.startsWith('SUPABASE') || name.startsWith('NEXT_PUBLIC')) {
        vi.stubEnv(name, '');
      }
    }
  };

  it('publish requires explicit intent flag', async () => {
    blankSecrets();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('network used'));
    const connect = vi.fn(unreachable);
    const file = await write(validManifest());
    const cases: [string[], string][] = [
      [['publish', file], 'exactly one of --new-exam or --new-version'],
      [['publish', file, '--json'], 'exactly one of --new-exam'],
      [['publish', file, '--rename'], 'exactly one of --new-exam'],
      [
        ['publish', file, '--new-exam', '--new-version'],
        'exactly one of --new-exam',
      ],
      [
        ['publish', file, '--new-exam', '--rename'],
        '--rename is allowed only with --new-version',
      ],
    ];
    for (const [argv, message] of cases) {
      const result = await run(argv, connect);
      expect(result.code, argv.join(' ')).toBe(1);
      expect(result.err, argv.join(' ')).toContain(message);
      expect(result.out, argv.join(' ')).toBe('');
    }
    expect(connect).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('publish validates the package before any client', async () => {
    const connect = vi.fn(unreachable);
    const { content, keys } = buildSyntheticPilot();
    const manifest = manifestOf(content, {
      ...keys,
      'hoeren-2': 'SECRETKEY',
    });
    const file = await write(manifest);
    const { code, out, all } = await run(
      ['publish', file, '--new-exam'],
      connect,
    );
    expect(code).toBe(1);
    expect(out).toMatch(/key-not-option \$\.keys id=hoeren-2/);
    expect(all).not.toContain('SECRETKEY');
    expect(all).not.toContain(dir);
    expect(connect).not.toHaveBeenCalled();
  });

  it('publish without secrets stops after validation', async () => {
    blankSecrets();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('network used'));
    const file = await write(validManifest());
    const before = await files();
    const { code, out, err } = await run(['publish', file, '--new-version']);
    expect(code).toBe(1);
    expect(out).toBe('');
    expect(err).toContain('SUPABASE_URL and SUPABASE_SECRET_KEY');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await files()).toEqual(before);
  });
});

describe('exam library CLI audit-audio', () => {
  const unreachable = () => {
    throw new Error('the database client must not be created');
  };

  it('audit command rejects unexpected arguments', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('network used'));
    const connect = vi.fn(unreachable);
    const cases = [
      ['audit-audio', 'extra'],
      ['audit-audio', 'manifest.json'],
      ['audit-audio', '--nope'],
      ['audit-audio', '--new-exam'],
      ['audit-audio', '--rename'],
      ['audit-audio', '--json', 'extra'],
    ];
    for (const argv of cases) {
      const result = await run(argv, connect);
      expect(result.code, argv.join(' ')).toBe(1);
      expect(result.err, argv.join(' ')).toContain('Usage');
      expect(result.out, argv.join(' ')).toBe('');
    }
    const unknown = await run(['audit-audios'], connect);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain('Usage');
    expect(connect).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('audit without secrets stops before any request', async () => {
    for (const name of Object.keys(process.env)) {
      if (name.startsWith('SUPABASE') || name.startsWith('NEXT_PUBLIC')) {
        vi.stubEnv(name, '');
      }
    }
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('network used'));
    const { code, out, err } = await run(['audit-audio']);
    expect(code).toBe(1);
    expect(out).toBe('');
    expect(err).toContain('SUPABASE_URL and SUPABASE_SECRET_KEY');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('audit and publisher hold no code that deletes objects', async () => {
    const lib = path.join(import.meta.dirname, 'lib');
    const audit = await readFile(path.join(lib, 'audio-audit.ts'), 'utf8');
    const publisher = await readFile(
      path.join(lib, 'publish-exam-version.ts'),
      'utf8',
    );
    expect(audit).not.toContain('storage.remove');
    expect(audit).not.toContain('.remove(');
    expect(publisher).not.toContain('.remove(');
    expect(publisher).not.toContain('upsert: true');
    // No owner tool outside the tests deletes or moves a Storage object.
    const names = await readdir(import.meta.dirname, { recursive: true });
    const sources = names.filter(
      (name) =>
        name.endsWith('.ts') &&
        !name.endsWith('.test.ts') &&
        !name.startsWith('prepare-pilot'),
    );
    for (const name of sources) {
      const text = await readFile(path.join(import.meta.dirname, name), 'utf8');
      expect(text, name).not.toMatch(/\.(remove|move)\(/);
    }
  });
});

// An in-memory bucket and table behind the two read calls of the audit. The
// fake offers no other method, so a call that writes or deletes would fail.
const fakeDatabase = (
  entries: Record<string, { name: string; id: string | null }[]>,
  references: string[],
): SupabaseClient => {
  const list = (folder: string, options: { limit: number; offset: number }) =>
    Promise.resolve({
      data: (entries[folder] ?? []).slice(
        options.offset,
        options.offset + options.limit,
      ),
      error: null,
    });
  const select = () => {
    const query = {
      order: () => query,
      range: (from: number, to: number) => ({
        returns: () =>
          Promise.resolve({
            data: references
              .slice(from, to + 1)
              .map((object_path) => ({ object_path })),
            error: null,
          }),
      }),
    };
    return query;
  };
  return {
    storage: { from: () => ({ list }) },
    from: () => ({ select }),
  } as unknown as SupabaseClient;
};

describe('audio audit report', () => {
  const objectNames = Array.from({ length: 250 }, (_, i) =>
    `${i}`.padStart(4, '0'),
  );
  const entries = {
    '': [
      { name: 'audio', id: null },
      { name: 'other', id: null },
    ],
    audio: objectNames.map((name) => ({
      name: `${name}.wav`,
      id: `id-${name}`,
    })),
    other: [
      { name: '.emptyFolderPlaceholder', id: 'id-placeholder' },
      { name: 'stray.mp3', id: 'id-stray' },
    ],
  };

  it('pages through the listing and the references', async () => {
    const referenced = objectNames
      .filter((name) => Number(name) % 2 === 0)
      .map((name) => `audio/${name}.wav`);
    // More references than one page of the table, most of them dangling.
    const dangling = Array.from({ length: 1500 }, (_, i) => `gone/${i}.wav`);
    const db = fakeDatabase(entries, [...dangling, ...referenced]);
    const report = await auditAudio(db);
    expect(report.objects).toBe(251);
    expect(report.referenced).toBe(125);
    expect(report.unreferenced).toHaveLength(126);
    expect(report.unreferenced).toContain('other/stray.mp3');
    expect(report.unreferenced).toContain('audio/0001.wav');
    expect(report.unreferenced).not.toContain('audio/0000.wav');
    expect(report.unreferenced).toEqual(report.unreferenced.toSorted());
  });

  it('prints paths and counts only, as text or JSON', () => {
    const report = { objects: 2, referenced: 1, unreferenced: ['audio/a.wav'] };
    const text = formatAuditReport(report, false);
    expect(text).toContain('unreferenced audio/a.wav');
    expect(text).toContain('Nothing was deleted');
    expect(JSON.parse(formatAuditReport(report, true))).toEqual(report);
  });

  it('audio audit without orphans prints no path', () => {
    const report = { objects: 1, referenced: 1, unreferenced: [] };
    expect(formatAuditReport(report, false)).not.toContain('audio/');
    expect(JSON.parse(formatAuditReport(report, true))).toEqual(report);
  });
});
