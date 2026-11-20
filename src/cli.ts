#!/usr/bin/env node
import { readFileSync, statSync } from 'node:fs';
import { dirname, basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { CHECK_IDS, CHECKS, DEFAULT_THRESHOLDS, DEFAULT_WIDTHS, RULE_IDS, RULES } from './catalog.ts';
import type { CheckId, RuleId, Thresholds } from './catalog.ts';
import { checkUrl } from './check-url.ts';
import { UsageError } from './errors.ts';
import { formatReport } from './format.ts';
import { hasProblems } from './inspect.ts';
import { parseList, parseWait, parseWidths } from './options.ts';
import { serveDirectory } from './serve.ts';
import type { CheckUrlOptions, StaticServer } from './types.ts';

const HELP = `viewport-qa: numeric layout QA for web pages across viewport widths

Usage
  viewport-qa <url|file.html> [options]

Options
  -w, --widths <list>       Viewport widths, comma separated. Add a height as 1440x900.
                            Default: ${DEFAULT_WIDTHS.join(',')}
      --checks <list>       Objective checks to run, comma separated, or "none". Default: all
      --rules <list>        Opt-in house rules to run, comma separated. Default: none
      --wait <selector|ms>  Wait for a selector to be visible, or for a number of milliseconds
      --dpr <number>        Device pixel ratio for every width. Default: 2 below 1920, 1 from 1920
      --threshold <n=v>     Override a threshold, for example layoutShift=0.05. Repeatable
      --fail-on <level>     Exit 1 on "error" (default) or on any "warning"
      --json                Print the result as JSON
      --screenshots <dir>   Save one PNG per width into the folder
      --full-page           Make the screenshots cover the whole page
      --list                List the checks, rules and thresholds, then exit
  -h, --help                Show this help
  -v, --version             Show the version

A local .html file is served from its own folder on 127.0.0.1 and is never opened over file://.

Exit codes
  0  no problems at or above --fail-on
  1  problems found at or above --fail-on
  2  usage error, or the page could not be checked
`;

function version(): string {
  const file = new URL('../package.json', import.meta.url);
  return (JSON.parse(readFileSync(file, 'utf8')) as { version: string }).version;
}

function listAll(): string {
  const width = Math.max(...[...CHECKS, ...RULES].map((entry) => entry.id.length));
  const row = (entry: { id: string; severity: string; summary: string; threshold: string }): string =>
    `  ${entry.id.padEnd(width)}  ${entry.severity.padEnd(7)}  ${entry.summary} [${entry.threshold}]`;
  const thresholds = Object.entries(DEFAULT_THRESHOLDS).map(([name, value]) => `  ${name} = ${value}`);
  return [
    'Checks (on by default)',
    ...CHECKS.map(row),
    '',
    'Rules (off by default, enable with --rules)',
    ...RULES.map(row),
    '',
    'Thresholds (override with --threshold name=value)',
    ...thresholds,
    '',
  ].join('\n');
}

function pickIds<T extends string>(value: string | undefined, known: readonly T[], kind: string): T[] | undefined {
  if (value === undefined) return undefined;
  if (value === 'none') return [];
  const ids = parseList(value);
  const unknown = ids.filter((id) => !(known as readonly string[]).includes(id));
  if (unknown.length) throw new UsageError(`Unknown ${kind}: ${unknown.join(', ')}. Known: ${known.join(', ')}.`);
  return ids as T[];
}

function parseThresholds(entries: string[]): Partial<Thresholds> {
  const result: Partial<Thresholds> = {};
  for (const entry of entries) {
    const [name, raw] = entry.split('=');
    const value = Number(raw);
    if (!(name in DEFAULT_THRESHOLDS) || raw === undefined || raw === '' || !Number.isFinite(value) || value < 0) {
      throw new UsageError(
        `Invalid --threshold "${entry}". Use name=value with a number, for example layoutShift=0.05.`,
      );
    }
    result[name as keyof Thresholds] = value;
  }
  return result;
}

interface Target {
  url: string;
  server?: StaticServer;
}

async function resolveTarget(input: string): Promise<Target> {
  if (/^https?:\/\//i.test(input)) return { url: input };
  if (/^file:/i.test(input)) {
    throw new UsageError(
      'file:// URLs are not supported. Pass the path of the .html file and it is served on 127.0.0.1.',
    );
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input))
    throw new UsageError(`Unsupported URL scheme in "${input}". Use http or https.`);
  const file = resolve(input);
  let isFile = false;
  try {
    isFile = statSync(file).isFile();
  } catch {
    // Not a path: it may still be a host such as localhost:3000.
  }
  if (isFile) {
    if (!/\.html?$/i.test(file)) throw new UsageError(`"${input}" is not an .html file.`);
    const server = await serveDirectory(dirname(file));
    return { url: new URL(encodeURIComponent(basename(file)), server.url).href, server };
  }
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(input)) return { url: `http://${input}` };
  throw new UsageError(`"${input}" is neither a URL nor an existing .html file.`);
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      widths: { type: 'string', short: 'w' },
      checks: { type: 'string' },
      rules: { type: 'string' },
      wait: { type: 'string' },
      dpr: { type: 'string' },
      threshold: { type: 'string', multiple: true },
      'fail-on': { type: 'string' },
      json: { type: 'boolean' },
      screenshots: { type: 'string' },
      'full-page': { type: 'boolean' },
      list: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${version()}\n`);
    return 0;
  }
  if (values.list) {
    process.stdout.write(listAll());
    return 0;
  }
  if (positionals.length !== 1) throw new UsageError('Pass exactly one URL or .html file. See viewport-qa --help.');
  const failOn = values['fail-on'] ?? 'error';
  if (failOn !== 'error' && failOn !== 'warning')
    throw new UsageError(`--fail-on must be "error" or "warning", got "${failOn}".`);
  const dpr = values.dpr === undefined ? undefined : Number(values.dpr);
  if (dpr !== undefined && !(dpr > 0 && dpr <= 5))
    throw new UsageError(`--dpr must be a number above 0 and at most 5, got "${values.dpr}".`);
  if (values['full-page'] && !values.screenshots) throw new UsageError('--full-page needs --screenshots <dir>.');

  const options: CheckUrlOptions = {
    widths: values.widths === undefined ? undefined : parseWidths(values.widths),
    checks: pickIds<CheckId>(values.checks, CHECK_IDS, 'check'),
    rules: pickIds<RuleId>(values.rules, RULE_IDS, 'rule'),
    thresholds: parseThresholds(values.threshold ?? []),
    wait: values.wait === undefined ? undefined : parseWait(values.wait),
    dpr,
    screenshots: values.screenshots ? { dir: values.screenshots, fullPage: values['full-page'] ?? false } : undefined,
  };

  const target = await resolveTarget(positionals[0]);
  try {
    const result = await checkUrl(target.url, options);
    if (values.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else
      process.stdout.write(
        formatReport(result, { target: positionals[0], color: Boolean(process.stdout.isTTY && !process.env.NO_COLOR) }),
      );
    return hasProblems(result, failOn) ? 1 : 0;
  } finally {
    await target.server?.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const usage =
      error instanceof UsageError ||
      (error instanceof TypeError && /^ERR_PARSE_ARGS/.test(String((error as { code?: string }).code)));
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`viewport-qa: ${message}\n`);
    if (usage) process.stderr.write('Run viewport-qa --help for usage.\n');
    process.exitCode = 2;
  },
);
