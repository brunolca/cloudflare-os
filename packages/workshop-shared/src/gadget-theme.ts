/**
 * The platform stylesheet injected into every Gadget UI, plus the theme plumbing that carries
 * Workshop's resolved appearance into the sandbox.
 *
 * Gadgets render into a totally sandboxed, null-origin iframe whose CSP is `default-src 'none'`:
 * no web fonts, no CDN stylesheets, no network of any kind. Before this module existed, that meant
 * every Gadget hand-rolled its own palette, type scale, and control styling from scratch, so no two
 * Gadgets looked alike and none of them matched the Workshop around them. This stylesheet is the
 * shared baseline: a token layer, conservative element defaults, and a small component vocabulary.
 *
 * Two rules keep it safe to inject under existing, already-written Gadgets:
 *
 * 1. **Every selector is single-class or single-element specificity, and nothing uses
 *    `!important`.** A Gadget's own CSS always wins, so this can only improve a Gadget that styles
 *    itself and can never fight it.
 * 2. **Component classes are all `g-` prefixed.** Gadgets in the wild already define `.card`,
 *    `.button`, `.row`; an unprefixed vocabulary would silently restyle them.
 *
 * Shared by the interactive path (workshop-frontend's GadgetUI) and the browser-export path
 * (workshop-backend's browser-export), so an exported PDF or HTML file looks like what the user
 * saw on screen. Both packages depend on workshop-shared, and this is a plain string constant
 * rather than a `.css` asset precisely so it needs no bundler support on either side.
 */

/** The appearance state Workshop pushes into a Gadget's sandbox. Mirrors GatekeeperAppTheme. */
export interface GadgetTheme {
  /** The concrete light or dark mode resolved by Workshop. */
  mode: "light" | "dark";
  /** The deployment accent seed, or null to use the stylesheet's default accent. */
  accentColor: string | null;
}

/** The theme applied to browser-mode exports: light, since exports are printed and shared. */
export const EXPORT_GADGET_THEME: GadgetTheme = { mode: "light", accentColor: null };

/** The attribute the stylesheet keys its dark palette off of. */
export const GADGET_THEME_ATTRIBUTE = "data-gadget-theme";

/** The `postMessage` type Workshop sends to retheme a live Gadget iframe without reloading it. */
export const GADGET_THEME_MESSAGE = "gadget-theme";

/** Accepts only `#rgb` / `#rrggbb`, so an accent seed can never inject CSS. */
function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value);
}

/**
 * The design tokens, element defaults, and component classes shared by every Gadget.
 *
 * Deliberately font-free: no `@font-face`, because embedding a webfont as a data URI would add tens
 * of kilobytes to every Gadget load and every export. The system stack renders as SF Pro on Apple
 * platforms and Segoe UI Variable on Windows, both of which are better than anything worth
 * embedding at that price.
 */
export const GADGET_STYLESHEET = `
/* ---------------------------------------------------------------- tokens */
:root {
  --g-accent-seed: #4f7cf7;

  --g-font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI Variable Text",
      "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --g-font-mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas,
      "Liberation Mono", monospace;

  /* Type scale. Large sizes get negative tracking; at display sizes the default spacing reads
     loose and amateurish. */
  --g-text-xs: 0.75rem;
  --g-text-sm: 0.8125rem;
  --g-text-base: 0.9375rem;
  --g-text-lg: 1.0625rem;
  --g-text-xl: 1.25rem;
  --g-text-2xl: 1.5rem;
  --g-text-3xl: 1.9375rem;
  --g-text-4xl: 2.4375rem;

  --g-space-1: 0.25rem;
  --g-space-2: 0.5rem;
  --g-space-3: 0.75rem;
  --g-space-4: 1rem;
  --g-space-5: 1.5rem;
  --g-space-6: 2rem;
  --g-space-7: 3rem;

  --g-radius-sm: 6px;
  --g-radius: 9px;
  --g-radius-lg: 13px;
  --g-radius-full: 999px;

  /* Custom curves: the CSS built-ins are too weak to read as intentional. Never ease-in — it
     delays the first frame, exactly where the eye is. */
  --g-ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  --g-ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);

  --g-duration-fast: 120ms;
  --g-duration: 180ms;

  /* Light palette. No pure white or pure black: both read as harsh and unfinished on real
     displays. A trace of blue in the neutrals keeps them from looking muddy. */
  color-scheme: light;
  --g-bg: oklch(0.993 0.0015 285);
  --g-bg-sunken: oklch(0.972 0.0025 285);
  --g-surface: oklch(1 0 0);
  --g-surface-hover: oklch(0.976 0.003 285);
  --g-text: oklch(0.245 0.011 285);
  --g-text-muted: oklch(0.505 0.012 285);
  --g-text-faint: oklch(0.645 0.011 285);
  --g-line: oklch(0.912 0.004 285);
  --g-line-strong: oklch(0.855 0.006 285);

  --g-danger: oklch(0.556 0.208 26);
  --g-danger-soft: oklch(0.955 0.026 26);
  --g-danger-text: oklch(0.995 0 0);
  --g-success: oklch(0.573 0.148 152);
  --g-success-soft: oklch(0.955 0.038 152);
  --g-warning: oklch(0.681 0.153 71);
  --g-warning-soft: oklch(0.958 0.052 82);

  /* Layered shadows. A single large blur is the most recognizable tell of unconsidered UI; real
     depth comes from a tight contact shadow plus a wider ambient one. */
  --g-shadow-sm: 0 1px 2px oklch(0.245 0.011 285 / 0.06),
      0 1px 1px oklch(0.245 0.011 285 / 0.04);
  --g-shadow: 0 1px 2px oklch(0.245 0.011 285 / 0.05),
      0 4px 12px -2px oklch(0.245 0.011 285 / 0.08);
  --g-shadow-lg: 0 1px 3px oklch(0.245 0.011 285 / 0.05),
      0 12px 32px -6px oklch(0.245 0.011 285 / 0.13);

  --g-accent: var(--g-accent-seed);
  --g-accent-hover: oklch(from var(--g-accent-seed) calc(l - 0.06) c h);
  --g-accent-text: oklch(0.995 0 0);
  --g-accent-soft: oklch(from var(--g-accent-seed) 0.958 calc(c * 0.34) h);
  --g-accent-line: oklch(from var(--g-accent-seed) 0.86 calc(c * 0.5) h);
  --g-accent-on-soft: oklch(from var(--g-accent-seed) calc(l - 0.1) c h);
  --g-ring: oklch(from var(--g-accent-seed) l c h / 0.42);
}

[data-gadget-theme="dark"] {
  color-scheme: dark;
  --g-bg: oklch(0.181 0.008 285);
  --g-bg-sunken: oklch(0.148 0.007 285);
  --g-surface: oklch(0.216 0.009 285);
  --g-surface-hover: oklch(0.249 0.01 285);
  --g-text: oklch(0.955 0.003 285);
  --g-text-muted: oklch(0.715 0.009 285);
  --g-text-faint: oklch(0.575 0.01 285);
  --g-line: oklch(0.302 0.011 285);
  --g-line-strong: oklch(0.372 0.013 285);

  --g-danger: oklch(0.702 0.176 24);
  --g-danger-soft: oklch(0.302 0.079 24);
  /* Dark mode lightens --g-danger for legibility as *text*, which leaves it too light to carry
     near-white label text as a *fill*. Flip the label dark instead, as the accent does. */
  --g-danger-text: oklch(0.17 0.02 24);
  --g-success: oklch(0.735 0.153 154);
  --g-success-soft: oklch(0.298 0.066 154);
  --g-warning: oklch(0.812 0.146 79);
  --g-warning-soft: oklch(0.315 0.069 79);

  /* Dark surfaces need a hairline highlight to read as raised; shadow alone does nothing
     against a dark background. */
  --g-shadow-sm: 0 1px 2px oklch(0 0 0 / 0.34), inset 0 1px 0 oklch(1 0 0 / 0.035);
  --g-shadow: 0 2px 4px oklch(0 0 0 / 0.34), 0 6px 16px -3px oklch(0 0 0 / 0.42),
      inset 0 1px 0 oklch(1 0 0 / 0.04);
  --g-shadow-lg: 0 4px 8px oklch(0 0 0 / 0.36), 0 18px 44px -8px oklch(0 0 0 / 0.56),
      inset 0 1px 0 oklch(1 0 0 / 0.05);

  --g-accent: oklch(from var(--g-accent-seed) 0.715 calc(c * 0.94) h);
  --g-accent-hover: oklch(from var(--g-accent-seed) 0.775 calc(c * 0.94) h);
  --g-accent-text: oklch(0.16 0.012 285);
  --g-accent-soft: oklch(from var(--g-accent-seed) 0.295 calc(c * 0.52) h);
  --g-accent-line: oklch(from var(--g-accent-seed) 0.42 calc(c * 0.6) h);
  --g-accent-on-soft: oklch(from var(--g-accent-seed) 0.845 calc(c * 0.7) h);
  --g-ring: oklch(from var(--g-accent-seed) 0.715 calc(c * 0.94) h / 0.52);
}

/* ------------------------------------------------------- element defaults */
/* Kept conservative and low-specificity on purpose: these also apply to Gadgets written before
   this stylesheet existed, so they must improve such a Gadget without ever fighting its own CSS. */

*, *::before, *::after { box-sizing: border-box; }

html {
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
}

body {
  margin: 0;
  background: var(--g-bg);
  color: var(--g-text);
  font-family: var(--g-font-sans);
  font-size: var(--g-text-base);
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  font-synthesis-weight: none;
  text-rendering: optimizeLegibility;
}

h1, h2, h3, h4, h5, h6 {
  margin: 0 0 var(--g-space-3);
  font-weight: 600;
  line-height: 1.22;
  letter-spacing: -0.019em;
  text-wrap: balance;
}
h1 { font-size: var(--g-text-3xl); letter-spacing: -0.026em; }
h2 { font-size: var(--g-text-2xl); letter-spacing: -0.022em; }
h3 { font-size: var(--g-text-xl); }
h4 { font-size: var(--g-text-lg); }
h5, h6 { font-size: var(--g-text-base); }

p { margin: 0 0 var(--g-space-4); text-wrap: pretty; }
p:last-child { margin-bottom: 0; }

small { font-size: var(--g-text-sm); color: var(--g-text-muted); }
strong, b { font-weight: 600; }

a {
  color: var(--g-accent);
  text-decoration-color: color-mix(in oklab, currentColor 32%, transparent);
  text-underline-offset: 0.16em;
  transition: color var(--g-duration-fast) ease;
}

hr {
  height: 1px;
  margin: var(--g-space-5) 0;
  border: 0;
  background: var(--g-line);
}

ul, ol { margin: 0 0 var(--g-space-4); padding-left: 1.35em; }
li { margin-bottom: var(--g-space-1); }

blockquote {
  margin: 0 0 var(--g-space-4);
  padding-left: var(--g-space-4);
  border-left: 2px solid var(--g-line-strong);
  color: var(--g-text-muted);
}

code, pre, kbd, samp { font-family: var(--g-font-mono); font-size: 0.9em; }

code {
  padding: 0.15em 0.36em;
  border-radius: var(--g-radius-sm);
  background: var(--g-bg-sunken);
}

pre {
  margin: 0 0 var(--g-space-4);
  padding: var(--g-space-4);
  overflow-x: auto;
  border: 1px solid var(--g-line);
  border-radius: var(--g-radius);
  background: var(--g-bg-sunken);
  line-height: 1.5;
}
pre code { padding: 0; background: none; }

kbd {
  padding: 0.15em 0.4em;
  border: 1px solid var(--g-line-strong);
  border-bottom-width: 2px;
  border-radius: var(--g-radius-sm);
  background: var(--g-surface);
  font-size: 0.8em;
}

img, svg, video, canvas { max-width: 100%; }
img, video { height: auto; }

/* Form controls do not inherit typography by default. Left alone, a Gadget's inputs and buttons
   render in the browser's 13px Arial while its prose renders in the system stack — on its own the
   single loudest source of "this looks unfinished". */
button, input, select, textarea, optgroup {
  font: inherit;
  letter-spacing: inherit;
  color: inherit;
}
button { cursor: pointer; }
button:disabled, input:disabled, select:disabled, textarea:disabled { cursor: not-allowed; }
textarea { resize: vertical; }

fieldset { margin: 0 0 var(--g-space-4); padding: 0; border: 0; }
legend { padding: 0; font-weight: 600; }
label { display: inline-block; }

table { border-collapse: collapse; border-spacing: 0; }
caption { text-align: left; color: var(--g-text-muted); }

:focus-visible {
  outline: 2px solid var(--g-accent);
  outline-offset: 2px;
  border-radius: var(--g-radius-sm);
}

::selection {
  background: var(--g-accent-soft);
  color: var(--g-accent-on-soft);
}

::placeholder { color: var(--g-text-faint); opacity: 1; }

/* ------------------------------------------------------------ components */

/* Column layout that owns the viewport: fixed header/footer, one scrolling middle. The default
   for any Gadget with a title bar or toolbar. */
.g-app {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  min-height: 100dvh;
}
.g-app > .g-main { flex: 1 1 auto; min-height: 0; }

.g-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--g-space-3);
  padding: var(--g-space-4) var(--g-space-5);
  border-bottom: 1px solid var(--g-line);
  background: color-mix(in oklab, var(--g-bg) 82%, transparent);
  backdrop-filter: blur(12px);
}
.g-header h1, .g-header h2, .g-header h3 { margin: 0; font-size: var(--g-text-lg); }

.g-main { padding: var(--g-space-5); overflow-y: auto; }

/* Centered reading measure. Prose past ~72ch is measurably harder to read, and full-bleed text
   in a wide pane is a common tell of unconsidered layout. */
.g-page { width: 100%; max-width: 72ch; margin-inline: auto; }
.g-page--wide { max-width: 1120px; }

.g-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--g-space-2);
}
.g-spacer { flex: 1 1 auto; }

.g-stack { display: flex; flex-direction: column; gap: var(--g-space-4); }
.g-stack--tight { gap: var(--g-space-2); }
.g-stack--loose { gap: var(--g-space-6); }

.g-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--g-space-3);
}

/* Auto-fitting grid: wraps to one column on a phone with no media query to maintain. */
.g-grid {
  display: grid;
  gap: var(--g-space-4);
  grid-template-columns: repeat(auto-fit, minmax(min(15rem, 100%), 1fr));
}

.g-card {
  padding: var(--g-space-5);
  border: 1px solid var(--g-line);
  border-radius: var(--g-radius-lg);
  background: var(--g-surface);
  box-shadow: var(--g-shadow-sm);
}
.g-card--flat { box-shadow: none; }
.g-card--raised { box-shadow: var(--g-shadow); }
.g-card > :last-child { margin-bottom: 0; }

.g-panel {
  border: 1px solid var(--g-line);
  border-radius: var(--g-radius-lg);
  background: var(--g-surface);
  overflow: hidden;
}
.g-panel > .g-panel-header {
  padding: var(--g-space-3) var(--g-space-4);
  border-bottom: 1px solid var(--g-line);
  background: var(--g-bg-sunken);
  font-size: var(--g-text-sm);
  font-weight: 600;
  color: var(--g-text-muted);
}
.g-panel > .g-panel-body { padding: var(--g-space-4); }

.g-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--g-space-2);
  padding: 0.5rem 0.875rem;
  border: 1px solid var(--g-line-strong);
  border-radius: var(--g-radius);
  background: var(--g-surface);
  box-shadow: var(--g-shadow-sm);
  color: var(--g-text);
  font-size: var(--g-text-sm);
  font-weight: 550;
  line-height: 1.25;
  white-space: nowrap;
  user-select: none;
  /* Named properties only: "all" sweeps in layout-triggering ones and cannot be reasoned about. */
  transition: transform var(--g-duration-fast) var(--g-ease-out),
      background-color var(--g-duration-fast) ease,
      border-color var(--g-duration-fast) ease,
      color var(--g-duration-fast) ease,
      opacity var(--g-duration-fast) ease;
}
/* Touch devices fire hover on tap and leave it stuck, so gate it. */
@media (hover: hover) and (pointer: fine) {
  .g-btn:hover { background: var(--g-surface-hover); border-color: var(--g-line-strong); }
}
/* Press feedback. Without it a button never confirms it heard the click. */
.g-btn:active { transform: scale(0.975); }
.g-btn:disabled { opacity: 0.5; box-shadow: none; transform: none; }

.g-btn--primary {
  border-color: transparent;
  background: var(--g-accent);
  color: var(--g-accent-text);
}
@media (hover: hover) and (pointer: fine) {
  .g-btn--primary:hover { background: var(--g-accent-hover); border-color: transparent; }
}

.g-btn--ghost {
  border-color: transparent;
  background: transparent;
  box-shadow: none;
  color: var(--g-text-muted);
}
@media (hover: hover) and (pointer: fine) {
  .g-btn--ghost:hover {
    background: var(--g-surface-hover);
    border-color: transparent;
    color: var(--g-text);
  }
}

.g-btn--danger {
  border-color: transparent;
  background: var(--g-danger);
  color: var(--g-danger-text);
}
@media (hover: hover) and (pointer: fine) {
  .g-btn--danger:hover {
    background: oklch(from var(--g-danger) calc(l - 0.06) c h);
    border-color: transparent;
  }
}

.g-btn--icon { padding: 0.5rem; aspect-ratio: 1; }
.g-btn--sm { padding: 0.3125rem 0.625rem; font-size: var(--g-text-xs); }
.g-btn--lg { padding: 0.625rem 1.125rem; font-size: var(--g-text-base); }

.g-input, .g-textarea, .g-select {
  width: 100%;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--g-line-strong);
  border-radius: var(--g-radius);
  background: var(--g-surface);
  color: var(--g-text);
  font-size: var(--g-text-sm);
  transition: border-color var(--g-duration-fast) ease, box-shadow var(--g-duration-fast) ease;
}
.g-input:focus, .g-textarea:focus, .g-select:focus {
  outline: none;
  border-color: var(--g-accent);
  box-shadow: 0 0 0 3px var(--g-ring);
}
.g-input:disabled, .g-textarea:disabled, .g-select:disabled {
  background: var(--g-bg-sunken);
  color: var(--g-text-faint);
}
.g-textarea { min-height: 5.5rem; }

.g-field { display: flex; flex-direction: column; gap: var(--g-space-2); }
.g-label { font-size: var(--g-text-sm); font-weight: 550; color: var(--g-text); }
.g-hint { font-size: var(--g-text-xs); color: var(--g-text-muted); }
.g-error { font-size: var(--g-text-xs); color: var(--g-danger); }

.g-check {
  display: inline-flex;
  align-items: center;
  gap: var(--g-space-2);
  font-size: var(--g-text-sm);
  cursor: pointer;
}
.g-check input { accent-color: var(--g-accent); }

.g-table { width: 100%; font-size: var(--g-text-sm); }
.g-table th, .g-table td {
  padding: var(--g-space-3);
  border-bottom: 1px solid var(--g-line);
  text-align: left;
  vertical-align: top;
}
.g-table th {
  font-size: var(--g-text-xs);
  font-weight: 600;
  letter-spacing: 0.035em;
  text-transform: uppercase;
  color: var(--g-text-muted);
}
.g-table tbody tr:last-child td { border-bottom: 0; }
@media (hover: hover) and (pointer: fine) {
  .g-table tbody tr:hover { background: var(--g-surface-hover); }
}
/* Numeric text lines up only with tabular figures; proportional digits make a column of numbers
   look ragged. Alignment is deliberately NOT part of this: right-aligning is correct in a table
   column and wrong everywhere else -- on a stat card it detaches the number from its label. */
.g-num { font-variant-numeric: tabular-nums; }
.g-table th.g-num, .g-table td.g-num { text-align: right; }

/* Any wide block (table, code, chart) belongs in one of these so the page itself never
   scrolls sideways on a phone. */
.g-scroll-x { overflow-x: auto; overscroll-behavior-x: contain; }

.g-badge {
  display: inline-flex;
  align-items: center;
  gap: var(--g-space-1);
  padding: 0.125rem 0.5rem;
  border-radius: var(--g-radius-full);
  background: var(--g-bg-sunken);
  color: var(--g-text-muted);
  font-size: var(--g-text-xs);
  font-weight: 550;
  white-space: nowrap;
}
.g-badge--accent { background: var(--g-accent-soft); color: var(--g-accent-on-soft); }
.g-badge--success { background: var(--g-success-soft); color: var(--g-success); }
.g-badge--warning { background: var(--g-warning-soft); color: var(--g-warning); }
.g-badge--danger { background: var(--g-danger-soft); color: var(--g-danger); }

.g-title { font-size: var(--g-text-xl); font-weight: 600; letter-spacing: -0.022em; }
.g-subtitle { font-size: var(--g-text-sm); color: var(--g-text-muted); }
.g-muted { color: var(--g-text-muted); }
.g-faint { color: var(--g-text-faint); }
.g-mono { font-family: var(--g-font-mono); }
.g-truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.g-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.g-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--g-space-2);
  padding: var(--g-space-7) var(--g-space-5);
  text-align: center;
  color: var(--g-text-muted);
}
.g-empty .g-empty-title { font-weight: 600; color: var(--g-text); }

.g-spinner {
  width: 1rem;
  height: 1rem;
  border: 2px solid var(--g-line-strong);
  border-top-color: var(--g-accent);
  border-radius: 50%;
  animation: g-spin 620ms linear infinite;
}
@keyframes g-spin { to { transform: rotate(360deg); } }

.g-skeleton {
  border-radius: var(--g-radius-sm);
  background: var(--g-bg-sunken);
  animation: g-pulse 1.4s var(--g-ease-in-out) infinite;
}
@keyframes g-pulse { 50% { opacity: 0.55; } }

/* ------------------------------------------------------- accessibility */
/* Reduced motion means less movement, not no transitions: color and opacity changes still carry
   meaning, so only motion and looping animation are dropped. */
@media (prefers-reduced-motion: reduce) {
  /* Blanket-flatten motion, including whatever the Gadget itself animates. "!important" is
     warranted here and nowhere else in this stylesheet: it is honouring an OS accessibility
     setting the Gadget's author never accounted for. */
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
  /* Loading indicators are exempt: a frozen spinner reads as a hung app. Kept slower and
     opacity-only so it conveys progress without sustained movement. */
  .g-spinner {
    animation-duration: 1.1s !important;
    animation-iteration-count: infinite !important;
  }
  .g-skeleton {
    animation-duration: 2.4s !important;
    animation-iteration-count: infinite !important;
  }
  .g-btn:active { transform: none; }
  html { scroll-behavior: auto; }
}

/* -------------------------------------------------------------- print */
/* Browser-mode PDF export renders under print media. Force the light palette regardless of the
   theme captured in the document, drop chrome that only makes sense on screen, and stop rows and
   cards from being split across a page break. */
@media print {
  :root {
    color-scheme: light;
    --g-bg: #fff;
    --g-bg-sunken: #f6f6f7;
    --g-surface: #fff;
    --g-text: #16161a;
    --g-text-muted: #56565e;
    --g-text-faint: #76767e;
    --g-line: #dededf;
    --g-line-strong: #c6c6c8;
    --g-shadow-sm: none;
    --g-shadow: none;
    --g-shadow-lg: none;
  }
  body { background: #fff; }
  .g-app { min-height: 0; }
  .g-main { overflow: visible; padding: 0; }
  .g-header { position: static; border-bottom: 1px solid var(--g-line); backdrop-filter: none; }
  .g-scroll-x { overflow: visible; }
  .g-btn, .g-spinner, .g-skeleton { display: none; }
  .g-card, .g-panel { break-inside: avoid; box-shadow: none; }
  tr, li, blockquote, pre { break-inside: avoid; }
  h1, h2, h3, h4 { break-after: avoid; }
  a { color: inherit; text-decoration: none; }
}
`;

/**
 * The `<style>` element carrying the platform stylesheet.
 *
 * The content is a compile-time constant with no interpolation, so there is nothing to escape:
 * the accent seed travels as a validated custom property on the root element (see
 * `gadgetThemeRootAttributes`), never spliced into CSS text.
 */
export function gadgetStyleTag(): string {
  return `<style>${GADGET_STYLESHEET}</style>`;
}

/**
 * The theme attributes for the document's root element, so the correct palette is in effect on the
 * very first paint. Applying the theme after load would flash the light palette in a dark
 * Workshop.
 */
export function gadgetThemeRootAttributes(theme: GadgetTheme): string {
  let attributes = `${GADGET_THEME_ATTRIBUTE}="${theme.mode === "dark" ? "dark" : "light"}"`;
  // Rejecting a non-hex seed rather than escaping it keeps the sandbox's style surface closed:
  // the value lands inside a `style` attribute, where arbitrary text could open a new declaration.
  if (isHexColor(theme.accentColor)) {
    attributes += ` style="--g-accent-seed:${theme.accentColor}"`;
  }
  return attributes;
}

/** The theme as the sandbox should see it, with an unusable accent seed normalized away. */
export function normalizeGadgetTheme(theme: GadgetTheme): GadgetTheme {
  return {
    mode: theme.mode === "dark" ? "dark" : "light",
    accentColor: isHexColor(theme.accentColor) ? theme.accentColor : null,
  };
}
