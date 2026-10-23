/** D-206: Max graphics keeps chrome text readable and steps aside whenever the user asks for less. */
import Color from 'colorjs.io'
import { act, render, screen } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { APPEARANCE_KEY, AppearanceProvider } from '../../src/lib/appearance.tsx'
import flat from '../../../ui/generated/tokens.flat.json'
import { graphicsSuppressed, MAX_GRAPHICS_STRENGTH, MaxGraphics, worstFieldColor } from '../../src/features/shell/MaxGraphics.tsx'

const tokens = flat as Record<string, Array<{ name: string; $value: { hex?: string } }>>
const hex = (context: string, name: string) => tokens[context]!.find(token => token.name === name)!.$value.hex!
const rgb = (value: string) => [1, 3, 5].map(index => parseInt(value.slice(index, index + 2), 16) / 255)
const toHex = (value: number[]) => `#${value.map(channel => Math.round(channel * 255).toString(16).padStart(2, '0')).join('')}`
const contrast = (a: string, b: string) => new Color(a).contrast(new Color(b), 'WCAG21')

describe('Max graphics contrast', () => {
  for (const [context, dark] of [['light/compact/full', false], ['dark/compact/full', true]] as const) {
    it(`keeps secondary chrome text at 4.5:1 and primary at 7:1 over the field's worst colour (${context})`, () => {
      const field = toHex(worstFieldColor(rgb(hex(context, 'color.background.primary')), rgb(hex(context, 'color.background.accent')),
        rgb(hex(context, dark ? 'color.background.pressed' : 'color.background.secondary')), dark))
      expect(contrast(hex(context, 'color.text.secondary'), field)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(hex(context, 'color.text.primary'), field)).toBeGreaterThanOrEqual(7)
    })
  }
  it('fails the check when the strength is pushed too far (the assertion can fail)', () => {
    const base = rgb(hex('light/compact/full', 'color.background.primary')), accent = rgb(hex('light/compact/full', 'color.background.accent'))
    const tooStrong = toHex(base.map((value, index) => value * 0.4 + accent[index]! * 0.6))
    expect(contrast(hex('light/compact/full', 'color.text.secondary'), tooStrong)).toBeLessThan(4.5)
    expect(MAX_GRAPHICS_STRENGTH.light).toBeLessThan(0.6)
  })
})

describe('graphicsSuppressed', () => {
  it('steps aside for in-app reduced motion, reduced transparency, battery saver, GPU off and high contrast', () => {
    const cases: Array<[string, string]> = [['motion', 'reduced'], ['reduceTransparency', ''], ['batterySaver', ''], ['gpuCompositing', 'off'], ['theme', 'dark-hc']]
    for (const [key, value] of cases) {
      const root = document.createElement('div')
      root.dataset[key] = value
      expect(graphicsSuppressed(root), key).toBe(true)
    }
    expect(graphicsSuppressed(document.createElement('div'))).toBe(false)
  })
})

function setMatchMedia(matches: (query: string) => boolean) {
  Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true,
    value: (query: string) => ({ matches: matches(query), media: query, addEventListener() {}, removeEventListener() {} }) })
}

describe('graphicsSuppressed and the OS', () => {
  it('the OS reduced-motion preference always wins, even over the in-app "full" motion setting (P3)', () => {
    setMatchMedia(query => query === '(prefers-reduced-motion: reduce)')
    const root = document.createElement('div')
    root.dataset.motion = 'full'
    expect(graphicsSuppressed(root)).toBe(true)
    setMatchMedia(() => false)
    expect(graphicsSuppressed(root)).toBe(false)
  })
})

describe('WebGL lifecycle (P3)', () => {
  function fakeGl() {
    const calls: string[] = []
    const lose = vi.fn(() => { calls.push('loseContext') })
    let id = 0
    const gl = new Proxy({
      VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, ARRAY_BUFFER: 3, STATIC_DRAW: 4, FLOAT: 5, TRIANGLES: 6, LINK_STATUS: 7,
      getProgramParameter: () => true,
      getExtension: (name: string) => name === 'WEBGL_lose_context' ? { loseContext: lose } : null,
      getAttribLocation: () => 0, getUniformLocation: () => ({}),
      createShader: () => ({ shader: ++id }), createProgram: () => { calls.push('createProgram'); return { program: ++id } }, createBuffer: () => ({}),
    } as Record<string, unknown>, { get: (target, key: string) => key in target ? target[key] : (...args: unknown[]) => { calls.push(key); void args } })
    return { gl, calls, lose }
  }
  function install() {
    const fake = fakeGl()
    const values = new Map([[APPEARANCE_KEY, JSON.stringify({ density: 'comfortable', graphics: 'max', motion: 'system' })]])
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: () => {} })
    setMatchMedia(() => false)
    let frames = 0
    vi.stubGlobal('requestAnimationFrame', () => ++frames)
    vi.stubGlobal('cancelAnimationFrame', () => { fake.calls.push('cancelAnimationFrame') })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement, kind: string) {
      if (kind === '2d') return { fillRect() {}, getImageData: () => ({ data: [240, 243, 248, 255] }), set fillStyle(_value: string) {} } as never
      return fake.gl as never
    })
    return fake
  }
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('deletes its shaders after linking, survives a lost context and releases the context on teardown, also under StrictMode', async () => {
    const fake = install()
    const view = render(<StrictMode><AppearanceProvider><MaxGraphics /></AppearanceProvider></StrictMode>)
    const canvas = await screen.findByTestId('max-graphics')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(fake.calls.filter(call => call === 'deleteShader').length).toBeGreaterThanOrEqual(2)
    // StrictMode re-runs the effect on the same canvas: the context must not be lost in between.
    expect(fake.lose).not.toHaveBeenCalled()
    const lost = new Event('webglcontextlost', { cancelable: true })
    act(() => { canvas.dispatchEvent(lost) })
    expect(lost.defaultPrevented).toBe(true)
    const programs = fake.calls.filter(call => call === 'createProgram').length
    await act(async () => { canvas.dispatchEvent(new Event('webglcontextrestored')) })
    expect(fake.calls.filter(call => call === 'createProgram').length).toBe(programs + 1)
    view.unmount()
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(fake.lose).toHaveBeenCalledTimes(1)
  })
})
