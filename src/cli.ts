#!/usr/bin/env node
/**
 * Executable entry point for the `any-extractor` bin.
 *
 * A thin command-line wrapper over {@link extract}. Reads a file path,
 * URL, or stdin (`-`) and emits one of four views to stdout:
 *
 * - default          full-document GFM markdown
 * - `--text`         plain reading-order text (no markdown syntax)
 * - `--metadata`     the {@link ExtractMetadata} object as JSON
 * - `--json`         the full {@link ExtractResult} as JSON
 *
 * `--section <n>` narrows any of the above to a single 1-based section.
 *
 * Diagnostics go to stderr; the rendered result is the only thing on
 * stdout, so the CLI composes cleanly in pipelines. Exit code is 0 on
 * success and 1 on any error (bad flag, unknown section, extraction
 * failure).
 *
 * @example
 * ```sh
 * any-extractor report.pdf                 # markdown
 * any-extractor report.pdf --text          # plain text
 * any-extractor report.pdf --json          # full ExtractResult
 * any-extractor report.pdf --metadata      # metadata only
 * any-extractor report.pdf --section 2     # just section 2
 * cat notes.md | any-extractor - --text    # read from stdin
 * ```
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { extract } from './index';
import { toMarkdown, toText } from './blocks';
import type { ExtractResult, Section } from './types';

/** Output views the CLI can render. Mutually exclusive. */
type Format = 'markdown' | 'text' | 'metadata' | 'json';

interface Args {
  /** File path, URL, or `-` for stdin. */
  input: string;
  format: Format;
  /** 1-based section to narrow to, if `--section` was given. */
  section?: number;
}

const USAGE = `any-extractor — turn any document into agent-ready markdown, text, or JSON.

Usage:
  any-extractor <file|url|-> [options]

Options:
  --text            Emit plain reading-order text (no markdown syntax).
  --metadata        Emit file-level metadata as JSON.
  --json            Emit the full ExtractResult (sections, metadata, markdown, text) as JSON.
  --section <n>     Narrow output to a single 1-based section.
  -h, --help        Show this help and exit.
  -v, --version     Print the version and exit.

Input:
  Pass a file path or URL, or "-" to read the document from stdin.

Examples:
  any-extractor report.pdf
  any-extractor report.pdf --text
  any-extractor report.pdf --section 2
  cat notes.md | any-extractor - --json`;

/**
 * Print a short error + a hint pointing at `--help`, then exit 1. We
 * deliberately do NOT dump the full USAGE on every error — most modern
 * CLIs (git, node, npm) keep errors terse and let `--help` be the entry
 * point for exploration. Bare invocation (no args) is handled
 * separately in {@link parseArgs} and shows the full help on stdout.
 */
function fail(message: string): never {
  process.stderr.write(`any-extractor: ${message}\nRun \`any-extractor --help\` for usage.\n`);
  process.exit(1);
}

/** Read the package version from the sibling package.json. */
function readVersion(): string {
  const pkgUrl = new URL('../package.json', import.meta.url);
  const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), 'utf8')) as { version: string };
  return pkg.version;
}

/** Slurp stdin to a Buffer. Used for the `-` input. */
async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Parse argv into {@link Args}. Handles `--help`/`--version` by printing
 * and exiting directly; every other malformed input exits via
 * {@link fail} (usage on stderr, code 1).
 */
function parseArgs(argv: string[]): Args {
  // Bare `any-extractor` with no args is almost always a first-run
  // "what is this?" — show help on stdout and exit 0 rather than
  // treating it as a usage error.
  if (argv.length === 0) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }

  let input: string | undefined;
  let format: Format = 'markdown';
  let section: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '-h':
      case '--help':
        process.stdout.write(`${USAGE}\n`);
        process.exit(0);
        break;
      case '-v':
      case '--version':
        process.stdout.write(`${readVersion()}\n`);
        process.exit(0);
        break;
      case '--text':
        format = 'text';
        break;
      case '--metadata':
        format = 'metadata';
        break;
      case '--json':
        format = 'json';
        break;
      case '--section': {
        const raw = argv[++i];
        const n = Number(raw);
        if (!raw || !Number.isInteger(n) || n < 1) {
          fail(`--section requires a positive integer, got "${raw ?? ''}"`);
        }
        section = n;
        break;
      }
      case '-':
        input = arg;
        break;
      default:
        if (arg.startsWith('-')) fail(`unknown flag "${arg}"`);
        if (input !== undefined) fail(`unexpected argument "${arg}"`);
        input = arg;
    }
  }

  if (input === undefined) fail('missing input — pass a file path, URL, or "-" for stdin');
  return { input, format, section };
}

/** Render the requested view of a whole result. */
function renderResult(result: ExtractResult, format: Format): string {
  switch (format) {
    case 'markdown':
      return result.markdown;
    case 'text':
      return result.text;
    case 'metadata':
      return JSON.stringify(result.metadata, null, 2);
    case 'json':
      // `markdown` and `text` are enumerable getters on the result, so
      // JSON.stringify materializes them alongside `sections`/`metadata`.
      return JSON.stringify(result, null, 2);
  }
}

/**
 * Render the requested view of a single section. Metadata and full-JSON
 * formats aren't section-scoped, so they fall back to the whole result
 * with the chosen section's blocks swapped in.
 */
function renderSection(result: ExtractResult, section: Section, format: Format): string {
  switch (format) {
    case 'markdown':
      return toMarkdown(section);
    case 'text':
      return toText(section);
    case 'metadata':
      return JSON.stringify(result.metadata, null, 2);
    case 'json':
      return JSON.stringify(
        {
          markdown: toMarkdown(section),
          text: toText(section),
          section,
          metadata: result.metadata,
        },
        null,
        2,
      );
  }
}

async function main(): Promise<void> {
  // A downstream consumer (`head`, `less`, a closed pager) can close our
  // stdout before we finish writing. Node surfaces that as an EPIPE
  // 'error' event that would otherwise crash the process with a stack
  // trace — swallow it and exit quietly, the standard CLI behavior.
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') process.exit(0);
    throw err;
  });

  const args = parseArgs(process.argv.slice(2));
  const input = args.input === '-' ? await readStdin() : args.input;

  let result: ExtractResult;
  try {
    result = await extract(input);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  let output: string;
  if (args.section !== undefined) {
    const section = result.sections[args.section - 1];
    if (!section) {
      process.stderr.write(
        `any-extractor: section ${args.section} out of range ` +
          `(document has ${result.sections.length} section(s))\n`,
      );
      process.exit(1);
    }
    output = renderSection(result, section, args.format);
  } else {
    output = renderResult(result, args.format);
  }

  process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
}

main().catch((err) => {
  process.stderr.write(`any-extractor: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
