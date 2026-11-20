/** Ids of the objective checks, all on by default. */
export const CHECK_IDS = [
  'horizontal-overflow',
  'offscreen-element',
  'clipped-text',
  'broken-image',
  'low-res-image',
  'repeated-image',
  'layout-shift',
  'edge-touching',
  'inconsistent-inset',
  'inconsistent-radius',
  'orphan-grid-row',
] as const;

/** Ids of the opinionated house rules, all off by default. */
export const RULE_IDS = [
  'heading-logo-alignment',
  'white-icon-on-dark',
  'no-native-select',
  'no-native-date-picker',
  'pointer-cursor',
  'no-coloured-text-on-dark',
] as const;

/** The id of one objective check. */
export type CheckId = (typeof CHECK_IDS)[number];

/** The id of one opt-in rule. */
export type RuleId = (typeof RULE_IDS)[number];

/** How serious a problem is: `error` for a defect, `warning` for something to review. */
export type Severity = 'error' | 'warning';

/** Description of one check or rule, as listed by `viewport-qa --list`. */
export interface CheckInfo<Id extends string = string> {
  id: Id;
  severity: Severity;
  /** What the check measures. */
  summary: string;
  /** The default threshold, in words. */
  threshold: string;
}

/** Every objective check with its severity and default threshold. */
export const CHECKS: readonly CheckInfo<CheckId>[] = [
  {
    id: 'horizontal-overflow',
    severity: 'error',
    summary: 'The page scrolls sideways: document scrollWidth is wider than the viewport.',
    threshold: 'overflowTolerance 1px',
  },
  {
    id: 'offscreen-element',
    severity: 'warning',
    summary: 'A visible element crosses the left or right edge of the viewport and is not inside a scroller.',
    threshold: 'overflowTolerance 1px',
  },
  {
    id: 'clipped-text',
    severity: 'error',
    summary: 'Text is cut off by overflow: hidden, with no ellipsis or line clamp.',
    threshold: 'clipTolerance 1px',
  },
  {
    id: 'broken-image',
    severity: 'error',
    summary: 'A visible image finished loading with no pixels.',
    threshold: 'naturalWidth 0',
  },
  {
    id: 'low-res-image',
    severity: 'warning',
    summary: 'An image is shown above its resolution: chosen srcset file against rendered size times DPR.',
    threshold: 'upscaleTolerance 1.05, minImageWidth 48px',
  },
  {
    id: 'repeated-image',
    severity: 'warning',
    summary: 'The same image file appears more than once on the page.',
    threshold: 'minRepeatedImageWidth 120px',
  },
  {
    id: 'layout-shift',
    severity: 'warning',
    summary: 'Cumulative layout shift recorded since navigation.',
    threshold: 'layoutShift 0.1',
  },
  {
    id: 'edge-touching',
    severity: 'warning',
    summary: 'A painted band or panel touches the left or right edge of the viewport.',
    threshold: 'minBoxWidthRatio 0.5, minBoxHeight 40px',
  },
  {
    id: 'inconsistent-inset',
    severity: 'warning',
    summary: 'Panels use more than one left/right inset down the page.',
    threshold: 'insetTolerance 1px, minBandHeight 120px',
  },
  {
    id: 'inconsistent-radius',
    severity: 'warning',
    summary: 'Panels use more than one corner radius down the page.',
    threshold: 'radiusTolerance 0px, minBandHeight 120px',
  },
  {
    id: 'orphan-grid-row',
    severity: 'warning',
    summary: 'A grid of equal-width items ends on a partly filled row.',
    threshold: 'gridItemVariance 1.2',
  },
];

/** Every opt-in rule with its severity and default threshold. */
export const RULES: readonly CheckInfo<RuleId>[] = [
  {
    id: 'heading-logo-alignment',
    severity: 'error',
    summary: "Left-aligned h1 and h2 copy starts at the logo's left edge (viewports 1000px and wider).",
    threshold: 'headingTolerance 1px',
  },
  {
    id: 'white-icon-on-dark',
    severity: 'warning',
    summary: 'Small SVG icons on dark grounds are white.',
    threshold: 'ground luminance below 0.2',
  },
  {
    id: 'no-native-select',
    severity: 'error',
    summary: 'No native <select> dropdowns.',
    threshold: 'none',
  },
  {
    id: 'no-native-date-picker',
    severity: 'error',
    summary: 'No native date, time, month or week inputs.',
    threshold: 'none',
  },
  {
    id: 'pointer-cursor',
    severity: 'error',
    summary: 'Links, buttons, summaries and clickable labels show cursor: pointer.',
    threshold: 'none',
  },
  {
    id: 'no-coloured-text-on-dark',
    severity: 'warning',
    summary: 'Text on dark grounds is neutral, not coloured.',
    threshold: 'chroma above 40',
  },
];

/** Numeric limits used by the checks. Every default can be overridden per run. */
export interface Thresholds {
  /** Pixels of slack before overflow and off-screen findings count. */
  overflowTolerance: number;
  /** Pixels of slack before clipped text counts. */
  clipTolerance: number;
  /** A painted box counts as a panel when at least this share of the viewport wide. */
  minBoxWidthRatio: number;
  /** A painted box counts as a panel when at least this tall (px). */
  minBoxHeight: number;
  /** Panels shorter than this (px) are left out of the inset and radius checks. */
  minBandHeight: number;
  /** Panels with a corner radius at or above this (px) are treated as pills and left out. */
  maxBandRadius: number;
  /** Insets closer than this (px) count as the same value. */
  insetTolerance: number;
  /** Radii closer than this (px) count as the same value. */
  radiusTolerance: number;
  /** Images narrower than this (px) are not checked for resolution. */
  minImageWidth: number;
  /** An image is low resolution when rendered size times DPR exceeds its file size by more than this factor. */
  upscaleTolerance: number;
  /** Images narrower than this (px) are not counted as repeated. */
  minRepeatedImageWidth: number;
  /** Layout shift score above which the page is flagged. */
  layoutShift: number;
  /** Milliseconds to wait for buffered layout shift entries before reading the score. */
  layoutShiftWaitMs: number;
  /** Pixels of slack for the heading-logo-alignment rule. */
  headingTolerance: number;
  /** The heading-logo-alignment rule runs from this viewport width (px) up. */
  headingMinViewport: number;
  /** Headings narrower than this share of the viewport are skipped by heading-logo-alignment. */
  headingMinWidthRatio: number;
  /** Grids whose widest item is more than this factor wider than the narrowest are treated as bento and skipped. */
  gridItemVariance: number;
  /** Most text nodes read by no-coloured-text-on-dark. */
  maxTextNodes: number;
  /** Most problems reported per check on one page. Further ones are counted, not listed. */
  maxPerCheck: number;
}

/** The default value of every threshold. */
export const DEFAULT_THRESHOLDS: Readonly<Thresholds> = {
  overflowTolerance: 1,
  clipTolerance: 1,
  minBoxWidthRatio: 0.5,
  minBoxHeight: 40,
  minBandHeight: 120,
  maxBandRadius: 100,
  insetTolerance: 1,
  radiusTolerance: 0,
  minImageWidth: 48,
  upscaleTolerance: 1.05,
  minRepeatedImageWidth: 120,
  layoutShift: 0.1,
  layoutShiftWaitMs: 300,
  headingTolerance: 1,
  headingMinViewport: 1000,
  headingMinWidthRatio: 0.25,
  gridItemVariance: 1.2,
  maxTextNodes: 5000,
  maxPerCheck: 25,
};

/** The default viewport widths, in pixels. */
export const DEFAULT_WIDTHS: readonly number[] = [390, 768, 1024, 1440, 1920, 2560, 3840];
