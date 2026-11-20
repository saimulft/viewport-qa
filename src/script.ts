import { collect } from './browser.ts';
import { resolveRun } from './options.ts';
import type { CommonOptions } from './types.ts';

/**
 * Returns the browser-side script as a string for drivers other than Playwright.
 * It evaluates to a promise of a `BrowserReport`: run it with Puppeteer's `page.evaluate(script)`, or with
 * CDP `Runtime.evaluate({ expression: script, awaitPromise: true, returnByValue: true })`.
 */
export function buildScript(options: CommonOptions = {}): string {
  return `(${collect.toString()})(${JSON.stringify(resolveRun(options))})`;
}
