import type { Browser } from 'playwright';
import type { CheckId, RuleId, Severity, Thresholds } from './catalog.ts';

/** One value in a problem's `details`: a number, string, boolean, null or a list of numbers and strings. */
export type Detail = string | number | boolean | null | Array<string | number>;

/** The numbers and values that triggered a problem. */
export type Details = Record<string, Detail>;

/** One finding from a check or rule, at one viewport width. */
export interface Problem {
  /** The id of the check or rule that found it. */
  check: CheckId | RuleId;
  severity: Severity;
  /** A CSS selector for the element, or `html` for a page-level finding. */
  selector: string;
  /** The viewport width in CSS pixels. */
  width: number;
  /** A one-line description that includes the key numbers. */
  message: string;
  /** The raw numbers and values behind the message. */
  details: Details;
  /** A short text snippet from the element, when it has one. */
  text?: string;
}

/** A problem as the browser-side script reports it, before the width is attached. */
export type RawProblem = Omit<Problem, 'width'>;

/** The resolved input of the browser-side script. Build it with `buildScript` rather than by hand. */
export interface BrowserOptions {
  checks: CheckId[];
  rules: RuleId[];
  thresholds: Thresholds;
}

/** What the browser-side script returns for one page load. */
export interface BrowserReport {
  viewport: { width: number; height: number; dpr: number };
  problems: RawProblem[];
  /** How many problems each check found, including ones cut off by `maxPerCheck`. */
  totals: Record<string, number>;
  /** Cumulative layout shift, or null when the browser does not report it. */
  layoutShift: number | null;
}

/** Options shared by `checkPage`, `checkUrl` and `buildScript`. */
export interface CommonOptions {
  /** Objective checks to run. Defaults to all of them. An empty list runs none. */
  checks?: readonly CheckId[];
  /** Opt-in rules to run. Defaults to none. */
  rules?: readonly RuleId[];
  /** Overrides for the default thresholds. */
  thresholds?: Partial<Thresholds>;
}

/** A viewport to test. Height and DPR are derived from the width when omitted. */
export interface Viewport {
  width: number;
  /** Defaults to a typical height for the width, for example 844 at 390 and 900 at 1440. */
  height?: number;
  /** Device pixel ratio. Ignored by `checkPage`, which cannot change it on an open page. */
  dpr?: number;
  /** Emulate a phone: touch input and the mobile viewport rules. Defaults to true below 768px. */
  mobile?: boolean;
}

/** A viewport width in pixels, or a full viewport description. */
export type WidthSpec = number | Viewport;

/** How to decide the page is ready to measure. */
export interface WaitOptions {
  /** Navigation milestone to wait for. Defaults to `networkidle`. */
  until?: 'load' | 'domcontentloaded' | 'networkidle';
  /** A selector that must be visible before measuring. */
  selector?: string;
  /** Extra milliseconds to wait after everything else. */
  delay?: number;
  /** Timeout in milliseconds for navigation and for the selector. Defaults to 30000. */
  timeout?: number;
}

/** Where to save one screenshot per width. */
export interface ScreenshotOptions {
  /** Directory for `<width>.png` files. Created when missing. */
  dir: string;
  /** Capture the whole page instead of the first viewport. */
  fullPage?: boolean;
}

/** The outcome at one viewport width. */
export interface WidthResult {
  width: number;
  height: number;
  dpr: number;
  problems: Problem[];
  /** Cumulative layout shift, or null when the browser does not report it. */
  layoutShift: number | null;
  /** Problems found beyond `maxPerCheck`, by check id. Empty when nothing was cut off. */
  truncated: Record<string, number>;
  /** Path of the screenshot, when screenshots were requested. */
  screenshot?: string;
}

/** The outcome of a run across all widths. */
export interface CheckResult {
  url: string;
  widths: WidthResult[];
  /** Every problem across all widths. */
  problems: Problem[];
  errors: number;
  warnings: number;
}

/** Options for `checkPage`. */
export interface CheckPageOptions extends CommonOptions {
  /**
   * Resize the page to each width in turn. When omitted, the page is checked once, as it is.
   * The viewport is restored afterwards.
   */
  widths?: readonly WidthSpec[];
  /** Reload the page at each width so media queries and scripts run again. Defaults to true. */
  reload?: boolean;
  wait?: WaitOptions;
  screenshots?: ScreenshotOptions;
}

/** Options for `checkUrl`. */
export interface CheckUrlOptions extends CommonOptions {
  /** Widths to test. Defaults to 390, 768, 1024, 1440, 1920, 2560 and 3840. */
  widths?: readonly WidthSpec[];
  /** Device pixel ratio for every width. `auto` uses 2 below 1920px and 1 from 1920px up. */
  dpr?: number | 'auto';
  wait?: WaitOptions;
  screenshots?: ScreenshotOptions;
  /** A browser to reuse. When omitted, Chromium is launched and closed for the run. */
  browser?: Browser;
}

/** A directory served over HTTP on 127.0.0.1. */
export interface StaticServer {
  /** Base URL, for example `http://127.0.0.1:50321/`. */
  url: string;
  close(): Promise<void>;
}
