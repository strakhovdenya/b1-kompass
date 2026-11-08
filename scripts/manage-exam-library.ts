// Trusted owner tool for full DTZ exam packages. Today it has one command:
//
//   npm run exam:validate -- <manifest.json> [--json]
//
// `validate` is a dry run: it reads the owner manifest and checks the
// content, the answer keys and the local audio files. It needs no secrets,
// opens no network connection, uses no database or Storage client and writes
// nothing. The report holds codes, JSON paths and ids only: never keys,
// task texts, manifest content or absolute paths. Publication is a separate
// command (#81).

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { validateOwnerManifestFile } from './lib/owner-exam-manifest';
import type { ManifestValidation } from './lib/owner-exam-manifest';

export interface OwnerCliIo {
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export const EXIT_OK = 0;
export const EXIT_INVALID = 1;
export const EXIT_USAGE = 2;

export const USAGE = `Usage:
  validate <manifest.json> [--json]   check an owner manifest v1; writes nothing`;

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

export const runOwnerCli = async (
  argv: readonly string[],
  io: OwnerCliIo,
): Promise<number> => {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: { json: { type: 'boolean' } },
      allowPositionals: true,
      strict: true,
    });
  } catch {
    io.stderr(`${USAGE}\n`);
    return EXIT_USAGE;
  }
  const [command, manifestArgument, ...rest] = parsed.positionals;
  if (command !== 'validate' || !manifestArgument || rest.length > 0) {
    io.stderr(`${USAGE}\n`);
    return EXIT_USAGE;
  }
  return validateCommand(manifestArgument, io, parsed.values.json === true);
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
