# Changelog

## 0.1.2

- The README is now a visual tour: a picture of the package at work, the guide, npm, GitHub and changelog links, and a See it work section. No code changes.

## 0.1.1

- Clearer npm description and keywords, and a homepage with a guide, examples and FAQ: https://oss.saimulislam.com/viewport-qa/
- The `bin` path is written as `dist/cli.js`, the form npm expects, so publishing no longer warns.

## 0.1.0

Initial release.

- Eleven objective checks, on by default: horizontal overflow, off-screen elements, clipped text, broken, low-resolution and repeated images, layout shift, edge-touching bands, inconsistent insets and radii, and orphan grid rows.
- Six opt-in house rules: heading and logo alignment, white icons on dark, no native select, no native date picker, pointer cursor, and no coloured text on dark.
- `checkUrl`, `checkPage` and `buildScript` for Playwright, existing pages and other drivers, with every threshold overridable.
- `viewport-qa` CLI with local `.html` files served on 127.0.0.1, text and JSON output, screenshots and `--fail-on`.
