import type { Browser } from 'playwright';
import { DEFAULT_WIDTHS } from './catalog.ts';
import { UsageError } from './errors.ts';
import { inspect, summarize } from './inspect.ts';
import { resolveRun, resolveViewports } from './options.ts';
import type { CheckResult, CheckUrlOptions, WidthResult } from './types.ts';

async function launchChromium(): Promise<Browser> {
  let playwright: typeof import('playwright');
  try {
    playwright = await import('playwright');
  } catch {
    throw new Error('Playwright is not installed. Run: npm install playwright && npx playwright install chromium');
  }
  try {
    return await playwright.chromium.launch();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Executable doesn't exist/i.test(message)) {
      throw new Error('Chromium is not installed for Playwright. Run: npx playwright install chromium', {
        cause: error,
      });
    }
    throw error;
  }
}

/**
 * Loads a URL at each width in a fresh browser context (own viewport, DPR and touch emulation), waits for it to
 * settle and runs the checks. Chromium is launched for the run unless you pass `browser`.
 */
export async function checkUrl(url: string, options: CheckUrlOptions = {}): Promise<CheckResult> {
  if (/^file:/i.test(url)) {
    throw new UsageError('file:// URLs are not supported. Serve the folder with serveDirectory() and pass its URL.');
  }
  const run = resolveRun(options);
  const viewports = resolveViewports(options.widths ?? DEFAULT_WIDTHS, options.dpr);
  const browser = options.browser ?? (await launchChromium());
  const wait = options.wait;
  const results: WidthResult[] = [];
  try {
    for (const viewport of viewports) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: viewport.dpr,
        isMobile: viewport.mobile,
        hasTouch: viewport.mobile,
      });
      try {
        const page = await context.newPage();
        const response = await page.goto(url, {
          waitUntil: wait?.until ?? 'networkidle',
          timeout: wait?.timeout ?? 30000,
        });
        if (response && response.status() >= 400) {
          throw new Error(`${url} answered with HTTP ${response.status()} ${response.statusText()}`.trim());
        }
        results.push(await inspect(page, run, wait, options.screenshots));
      } finally {
        await context.close();
      }
    }
  } finally {
    if (!options.browser) await browser.close();
  }
  return summarize(url, results);
}
