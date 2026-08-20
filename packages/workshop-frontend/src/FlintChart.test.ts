import { describe, expect, it } from 'vitest'
import { parseFlintBlock } from './FlintChart'

// The distinction that matters most here: chat messages stream, so a ```flint block is unparseable
// JSON for as long as it is still arriving. Treating that as an error would flash a failure under
// every chart the agent writes, so `incomplete` must stay separate from `invalid`.
describe('parseFlintBlock streaming behavior', () => {
  const complete = JSON.stringify({
    data: { values: [{ a: 'x', b: 1 }] },
    semantic_types: { a: 'Category', b: 'Count' },
    chart_spec: { chartType: 'Bar Chart', encodings: { x: { field: 'a' }, y: { field: 'b' } } },
  })

  it('accepts a complete spec', () => {
    const result = parseFlintBlock(complete)
    expect(result.status).toBe('ok')
  })

  it('reports every truncation of a valid spec as incomplete, never invalid', () => {
    // Every prefix stands in for a moment mid-stream. None may report an error.
    for (let length = 1; length < complete.length; length++) {
      const status = parseFlintBlock(complete.slice(0, length)).status
      expect(status, `prefix of length ${length} should not be invalid`).not.toBe('invalid')
    }
  })

  it('treats an empty or whitespace block as incomplete', () => {
    expect(parseFlintBlock('').status).toBe('incomplete')
    expect(parseFlintBlock('   \n  ').status).toBe('incomplete')
  })

  it('reports balanced-but-broken JSON as invalid', () => {
    // Every brace and bracket is closed, so nothing more is coming: the trailing comma makes this
    // genuinely wrong rather than mid-stream.
    expect(parseFlintBlock('{"data": {"values": [1,2,]}}').status).toBe('invalid')
    expect(parseFlintBlock('{"chart_spec": {,}}').status).toBe('invalid')
  })

  it('is not fooled by braces inside strings', () => {
    const result = parseFlintBlock('{"title": "a { brace"')
    expect(result.status).toBe('incomplete')
  })
})

describe('parseFlintBlock validation', () => {
  const base = {
    data: { values: [{ a: 'x', b: 1 }] },
    chart_spec: { chartType: 'Bar Chart', encodings: { x: { field: 'a' } } },
  }
  const parse = (input: unknown) => parseFlintBlock(JSON.stringify(input))

  it('rejects non-objects', () => {
    expect(parse([1, 2]).status).toBe('invalid')
    expect(parse('a string').status).toBe('invalid')
    expect(parse(42).status).toBe('invalid')
  })

  it('requires inline rows, a chart type, and encodings', () => {
    expect(parse({ ...base, data: {} }).status).toBe('invalid')
    expect(parse({ ...base, data: { values: [] } }).status).toBe('invalid')
    expect(parse({ ...base, chart_spec: { encodings: {} } }).status).toBe('invalid')
    expect(parse({ ...base, chart_spec: { chartType: 'Bar Chart' } }).status).toBe('invalid')
  })

  it('drops a data url so rendering can never trigger a fetch', () => {
    const result = parseFlintBlock(JSON.stringify({
      ...base,
      data: { values: [{ a: 'x', b: 1 }], url: 'https://example.invalid/data.json' },
    }))
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.input.data).toEqual({ values: [{ a: 'x', b: 1 }] })
  })

  it('caps row count so a runaway table cannot jank the conversation', () => {
    const values = Array.from({ length: 9000 }, (_, index) => ({ a: `x${index}`, b: index }))
    const result = parseFlintBlock(JSON.stringify({ ...base, data: { values } }))
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect((result.input.data as { values: unknown[] }).values).toHaveLength(4000)
  })
})
