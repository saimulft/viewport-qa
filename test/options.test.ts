import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CHECK_IDS, CHECKS, DEFAULT_THRESHOLDS, DEFAULT_WIDTHS, RULE_IDS, RULES, UsageError } from '../src/index.ts';
import { defaultHeight, parseList, parseWait, parseWidths, resolveRun, resolveViewports } from '../src/options.ts';

describe('options', () => {
  it('parses widths, with an optional height', () => {
    assert.deepEqual(parseWidths('390, 768,1440x900'), [390, 768, { width: 1440, height: 900 }]);
    assert.throws(() => parseWidths('abc'), UsageError);
    assert.throws(() => parseWidths('50'), /between 100 and 10000/);
    assert.throws(() => parseWidths(''), /at least one width/);
  });

  it('reads --wait as a delay or a selector', () => {
    assert.deepEqual(parseWait('500'), { delay: 500 });
    assert.deepEqual(parseWait('.ready'), { selector: '.ready' });
    assert.deepEqual(parseList(' a, b ,,c '), ['a', 'b', 'c']);
  });

  it('fills in height, DPR and mobile emulation', () => {
    assert.deepEqual(resolveViewports([390, 1920, { width: 1000, height: 500, dpr: 3 }]), [
      { width: 390, height: 844, dpr: 2, mobile: true },
      { width: 1920, height: 1080, dpr: 1, mobile: false },
      { width: 1000, height: 500, dpr: 3, mobile: false },
    ]);
    assert.equal(resolveViewports([1440], 1)[0].dpr, 1);
    assert.equal(defaultHeight(1280), 720);
    assert.equal(defaultHeight(600), 844);
    assert.throws(() => resolveViewports([]), UsageError);
    assert.throws(() => resolveViewports([1440], 0), /DPR/);
  });

  it('runs every check and no rules by default', () => {
    const run = resolveRun({});
    assert.deepEqual(run.checks, [...CHECK_IDS]);
    assert.deepEqual(run.rules, []);
    assert.deepEqual(run.thresholds, DEFAULT_THRESHOLDS);
    assert.equal(resolveRun({ thresholds: { layoutShift: 0.25 } }).thresholds.layoutShift, 0.25);
    assert.throws(() => resolveRun({ thresholds: { layoutShift: -1 } }), /0 or more/);
  });

  it('describes every check and rule once', () => {
    assert.deepEqual(
      CHECKS.map((c) => c.id),
      [...CHECK_IDS],
    );
    assert.deepEqual(
      RULES.map((r) => r.id),
      [...RULE_IDS],
    );
    assert.equal(new Set([...CHECK_IDS, ...RULE_IDS]).size, CHECK_IDS.length + RULE_IDS.length);
    assert.deepEqual(DEFAULT_WIDTHS, [390, 768, 1024, 1440, 1920, 2560, 3840]);
  });
});
