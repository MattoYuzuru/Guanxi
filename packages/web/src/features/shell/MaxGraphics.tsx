import { useEffect, useRef, useState } from 'react'
import { useOptionalAppearance } from '../../lib/appearance.tsx'

/**
 * Max graphics (D-206): one WebGL canvas behind the chrome with a slow, domain-warped gradient
 * field in the chrome and accent hues (never blue-violet, BRAND). Written for Guanxi; no shader
 * code is copied. Costs are bounded: half-resolution rendering, about 30 frames per second,
 * held still for a moment after any input so typing never competes with it, stopped while the
 * page is hidden, and not mounted at all under reduced motion, reduced
 * transparency, increased contrast, forced colours, battery saver, GPU compositing off or without
 * WebGL. Panes stay opaque, so no reading text ever sits on it; chrome text over it uses the
 * secondary tone (app-shell-chrome.css) and the field's strength is capped so that tone keeps
 * 4.5:1 over the field's brightest colour (asserted in max-graphics.test.tsx).
 */
const VERTEX = `attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }`
const FRAGMENT = `precision mediump float;
uniform vec2 res; uniform float time; uniform vec3 base; uniform vec3 accent; uniform vec3 soft; uniform float strength;
float hash(vec2 v) { return fract(sin(dot(v, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 v) {
  vec2 i = floor(v), f = fract(v), u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 v) { float sum = 0.0, amp = 0.5; for (int i = 0; i < 3; i++) { sum += amp * noise(v); v *= 2.02; amp *= 0.5; } return sum; }
void main() {
  vec2 uv = gl_FragCoord.xy / res;
  vec2 v = uv * vec2(res.x / res.y, 1.0) * 1.1;
  float t = time * 0.035;
  vec2 q = vec2(fbm(v + t), fbm(v + vec2(5.2, 1.3) - t));
  float f = fbm(v + 1.8 * q);
  vec3 color = mix(base, accent, smoothstep(0.3, 0.75, f) * strength);
  color = mix(color, soft, smoothstep(0.35, 0.7, q.x) * strength * 0.8);
  color += (hash(gl_FragCoord.xy + time) - 0.5) / 255.0;
  gl_FragColor = vec4(color, 1.0);
}`

/** Frames per second the field is drawn at; the motion is slow, so 30 looks continuous. */
export const MAX_GRAPHICS_FPS = 30
/** Fraction of the device pixel ratio the canvas renders at; CSS scales it up. */
export const MAX_GRAPHICS_SCALE = 0.5
/** Mix strength of the accent field over the chrome, per theme (contrast-tested). */
export const MAX_GRAPHICS_STRENGTH = { light: 0.26, dark: 0.3 } as const

/** The colour at the field's least-contrasting point, mirroring the fragment shader's mixing. */
export function worstFieldColor(base: number[], accent: number[], soft: number[], dark: boolean): number[] {
  const strength = MAX_GRAPHICS_STRENGTH[dark ? 'dark' : 'light']
  const mix = (a: number[], b: number[], t: number) => a.map((value, index) => value * (1 - t) + (b[index] ?? 0) * t)
  // Light theme: dark text loses contrast where the accent is strongest and the soft tone absent;
  // dark theme: light text loses contrast where both lift the chrome.
  return dark ? mix(mix(base, accent, strength), soft, strength * 0.8) : mix(base, accent, strength)
}

/** The field holds still this long after any key, pointer or wheel input, so input never waits on it. */
export const MAX_GRAPHICS_INPUT_QUIET_MS = 600

const QUERIES = ['(prefers-reduced-motion: reduce)', '(prefers-reduced-transparency: reduce)', '(prefers-contrast: more)', '(forced-colors: active)']

/** True when the user or the OS asked for less: then the static design is what they get. */
export function graphicsSuppressed(root: HTMLElement = document.documentElement): boolean {
  if (root.dataset.motion === 'reduced' || 'reduceTransparency' in root.dataset || 'batterySaver' in root.dataset
    || root.dataset.gpuCompositing === 'off' || root.dataset.theme?.endsWith('-hc')) return true
  // The OS preference always wins: an in-app "full" motion setting never overrides an OS that
  // asks for reduced motion, transparency or contrast (P3).
  return QUERIES.some(query => window.matchMedia?.(query).matches)
}

/** Reads a CSS colour variable as linear-ish RGB 0–1 by painting one pixel (works for oklch too). */
function cssColor(name: string): [number, number, number] {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || 'transparent'
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const context = canvas.getContext('2d')
  if (!context) return [0.94, 0.95, 0.97]
  context.fillStyle = value
  context.fillRect(0, 0, 1, 1)
  const [r = 0, g = 0, b = 0] = context.getImageData(0, 0, 1, 1).data
  return [r / 255, g / 255, b / 255]
}

export function MaxGraphics() {
  const appearance = useOptionalAppearance()
  const enabled = appearance?.graphics === 'max'
  const [suppressed, setSuppressed] = useState(() => typeof window === 'undefined' || graphicsSuppressed())
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // No WebGL, or a shader the driver refuses: the static design stays, and no canvas remains.
  const [unsupported, setUnsupported] = useState(false)
  // A lost context that the browser restores rebuilds the field on the same canvas.
  const [generation, setGeneration] = useState(0)
  const run = useRef(0)

  // Follow OS and in-app preferences live: reduced motion turns the layer off at once.
  useEffect(() => {
    const update = () => setSuppressed(graphicsSuppressed())
    const lists = QUERIES.map(query => window.matchMedia?.(query)).filter(Boolean) as MediaQueryList[]
    lists.forEach(list => list.addEventListener('change', update))
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion', 'data-theme', 'data-reduce-transparency', 'data-battery-saver', 'data-gpu-compositing'] })
    update()
    return () => { lists.forEach(list => list.removeEventListener('change', update)); observer.disconnect() }
  }, [])

  const active = enabled && !suppressed && !unsupported
  useEffect(() => {
    document.documentElement.toggleAttribute('data-graphics-active', active)
    return () => document.documentElement.removeAttribute('data-graphics-active')
  }, [active])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!active || !canvas) return
    const thisRun = ++run.current
    const gl = canvas.getContext('webgl', { antialias: false, alpha: false, depth: false, powerPreference: 'low-power', preserveDrawingBuffer: false })
    if (!gl) { setUnsupported(true); return }
    const shader = (type: number, source: string) => {
      const value = gl.createShader(type)!
      gl.shaderSource(value, source)
      gl.compileShader(value)
      return value
    }
    const program = gl.createProgram()!
    const shaders = [shader(gl.VERTEX_SHADER, VERTEX), shader(gl.FRAGMENT_SHADER, FRAGMENT)]
    for (const value of shaders) gl.attachShader(program, value)
    gl.linkProgram(program)
    // The linked program keeps what it needs; the shader objects are released at once.
    for (const value of shaders) { gl.detachShader(program, value); gl.deleteShader(value) }
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { gl.deleteProgram(program); setUnsupported(true); return }
    gl.useProgram(program)
    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const position = gl.getAttribLocation(program, 'p')
    gl.enableVertexAttribArray(position)
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
    const uniform = (name: string) => gl.getUniformLocation(program, name)
    const res = uniform('res'), time = uniform('time'), base = uniform('base'), accent = uniform('accent'), soft = uniform('soft'), strength = uniform('strength')

    const palette = () => {
      const dark = document.documentElement.classList.contains('dark') || document.documentElement.dataset.theme === 'dark'
      gl.uniform3fv(base, cssColor('--color-background-primary'))
      gl.uniform3fv(accent, cssColor('--color-background-accent'))
      gl.uniform3fv(soft, cssColor(dark ? '--color-background-pressed' : '--color-background-secondary'))
      gl.uniform1f(strength, MAX_GRAPHICS_STRENGTH[dark ? 'dark' : 'light'])
    }
    const resize = () => {
      const scale = Math.min(window.devicePixelRatio || 1, 2) * MAX_GRAPHICS_SCALE
      canvas.width = Math.max(1, Math.round(window.innerWidth * scale))
      canvas.height = Math.max(1, Math.round(window.innerHeight * scale))
      gl.viewport(0, 0, canvas.width, canvas.height)
      gl.uniform2f(res, canvas.width, canvas.height)
    }
    palette(); resize()
    const started = performance.now()
    let frame = 0, last = 0, quietUntil = 0
    const quiet = () => { quietUntil = performance.now() + MAX_GRAPHICS_INPUT_QUIET_MS }
    const draw = (now: number) => {
      frame = requestAnimationFrame(draw)
      if (now < quietUntil || now - last < 1000 / MAX_GRAPHICS_FPS) return
      last = now
      gl.uniform1f(time, (now - started) / 1000)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }
    const start = () => { cancelAnimationFrame(frame); if (document.visibilityState !== 'hidden') frame = requestAnimationFrame(draw) }
    const visibility = () => { if (document.visibilityState === 'hidden') cancelAnimationFrame(frame); else start() }
    // The GPU may drop the context (driver reset, memory pressure): stop drawing, ask the browser to
    // restore it, and rebuild once it is back. Until then the chrome shows its static colour.
    const lost = (event: Event) => { event.preventDefault(); cancelAnimationFrame(frame) }
    const restored = () => setGeneration(value => value + 1)
    canvas.addEventListener('webglcontextlost', lost)
    canvas.addEventListener('webglcontextrestored', restored)
    const themeObserver = new MutationObserver(palette)
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] })
    window.addEventListener('resize', resize)
    document.addEventListener('visibilitychange', visibility)
    for (const type of ['keydown', 'pointerdown', 'wheel'] as const) window.addEventListener(type, quiet, { capture: true, passive: true })
    start()
    return () => {
      cancelAnimationFrame(frame)
      themeObserver.disconnect()
      window.removeEventListener('resize', resize)
      document.removeEventListener('visibilitychange', visibility)
      for (const type of ['keydown', 'pointerdown', 'wheel'] as const) window.removeEventListener(type, quiet, { capture: true })
      canvas.removeEventListener('webglcontextlost', lost)
      canvas.removeEventListener('webglcontextrestored', restored)
      gl.deleteProgram(program)
      gl.deleteBuffer(buffer)
      // Release the GPU context on a real teardown. StrictMode re-runs this effect on the same
      // canvas at once, and a lost context cannot compile again, so the release waits a task and
      // is skipped when the effect has run again in the meantime.
      setTimeout(() => { if (run.current === thisRun) gl.getExtension('WEBGL_lose_context')?.loseContext() }, 0)
    }
  }, [active, generation])

  if (!active) return null
  return <canvas ref={canvasRef} aria-hidden="true" className="max-graphics" data-testid="max-graphics" />
}
