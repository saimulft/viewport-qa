import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import { buildScript, checkPage, checkUrl, formatReport, hasProblems, RULE_IDS, UsageError } from '../src/index.ts';
import type { BrowserReport, CheckResult, CheckUrlOptions, Problem } from '../src/index.ts';
import { prepareSite } from './helpers/site.ts';
import type { Site } from './helpers/site.ts';

const WIDTHS = [390, 768, 1440];

describe('checks in a real browser', { timeout: 180_000 }, () => {
  let site: Site;
  let browser: Browser;

  before(async () => {
    site = await prepareSite(true);
    browser = await chromium.launch();
  });
  after(async () => {
    await browser?.close();
    await site?.close();
  });

  /** Checks one fixture page at the test widths, at DPR 1 unless told otherwise. */
  const run = (page: string, options: CheckUrlOptions = {}): Promise<CheckResult> =>
    checkUrl(site.url(page), { browser, widths: WIDTHS, dpr: 1, wait: { until: 'load' }, ...options });
  const find = (result: CheckResult, check: string): Problem[] => result.problems.filter((p) => p.check === check);
  const selectors = (problems: Problem[]): string[] => problems.map((p) => p.selector);
  const widthsOf = (problems: Problem[]): number[] => problems.map((p) => p.width);

  describe('clean pages', () => {
    it('report nothing with every check and every rule on', async () => {
      const result = await run('clean.html', { rules: RULE_IDS, wait: { until: 'networkidle' } });
      assert.deepEqual(result.problems, []);
      assert.deepEqual(
        result.widths.map((w) => [w.width, w.height, w.dpr]),
        [
          [390, 844, 1],
          [768, 1024, 1],
          [1440, 900, 1],
        ],
      );
      assert.equal(result.errors + result.warnings, 0);
      assert.equal(hasProblems(result, 'warning'), false);
    });

    it('stay clean at DPR 2 with the default options', async () => {
      const result = await run('clean.html', { dpr: 'auto', widths: [390, 1440] });
      assert.deepEqual(result.problems, []);
      assert.deepEqual(
        result.widths.map((w) => w.dpr),
        [2, 2],
      );
    });
  });

  describe('objective checks', () => {
    it('horizontal-overflow and offscreen-element fire only where the page is too wide', async () => {
      const result = await run('overflow.html');
      const overflow = find(result, 'horizontal-overflow');
      assert.deepEqual(widthsOf(overflow), [390, 768]);
      assert.equal(overflow[0].severity, 'error');
      assert.equal(overflow[0].selector, 'html');
      assert.equal(overflow[0].details.scrollWidth, 924);
      assert.equal(overflow[0].details.viewport, 390);
      assert.equal(overflow[0].details.overflowBy, 534);
      const offscreen = find(result, 'offscreen-element');
      assert.deepEqual(widthsOf(offscreen), [390, 768]);
      assert.equal(offscreen[0].severity, 'warning');
      assert.match(offscreen[0].selector, /\.wide$/);
      assert.equal(offscreen[0].details.right, 924);
    });

    it('clipped-text finds cut-off text and leaves ellipsis, line clamps and sliders alone', async () => {
      const result = await run('clipped.html', { checks: ['clipped-text'] });
      const clipped = find(result, 'clipped-text');
      assert.deepEqual([...new Set(selectors(clipped))].sort(), ['#fixed-height > p', '#nowrap']);
      assert.equal(clipped.length, 6);
      const nowrap = clipped.find((p) => p.selector === '#nowrap');
      assert.equal(nowrap?.severity, 'error');
      assert.equal(nowrap?.details.axis, 'x');
      assert.equal(nowrap?.details.clientWidth, 150);
      assert.ok(Number(nowrap?.details.scrollWidth) > 150);
      assert.equal(nowrap?.text, 'A heading far too long for its box');
    });

    it('broken-image, low-res-image and repeated-image read the srcset candidate the browser chose', async () => {
      const result = await run('images.html', {
        widths: [1440],
        dpr: 2,
        checks: ['broken-image', 'low-res-image', 'repeated-image'],
      });
      const lowRes = find(result, 'low-res-image');
      assert.deepEqual(selectors(lowRes).sort(), ['#density', '#lowres', '#widths']);
      const widths = lowRes.find((p) => p.selector === '#widths');
      // sizes="500px" with 600w: naturalWidth reads 500, the file is 600 wide, 500 / 600 * 2 DPR = 1.67.
      assert.equal(widths?.details.fileWidth, 600);
      assert.equal(widths?.details.boxWidth, 500);
      assert.equal(widths?.details.dpr, 2);
      assert.equal(widths?.details.upscale, 1.67);
      const density = lowRes.find((p) => p.selector === '#density');
      assert.equal(density?.details.fileWidth, 600);
      assert.equal(density?.details.upscale, 1.67);
      const small = lowRes.find((p) => p.selector === '#lowres');
      assert.equal(small?.details.fileWidth, 200);
      assert.equal(small?.details.boxWidth, 1152);
      assert.equal(small?.severity, 'warning');
      const broken = find(result, 'broken-image');
      assert.deepEqual(selectors(broken), ['#broken']);
      assert.equal(broken[0].severity, 'error');
      assert.equal(broken[0].details.src, '/missing.png');
      const repeated = find(result, 'repeated-image');
      assert.deepEqual(selectors(repeated), ['#rep2']);
      assert.equal(repeated[0].details.times, 2);
    });

    it('low-res-image depends on the device pixel ratio and on the threshold', async () => {
      const options = { widths: [1440], checks: ['low-res-image' as const] };
      const at1x = await run('images.html', { ...options, dpr: 1 });
      // At 1x the browser picks the 250px candidate, which is still too small for the 500px slot.
      assert.deepEqual(selectors(find(at1x, 'low-res-image')).sort(), ['#density', '#lowres']);
      const lenient = await run('images.html', { ...options, dpr: 2, thresholds: { upscaleTolerance: 20 } });
      assert.deepEqual(lenient.problems, []);
    });

    it('edge-touching skips pinned bars and inconsistent-inset and inconsistent-radius compare panels', async () => {
      const result = await run('edges.html');
      const edge = find(result, 'edge-touching');
      assert.deepEqual(selectors(edge), ['#band', '#band', '#band']);
      assert.equal(edge[0].details.left, 0);
      assert.equal(edge[0].details.right, 0);
      const insets = find(result, 'inconsistent-inset');
      assert.deepEqual(selectors(insets), ['#panel-b', '#panel-b', '#panel-b']);
      assert.deepEqual(
        insets.map((p) => [p.details.inset, p.details.dominantInset]),
        [
          [48, 24],
          [48, 24],
          [168, 144],
        ],
      );
      const radii = find(result, 'inconsistent-radius');
      assert.equal(radii.length, 3);
      assert.equal(radii[0].selector, '#panel-b');
      assert.equal(radii[0].details.radius, 4);
      assert.equal(radii[0].details.dominantRadius, 12);
    });

    it('orphan-grid-row flags a partly filled last row and skips full and bento grids', async () => {
      const result = await run('grid-orphan.html');
      const orphans = find(result, 'orphan-grid-row');
      assert.deepEqual(selectors(orphans), ['#orphan', '#orphan', '#orphan']);
      assert.deepEqual(widthsOf(orphans), WIDTHS);
      assert.equal(orphans[0].details.columns, 3);
      assert.equal(orphans[0].details.items, 4);
      assert.equal(orphans[0].details.lastRowItems, 1);
    });

    it('layout-shift reports the score and honours the threshold', async () => {
      const result = await run('layout-shift.html', { wait: { until: 'networkidle' } });
      const shifts = find(result, 'layout-shift');
      assert.deepEqual(widthsOf(shifts), WIDTHS);
      for (const entry of result.widths) assert.ok((entry.layoutShift ?? 0) > 0.1, `shift at ${entry.width}`);
      assert.equal(shifts[0].severity, 'warning');
      assert.equal(shifts[0].details.limit, 0.1);
      const lenient = await run('layout-shift.html', {
        wait: { until: 'networkidle' },
        thresholds: { layoutShift: 5 },
      });
      assert.deepEqual(find(lenient, 'layout-shift'), []);
    });

    it('limits how many problems are listed per check and counts the rest', async () => {
      const result = await run('clipped.html', {
        widths: [390],
        checks: ['clipped-text'],
        thresholds: { maxPerCheck: 1 },
      });
      assert.equal(result.problems.length, 1);
      assert.deepEqual(result.widths[0].truncated, { 'clipped-text': 1 });
    });
  });

  describe('opt-in rules', () => {
    it('stay silent unless named', async () => {
      const result = await run('rules.html', { checks: [] });
      assert.deepEqual(result.problems, []);
    });

    it('report every house rule when named', async () => {
      const result = await run('rules.html', { checks: [], rules: RULE_IDS });
      const ids = new Set(result.problems.map((p) => p.check));
      assert.deepEqual([...ids].sort(), [...RULE_IDS].sort());
      assert.deepEqual(
        selectors(find(result, 'pointer-cursor')).filter((s, i, all) => all.indexOf(s) === i),
        ['#no-pointer', '#native-select'],
      );
      assert.deepEqual([...new Set(selectors(find(result, 'no-native-select')))], ['#native-select']);
      assert.deepEqual([...new Set(selectors(find(result, 'no-native-date-picker')))], ['#native-date']);
      assert.deepEqual([...new Set(selectors(find(result, 'no-coloured-text-on-dark')))], ['#orange']);
      assert.deepEqual([...new Set(selectors(find(result, 'white-icon-on-dark')))], ['#red-icon']);
      assert.equal(find(result, 'white-icon-on-dark')[0].details.ground, '#111111');
      // Only measured from 1000px wide up.
      const alignment = find(result, 'heading-logo-alignment');
      assert.deepEqual(widthsOf(alignment), [1440]);
      assert.equal(alignment[0].details.offBy, 40);
      assert.equal(alignment[0].selector, '#misaligned');
    });

    it('run on their own, without the objective checks', async () => {
      const result = await run('rules.html', { checks: [], rules: ['no-native-select'], widths: [390] });
      assert.deepEqual(
        result.problems.map((p) => p.check),
        ['no-native-select'],
      );
    });
  });

  describe('options', () => {
    it('run only the checks asked for', async () => {
      const only = await run('overflow.html', { checks: ['clipped-text'] });
      assert.deepEqual(only.problems, []);
      const none = await run('overflow.html', { checks: [] });
      assert.deepEqual(none.problems, []);
      const some = await run('overflow.html', { checks: ['horizontal-overflow'] });
      assert.deepEqual([...new Set(some.problems.map((p) => p.check))], ['horizontal-overflow']);
    });

    it('apply threshold overrides', async () => {
      const result = await run('overflow.html', {
        checks: ['horizontal-overflow'],
        thresholds: { overflowTolerance: 1000 },
      });
      assert.deepEqual(result.problems, []);
    });

    it('reject unknown checks, rules and thresholds', async () => {
      await assert.rejects(run('clean.html', { checks: ['nope' as never] }), UsageError);
      await assert.rejects(run('clean.html', { rules: ['nope' as never] }), /Unknown rule: nope/);
      await assert.rejects(run('clean.html', { thresholds: { nope: 1 } as never }), /Unknown threshold: nope/);
      await assert.rejects(run('clean.html', { widths: [50] }), /between 100 and 10000/);
    });

    it('wait for a selector and a delay before measuring', async () => {
      const result = await run('clean.html', { widths: [390], wait: { until: 'load', selector: 'h1', delay: 20 } });
      assert.deepEqual(result.problems, []);
    });

    it('refuse file:// URLs and report HTTP errors', async () => {
      await assert.rejects(checkUrl('file:///tmp/page.html', { browser }), UsageError);
      await assert.rejects(run('missing.html'), /HTTP 404/);
    });

    it('save a screenshot per width', async () => {
      const dir = join(site.dir, 'shots');
      const result = await run('clean.html', { widths: [390, 768], checks: [], screenshots: { dir } });
      assert.deepEqual(
        result.widths.map((w) => w.screenshot),
        [join(dir, '390.png'), join(dir, '768.png')],
      );
      for (const w of result.widths) assert.ok(w.screenshot && existsSync(w.screenshot));
    });
  });

  describe('drivers', () => {
    it('checkPage checks an open page once, as it is', async () => {
      const context = await browser.newContext({ viewport: { width: 600, height: 800 } });
      try {
        const page = await context.newPage();
        await page.goto(site.url('overflow.html'));
        const result = await checkPage(page, { checks: ['horizontal-overflow'] });
        assert.equal(result.url, site.url('overflow.html'));
        assert.equal(result.widths.length, 1);
        assert.equal(result.widths[0].width, 600);
        assert.equal(result.problems[0].details.viewport, 600);
      } finally {
        await context.close();
      }
    });

    it('checkPage resizes through widths and restores the viewport', async () => {
      const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
      try {
        const page = await context.newPage();
        await page.goto(site.url('overflow.html'));
        const result = await checkPage(page, {
          widths: [390, 1440],
          checks: ['horizontal-overflow'],
          wait: { until: 'load' },
        });
        assert.deepEqual(widthsOf(result.problems), [390]);
        assert.deepEqual(page.viewportSize(), { width: 1000, height: 700 });
      } finally {
        await context.close();
      }
    });

    it('buildScript returns a string any driver can evaluate', async () => {
      const options = { checks: ['horizontal-overflow', 'offscreen-element'] as const };
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      try {
        const page = await context.newPage();
        await page.goto(site.url('overflow.html'));
        const script = buildScript(options);
        assert.equal(typeof script, 'string');
        const report = (await page.evaluate(script)) as BrowserReport;
        assert.deepEqual(report.problems.map((p) => p.check).sort(), ['horizontal-overflow', 'offscreen-element']);
        assert.deepEqual(report.viewport, { width: 390, height: 844, dpr: 1 });
        const viaCheckUrl = await run('overflow.html', { ...options, widths: [390] });
        const pair = (p: { check: string; selector: string; details: unknown }): unknown => [
          p.check,
          p.selector,
          p.details,
        ];
        assert.deepEqual(viaCheckUrl.problems.map(pair), report.problems.map(pair));
      } finally {
        await context.close();
      }
    });
  });

  describe('formatReport', () => {
    it('lists problems by width with selector and numbers, without colour by default', async () => {
      const result = await run('overflow.html', { checks: ['horizontal-overflow', 'offscreen-element'] });
      const text = formatReport(result, { target: 'overflow.html' });
      assert.match(text, /^viewport-qa {2}overflow\.html\n/);
      assert.match(text, /390x844 @1x {2}1 error, 1 warning/);
      assert.match(text, /error +horizontal-overflow +html/);
      assert.match(text, /scrollWidth 924px against a 390px viewport/);
      assert.match(text, /1440x900 @1x {2}no problems/);
      assert.ok(!text.includes('\u001b'));
    });
  });
});
