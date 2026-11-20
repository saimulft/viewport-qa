import { CHECK_IDS, DEFAULT_THRESHOLDS, RULE_IDS } from './catalog.ts';
import type { CheckId, RuleId, Thresholds } from './catalog.ts';
import { UsageError } from './errors.ts';
import type { BrowserOptions, CommonOptions, WaitOptions, WidthSpec } from './types.ts';

/** A viewport with every field filled in. */
export interface ResolvedViewport {
  width: number;
  height: number;
  dpr: number;
  mobile: boolean;
}

const KNOWN_HEIGHTS: Record<number, number> = {
  390: 844,
  768: 1024,
  1024: 768,
  1440: 900,
  1920: 1080,
  2048: 1152,
  2560: 1440,
  3440: 1440,
  3840: 2160,
};

/** A typical viewport height for a width: a phone, a tablet or a 16:9 screen. */
export function defaultHeight(width: number): number {
  const known = KNOWN_HEIGHTS[width];
  if (known) return known;
  if (width < 768) return 844;
  if (width < 1024) return 1024;
  return Math.round((width * 9) / 16);
}

/** The device pixel ratio used when none is given: 2 below 1920px wide, 1 from 1920px up. */
export function defaultDpr(width: number): number {
  return width < 1920 ? 2 : 1;
}

function assertDimension(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 100 || value > 10000) {
    throw new UsageError(`${name} must be a whole number between 100 and 10000, got ${value}.`);
  }
}

/** Fills in height, DPR and mobile emulation for each width. */
export function resolveViewports(widths: readonly WidthSpec[], dpr: number | 'auto' = 'auto'): ResolvedViewport[] {
  if (widths.length === 0) throw new UsageError('At least one width is required.');
  return widths.map((spec) => {
    const viewport = typeof spec === 'number' ? { width: spec } : spec;
    assertDimension('Width', viewport.width);
    const height = viewport.height ?? defaultHeight(viewport.width);
    assertDimension('Height', height);
    const ratio = viewport.dpr ?? (dpr === 'auto' ? defaultDpr(viewport.width) : dpr);
    if (!(ratio > 0 && ratio <= 5)) throw new UsageError(`DPR must be above 0 and at most 5, got ${ratio}.`);
    return { width: viewport.width, height, dpr: ratio, mobile: viewport.mobile ?? viewport.width < 768 };
  });
}

/** Validates the check and rule ids and fills in the thresholds. */
export function resolveRun(options: CommonOptions): BrowserOptions {
  const checks = [...(options.checks ?? CHECK_IDS)];
  const rules = [...(options.rules ?? [])];
  const unknownChecks = checks.filter((id) => !(CHECK_IDS as readonly string[]).includes(id));
  if (unknownChecks.length) {
    throw new UsageError(`Unknown check: ${unknownChecks.join(', ')}. Known checks: ${CHECK_IDS.join(', ')}.`);
  }
  const unknownRules = rules.filter((id) => !(RULE_IDS as readonly string[]).includes(id));
  if (unknownRules.length) {
    throw new UsageError(`Unknown rule: ${unknownRules.join(', ')}. Known rules: ${RULE_IDS.join(', ')}.`);
  }
  const thresholds: Thresholds = { ...DEFAULT_THRESHOLDS };
  for (const [name, value] of Object.entries(options.thresholds ?? {})) {
    if (!(name in DEFAULT_THRESHOLDS)) {
      throw new UsageError(
        `Unknown threshold: ${name}. Known thresholds: ${Object.keys(DEFAULT_THRESHOLDS).join(', ')}.`,
      );
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new UsageError(`Threshold ${name} must be a number of 0 or more, got ${String(value)}.`);
    }
    thresholds[name as keyof Thresholds] = value;
  }
  return { checks: checks as CheckId[], rules: rules as RuleId[], thresholds };
}

/** Splits a comma-separated list, dropping blanks. */
export function parseList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Parses `390,768,1440x900` into width specs. A `WxH` entry sets the height too. */
export function parseWidths(value: string): WidthSpec[] {
  const items = parseList(value);
  if (items.length === 0) throw new UsageError('--widths needs at least one width, for example --widths 390,1440.');
  return items.map((item) => {
    const match = /^(\d+)(?:x(\d+))?$/i.exec(item);
    if (!match)
      throw new UsageError(`Invalid width "${item}". Use a number such as 1440, or WIDTHxHEIGHT such as 1440x900.`);
    const width = Number(match[1]);
    assertDimension('Width', width);
    if (!match[2]) return width;
    const height = Number(match[2]);
    assertDimension('Height', height);
    return { width, height };
  });
}

/** Reads `--wait`: all digits means a delay in milliseconds, anything else is a selector. */
export function parseWait(value: string): WaitOptions {
  return /^\d+$/.test(value) ? { delay: Number(value) } : { selector: value };
}
