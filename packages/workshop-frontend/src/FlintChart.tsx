import { useEffect, useMemo, useRef, useState } from 'react'
import { useOptionalTheme } from './ThemeContext'
import styles from './FlintChart.module.css'

/**
 * Renders a Flint chart spec that an agent emitted in a ```flint fenced code block.
 *
 * Flint (https://github.com/microsoft/flint-chart) is a compiler, not a renderer: it turns a small
 * semantic spec -- data, per-field semantic types, a chart type and encodings -- into a native
 * chart spec, making the design decisions (scales, zero baselines, tick counts, label sizing,
 * legend placement, palettes) that agents otherwise get wrong. We target its Vega-Lite backend and
 * render with Vega.
 *
 * Vega-Lite specifically, and not the smaller Chart.js target, because as of flint-chart 0.5.1 the
 * Chart.js backend ignores `theme_spec` entirely and drops the chart title -- every theme compiles
 * to the same default blue. The Vega-Lite backend honours both, plus the shipped house themes
 * (`datawrapper`, `economist`, `nyt`, ...) and synthetic data-label layers. Taking Chart.js would
 * have bought a smaller bundle and given up the reason to use Flint at all.
 *
 * Everything is behind a dynamic import: Vega plus Vega-Lite plus the compiler is roughly half a
 * megabyte gzipped, and a user who never sees a chart never downloads it.
 */

// Vega compiles its expression language through `new Function`. That is fine here -- the app's own
// CSP is only `frame-src srcdoc:` (see index.html) -- but it is exactly why this renderer cannot be
// reused inside a Gadget iframe, whose CSP has no 'unsafe-eval'.

type FlintModules = {
  assembleVegaLite: (input: unknown) => Record<string, unknown>
  compile: (spec: unknown) => { spec: unknown }
  parse: (spec: unknown) => unknown
  View: new (runtime: unknown, options?: Record<string, unknown>) => VegaView
}

type VegaView = {
  initialize(element: HTMLElement): VegaView
  runAsync(): Promise<unknown>
  finalize(): void
}

// One in-flight load shared by every chart on the page, so N charts in a conversation cost one
// chunk fetch rather than N.
let modulesPromise: Promise<FlintModules> | null = null

function loadFlint(): Promise<FlintModules> {
  modulesPromise ??= Promise.all([
    import('flint-chart/vegalite'),
    import('vega-lite'),
    import('vega'),
  ]).then(([flint, vegaLite, vega]) => ({
    assembleVegaLite: flint.assembleVegaLite as FlintModules['assembleVegaLite'],
    compile: vegaLite.compile as unknown as FlintModules['compile'],
    parse: vega.parse as unknown as FlintModules['parse'],
    View: vega.View as unknown as FlintModules['View'],
  }))
  // A failed load must not be cached, or one offline moment poisons every later chart.
  modulesPromise.catch(() => { modulesPromise = null })
  return modulesPromise
}

/**
 * The neutrals Flint paints axes, gridlines, labels, and text with, per resolved mode.
 *
 * Stated explicitly rather than scraped out of the Kumo custom properties: the values are shared
 * with the Gadget platform stylesheet's palette, so a chart in a chat and a Gadget UI agree, and a
 * deterministic palette is testable. Hex rather than oklch() because Flint does color math on these
 * strings; they are not only handed to CSS.
 *
 * The data palette deliberately stays with the chosen house theme -- that is the part Flint is
 * good at, and overriding it would flatten every series to one accent.
 */
const CHART_INK = {
  light: {
    text: { primary: '#3b3b45', secondary: '#5c5c66', muted: '#76767f' },
    structure: { axis: '#cfcfd6', grid: '#e9e9ee', frame: '#e2e2e8', rule: '#c4c4cd' },
  },
  dark: {
    text: { primary: '#e6e6ea', secondary: '#a6a6b0', muted: '#84848e' },
    structure: { axis: '#4b4b55', grid: '#33333b', frame: '#3a3a43', rule: '#55555f' },
  },
}

/** Fallback surface per mode, for when nothing up the tree paints a background. */
const FALLBACK_SURFACE = { light: '#ffffff', dark: '#1f1f26' }

/**
 * The background the chart is actually sitting on, as a hex string.
 *
 * This matters more than it looks: Flint *derives* gridline and tick contrast from the surface it
 * is told about, so passing `transparent` makes it derive against nothing and emit mid-grey
 * gridlines that are too hot on a dark background. Reading the real color off the DOM keeps the
 * derivation correct without hardcoding a guess at what the chat surface currently is.
 */
function resolveSurface(element: HTMLElement | null, mode: 'light' | 'dark'): string {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const hex = toHexColor(getComputedStyle(node).backgroundColor)
    if (hex) return hex
  }
  return FALLBACK_SURFACE[mode]
}

/** A fully opaque `rgb()`/`rgba()` as hex, or null when absent or transparent. */
function toHexColor(color: string): string | null {
  const match = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?/.exec(color)
  if (!match) return null
  // Skip see-through layers: they reveal whatever is painted behind them, so they are not the
  // surface the chart is read against.
  if (match[4] !== undefined && Number(match[4]) < 0.9) return null
  const channels = [match[1], match[2], match[3]]
      .map(value => Math.max(0, Math.min(255, Math.round(Number(value)))))
  return `#${channels.map(value => value.toString(16).padStart(2, '0')).join('')}`
}

// Flint's own house themes. An agent may name one; anything else falls back to a neutral default.
const ALLOWED_THEMES = new Set([
  'datawrapper', 'economist', 'mckinsey', 'nature', 'nyt', 'powerbi', 'powerbi-light',
])
const DEFAULT_THEME = 'datawrapper'

// Upper bound on inline rows. Flint and Vega both cope with more, but the work happens on the main
// thread during a chat render, and a runaway table would jank the whole conversation.
const MAX_ROWS = 4000

/** Chart height when the spec names none. A shade under 16:9 at typical chat widths. */
const DEFAULT_HEIGHT = 300
/** Ignore resizes below this, so a scrollbar appearing does not recompile the chart. */
const RESIZE_EPSILON_PX = 24

export type FlintChartResult =
  | { status: 'ok'; input: Record<string, unknown> }
  | { status: 'incomplete' }
  | { status: 'invalid'; message: string }

/**
 * Validates the JSON inside a ```flint block into an assembler input.
 *
 * `incomplete` is distinct from `invalid` on purpose: chat messages stream, so a block is
 * unparseable JSON for as long as it is still arriving. Showing an error then would flash a
 * failure on every chart the agent writes. Exported for tests.
 */
export function parseFlintBlock(source: string): FlintChartResult {
  const trimmed = source.trim()
  if (!trimmed) return { status: 'incomplete' }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    // Balanced braces mean the JSON is all here and genuinely wrong; unbalanced means it is still
    // streaming in.
    return isProbablyComplete(trimmed)
      ? { status: 'invalid', message: 'This chart spec is not valid JSON.' }
      : { status: 'incomplete' }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { status: 'invalid', message: 'A chart spec must be a JSON object.' }
  }

  const input = parsed as Record<string, any>
  const values = input.data?.values
  if (!Array.isArray(values)) {
    return { status: 'invalid', message: 'A chart spec needs `data.values` as an array of rows.' }
  }
  if (values.length === 0) {
    return { status: 'invalid', message: 'This chart has no data rows.' }
  }
  if (!input.chart_spec?.chartType) {
    return { status: 'invalid', message: 'A chart spec needs `chart_spec.chartType`.' }
  }
  if (!input.chart_spec?.encodings || typeof input.chart_spec.encodings !== 'object') {
    return { status: 'invalid', message: 'A chart spec needs `chart_spec.encodings`.' }
  }

  return {
    status: 'ok',
    input: {
      ...input,
      // `url` data would make Vega fetch at render time. Only inline rows are supported.
      data: { values: values.slice(0, MAX_ROWS) },
    },
  }
}

/** Whether every brace and bracket opened in the text has been closed, ignoring string contents. */
function isProbablyComplete(text: string): boolean {
  let depth = 0
  let inString = false
  let escaped = false
  for (const character of text) {
    if (escaped) { escaped = false; continue }
    if (inString) {
      if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === '{' || character === '[') depth++
    else if (character === '}' || character === ']') depth--
  }
  return !inString && depth <= 0
}

/** Applies our ink and a validated house theme over whatever the spec asked for. */
function withHostTheme(
  input: Record<string, any>,
  mode: 'light' | 'dark',
  width: number,
  surface: string,
) {
  const requested = typeof input.theme_spec === 'string' ? input.theme_spec : undefined
  const base = requested && ALLOWED_THEMES.has(requested) ? requested : DEFAULT_THEME
  const height = Number(input.chart_spec?.baseSize?.height) || DEFAULT_HEIGHT

  return {
    ...input,
    chart_spec: {
      ...input.chart_spec,
      // Hand Flint the real width it has to work in. Adapting sizing, tick counts, and label
      // treatment to the available canvas is the whole point of the library, so measuring the
      // container beats letting it guess and then scaling the result.
      baseSize: { width, height },
      canvasSize: { width, height },
    },
    theme_spec: {
      extends: base,
      ink: { surface: { source: 'host', canvas: surface, plot: surface }, ...CHART_INK[mode] },
      // Drop the house furniture. Several themes (datawrapper, nyt) draw an editorial footer or
      // masthead rule whose color comes from the theme rather than from `ink`, so it renders
      // near-white on a dark surface -- and a chart inside a chat message already has framing.
      // Clearing it also collapses the spec from a vconcat wrapper to a plain layer.
      furniture: [],
    },
  }
}

export default function FlintChart({ source }: { source: string }) {
  const parsed = useMemo(() => parseFlintBlock(source), [source])
  const mode = useOptionalTheme()?.resolvedThemeMode ?? 'light'
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState<number | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [rendered, setRendered] = useState(false)

  // Track the container's usable width so Flint lays the chart out for the space it actually has.
  useEffect(() => {
    const element = containerRef.current
    if (!element) return

    const apply = (next: number) => {
      if (next <= 0) return
      setWidth(current =>
        current === null || Math.abs(current - next) >= RESIZE_EPSILON_PX ? next : current)
    }
    apply(element.clientWidth)

    // Guarded rather than assumed: a fixed initial measurement is a perfectly good chart, so a
    // missing ResizeObserver should cost responsiveness, not the chart.
    if (typeof ResizeObserver === 'undefined') {
      const onResize = () => apply(element.clientWidth)
      window.addEventListener('resize', onResize)
      return () => window.removeEventListener('resize', onResize)
    }

    const observer = new ResizeObserver(entries => {
      for (const entry of entries) apply(entry.contentRect.width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (parsed.status !== 'ok' || width === null) return

    let view: VegaView | undefined
    let cancelled = false
    setFailure(null)

    void (async () => {
      try {
        const surface = resolveSurface(containerRef.current, mode)
        const { assembleVegaLite, compile, parse, View } = await loadFlint()
        if (cancelled) return

        const vegaLiteSpec = assembleVegaLite(withHostTheme(parsed.input, mode, width, surface))
        const runtime = parse(compile(vegaLiteSpec).spec)
        if (cancelled) return

        view = new View(runtime, { renderer: 'svg' })
        // Render before mounting, so a chart never appears half-drawn.
        await view.runAsync()
        if (cancelled || !chartRef.current) return

        chartRef.current.replaceChildren()
        view.initialize(chartRef.current)
        await view.runAsync()
        if (cancelled) return
        setRendered(true)
      } catch (error) {
        if (cancelled) return
        // Deliberately not surfaced verbatim: the text can carry agent-authored data.
        console.error('Failed to render Flint chart:', error)
        setFailure('This chart could not be rendered.')
      }
    })()

    return () => {
      cancelled = true
      view?.finalize()
    }
  }, [parsed, mode, width])

  if (parsed.status === 'invalid' || failure) {
    const message = failure ?? (parsed.status === 'invalid' ? parsed.message : '')
    return (
      <div className={`${styles.chart} ${styles.error}`}>
        <p className={styles.message}>{message}</p>
        {/* Keep the spec visible: a chart the agent got wrong is still something the user can
            read, quote back, and ask it to fix. */}
        <pre><code>{source}</code></pre>
      </div>
    )
  }

  return (
    <div className={styles.chart} ref={containerRef}>
      <div
        ref={chartRef}
        className={styles.canvas}
        style={{ minHeight: rendered ? undefined : DEFAULT_HEIGHT }}
        role="img"
      />
    </div>
  )
}
