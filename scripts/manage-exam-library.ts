// Trusted owner tool for full DTZ exam packages:
//
//   npm run exam:validate -- <manifest.json> [--json]
//   SUPABASE_URL=... SUPABASE_SECRET_KEY=... \
//   npm run exam:publish -- <manifest.json> --new-exam | --new-version [--rename]
//   npm run exam:audit-audio [-- --json]
//
// `validate` is a dry run: it reads the owner manifest and checks the
// content, the answer keys and the local audio files. It needs no secrets,
// opens no network connection, uses no database or Storage client and writes
// nothing.
//
// `publish` (#81) requires exactly one intent flag before anything else
// happens, repeats the same validation, runs a read-only preflight of the
// exam identity (slug, title, format) and only then uploads the audio and
// calls the guarded database function through publishExamVersion. A refused
// preflight uploads nothing and writes nothing.
//
// `audit-audio` (#82) is read-only: it lists the objects of the private audio
// bucket that no version refers to and prints their paths. It deletes nothing.
//
// Reports hold codes, JSON paths, ids, the slug and the version id only:
// never keys, task texts, manifest content, secrets, signed URLs or absolute
// paths.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createServiceClient,
  readServiceConfig,
} from '../apps/web/src/server/db';
import {
  LISTING_FAILED,
  REFERENCES_FAILED,
  auditAudio,
  formatAuditReport,
} from './lib/audio-audit';
import {
  loadOwnerPackage,
  validateOwnerManifestFile,
} from './lib/owner-exam-manifest';
import type { ManifestValidation } from './lib/owner-exam-manifest';
import {
  AudioObjectMismatchError,
  PublicationRejectedError,
  preflightPublication,
  publishExamVersion,
} from './lib/publish-exam-version';
import type {
  PublicationRejection,
  PublishIntent,
  PublishOutcome,
} from './lib/publish-exam-version';

export interface OwnerCliIo {
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  // Opens the privileged client; only `publish` calls it, after the intent
  // and the validation. Defaults to SUPABASE_URL and SUPABASE_SECRET_KEY.
  connect?: () => SupabaseClient;
}

export const EXIT_OK = 0;
export const EXIT_INVALID = 1;
export const EXIT_USAGE = 2;

export const USAGE = `Usage:
  validate <manifest.json> [--json]   check an owner manifest v1; writes nothing
  publish <manifest.json> --new-exam | --new-version [--rename] [--json]
                                      validate again and publish one version
                                      (needs SUPABASE_URL, SUPABASE_SECRET_KEY)
  audit-audio [--json]                list audio objects without a version
                                      (read-only; deletes nothing)`;

const REJECTION_MESSAGES: Readonly<Record<PublicationRejection, string>> = {
  exam_exists: 'The slug already belongs to an exam; use --new-version.',
  exam_not_found: 'No exam has this slug; use --new-exam.',
  exam_format_mismatch: 'The format of an existing exam cannot change.',
  exam_title_mismatch:
    'The title differs from the published exam; add --rename to change it.',
  exam_identity_conflict: 'The exam changed concurrently; run again.',
  publish_intent_invalid: 'The publication intent is not valid.',
  material_invalid: 'The database refused the material or its audio.',
};

// Fixed messages of the publisher that carry no data.
const SAFE_FAILURES = new Set([
  'Exam lookup failed',
  'Version lookup failed',
  'Key lookup failed',
  'Audio lookup failed',
  'Audio upload failed',
  'Audio verification failed',
  'Publication failed',
]);

const UNREADABLE_RESULT = 'Publication result unreadable';

const SAFE_CODE = /^[A-Za-z0-9_]{1,40}$/;

const codeOf = (cause: unknown): string | null => {
  if (typeof cause !== 'object' || cause === null) return null;
  const { code, statusCode } = cause as {
    code?: unknown;
    statusCode?: unknown;
  };
  const value = code ?? statusCode;
  const text = typeof value === 'number' ? String(value) : value;
  return typeof text === 'string' && SAFE_CODE.test(text) ? text : null;
};

// A failure as one safe line: the code of a refusal, a fixed message of the
// publisher with the code of its cause, or nothing about the internals.
const describeFailure = (error: unknown): string => {
  if (error instanceof AudioObjectMismatchError) {
    return (
      `Publication stopped: ${error.code} (track ${error.trackId}) - ` +
      'the stored audio object does not match its SHA-256; nothing was ' +
      'overwritten or deleted'
    );
  }
  if (error instanceof PublicationRejectedError) {
    const message = REJECTION_MESSAGES[error.code];
    return `Publication rejected: ${error.code} - ${message}`;
  }
  if (error instanceof Error && error.message === UNREADABLE_RESULT) {
    // Committed, but the answer could not be read.
    return `${UNREADABLE_RESULT}: the version may be published; check the exam before running again`;
  }
  if (error instanceof Error && SAFE_FAILURES.has(error.message)) {
    const code = codeOf(error.cause);
    const suffix = code ? ` (${code})` : '';
    return `Publication failed: ${error.message}${suffix}`;
  }
  return 'Publication aborted by an internal error';
};

const formatProblem = (item: ManifestValidation['problems'][number]): string =>
  [
    item.code,
    item.path,
    ...(item.id === undefined ? [] : [`id=${item.id}`]),
    `- ${item.message}`,
  ].join(' ');

const report = (result: ManifestValidation, io: OwnerCliIo, json: boolean) => {
  const { problems, summary } = result;
  if (json) {
    io.stdout(
      `${JSON.stringify({ ok: problems.length === 0, summary, problems }, null, 2)}\n`,
    );
  } else if (summary) {
    const { slug, title, hoeren, lesen, tracks } = summary;
    io.stdout(
      `OK ${slug} "${title}": ${hoeren} Hören, ${lesen} Lesen, ${tracks} audio track(s)\n`,
    );
  } else {
    io.stdout(`${problems.map(formatProblem).join('\n')}\n`);
  }
  if (problems.length > 0) {
    io.stderr(`Validation failed: ${problems.length} problem(s)\n`);
  }
};

const validateCommand = async (
  manifestArgument: string,
  io: OwnerCliIo,
  json: boolean,
): Promise<number> => {
  const manifestPath = path.resolve(io.cwd, manifestArgument);
  try {
    const result = await validateOwnerManifestFile(manifestPath);
    report(result, io, json);
    return result.problems.length === 0 ? EXIT_OK : EXIT_INVALID;
  } catch {
    // A bug must not echo data it was holding.
    io.stderr('Validation aborted by an internal error\n');
    return EXIT_INVALID;
  }
};

const connectFromEnv = (): SupabaseClient =>
  createServiceClient(readServiceConfig(process.env));

const reportOutcome = (
  slug: string,
  outcome: PublishOutcome,
  io: OwnerCliIo,
  json: boolean,
) => {
  const { versionId, isNew } = outcome;
  if (json) {
    io.stdout(`${JSON.stringify({ slug, versionId, isNew }, null, 2)}\n`);
    return;
  }
  const state = isNew ? 'Published' : 'Already published';
  io.stdout(`${state} slug=${slug} versionId=${versionId} isNew=${isNew}\n`);
};

interface PublishOptions {
  intent: PublishIntent;
  rename: boolean;
  json: boolean;
}

const publishCommand = async (
  manifestArgument: string,
  options: PublishOptions,
  io: OwnerCliIo,
): Promise<number> => {
  const manifestPath = path.resolve(io.cwd, manifestArgument);
  let loaded;
  try {
    loaded = await loadOwnerPackage(manifestPath);
  } catch {
    io.stderr('Validation aborted by an internal error\n');
    return EXIT_INVALID;
  }
  const { ownerPackage } = loaded;
  if (!ownerPackage) {
    report(loaded.validation, io, options.json);
    return EXIT_INVALID;
  }
  let db: SupabaseClient;
  try {
    db = (io.connect ?? connectFromEnv)();
  } catch {
    io.stderr('Publication needs SUPABASE_URL and SUPABASE_SECRET_KEY\n');
    return EXIT_INVALID;
  }
  const request = {
    ...ownerPackage,
    intent: options.intent,
    rename: options.rename,
  };
  try {
    const existing = await preflightPublication(db, request);
    const outcome = await publishExamVersion(db, request);
    reportOutcome(ownerPackage.slug, outcome, io, options.json);
    if (existing && existing.title !== request.title) {
      io.stderr(
        'Warning: --rename changed the title shown for every version and ' +
          'every earlier review of this exam\n',
      );
    }
    return EXIT_OK;
  } catch (error) {
    io.stderr(`${describeFailure(error)}\n`);
    return EXIT_INVALID;
  }
};

const AUDIT_FAILURES = new Set([LISTING_FAILED, REFERENCES_FAILED]);

const describeAuditFailure = (error: unknown): string => {
  if (error instanceof Error && AUDIT_FAILURES.has(error.message)) {
    const code = codeOf(error.cause);
    return `Audit failed: ${error.message}${code ? ` (${code})` : ''}`;
  }
  return 'Audit aborted by an internal error';
};

// `audit-audio` takes no manifest and no publish flag; anything else is a
// refusal before a client exists.
const auditCommand = async (
  args: readonly string[],
  io: OwnerCliIo,
): Promise<number> => {
  let json = false;
  try {
    const parsed = parseArgs({
      args: [...args],
      options: { json: { type: 'boolean' } },
      allowPositionals: true,
      strict: true,
    });
    if (parsed.positionals.length > 0) throw new Error('unexpected argument');
    json = parsed.values.json === true;
  } catch {
    io.stderr(`${USAGE}\n`);
    return EXIT_INVALID;
  }
  let db: SupabaseClient;
  try {
    db = (io.connect ?? connectFromEnv)();
  } catch {
    io.stderr('Audit needs SUPABASE_URL and SUPABASE_SECRET_KEY\n');
    return EXIT_INVALID;
  }
  try {
    io.stdout(formatAuditReport(await auditAudio(db), json));
    return EXIT_OK;
  } catch (error) {
    io.stderr(`${describeAuditFailure(error)}\n`);
    return EXIT_INVALID;
  }
};

interface IntentFlags {
  'new-exam'?: boolean;
  'new-version'?: boolean;
  rename?: boolean;
}

// The intent of a publish run: exactly one of --new-exam and --new-version,
// and --rename only with --new-version. A refusal is a message.
const intentOf = (
  flags: IntentFlags,
): { intent: PublishIntent | null; refusal: string | null } => {
  const isNewExam = flags['new-exam'] === true;
  const isNewVersion = flags['new-version'] === true;
  if (isNewExam === isNewVersion) {
    const refusal = 'publish needs exactly one of --new-exam or --new-version';
    return { intent: null, refusal };
  }
  if (isNewExam && flags.rename === true) {
    const refusal = '--rename is allowed only with --new-version';
    return { intent: null, refusal };
  }
  return { intent: isNewExam ? 'new-exam' : 'new-version', refusal: null };
};

const hasPublishFlag = (flags: IntentFlags): boolean =>
  flags['new-exam'] === true ||
  flags['new-version'] === true ||
  flags.rename === true;

export const runOwnerCli = async (
  argv: readonly string[],
  io: OwnerCliIo,
): Promise<number> => {
  if (argv[0] === 'audit-audio') return auditCommand(argv.slice(1), io);
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        json: { type: 'boolean' },
        'new-exam': { type: 'boolean' },
        'new-version': { type: 'boolean' },
        rename: { type: 'boolean' },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch {
    io.stderr(`${USAGE}\n`);
    return EXIT_USAGE;
  }
  const { values, positionals } = parsed;
  const [command, manifestArgument, ...rest] = positionals;
  const isKnown = command === 'validate' || command === 'publish';
  if (!isKnown || !manifestArgument || rest.length > 0) {
    io.stderr(`${USAGE}\n`);
    return EXIT_USAGE;
  }
  const json = values.json === true;
  if (command === 'validate') {
    if (hasPublishFlag(values)) {
      io.stderr(`${USAGE}\n`);
      return EXIT_USAGE;
    }
    return validateCommand(manifestArgument, io, json);
  }
  const { intent, refusal } = intentOf(values);
  if (!intent) {
    io.stderr(`${refusal}\n${USAGE}\n`);
    return EXIT_INVALID;
  }
  const rename = values.rename === true;
  return publishCommand(manifestArgument, { intent, rename, json }, io);
};

const samePath = (left: string, right: string): boolean => {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32'
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
};

const isEntryPoint =
  process.argv[1] !== undefined &&
  samePath(fileURLToPath(import.meta.url), process.argv[1]);

if (isEntryPoint) {
  runOwnerCli(process.argv.slice(2), {
    cwd: process.cwd(),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  }).then((code) => {
    process.exitCode = code;
  });
}
