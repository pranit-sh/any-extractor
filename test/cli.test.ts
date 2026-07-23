import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist', 'cli.mjs');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'sample.md');

// The CLI is a compiled artifact — run these tests only when `dist/cli.mjs`
// exists. `prepublishOnly` and CI both build before test, so this stays
// covered in the pipelines that matter without slowing down the inner loop.
const cliBuilt = existsSync(CLI);
const d = cliBuilt ? describe : describe.skip;

async function runCli(
  args: string[],
  opts: { input?: string } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const child = execFileAsync('node', [CLI, ...args], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    if (opts.input !== undefined) {
      child.child.stdin?.end(opts.input);
    }
    const { stdout, stderr } = await child;
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 };
  }
}

d('any-extractor CLI', () => {
  beforeAll(() => {
    if (!cliBuilt) {
      // eslint-disable-next-line no-console
      console.warn(`[cli.test] skipping — build dist first with \`npm run build\``);
    }
  });

  it('prints version with --version', async () => {
    const { stdout, code } = await runCli(['--version']);
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('prints usage with --help', async () => {
    const { stdout, code } = await runCli(['--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('any-extractor');
    expect(stdout).toContain('Options:');
  });

  it('emits markdown by default', async () => {
    const { stdout, code } = await runCli([FIXTURE]);
    expect(code).toBe(0);
    expect(stdout.length).toBeGreaterThan(0);
    // Markdown for a sample.md fixture with a heading — accept either GFM
    // heading (# ...) or the plain text if the fixture is not heading-led.
    expect(stdout.trim().length).toBeGreaterThan(0);
  });

  it('emits plain text with --text', async () => {
    const { stdout, code } = await runCli([FIXTURE, '--text']);
    expect(code).toBe(0);
    // Plain-text render strips markdown emphasis.
    expect(stdout).not.toMatch(/\*\*/);
  });

  it('emits metadata JSON with --metadata', async () => {
    const { stdout, code } = await runCli([FIXTURE, '--metadata']);
    expect(code).toBe(0);
    const meta = JSON.parse(stdout) as { mime: string };
    expect(meta.mime).toBeTruthy();
  });

  it('emits full ExtractResult with --json', async () => {
    const { stdout, code } = await runCli([FIXTURE, '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as {
      markdown: string;
      text: string;
      sections: unknown[];
      metadata: { mime: string };
    };
    expect(parsed.sections.length).toBeGreaterThan(0);
    expect(typeof parsed.markdown).toBe('string');
    expect(typeof parsed.text).toBe('string');
  });

  it('emits a single section with --section', async () => {
    const { stdout, code } = await runCli([FIXTURE, '--section', '1']);
    expect(code).toBe(0);
    expect(stdout.length).toBeGreaterThan(0);
  });

  it('exits 1 for an out-of-range --section without dumping usage', async () => {
    const { stderr, stdout, code } = await runCli([FIXTURE, '--section', '99']);
    expect(code).toBe(1);
    expect(stderr).toContain('out of range');
    expect(stderr).not.toContain('Usage:');
    expect(stdout).toBe('');
  });

  it('exits 1 with a --help hint on unknown flag (no USAGE dump)', async () => {
    const { stderr, code } = await runCli(['--nope']);
    expect(code).toBe(1);
    expect(stderr).toContain('unknown flag');
    expect(stderr).toContain('any-extractor --help');
    // The short-error UX should NOT dump the full USAGE block.
    expect(stderr).not.toContain('Usage:');
  });

  it('shows help on stdout and exits 0 when run with no arguments', async () => {
    const { stdout, stderr, code } = await runCli([]);
    expect(code).toBe(0);
    expect(stdout).toContain('any-extractor');
    expect(stdout).toContain('Options:');
    expect(stderr).toBe('');
  });

  it('reads from stdin with `-`', async () => {
    const { stdout, code } = await runCli(['-', '--text'], { input: 'hello from stdin' });
    expect(code).toBe(0);
    expect(stdout).toContain('hello from stdin');
  });
});
