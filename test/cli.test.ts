import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { prepareSite } from './helpers/site.ts';
import type { Site } from './helpers/site.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const VERSION = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;

interface Outcome {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the CLI from source, the way a user would run the built file. */
function cli(args: string[]): Promise<Outcome> {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, ['src/cli.ts', ...args], {
      cwd: ROOT,
      env: { ...process.env, NO_COLOR: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}

describe('cli', { timeout: 180_000, concurrency: 4 }, () => {
  let site: Site;
  const page = (name: string): string => join(site.dir, name);

  before(async () => {
    site = await prepareSite(false);
  });
  after(async () => {
    await site?.close();
  });

  it('prints help and the version', async () => {
    const help = await cli(['--help']);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /Usage\n {2}viewport-qa <url\|file\.html> \[options\]/);
    assert.match(help.stdout, /--fail-on/);
    assert.deepEqual(await cli(['--version']), { code: 0, stdout: `${VERSION}\n`, stderr: '' });
  });

  it('lists checks, rules and thresholds', async () => {
    const { code, stdout } = await cli(['--list']);
    assert.equal(code, 0);
    assert.match(stdout, /horizontal-overflow +error/);
    assert.match(stdout, /pointer-cursor +error/);
    assert.match(stdout, /layoutShift = 0\.1/);
  });

  it('exits 0 and says so for a clean local file, with every rule on', async () => {
    const { code, stdout, stderr } = await cli([
      page('clean.html'),
      '--widths',
      '390,1024',
      '--rules',
      'heading-logo-alignment,white-icon-on-dark,no-native-select,no-native-date-picker,pointer-cursor,no-coloured-text-on-dark',
    ]);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /390x844 @2x {2}no problems/);
    assert.match(stdout, /1024x768 @2x {2}no problems/);
    assert.match(stdout, /No problems across 2 widths\./);
  });

  it('exits 1 on an error and lists it per width with selector and numbers', async () => {
    const { code, stdout } = await cli([page('overflow.html'), '--widths', '390,1440']);
    assert.equal(code, 1);
    assert.match(stdout, /390x844 @2x {2}1 error, 2 warnings/);
    assert.match(
      stdout,
      /error +horizontal-overflow +html\n +Page scrolls sideways: scrollWidth 924px against a 390px viewport/,
    );
    assert.match(stdout, /warning +offscreen-element +div\.wide/);
    assert.match(stdout, /1440x900 @2x {2}no problems/);
  });

  it('applies --fail-on to warnings', async () => {
    const args = [page('grid-orphan.html'), '--widths', '1024', '--checks', 'orphan-grid-row'];
    const lenient = await cli(args);
    assert.equal(lenient.code, 0);
    assert.match(lenient.stdout, /warning +orphan-grid-row +#orphan/);
    assert.equal((await cli([...args, '--fail-on', 'warning'])).code, 1);
  });

  it('prints JSON with --json', async () => {
    const { code, stdout } = await cli([
      page('overflow.html'),
      '--widths',
      '390',
      '--checks',
      'horizontal-overflow',
      '--json',
    ]);
    assert.equal(code, 1);
    const result = JSON.parse(stdout) as {
      errors: number;
      widths: unknown[];
      problems: Array<Record<string, unknown>>;
    };
    assert.equal(result.errors, 1);
    assert.equal(result.widths.length, 1);
    assert.deepEqual(result.problems[0].details, { scrollWidth: 924, viewport: 390, overflowBy: 534 });
    assert.equal(result.problems[0].check, 'horizontal-overflow');
    assert.equal(result.problems[0].width, 390);
  });

  it('runs rules alone with --checks none, and takes --wait and --dpr', async () => {
    const { code, stdout } = await cli([
      page('rules.html'),
      '--widths',
      '390',
      '--checks',
      'none',
      '--rules',
      'no-native-select',
      '--wait',
      'h2',
      '--dpr',
      '1',
    ]);
    assert.equal(code, 1);
    assert.match(stdout, /390x844 @1x {2}1 error, 0 warnings/);
    assert.match(stdout, /no-native-select +#native-select/);
    assert.equal((await cli([page('clean.html'), '--widths', '390', '--checks', 'none', '--wait', '50'])).code, 0);
  });

  it('overrides thresholds with --threshold', async () => {
    const { code } = await cli([
      page('overflow.html'),
      '--widths',
      '390',
      '--threshold',
      'overflowTolerance=2000',
      '--checks',
      'horizontal-overflow',
    ]);
    assert.equal(code, 0);
  });

  it('saves screenshots with --screenshots', async () => {
    const dir = join(site.dir, 'cli-shots');
    const { code, stdout } = await cli([
      page('clean.html'),
      '--widths',
      '390,768',
      '--checks',
      'none',
      '--screenshots',
      dir,
    ]);
    assert.equal(code, 0);
    assert.ok(existsSync(join(dir, '390.png')) && existsSync(join(dir, '768.png')));
    assert.match(stdout, /screenshot .*390\.png/);
  });

  it('exits 2 with a message on usage errors', async () => {
    const cases: Array<[string[], RegExp]> = [
      [[], /exactly one URL or \.html file/],
      [['a.html', 'b.html'], /exactly one URL/],
      [['--nope', 'x'], /nope/],
      [[page('clean.html'), '--checks', 'nope'], /Unknown check: nope/],
      [[page('clean.html'), '--rules', 'nope'], /Unknown rule: nope/],
      [[page('clean.html'), '--widths', 'abc'], /Invalid width "abc"/],
      [[page('clean.html'), '--fail-on', 'nope'], /--fail-on must be/],
      [[page('clean.html'), '--threshold', 'nope=1'], /Invalid --threshold/],
      [[page('clean.html'), '--dpr', '0'], /--dpr/],
      [[page('clean.html'), '--full-page'], /--full-page needs --screenshots/],
      [[join(site.dir, 'missing.html')], /neither a URL nor an existing \.html file/],
      [[page('base.css')], /not an \.html file/],
      [['file:///tmp/page.html'], /file:\/\/ URLs are not supported/],
      [['ftp://example.com/page.html'], /Unsupported URL scheme/],
    ];
    for (const [args, message] of cases) {
      const { code, stdout, stderr } = await cli(args);
      assert.equal(code, 2, `viewport-qa ${args.join(' ')}`);
      assert.equal(stdout, '');
      assert.match(stderr, message);
    }
  });

  it('exits 2 when the page cannot be loaded', async () => {
    // Port 9 (discard) refuses connections on a normal machine.
    const { code, stderr } = await cli(['http://127.0.0.1:9/', '--widths', '390']);
    assert.equal(code, 2);
    assert.match(stderr, /^viewport-qa: /);
  });
});
