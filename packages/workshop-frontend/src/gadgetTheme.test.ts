import { describe, expect, it } from 'vitest'
import {
  GADGET_STYLESHEET,
  gadgetStyleTag,
  gadgetThemeRootAttributes,
  normalizeGadgetTheme,
} from '@gadgets/workshop-shared/gadget-theme'

// The stylesheet is injected under Gadgets that were written before it existed, so these invariants
// are what make that safe. They are asserted here rather than left to review because a single
// stray `!important` or unprefixed class would silently restyle Gadgets in the wild.
describe('GADGET_STYLESHEET invariants', () => {
  const reduceStart = GADGET_STYLESHEET.indexOf('@media (prefers-reduced-motion: reduce)')
  const printStart = GADGET_STYLESHEET.indexOf('@media print')

  it('places the reduced-motion block before the print block', () => {
    // The slicing below depends on this order; if the blocks move, the invariant tests would
    // silently stop covering anything.
    expect(reduceStart).toBeGreaterThan(0)
    expect(printStart).toBeGreaterThan(reduceStart)
  })

  it('uses !important only to honor prefers-reduced-motion', () => {
    const outsideReducedMotion =
      GADGET_STYLESHEET.slice(0, reduceStart) + GADGET_STYLESHEET.slice(printStart)
    expect(outsideReducedMotion).not.toContain('!important')
  })

  it('prefixes every class selector with g-, so it cannot collide with Gadget class names', () => {
    // Requiring a letter after the dot skips decimals like `0.5rem` and `oklch(0.245 …)`.
    const classNames = [...GADGET_STYLESHEET.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(m => m[1])
    expect(classNames.length).toBeGreaterThan(20)
    expect([...new Set(classNames.filter(name => !name.startsWith('g-')))]).toEqual([])
  })

  it('requests no external resources, which the sandbox CSP would block anyway', () => {
    expect(GADGET_STYLESHEET).not.toContain('@import')
    expect(GADGET_STYLESHEET).not.toContain('@font-face')
    expect(GADGET_STYLESHEET).not.toMatch(/url\(\s*['"]?(?:https?:)?\/\//)
  })

  it('defines the dark palette against the theme attribute', () => {
    expect(GADGET_STYLESHEET).toContain('[data-gadget-theme="dark"]')
  })
})

describe('gadgetStyleTag', () => {
  it('wraps the stylesheet in a style element', () => {
    const tag = gadgetStyleTag()
    expect(tag.startsWith('<style>')).toBe(true)
    expect(tag.endsWith('</style>')).toBe(true)
    // Nothing may close the element early, or the rest would be parsed as markup.
    expect(GADGET_STYLESHEET).not.toContain('</style')
  })
})

describe('gadgetThemeRootAttributes', () => {
  it('carries the resolved mode', () => {
    expect(gadgetThemeRootAttributes({ mode: 'dark', accentColor: null }))
      .toBe('data-gadget-theme="dark"')
    expect(gadgetThemeRootAttributes({ mode: 'light', accentColor: null }))
      .toBe('data-gadget-theme="light"')
  })

  it('passes a valid accent seed through as a custom property', () => {
    expect(gadgetThemeRootAttributes({ mode: 'light', accentColor: '#4f7cf7' }))
      .toBe('data-gadget-theme="light" style="--g-accent-seed:#4f7cf7"')
    expect(gadgetThemeRootAttributes({ mode: 'light', accentColor: '#abc' }))
      .toContain('--g-accent-seed:#abc')
  })

  // The seed lands inside a style attribute, where unvalidated text could close the declaration
  // and open another -- or close the attribute and add new ones.
  it('drops an accent seed that is not a plain hex color', () => {
    for (const hostile of [
      'red',
      '#4f7cf7; background:url(https://evil.example)',
      '" onload="alert(1)',
      '#zzzzzz',
      '#4f7cf',
      '',
    ]) {
      expect(gadgetThemeRootAttributes({ mode: 'light', accentColor: hostile }))
        .toBe('data-gadget-theme="light"')
    }
  })
})

describe('normalizeGadgetTheme', () => {
  it('normalizes an unusable accent seed away and defaults the mode to light', () => {
    expect(normalizeGadgetTheme({ mode: 'dark', accentColor: '#ABCDEF' }))
      .toEqual({ mode: 'dark', accentColor: '#ABCDEF' })
    expect(normalizeGadgetTheme({ mode: 'light', accentColor: 'chartreuse' }))
      .toEqual({ mode: 'light', accentColor: null })
    expect(normalizeGadgetTheme({ mode: 'sideways' as 'light', accentColor: null }))
      .toEqual({ mode: 'light', accentColor: null })
  })
})
