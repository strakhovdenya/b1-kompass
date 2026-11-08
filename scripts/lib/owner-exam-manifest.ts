// Owner manifest v1: the private description of one full DTZ package (content,
// answer keys, local audio files), its read-only validation and the hand-over
// of a validated package to the publication (#81). Nothing here touches the
// database, Storage, the network or the environment, and nothing is written. The manifest holds answer keys, so a problem carries only a
// code, a JSON path, an id of a task or track and a fixed message — never a
// key, a task text, a manifest fragment or an absolute path.

import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  examContentSchema,
  findFullDtzProblems,
  sourceSchema,
} from '@b1k/domain';
import type { ExamContent } from '@b1k/domain';
import {
  audioContentTypeOf,
  findAudioContentType,
  isValidTrackId,
} from './publish-exam-version';
import type { AudioFileInput, ExamIdentity } from './publish-exam-version';

// The version of this administrative input. It is not `exam_versions.version`
// and not the format of the stored content.
export const OWNER_MANIFEST_SCHEMA_VERSION = 1;

// A full DTZ manifest is a few hundred kilobytes (45 tasks, texts, keys).
export const MANIFEST_MAX_BYTES = 5 * 1024 * 1024;

// The private Storage bucket accepts files up to 50 MiB
// (supabase/config.toml, file_size_limit). A full Hören recording as MP3 is
// about 25 MB; WAV of that length does not fit and must be encoded first.
export const AUDIO_MAX_BYTES = 50 * 1024 * 1024;

export const SUPPORTED_AUDIO_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.ogg'];

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const ownerManifestSchema = z.strictObject({
  schemaVersion: z.literal(OWNER_MANIFEST_SCHEMA_VERSION),
  slug: z.string().min(1).max(100).regex(SLUG),
  // No control characters: the title is printed in the terminal summary.
  title: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[^\p{Cc}]+$/u),
  format: z.literal('DTZ'),
  source: sourceSchema,
  content: examContentSchema,
  keys: z.record(z.string(), z.string()),
  audio: z
    .array(
      z.strictObject({
        trackId: z.string().min(1).max(100),
        file: z.string().min(1).max(500),
      }),
    )
    .min(1)
    .max(50),
});

export type OwnerExamManifest = z.infer<typeof ownerManifestSchema>;

export interface ManifestProblem {
  code: string;
  path: string;
  id?: string;
  message: string;
}

export interface ManifestSummary {
  slug: string;
  title: string;
  hoeren: number;
  lesen: number;
  tracks: number;
}

export interface ManifestValidation {
  problems: ManifestProblem[];
  // Present only when there are no problems.
  summary?: ManifestSummary;
}

const MESSAGES: Readonly<Record<string, string>> = {
  'manifest-unreadable': 'The manifest file cannot be read.',
  'manifest-too-large': `The manifest is larger than ${MANIFEST_MAX_BYTES} bytes.`,
  'manifest-invalid-json': 'The manifest is not valid JSON.',
  'unsupported-schema-version': 'schemaVersion must be the number 1.',
  'invalid-format': 'format must be "DTZ".',
  'unknown-field': 'The object has a field that manifest v1 does not define.',
  'invalid-field': 'The field is missing or has an invalid value.',
  'source-mismatch': 'source must equal content.source.',
  'audio-track-invalid':
    'trackId must use lower-case letters, digits and single hyphens.',
  'audio-track-duplicate': 'The trackId is used by more than one audio entry.',
  'audio-path-absolute': 'The audio path must be relative to the manifest.',
  'audio-path-url': 'The audio must be a local file, not a URL.',
  'audio-path-traversal': 'The audio path must not contain ".." segments.',
  'audio-path-invalid': 'The audio path contains forbidden characters.',
  'audio-path-symlink':
    'The audio file resolves outside the manifest directory.',
  'audio-type-unsupported': `The audio file type must be one of ${SUPPORTED_AUDIO_EXTENSIONS.join(', ')}.`,
  'audio-missing': 'The audio file does not exist.',
  'audio-unreadable': 'The audio file cannot be inspected.',
  'audio-not-file': 'The audio path is not a regular file.',
  'audio-empty': 'The audio file is empty.',
  'audio-too-large': `The audio file is larger than ${AUDIO_MAX_BYTES} bytes.`,
  'missing-key': 'The task has no answer key.',
  'key-not-option': 'The key does not name an option of the task.',
  'key-for-example': 'An example must not have a key.',
  'unknown-key': 'The key belongs to no task.',
  'broken-reference': 'A reference points to a missing text, track or task.',
  'inventory-mismatch': 'The task count differs from the full DTZ (20/25).',
  'duplicate-id': 'The id is used more than once.',
  'duplicate-number': 'The task number is used more than once in its skill.',
  'duplicate-option': 'An option id is used more than once in the task.',
  'invalid-group': 'The group does not match the full DTZ structure.',
  'options-mismatch': 'The options differ from the shared set of the group.',
  'invalid-example': 'The example is malformed.',
  'teil-mismatch': 'The Teil has a wrong number of tasks for the full DTZ.',
  'numbering-gap': 'Task numbers are not a gap-free ascending row.',
  'teil-order': 'Tasks are not ordered by Teil.',
  'invalid-question-kind':
    'The task kind or option count does not fit its Teil.',
  'multiple-hoeren-tracks': 'Hören must use exactly one recording.',
};

const UNSAFE_CHARACTERS = /[^A-Za-z0-9:_-]/g;

// Ids and path segments come from the private manifest; anything outside a
// conservative alphabet is masked so no free text can pass through.
const safe = (value: string): string =>
  value.replace(UNSAFE_CHARACTERS, '?').slice(0, 100);

const problem = (
  code: string,
  jsonPath: string,
  id?: string,
): ManifestProblem => ({
  code,
  path: jsonPath,
  ...(id === undefined ? {} : { id: safe(id) }),
  message: MESSAGES[code] ?? 'The package does not satisfy the DTZ contract.',
});

const pathOf = (segments: readonly PropertyKey[]): string =>
  segments.reduce<string>(
    (acc, segment) =>
      typeof segment === 'number'
        ? `${acc}[${segment}]`
        : `${acc}.${safe(String(segment))}`,
    '$',
  );

const zodProblems = (error: z.ZodError): ManifestProblem[] =>
  error.issues.map((issue) => {
    const [first] = issue.path;
    let code = 'invalid-field';
    if (issue.code === 'unrecognized_keys') code = 'unknown-field';
    else if (first === 'schemaVersion') code = 'unsupported-schema-version';
    else if (first === 'format') code = 'invalid-format';
    return problem(code, pathOf(issue.path));
  });

// Material rules come from the domain (#79); keys are addressed under $.keys.
const KEY_CODES = new Set([
  'missing-key',
  'key-not-option',
  'key-for-example',
  'unknown-key',
]);

const materialProblems = (
  manifest: OwnerExamManifest,
  trackIds: ReadonlySet<string>,
): ManifestProblem[] =>
  findFullDtzProblems(manifest.content, manifest.keys, { trackIds }).map(
    ({ code, questionId }) =>
      problem(code, KEY_CODES.has(code) ? '$.keys' : '$.content', questionId),
  );

const WINDOWS_DRIVE = /^[a-z]:/i;
const URL_SCHEME = /^[a-z][a-z0-9+.-]+:/i;

// Lexical checks that need no file system access.
const lexicalPathProblem = (file: string): string | undefined => {
  if (file.includes('\0')) return 'audio-path-invalid';
  if (
    WINDOWS_DRIVE.test(file) ||
    path.posix.isAbsolute(file) ||
    path.win32.isAbsolute(file)
  ) {
    return 'audio-path-absolute';
  }
  if (URL_SCHEME.test(file)) return 'audio-path-url';
  if (file.split(/[\\/]/).includes('..')) return 'audio-path-traversal';
  if (!findAudioContentType(file)) return 'audio-type-unsupported';
  return undefined;
};

const isInside = (root: string, target: string): boolean => {
  const relative = path.relative(root, target);
  return (
    relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
  );
};

// Inspects one file without reading its bytes.
const fileProblem = async (
  manifestDir: string,
  file: string,
): Promise<string | undefined> => {
  const resolved = path.resolve(manifestDir, file);
  try {
    await lstat(resolved);
  } catch {
    return 'audio-missing';
  }
  let real: string;
  let realDir: string;
  try {
    real = await realpath(resolved);
    realDir = await realpath(manifestDir);
  } catch {
    return 'audio-missing';
  }
  if (!isInside(realDir, real)) return 'audio-path-symlink';
  try {
    const info = await stat(real);
    if (!info.isFile()) return 'audio-not-file';
    if (info.size === 0) return 'audio-empty';
    if (info.size > AUDIO_MAX_BYTES) return 'audio-too-large';
  } catch {
    return 'audio-unreadable';
  }
  return undefined;
};

const audioEntriesSchema = ownerManifestSchema.shape.audio;
type AudioEntries = z.infer<typeof audioEntriesSchema>;

const audioProblems = async (
  entries: AudioEntries,
  manifestDir: string,
): Promise<ManifestProblem[]> => {
  const seen = new Set<string>();
  const checks = entries.map(async (entry, index) => {
    const at = `$.audio[${index}]`;
    const found: ManifestProblem[] = [];
    const trackId = isValidTrackId(entry.trackId) ? entry.trackId : undefined;
    if (trackId === undefined) {
      found.push(problem('audio-track-invalid', `${at}.trackId`));
    } else if (seen.has(trackId)) {
      found.push(problem('audio-track-duplicate', `${at}.trackId`, trackId));
    } else {
      seen.add(trackId);
    }
    const code =
      lexicalPathProblem(entry.file) ??
      (await fileProblem(manifestDir, entry.file));
    if (code) found.push(problem(code, `${at}.file`, trackId));
    return found;
  });
  return (await Promise.all(checks)).flat();
};

const countOf = (content: ExamContent, skill: 'hoeren' | 'lesen'): number =>
  content.questions.filter((question) => question.skill === skill).length;

// Validates a parsed manifest object; the audio paths are resolved against
// manifestDir. Collects every problem instead of stopping at the first.
export const validateOwnerManifest = async (
  raw: unknown,
  manifestDir: string,
): Promise<ManifestValidation> => {
  const parsed = ownerManifestSchema.safeParse(raw);
  const problems: ManifestProblem[] = parsed.success
    ? []
    : zodProblems(parsed.error);
  const rawAudio =
    typeof raw === 'object' && raw !== null && 'audio' in raw
      ? audioEntriesSchema.safeParse(raw.audio)
      : undefined;
  if (rawAudio?.success) {
    problems.push(...(await audioProblems(rawAudio.data, manifestDir)));
  }
  if (!parsed.success) return { problems };
  const manifest = parsed.data;
  if (!isDeepStrictEqual(manifest.source, manifest.content.source)) {
    problems.push(problem('source-mismatch', '$.source'));
  }
  const trackIds = new Set(
    manifest.audio.map((item) => item.trackId).filter(isValidTrackId),
  );
  problems.push(...materialProblems(manifest, trackIds));
  if (problems.length > 0) return { problems };
  return {
    problems,
    summary: {
      slug: manifest.slug,
      title: manifest.title,
      hoeren: countOf(manifest.content, 'hoeren'),
      lesen: countOf(manifest.content, 'lesen'),
      tracks: manifest.audio.length,
    },
  };
};

type ManifestRead =
  | { raw: unknown; manifestDir: string; problems: null }
  | { raw: null; manifestDir: null; problems: ManifestProblem[] };

const unreadable = (code: string): ManifestRead => ({
  raw: null,
  manifestDir: null,
  problems: [problem(code, '$')],
});

const readManifestFile = async (
  manifestPath: string,
): Promise<ManifestRead> => {
  const resolved = path.resolve(manifestPath);
  let text: string;
  try {
    const info = await stat(resolved);
    if (!info.isFile()) return unreadable('manifest-unreadable');
    if (info.size > MANIFEST_MAX_BYTES) return unreadable('manifest-too-large');
    text = await readFile(resolved, 'utf8');
  } catch {
    return unreadable('manifest-unreadable');
  }
  try {
    const raw: unknown = JSON.parse(text);
    return { raw, manifestDir: path.dirname(resolved), problems: null };
  } catch {
    // The parser message quotes the input; it is deliberately dropped.
    return unreadable('manifest-invalid-json');
  }
};

// Reads the manifest file (the only file whose bytes are read) and validates
// it. Audio paths are relative to the directory of the manifest.
export const validateOwnerManifestFile = async (
  manifestPath: string,
): Promise<ManifestValidation> => {
  const read = await readManifestFile(manifestPath);
  if (read.problems) return { problems: read.problems };
  return validateOwnerManifest(read.raw, read.manifestDir);
};

// A validated package as the input of publishExamVersion, without intent.
export interface OwnerPackage extends ExamIdentity {
  content: ExamContent;
  keys: Record<string, string>;
  audio: AudioFileInput[];
}

export interface OwnerPackageLoad {
  validation: ManifestValidation;
  // Present only when the validation found no problem.
  ownerPackage: OwnerPackage | null;
}

const readAudio = async (
  manifestDir: string,
  entry: OwnerExamManifest['audio'][number],
  index: number,
): Promise<AudioFileInput | ManifestProblem> => {
  const at = `$.audio[${index}].file`;
  // The file may have changed after the validation: the containment, type
  // and size checks run again right before its bytes are read.
  const code = await fileProblem(manifestDir, entry.file);
  if (code) return problem(code, at, entry.trackId);
  let bytes: Uint8Array;
  try {
    const real = await realpath(path.resolve(manifestDir, entry.file));
    bytes = new Uint8Array(await readFile(real));
  } catch {
    return problem('audio-unreadable', at, entry.trackId);
  }
  if (bytes.byteLength === 0) return problem('audio-empty', at, entry.trackId);
  if (bytes.byteLength > AUDIO_MAX_BYTES) {
    return problem('audio-too-large', at, entry.trackId);
  }
  return {
    trackId: entry.trackId,
    contentType: audioContentTypeOf(entry.file),
    bytes,
  };
};

const isAudioFile = (
  item: AudioFileInput | ManifestProblem,
): item is AudioFileInput => 'bytes' in item;

// Repeats the full validation of the manifest and, only when it passes,
// reads the audio bytes for the publication. No problem, no package.
export const loadOwnerPackage = async (
  manifestPath: string,
): Promise<OwnerPackageLoad> => {
  const read = await readManifestFile(manifestPath);
  if (read.problems) {
    return { validation: { problems: read.problems }, ownerPackage: null };
  }
  const validation = await validateOwnerManifest(read.raw, read.manifestDir);
  const parsed = ownerManifestSchema.safeParse(read.raw);
  if (validation.problems.length > 0 || !parsed.success) {
    return { validation, ownerPackage: null };
  }
  const manifest = parsed.data;
  const { manifestDir } = read;
  const items = await Promise.all(
    manifest.audio.map((entry, index) => readAudio(manifestDir, entry, index)),
  );
  const audio = items.filter(isAudioFile);
  if (audio.length !== items.length) {
    const problems = items.filter(
      (item): item is ManifestProblem => !isAudioFile(item),
    );
    return { validation: { problems }, ownerPackage: null };
  }
  return {
    validation,
    ownerPackage: {
      slug: manifest.slug,
      title: manifest.title,
      format: manifest.format,
      content: manifest.content,
      keys: manifest.keys,
      audio,
    },
  };
};
