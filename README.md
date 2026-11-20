# viewport-qa

Numeric layout QA for web pages across viewport widths, from 390 to 3840.

[![npm version](https://img.shields.io/npm/v/viewport-qa)](https://www.npmjs.com/package/viewport-qa)
[![license](https://img.shields.io/npm/l/viewport-qa)](https://www.npmjs.com/package/viewport-qa)
[![node](https://img.shields.io/node/v/viewport-qa)](https://www.npmjs.com/package/viewport-qa)

viewport-qa loads a page in Chromium at each viewport width and measures the layout: horizontal overflow, clipped text, elements off-screen, images shown above their resolution, repeated images, layout shift, edge-touching bands, inconsistent insets and radii, and orphan grid rows. Every finding comes with a check id, a severity, a selector, the width and the numbers that triggered it. axe and Lighthouse check accessibility and performance, and visual-regression tools compare screenshots; none of them measures whether a layout stays consistent from phone to 4K.

## Install

```sh
npm install viewport-qa playwright
npx playwright install chromium
```

Requires Node 20 or newer and Playwright 1.40 or newer. Playwright is a peer dependency, so you keep control of its version and of the browser it downloads.

## CLI

```
viewport-qa <url|file.html> [options]
```

| Option                  | Meaning                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------- |
| `-w, --widths <list>`   | Viewport widths, comma separated. Add a height as `1440x900`. Default `390,768,1024,1440,1920,2560,3840` |
| `--checks <list>`       | Objective checks to run, or `none`. Default: all                                                         |
| `--rules <list>`        | Opt-in house rules to run. Default: none                                                                 |
| `--wait <selector\|ms>` | Wait for a selector to be visible, or for a number of milliseconds                                       |
| `--dpr <number>`        | Device pixel ratio for every width. Default: 2 below 1920px, 1 from 1920px up                            |
| `--threshold <n=v>`     | Override a threshold, for example `layoutShift=0.05`. Repeatable                                         |
| `--fail-on <level>`     | Exit 1 on `error` (default) or on any `warning`                                                          |
| `--json`                | Print the result as JSON                                                                                 |
| `--screenshots <dir>`   | Save one PNG per width. Add `--full-page` to capture the whole page                                      |
| `--list`                | List every check, rule and threshold                                                                     |

A local `.html` file is served from its own folder by a small server on 127.0.0.1 and is never loaded over `file://`. Widths below 768px are emulated as a phone (touch, mobile viewport rules); the page is loaded fresh at every width.

Exit code 0 means no problems at or above `--fail-on`, 1 means problems were found, and 2 means a usage error or a page that could not be checked.

```sh
viewport-qa overflow.html --widths 390,1440
```

```
viewport-qa  overflow.html

390x844 @2x  1 error, 2 warnings
  error    horizontal-overflow  html
           Page scrolls sideways: scrollWidth 924px against a 390px viewport (534px too wide).
  warning  offscreen-element  div.wide
           Element runs 534px past the right edge (left 24, right 924, viewport 390).
  warning  edge-touching  div.wide
           Box (#fee2e2) touches the right edge of the viewport: left 24px, right -534px.

1440x900 @2x  no problems

1 error, 2 warnings across 2 widths.
```

That run exits with code 1. The output above comes from a page with a fixed 900px block; it fits at 1440 and overflows at 390.

## API

```ts
import { checkUrl, hasProblems } from 'viewport-qa';

const result = await checkUrl('http://localhost:3000/pricing', {
  widths: [390, 1024, 1440],
  wait: { selector: 'main' },
  rules: ['pointer-cursor'],
});

for (const problem of result.problems) {
  console.log(problem.width, problem.check, problem.selector, problem.details);
}
if (hasProblems(result)) process.exitCode = 1;
```

| Export                                 | What it does                                                                                                                                   |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `checkUrl(url, options?)`              | Launches Chromium, loads the URL at each width in its own context (viewport, DPR, touch), waits, runs the checks. Pass `browser` to reuse one. |
| `checkPage(page, options?)`            | Runs the checks on a Playwright `Page` you already have. With `widths` it resizes and reloads the page for each one, then restores it.         |
| `buildScript(options?)`                | Returns the browser-side script as a string for other drivers. It evaluates to a promise of a `BrowserReport`.                                 |
| `serveDirectory(dir)`                  | Serves a folder on 127.0.0.1 and returns `{ url, close() }`, for local pages.                                                                  |
| `formatReport(result, options?)`       | Renders a result as the text the CLI prints.                                                                                                   |
| `hasProblems(result, level?)`          | True when the result has an `error` (default) or any `warning`.                                                                                |
| `CHECKS`, `RULES`                      | Id, severity, summary and default threshold of every check and rule. `CHECK_IDS` and `RULE_IDS` list the ids.                                  |
| `DEFAULT_THRESHOLDS`, `DEFAULT_WIDTHS` | The defaults.                                                                                                                                  |

Options shared by `checkUrl`, `checkPage` and `buildScript`: `checks` (defaults to every check, `[]` runs none), `rules` (defaults to none) and `thresholds` (partial overrides). `checkUrl` adds `widths`, `dpr` (a number or `'auto'`), `wait`, `screenshots` and `browser`. A width is a number or `{ width, height?, dpr?, mobile? }`. `wait` is `{ until?, selector?, delay?, timeout? }` and defaults to `networkidle`.

Each `Problem` has `check`, `severity` (`'error'` or `'warning'`), `selector`, `width`, `message`, `details` (the raw numbers) and, when the element has text, `text`. A `CheckResult` has `url`, `widths` (one entry per width with its `problems`, `layoutShift` and `screenshot`), the flat `problems` list, and the `errors` and `warnings` counts. All option and result types are exported.

Use an existing Playwright page, for example inside a test:

```ts
import { test, expect } from '@playwright/test';
import { checkPage } from 'viewport-qa';

test('pricing layout holds', async ({ page }) => {
  await page.goto('/pricing');
  const result = await checkPage(page, { widths: [390, 1440] });
  expect(result.problems.filter((p) => p.severity === 'error')).toEqual([]);
});
```

Run the checks from another driver. The script evaluates to a promise, so evaluate it as an expression and await it:

```ts
import { buildScript } from 'viewport-qa';

const report = await page.evaluate(buildScript({ checks: ['horizontal-overflow'] })); // Puppeteer
// CDP: Runtime.evaluate({ expression: buildScript(), awaitPromise: true, returnByValue: true })
```

## Checks

These run by default. Each can be switched off by leaving it out of `checks` (or `--checks`).

| Id                    | Severity | What it measures                                                                                      | Default threshold                             |
| --------------------- | -------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `horizontal-overflow` | error    | Document `scrollWidth` wider than the viewport                                                        | `overflowTolerance` 1px                       |
| `offscreen-element`   | warning  | A visible element crossing the left or right edge, outside any scroller; the outermost element only   | `overflowTolerance` 1px                       |
| `clipped-text`        | error    | Text cut off by `overflow: hidden` or a fixed-height parent, with no ellipsis or line clamp           | `clipTolerance` 1px                           |
| `broken-image`        | error    | A visible `<img>` that finished loading with no pixels                                                | `naturalWidth` 0                              |
| `low-res-image`       | warning  | Chosen file (read from its `srcset` entry) against rendered size times DPR, cover crops included      | `upscaleTolerance` 1.05, `minImageWidth` 48px |
| `repeated-image`      | warning  | The same image file used more than once                                                               | `minRepeatedImageWidth` 120px                 |
| `layout-shift`        | warning  | Cumulative layout shift since navigation                                                              | `layoutShift` 0.1                             |
| `edge-touching`       | warning  | A painted band or panel touching the left or right edge; fixed and sticky bars are skipped            | `minBoxWidthRatio` 0.5, `minBoxHeight` 40px   |
| `inconsistent-inset`  | warning  | Panels using more than one left/right inset on the page                                               | `insetTolerance` 1px, `minBandHeight` 120px   |
| `inconsistent-radius` | warning  | Panels using more than one corner radius on the page                                                  | `radiusTolerance` 0px, `minBandHeight` 120px  |
| `orphan-grid-row`     | warning  | A grid of equal-width items whose last row is partly filled; bento grids with mixed sizes are skipped | `gridItemVariance` 1.2                        |

A panel is a painted box (background colour, image, gradient or media) at least half the viewport wide and 40px tall that is not the page colour and is not inside another panel. Insets and radii are compared across panels at least 120px tall.

### Opt-in rules

These encode one house style, so they are off until named with `rules` or `--rules`.

| Id                         | Severity | What it enforces                                                                                                               |
| -------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `heading-logo-alignment`   | error    | Left-aligned `h1` and `h2` copy starts at the logo's left edge, from 1000px wide up (`headingTolerance` 1px)                   |
| `white-icon-on-dark`       | warning  | Small SVG icons on dark grounds are white (a brand-coloured dot will be flagged; judge by eye)                                 |
| `no-native-select`         | error    | No native `<select>` dropdowns                                                                                                 |
| `no-native-date-picker`    | error    | No native date, time, datetime-local, month or week inputs                                                                     |
| `pointer-cursor`           | error    | Links, buttons, `summary`, `[role=button]` and clickable labels show `cursor: pointer` (`none` and `grab` count as deliberate) |
| `no-coloured-text-on-dark` | warning  | Text on dark grounds is neutral (chroma at most 40); text over images and gradients is skipped                                 |

### Thresholds

Every number above is a threshold you can override, with `thresholds` in the API or `--threshold name=value` on the command line. `viewport-qa --list` prints them all with their defaults: `overflowTolerance`, `clipTolerance`, `minBoxWidthRatio`, `minBoxHeight`, `minBandHeight`, `maxBandRadius`, `insetTolerance`, `radiusTolerance`, `minImageWidth`, `upscaleTolerance`, `minRepeatedImageWidth`, `layoutShift`, `layoutShiftWaitMs`, `headingTolerance`, `headingMinViewport`, `headingMinWidthRatio`, `gridItemVariance`, `maxTextNodes` and `maxPerCheck` (problems listed per check and width; the rest are counted).

## Limits

- The checks are heuristics on numbers, not a judgment of design. Intentional choices are flagged too: full-bleed sections show up under `edge-touching`, and a deliberate mix of insets under `inconsistent-inset`. Switch off the checks that do not fit your design.
- One state per width. Nothing is hovered, clicked or scrolled, so open menus, modals, and content revealed on scroll are not measured. Lazy images far below the first screen never load, so they are not checked.
- Only `<img>` and `<picture>` resolution is checked, not CSS `background-image`. SVG images are skipped.
- `horizontal-overflow` reads the document's `scrollWidth`. A page that hides sideways scroll with `overflow-x: hidden` on `html` or `body` is still reported, because content is still wider than the viewport.
- Layout shift counts every shift from navigation to measurement, including input-driven ones. Chromium's mobile emulation marks lab shifts as input-driven, so none are excluded. It does not see shifts that happen after the measurement.
- Shadow DOM and iframes are not entered.
- Colour and contrast are out of scope for the default checks; use axe for contrast.
- Chromium only, through Playwright. Only Playwright 1.63 is tested.
- A local `.html` file is served from its own folder, so root-relative paths such as `/assets/app.css` resolve against that folder. Pages that need a build step or an API should be checked by URL.
- Selectors are the shortest CSS path that matches one element at the time of the run; they can change when the page re-renders.

## License

MIT © Saimul Islam
