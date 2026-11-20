import type { CheckResult, Problem } from './types.ts';

/** Options for `formatReport`. */
export interface FormatOptions {
  /** What was checked, shown in the heading. Defaults to the result's URL. */
  target?: string;
  /** Colour severities with ANSI escapes. Defaults to false. */
  color?: boolean;
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Renders a result as plain text: problems grouped by width, each with selector and numbers. */
export function formatReport(result: CheckResult, options: FormatOptions = {}): string {
  const paint = (code: number, text: string): string => (options.color ? `\u001b[${code}m${text}\u001b[0m` : text);
  const severity = (problem: Problem): string =>
    problem.severity === 'error' ? paint(31, 'error  ') : paint(33, 'warning');
  const lines: string[] = [`viewport-qa  ${options.target ?? result.url}`, ''];
  for (const entry of result.widths) {
    const errors = entry.problems.filter((problem) => problem.severity === 'error').length;
    const warnings = entry.problems.length - errors;
    const heading = `${entry.width}x${entry.height} @${entry.dpr}x`;
    const counts = entry.problems.length ? `${plural(errors, 'error')}, ${plural(warnings, 'warning')}` : 'no problems';
    lines.push(`${paint(1, heading)}  ${counts}`);
    for (const problem of entry.problems) {
      const text = problem.text ? ` "${problem.text}"` : '';
      lines.push(`  ${severity(problem)}  ${problem.check}  ${problem.selector}${text}`);
      lines.push(`           ${problem.message}`);
    }
    for (const [check, count] of Object.entries(entry.truncated)) {
      lines.push(`  ... and ${count} more ${check} (raise the limit with --threshold maxPerCheck=<n>)`);
    }
    if (entry.screenshot) lines.push(`  screenshot ${entry.screenshot}`);
    lines.push('');
  }
  const span = plural(result.widths.length, 'width');
  lines.push(
    result.errors + result.warnings === 0
      ? `No problems across ${span}.`
      : `${plural(result.errors, 'error')}, ${plural(result.warnings, 'warning')} across ${span}.`,
  );
  return `${lines.join('\n')}\n`;
}
