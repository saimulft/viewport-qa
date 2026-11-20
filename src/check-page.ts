import type { Page } from 'playwright';
import { inspect, summarize } from './inspect.ts';
import { resolveRun, resolveViewports } from './options.ts';
import type { CheckPageOptions, CheckResult, WidthResult } from './types.ts';

/**
 * Runs the checks on a Playwright page you already have. Without `widths` the page is checked once, as it is;
 * with `widths` it is resized to each one in turn (and reloaded) and the original size is restored afterwards.
 */
export async function checkPage(page: Page, options: CheckPageOptions = {}): Promise<CheckResult> {
  const run = resolveRun(options);
  const results: WidthResult[] = [];
  if (!options.widths) {
    results.push(await inspect(page, run, options.wait, options.screenshots));
    return summarize(page.url(), results);
  }
  const original = page.viewportSize();
  try {
    for (const viewport of resolveViewports(options.widths)) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      if (options.reload !== false) {
        await page.reload({ waitUntil: options.wait?.until ?? 'networkidle', timeout: options.wait?.timeout ?? 30000 });
      }
      results.push(await inspect(page, run, options.wait, options.screenshots));
    }
  } finally {
    if (original) await page.setViewportSize(original);
  }
  return summarize(page.url(), results);
}
