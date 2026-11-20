/// <reference lib="dom" />
// This file is the only one that touches DOM types, so it carries its own lib reference. The reference is
// program-wide for tsc, but nothing else in src/ uses DOM globals.
//
// `collect` runs inside the page. It is serialised with Function.prototype.toString, so it must stay
// self-contained: no module-level helpers, no imports at runtime (type imports are erased).
import type { CheckId, RuleId, Severity } from './catalog.ts';
import type { BrowserOptions, BrowserReport, Details, RawProblem } from './types.ts';

/**
 * Runs the enabled checks against the current document and returns the findings.
 * Self-contained: pass it to `page.evaluate`, or use `buildScript` for other drivers.
 */
export async function collect(options: BrowserOptions): Promise<BrowserReport> {
  const t = options.thresholds;
  const enabled = new Set<string>([...options.checks, ...options.rules]);
  const on = (id: CheckId | RuleId): boolean => enabled.has(id);
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const dpr = window.devicePixelRatio || 1;

  interface Rgba {
    r: number;
    g: number;
    b: number;
    a: number;
  }
  interface Box {
    el: Element;
    paint: string;
    left: number;
    right: number;
    radius: number;
    height: number;
    pinned: boolean;
  }

  // ---- Helpers -------------------------------------------------------------------------------------------------

  const styleCache = new WeakMap<Element, CSSStyleDeclaration>();
  const styleOf = (el: Element): CSSStyleDeclaration => {
    let style = styleCache.get(el);
    if (!style) {
      style = getComputedStyle(el);
      styleCache.set(el, style);
    }
    return style;
  };

  const transparent: Rgba = { r: 0, g: 0, b: 0, a: 0 };
  const colourCache = new Map<string, Rgba>();
  let context: CanvasRenderingContext2D | null | undefined;
  // Any CSS colour (rgb, oklch, color()) as sRGB bytes, read back through a 1x1 canvas.
  const rgba = (colour: string): Rgba => {
    if (!colour || colour === 'transparent') return transparent;
    const known = colourCache.get(colour);
    if (known) return known;
    if (context === undefined) {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      context = canvas.getContext('2d', { willReadFrequently: true });
    }
    const ctx = context;
    if (!ctx) return transparent;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = 'rgba(0, 0, 0, 0)';
    ctx.fillStyle = colour;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    const value = { r, g, b, a: a / 255 };
    colourCache.set(colour, value);
    return value;
  };
  const channel = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = ({ r, g, b }: Rgba): number => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  const blend = (fg: Rgba, bg: Rgba): Rgba => ({
    r: Math.round(fg.r * fg.a + bg.r * (1 - fg.a)),
    g: Math.round(fg.g * fg.a + bg.g * (1 - fg.a)),
    b: Math.round(fg.b * fg.a + bg.b * (1 - fg.a)),
    a: 1,
  });
  const hex = ({ r, g, b }: Rgba): string => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  const chromaOf = ({ r, g, b }: Rgba): number => Math.max(r, g, b) - Math.min(r, g, b);
  const sameColour = (a: Rgba, b: Rgba): boolean => Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) < 6;

  // Rendered at all: not collapsed to a speck, not hidden, not clipped away.
  const shown = (el: Element): boolean => {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 2 || rect.height <= 2) return false;
    const style = styleOf(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    return !/rect\(0px,? 0px,? 0px,? 0px\)/.test(style.clip) && !/inset\(50%\)/.test(style.clipPath);
  };

  const words = (value: string | null | undefined, max = 40): string =>
    String(value ?? '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, max);
  const round = (value: number, places = 2): number => Number(value.toFixed(places));

  // A CSS selector that matches the element alone, as short as it can be.
  const selectorOf = (el: Element): string => {
    const parts: string[] = [];
    for (let node: Element | null = el; node && node !== document.documentElement; node = node.parentElement) {
      if (node.id && document.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      let part = node.tagName.toLowerCase();
      const classes = String(node.getAttribute('class') ?? '')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2);
      part += classes.map((name) => `.${CSS.escape(name)}`).join('');
      const siblings = node.parentElement
        ? [...node.parentElement.children].filter((c) => c.tagName === node.tagName)
        : [];
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      parts.unshift(part);
      try {
        const found = document.querySelectorAll(parts.join(' > '));
        if (found.length === 1 && found[0] === el) break;
      } catch {
        break;
      }
    }
    return parts.join(' > ') || 'html';
  };

  // A short readable name for the element: its heading, label or alt text.
  const textOf = (el: Element): string => {
    const heading = el.matches('h1,h2,h3,h4,h5,h6,a,button,summary,label,select') ? el : el.querySelector('h1,h2,h3');
    return words(heading?.textContent || el.getAttribute('aria-label') || el.getAttribute('alt'));
  };

  // An image address without the page origin, and without long data URIs, for readable output.
  const shortSrc = (src: string): string => {
    if (src.startsWith('data:')) return `${src.slice(0, 40)}...`;
    try {
      const url = new URL(src, location.href);
      return url.origin === location.origin ? `${url.pathname}${url.search}` : url.href;
    } catch {
      return src;
    }
  };

  const problems: RawProblem[] = [];
  const totals: Record<string, number> = {};
  const add = (
    check: CheckId | RuleId,
    severity: Severity,
    el: Element | null,
    message: string,
    details: Details,
    text?: string,
  ): void => {
    totals[check] = (totals[check] ?? 0) + 1;
    if (totals[check] > t.maxPerCheck) return;
    const snippet = text ?? (el ? textOf(el) : '');
    problems.push({
      check,
      severity,
      selector: el ? selectorOf(el) : 'html',
      message,
      details,
      ...(snippet ? { text: snippet } : {}),
    });
  };

  const all = [...document.body.querySelectorAll('*')];

  const overflowClips = (value: string): boolean => /^(auto|scroll|hidden|clip)$/.test(value);

  // Cards in a sideways scrolling row (drag-scroll rows, carousels) run past the window by design.
  const inScroller = (el: Element): boolean => {
    for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
      if (overflowClips(styleOf(node).overflowX) && node.scrollWidth > node.clientWidth + 1) {
        if (node.getBoundingClientRect().width < vw - 1) return true;
      }
    }
    return false;
  };

  let backgroundMemo: Rgba | undefined;
  const pageBackground = (): Rgba => {
    if (backgroundMemo) return backgroundMemo;
    for (const el of [document.body, document.documentElement]) {
      const colour = rgba(styleOf(el).backgroundColor);
      if (colour.a > 0.5) return (backgroundMemo = colour);
    }
    return (backgroundMemo = { r: 255, g: 255, b: 255, a: 1 });
  };

  // What is painted behind an element: the nearest ancestor with a colour, or an image or gradient.
  const groundBehind = (start: Element | null): { ground: Rgba | null; overImage: boolean } => {
    for (let node = start; node && node !== document.documentElement; node = node.parentElement) {
      const style = styleOf(node);
      if (style.backgroundImage !== 'none') return { ground: null, overImage: true };
      const colour = rgba(style.backgroundColor);
      if (colour.a > 0.5) return { ground: colour, overImage: false };
    }
    return { ground: pageBackground(), overImage: false };
  };

  // ---- Horizontal overflow and off-screen elements --------------------------------------------------------------

  const scrollWidth = document.documentElement.scrollWidth;
  if (on('horizontal-overflow') && scrollWidth > vw + t.overflowTolerance) {
    add(
      'horizontal-overflow',
      'error',
      null,
      `Page scrolls sideways: scrollWidth ${scrollWidth}px against a ${vw}px viewport (${scrollWidth - vw}px too wide).`,
      { scrollWidth, viewport: vw, overflowBy: scrollWidth - vw },
    );
  }

  if (on('offscreen-element')) {
    const crossing = new Set<Element>();
    for (const el of all) {
      if (!shown(el)) continue;
      const rect = el.getBoundingClientRect();
      const pastRight = rect.right > vw + t.overflowTolerance && rect.left < vw;
      const pastLeft = rect.left < -t.overflowTolerance && rect.right > 0;
      if (!pastRight && !pastLeft) continue;
      // Report the outermost element only, and skip anything a hidden or scrolling ancestor already contains.
      let covered = false;
      for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
        if (crossing.has(node)) covered = true;
        if (overflowClips(styleOf(node).overflowX)) {
          const box = node.getBoundingClientRect();
          if (box.left >= -t.overflowTolerance && box.right <= vw + t.overflowTolerance) covered = true;
        }
      }
      crossing.add(el);
      if (covered) continue;
      const side = pastRight ? 'right' : 'left';
      const by = pastRight ? rect.right - vw : -rect.left;
      add(
        'offscreen-element',
        'warning',
        el,
        `Element runs ${round(by, 1)}px past the ${side} edge (left ${round(rect.left, 1)}, right ${round(rect.right, 1)}, viewport ${vw}).`,
        { left: round(rect.left, 1), right: round(rect.right, 1), viewport: vw, side, overflowBy: round(by, 1) },
      );
    }
  }

  // ---- Clipped text -------------------------------------------------------------------------------------------

  if (on('clipped-text')) {
    const holdsText = (el: Element): boolean => {
      for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim()) return true;
      }
      return [...el.children].some((child) => styleOf(child).display === 'inline' && (child.textContent ?? '').trim());
    };
    const clipsAxis = (value: string): boolean => value === 'hidden' || value === 'clip';
    const skipTags = /^(INPUT|TEXTAREA|SELECT|OPTION|SCRIPT|STYLE|SVG|IMG|VIDEO|CANVAS|IFRAME)$/i;
    for (const el of all) {
      if (skipTags.test(el.tagName) || !holdsText(el) || !shown(el)) continue;
      const style = styleOf(el);
      const rect = el.getBoundingClientRect();
      // The box itself cuts its own text: a fixed height or a nowrap line inside overflow: hidden.
      if (style.display !== 'inline') {
        const clamped = style.getPropertyValue('-webkit-line-clamp');
        const clampedLines = clamped !== '' && clamped !== 'none';
        const wide = el.scrollWidth - el.clientWidth;
        const tall = el.scrollHeight - el.clientHeight;
        if (clipsAxis(style.overflowX) && style.textOverflow !== 'ellipsis' && wide > t.clipTolerance) {
          add(
            'clipped-text',
            'error',
            el,
            `Text is cut off sideways: content ${el.scrollWidth}px in a ${el.clientWidth}px box (${wide}px hidden).`,
            { axis: 'x', scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, hiddenPx: wide },
          );
          continue;
        }
        if (clipsAxis(style.overflowY) && !clampedLines && tall > t.clipTolerance) {
          add(
            'clipped-text',
            'error',
            el,
            `Text is cut off at the bottom: content ${el.scrollHeight}px in a ${el.clientHeight}px box (${tall}px hidden).`,
            { axis: 'y', scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, hiddenPx: tall },
          );
          continue;
        }
      }
      // A text element cut across its bottom edge by a parent with a fixed height.
      for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
        if (!clipsAxis(styleOf(node).overflowY)) continue;
        const box = node.getBoundingClientRect();
        if (rect.top < box.bottom - t.clipTolerance && rect.bottom > box.bottom + t.clipTolerance) {
          const hidden = rect.bottom - box.bottom;
          add(
            'clipped-text',
            'error',
            el,
            `Text runs ${round(hidden, 1)}px below its clipping parent ${selectorOf(node)}.`,
            {
              axis: 'y',
              hiddenPx: round(hidden, 1),
              textBottom: round(rect.bottom, 1),
              parentBottom: round(box.bottom, 1),
            },
          );
        }
        break;
      }
    }
  }

  // ---- Boxes: edge-touching bands, inset and radius consistency --------------------------------------------------

  if (on('edge-touching') || on('inconsistent-inset') || on('inconsistent-radius')) {
    // Plain sections often paint the page colour themselves: the colour that fills most of the full-width
    // sections counts as the page ground too.
    const grounds: Rgba[] = [pageBackground()];
    const heights = new Map<string, { colour: Rgba; height: number }>();
    for (const el of all) {
      const rect = el.getBoundingClientRect();
      if (rect.left > 0.5 || vw - rect.right > 0.5 || !shown(el)) continue;
      const style = styleOf(el);
      const colour = rgba(style.backgroundColor);
      if (style.backgroundImage !== 'none' || colour.a <= 0.5) continue;
      const key = hex(colour);
      heights.set(key, { colour, height: (heights.get(key)?.height ?? 0) + rect.height });
    }
    const [top] = [...heights.values()].sort((a, b) => b.height - a.height);
    if (top && top.height >= document.documentElement.scrollHeight * 0.35) grounds.push(top.colour);
    const isGround = (colour: Rgba): boolean => grounds.some((ground) => sameColour(colour, ground));

    // Painted surfaces at least half the viewport wide. Inner panels count with their box.
    const boxes: Box[] = [];
    for (const el of all) {
      if (!shown(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < vw * t.minBoxWidthRatio || rect.height < t.minBoxHeight) continue;
      if (boxes.some((box) => box.el.contains(el)) || inScroller(el)) continue;
      const style = styleOf(el);
      const background = rgba(style.backgroundColor);
      const media = /^(IMG|VIDEO|CANVAS|IFRAME|PICTURE)$/.test(el.tagName);
      const paint = media
        ? 'media'
        : style.backgroundImage !== 'none'
          ? 'image or gradient'
          : background.a > 0.5 && !isGround(background)
            ? hex(background)
            : null;
      if (!paint) continue;
      boxes.push({
        el,
        paint,
        left: Math.round(rect.left),
        right: Math.round(vw - rect.right),
        radius: parseFloat(style.borderTopLeftRadius) || 0,
        height: Math.round(rect.height),
        pinned: style.position === 'fixed' || style.position === 'sticky',
      });
    }

    if (on('edge-touching')) {
      // Fixed and sticky bars (headers, cookie notices) are meant to span the window.
      for (const box of boxes) {
        if (box.pinned || (box.left > 0 && box.right > 0)) continue;
        const side =
          box.left <= 0 && box.right <= 0 ? 'both edges' : box.left <= 0 ? 'the left edge' : 'the right edge';
        add(
          'edge-touching',
          'warning',
          box.el,
          `Box (${box.paint}) touches ${side} of the viewport: left ${box.left}px, right ${box.right}px.`,
          { paint: box.paint, left: box.left, right: box.right, radius: box.radius, height: box.height },
        );
      }
    }

    // Bands and panels only: tall boxes, no pills, nothing pinned or touching an edge.
    const placed = boxes.filter(
      (box) =>
        !box.pinned && box.left > 0 && box.right > 0 && box.height >= t.minBandHeight && box.radius < t.maxBandRadius,
    );

    // Groups values that lie within `tolerance` of the next one. Every group beyond the largest is a finding.
    const outliers = (items: Array<{ value: number; box: Box }>, tolerance: number) => {
      const sorted = [...items].sort((a, b) => a.value - b.value);
      const groups: Array<typeof items> = [];
      for (const item of sorted) {
        const last = groups[groups.length - 1];
        if (last && item.value - last[last.length - 1].value <= tolerance) last.push(item);
        else groups.push([item]);
      }
      if (groups.length < 2) return null;
      // The biggest group sets the pattern; a tie goes to the group that comes first in the document.
      const first = (group: typeof items): number => Math.min(...group.map((item) => placed.indexOf(item.box)));
      const dominant = groups.reduce(
        (best, group) =>
          group.length > best.length || (group.length === best.length && first(group) < first(best)) ? group : best,
        groups[0],
      );
      const counts = new Map<number, number>();
      for (const item of dominant) counts.set(item.value, (counts.get(item.value) ?? 0) + 1);
      const dominantValue = [...counts].sort((a, b) => b[1] - a[1])[0][0];
      const values = [...new Set(sorted.map((item) => item.value))];
      return { others: groups.filter((group) => group !== dominant), dominantValue, values };
    };

    if (on('inconsistent-inset')) {
      const found = outliers(
        placed.flatMap((box) => [
          { value: box.left, box },
          { value: box.right, box },
        ]),
        t.insetTolerance,
      );
      for (const group of found?.others ?? []) {
        add(
          'inconsistent-inset',
          'warning',
          group[0].box.el,
          `Panel inset ${group[0].value}px differs from the dominant ${found?.dominantValue}px (insets on the page: ${found?.values.join(', ')}px).`,
          {
            inset: group[0].value,
            dominantInset: found?.dominantValue ?? 0,
            values: found?.values ?? [],
            panels: group.length,
          },
        );
      }
    }
    if (on('inconsistent-radius')) {
      const found = outliers(
        placed.map((box) => ({ value: box.radius, box })),
        t.radiusTolerance,
      );
      for (const group of found?.others ?? []) {
        add(
          'inconsistent-radius',
          'warning',
          group[0].box.el,
          `Panel radius ${group[0].value}px differs from the dominant ${found?.dominantValue}px (radii on the page: ${found?.values.join(', ')}px).`,
          {
            radius: group[0].value,
            dominantRadius: found?.dominantValue ?? 0,
            values: found?.values ?? [],
            panels: group.length,
          },
        );
      }
    }
  }

  // ---- Images -------------------------------------------------------------------------------------------------

  if (on('broken-image') || on('low-res-image') || on('repeated-image')) {
    const absolute = (url: string): string => {
      try {
        return new URL(url, location.href).href;
      } catch {
        return url;
      }
    };
    // With srcset w descriptors, naturalWidth is the slot width that `sizes` promised, not the file's: read the
    // chosen file's real width from its srcset entry (in the img or its <picture> sources).
    const filePixels = (img: HTMLImageElement): { width: number; height: number } => {
      const src = img.currentSrc || img.src;
      const sources = img.parentElement?.tagName === 'PICTURE' ? [...img.parentElement.querySelectorAll('source')] : [];
      const sets = [img.getAttribute('srcset'), ...sources.map((source) => source.getAttribute('srcset'))].filter(
        (set): set is string => Boolean(set),
      );
      const ratio = img.naturalHeight / img.naturalWidth;
      for (const set of sets) {
        for (const entry of set.split(',')) {
          const [url, descriptor = ''] = entry.trim().split(/\s+/);
          if (!url || absolute(url) !== absolute(src)) continue;
          if (descriptor.endsWith('w')) {
            const width = parseFloat(descriptor);
            return { width, height: width * ratio };
          }
          if (descriptor.endsWith('x')) {
            const density = parseFloat(descriptor);
            return { width: img.naturalWidth * density, height: img.naturalHeight * density };
          }
        }
      }
      return { width: img.naturalWidth, height: img.naturalHeight };
    };

    const images = [...document.images].filter(shown);
    const uses = new Map<string, HTMLImageElement[]>();
    for (const img of images) {
      const src = img.currentSrc || img.src;
      const rect = img.getBoundingClientRect();
      if (on('broken-image') && img.complete && img.naturalWidth === 0) {
        add('broken-image', 'error', img, `Image failed to load: ${shortSrc(src || '(no src)')}.`, {
          src: shortSrc(src),
        });
        continue;
      }
      if (
        on('low-res-image') &&
        rect.width >= t.minImageWidth &&
        img.naturalWidth &&
        !/\.svg([?#]|$)/i.test(src) &&
        !src.startsWith('data:image/svg')
      ) {
        const file = filePixels(img);
        const scale =
          styleOf(img).objectFit === 'cover'
            ? Math.max(rect.width / file.width, rect.height / file.height)
            : rect.width / file.width;
        if (scale * dpr > t.upscaleTolerance) {
          add(
            'low-res-image',
            'warning',
            img,
            `Image file is ${Math.round(file.width)}x${Math.round(file.height)} but is shown at ${Math.round(rect.width)}x${Math.round(rect.height)} at ${dpr}x DPR (${round(scale * dpr)}x upscale).`,
            {
              src: shortSrc(src),
              fileWidth: Math.round(file.width),
              fileHeight: Math.round(file.height),
              boxWidth: Math.round(rect.width),
              boxHeight: Math.round(rect.height),
              dpr,
              upscale: round(scale * dpr),
            },
          );
        }
      }
      if (on('repeated-image') && rect.width >= t.minRepeatedImageWidth && src)
        uses.set(src, [...(uses.get(src) ?? []), img]);
    }
    for (const [src, list] of uses) {
      if (list.length < 2) continue;
      add('repeated-image', 'warning', list[1], `Image ${shortSrc(src)} is used ${list.length} times on the page.`, {
        src: shortSrc(src),
        times: list.length,
      });
    }
  }

  // ---- Orphan grid rows ---------------------------------------------------------------------------------------

  if (on('orphan-grid-row')) {
    for (const el of all) {
      const style = styleOf(el);
      if (style.display !== 'grid' || !shown(el)) continue;
      const columns = style.gridTemplateColumns.split(' ').filter(Boolean).length;
      const items = [...el.children].filter((child) => shown(child) && styleOf(child).position !== 'absolute');
      if (columns < 2 || items.length <= columns) continue;
      const widths = items.map((child) => child.getBoundingClientRect().width);
      // Bento grids mix item sizes on purpose.
      if (Math.max(...widths) > Math.min(...widths) * t.gridItemVariance) continue;
      const last = items.length % columns;
      if (last !== 0) {
        add(
          'orphan-grid-row',
          'warning',
          el,
          `Grid has ${columns} columns and ${items.length} items: the last row holds ${last} of ${columns}.`,
          { columns, items: items.length, lastRowItems: last },
        );
      }
    }
  }

  // ---- Rules: heading-logo-alignment ---------------------------------------------------------------------------

  if (on('heading-logo-alignment') && vw >= t.headingMinViewport) {
    const holder = [
      ...document.querySelectorAll(
        'header a[href="/"], header [class*="logo" i], a[aria-label*="home" i], [class*="logo" i]',
      ),
    ].find(shown);
    const logo = holder?.querySelector('img,svg') ?? holder;
    if (logo) {
      const logoLeft = Math.round(logo.getBoundingClientRect().left);
      for (const heading of document.querySelectorAll('h1, h2')) {
        if (!shown(heading) || heading.closest('header, nav, footer, dialog, [role=dialog]')) continue;
        const style = styleOf(heading);
        if (style.textAlign === 'center') continue;
        const rect = heading.getBoundingClientRect();
        if (rect.width < vw * t.headingMinWidthRatio) continue;
        const start = Math.round(rect.left + parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth));
        if (Math.abs(start - logoLeft) > t.headingTolerance) {
          add(
            'heading-logo-alignment',
            'error',
            heading,
            `Heading text starts at ${start}px but the logo starts at ${logoLeft}px (off by ${start - logoLeft}px).`,
            { left: start, logoLeft, offBy: start - logoLeft },
          );
        }
      }
    }
  }

  // ---- Rules: pointer-cursor ----------------------------------------------------------------------------------

  if (on('pointer-cursor')) {
    const checkable = (el: Element): boolean => {
      if (el.tagName !== 'LABEL') return true;
      const label = el as HTMLLabelElement;
      const target = label.control ?? document.getElementById(label.htmlFor);
      return Boolean(target && /^(checkbox|radio|file)$/.test((target as HTMLInputElement).type || ''));
    };
    const clickable = [
      ...document.querySelectorAll('a[href], button, [role="button"], summary, label[for], select'),
    ].filter(
      (el) =>
        shown(el) &&
        !(el as HTMLButtonElement).disabled &&
        el.getAttribute('aria-disabled') !== 'true' &&
        checkable(el),
    );
    for (const el of clickable) {
      const cursor = styleOf(el).cursor;
      // A cursor disc hides the system cursor (none) and drag rows show grab: both are deliberate.
      if (cursor === 'pointer' || cursor === 'none' || cursor === 'grab' || cursor === 'grabbing') continue;
      add(
        'pointer-cursor',
        'error',
        el,
        `Clickable <${el.tagName.toLowerCase()}> shows cursor: ${cursor}, not pointer.`,
        { cursor },
      );
    }
  }

  // ---- Rules: native controls ---------------------------------------------------------------------------------

  if (on('no-native-select')) {
    for (const select of document.querySelectorAll('select')) {
      if (!shown(select)) continue;
      add('no-native-select', 'error', select, 'Native <select> dropdown.', {
        options: (select as HTMLSelectElement).options.length,
        multiple: (select as HTMLSelectElement).multiple,
      });
    }
  }
  if (on('no-native-date-picker')) {
    const pickers =
      'input[type="date"], input[type="time"], input[type="datetime-local"], input[type="month"], input[type="week"]';
    for (const input of document.querySelectorAll(pickers)) {
      if (!shown(input)) continue;
      const type = (input as HTMLInputElement).type;
      add('no-native-date-picker', 'error', input, `Native ${type} picker.`, { type });
    }
  }

  // ---- Rules: coloured text on dark grounds -------------------------------------------------------------------

  if (on('no-coloured-text-on-dark')) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        (node.textContent ?? '').trim().length > 1 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
    });
    const checked = new Set<Element>();
    let visited = 0;
    while (walker.nextNode() && visited < t.maxTextNodes) {
      visited += 1;
      const node = walker.currentNode;
      const el = node.parentElement;
      if (!el || checked.has(el) || el.closest('script, style, noscript, svg') || !shown(el)) continue;
      checked.add(el);
      // Text over photos and gradients is left to the eye.
      const { ground, overImage } = groundBehind(el);
      if (overImage || !ground) continue;
      const raw = rgba(styleOf(el).color);
      if (raw.a < 0.1) continue;
      const text = blend(raw, ground);
      const chroma = chromaOf(text);
      if (luminance(ground) < 0.2 && chroma > 40) {
        add(
          'no-coloured-text-on-dark',
          'warning',
          el,
          `Coloured text ${hex(text)} (chroma ${chroma}) on a dark ground ${hex(ground)}.`,
          { colour: hex(text), ground: hex(ground), chroma },
          words(node.textContent),
        );
      }
    }
  }

  // ---- Rules: white icons on dark grounds ---------------------------------------------------------------------

  if (on('white-icon-on-dark')) {
    for (const svg of document.querySelectorAll('svg')) {
      if (!shown(svg)) continue;
      const rect = svg.getBoundingClientRect();
      // Large SVGs (maps, illustrations) are not icons.
      if (rect.width > 72 || rect.height > 72) continue;
      // The ground is what is painted behind the icon: read the stack at its centre when it is on screen (an icon
      // can sit over a sibling, such as a white input pill), else walk up its ancestors.
      let ground: Rgba | null = null;
      let overImage = false;
      const behind = (node: Element): boolean => {
        const style = styleOf(node);
        if (style.backgroundImage !== 'none') {
          overImage = true;
          return true;
        }
        const colour = rgba(style.backgroundColor);
        if (colour.a > 0.5) {
          ground = colour;
          return true;
        }
        return false;
      };
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const stack = cx >= 0 && cy >= 0 && cx < vw && cy < vh ? document.elementsFromPoint(cx, cy) : [];
      const at = stack.findIndex((node) => node === svg || svg.contains(node));
      if (at >= 0) {
        for (const node of stack.slice(at + 1)) if (behind(node)) break;
      } else {
        for (let node = svg.parentElement; node && node !== document.documentElement; node = node.parentElement) {
          if (behind(node)) break;
        }
      }
      if (overImage) continue;
      const backdrop: Rgba = ground ?? pageBackground();
      if (luminance(backdrop) >= 0.2) continue;
      const paints = new Set<string>();
      for (const shape of svg.querySelectorAll('path, circle, rect, line, polyline, polygon, ellipse, text, use')) {
        // Shapes in <defs>, clip paths, masks and symbols are never painted where they stand.
        if (shape.closest('defs, clipPath, mask, symbol, marker, pattern')) continue;
        const shapeStyle = styleOf(shape);
        for (const value of [shapeStyle.stroke, shapeStyle.fill]) {
          if (!value || value === 'none' || value.startsWith('url(')) continue;
          const colour = rgba(value);
          if (colour.a < 0.1) continue;
          const painted = blend(colour, backdrop);
          if (chromaOf(painted) > 40 || luminance(painted) < 0.4) paints.add(hex(painted));
        }
      }
      if (paints.size) {
        const holder = svg.closest('a, button, [role=button], summary, label') ?? svg.parentElement ?? svg;
        add(
          'white-icon-on-dark',
          'warning',
          holder,
          `Icon painted ${[...paints].slice(0, 3).join(', ')} on a dark ground ${hex(backdrop)}; it should be white.`,
          { colours: [...paints].slice(0, 3), ground: hex(backdrop) },
        );
      }
    }
  }

  // ---- Layout shift -------------------------------------------------------------------------------------------

  let layoutShift: number | null = null;
  if (on('layout-shift')) {
    layoutShift = await new Promise<number | null>((resolve) => {
      try {
        let total = 0;
        // Every shift counts, input-driven ones included: nothing here sends input, and Chromium's mobile
        // emulation marks shifts as input-driven even when no input happened.
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) total += (entry as PerformanceEntry & { value: number }).value;
        });
        observer.observe({ type: 'layout-shift', buffered: true });
        setTimeout(() => {
          observer.disconnect();
          resolve(Number(total.toFixed(3)));
        }, t.layoutShiftWaitMs);
      } catch {
        resolve(null);
      }
    });
    if (layoutShift !== null && layoutShift > t.layoutShift) {
      add('layout-shift', 'warning', null, `Layout shifted by a cumulative ${layoutShift} (limit ${t.layoutShift}).`, {
        score: layoutShift,
        limit: t.layoutShift,
      });
    }
  }

  return { viewport: { width: vw, height: vh, dpr }, problems, totals, layoutShift };
}
