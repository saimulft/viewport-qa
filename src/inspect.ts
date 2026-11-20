import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Page } from 'playwright';
import { collect } from './browser.ts';
import type { BrowserOptions, CheckResult, Problem, ScreenshotOptions, WaitOptions, WidthResult } from './types.ts';

/** Longest wait for images that are still loading, in milliseconds. */
const IMAGE_WAIT_MS = 5000;

/** Waits for the selector, for images in or near the first screen, and for the extra delay. */
export async function settle(page: Page, wait: WaitOptions = {}): Promise<void> {
  if (wait.selector) {
    await page.waitForSelector(wait.selector, { state: 'visible', timeout: wait.timeout ?? 30000 });
  }
  // Images decide the low-res and broken-image results, so give the ones that are loading time to finish.
  // Lazy images far below the first screen never start loading, so they are not waited for.
  await page.evaluate(async (limit) => {
    const pending = [...document.images].filter((img) => {
      if (img.complete) return false;
      if (img.loading !== 'lazy') return true;
      const rect = img.getBoundingClientRect();
      return rect.top < window.innerHeight && rect.bottom > 0;
    });
    const loaded = Promise.all(
      pending.map(
        (img) =>
          new Promise<void>((done) => {
            img.addEventListener('load', () => done(), { once: true });
            img.addEventListener('error', () => done(), { once: true });
          }),
      ),
    );
    await Promise.race([loaded, new Promise((done) => setTimeout(done, limit))]);
  }, IMAGE_WAIT_MS);
  if (wait.delay) await page.waitForTimeout(wait.delay);
}

/** Runs the checks on the page as it stands and returns the result for its current viewport. */
export async function inspect(
  page: Page,
  run: BrowserOptions,
  wait: WaitOptions | undefined,
  screenshots: ScreenshotOptions | undefined,
): Promise<WidthResult> {
  await settle(page, wait);
  const report = await page.evaluate(collect, run);
  const size = page.viewportSize();
  const width = size?.width ?? report.viewport.width;
  const height = size?.height ?? report.viewport.height;
  const problems: Problem[] = report.problems.map((problem) => ({ ...problem, width }));
  const truncated: Record<string, number> = {};
  for (const [check, total] of Object.entries(report.totals)) {
    const listed = problems.filter((problem) => problem.check === check).length;
    if (total > listed) truncated[check] = total - listed;
  }
  const result: WidthResult = {
    width,
    height,
    dpr: report.viewport.dpr,
    problems,
    layoutShift: report.layoutShift,
    truncated,
  };
  if (screenshots) {
    const dir = resolve(screenshots.dir);
    await mkdir(dir, { recursive: true });
    result.screenshot = join(dir, `${width}.png`);
    await page.screenshot({ path: result.screenshot, fullPage: screenshots.fullPage ?? false });
  }
  return result;
}

/** Combines per-width results into one run result. */
export function summarize(url: string, widths: WidthResult[]): CheckResult {
  const problems = widths.flatMap((entry) => entry.problems);
  return {
    url,
    widths,
    problems,
    errors: problems.filter((problem) => problem.severity === 'error').length,
    warnings: problems.filter((problem) => problem.severity === 'warning').length,
  };
}

/** True when the result has a problem at or above the given severity. */
export function hasProblems(result: CheckResult, level: 'error' | 'warning' = 'error'): boolean {
  return level === 'warning' ? result.errors + result.warnings > 0 : result.errors > 0;
}
