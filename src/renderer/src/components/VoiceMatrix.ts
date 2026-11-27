import { Mount } from "@effect/ui"
import { Effect, Schema, Stream } from "effect"
import { type Spectrum, VoiceClient } from "../voice/VoiceClient.ts"

const State = Schema.Literals(["off", "connecting", "live"])
type State = typeof State.Type

/** One lamp of the matrix and the gap beside it, in CSS pixels. */
const LAMP = 4
const PITCH = 6

/** The range of pitch shown, from the centre of the display out to its edges. */
const LOW_HZ = 90
const HIGH_HZ = 5000

const clamp = (value: number) => Math.min(1, Math.max(0, value))

/**
 * How loud one slice of pitch is, from 0 to 1. `from` and `to` are positions
 * between the lowest and highest pitch shown, on a scale where each step up is
 * the same musical distance, which is how a voice is heard.
 */
const bandLevel = (bands: Uint8Array | null, binHz: number, from: number, to: number): number => {
  if (bands === null || binHz === 0) return 0
  const hz = (position: number) => LOW_HZ * Math.pow(HIGH_HZ / LOW_HZ, position)
  const first = Math.floor(hz(from) / binHz)
  const last = Math.min(bands.length - 1, Math.max(first, Math.floor(hz(to) / binHz)))
  let sum = 0
  for (let bin = first; bin <= last; bin++) sum += bands[bin] ?? 0
  const average = sum / (last - first + 1) / 255
  // Room noise sits at the bottom of the scale. Above it the curve is steep,
  // so the pitches a voice is actually on stand well clear of the rest.
  return clamp(Math.pow(clamp((average - 0.24) / 0.6), 1.5))
}

/**
 * Runs a dot-matrix display on a canvas until the returned function is called.
 *
 * Idle, a slow wave drifts along the middle row. While a session connects, a
 * pulse sweeps across. Live, each column is a slice of pitch, low in the
 * centre and high at the edges, and it stands as tall as that pitch is loud:
 * your voice in the text colour, the assistant's in the accent. The lamp at
 * the top of each column hangs for a moment after the sound drops.
 */
const runMatrix = (canvas: HTMLCanvasElement, state: () => State, read: () => Spectrum): () => void => {
  const context = canvas.getContext("2d")
  if (context === null) return () => undefined

  const styles = getComputedStyle(canvas)
  const mine = styles.getPropertyValue("--text").trim() || "#eceef4"
  const theirs = styles.getPropertyValue("--blue").trim() || "#4f8dff"
  const still = matchMedia("(prefers-reduced-motion: reduce)")

  let columns = 0
  let rows = 0
  let levels = new Float32Array(0)
  let peaks = new Float32Array(0)
  /** 0 where the column last showed your voice, 1 where it showed the assistant's. */
  let speaker = new Uint8Array(0)

  const resize = () => {
    const ratio = window.devicePixelRatio || 1
    canvas.width = Math.round(canvas.clientWidth * ratio)
    canvas.height = Math.round(canvas.clientHeight * ratio)
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    const fit = (size: number) => Math.max(1, Math.floor((size + PITCH - LAMP) / PITCH))
    const nextColumns = fit(canvas.clientWidth)
    // An odd number of rows, so there is a middle one to grow from.
    rows = fit(canvas.clientHeight)
    if (rows % 2 === 0) rows -= 1
    if (nextColumns !== columns) {
      columns = nextColumns
      levels = new Float32Array(columns)
      peaks = new Float32Array(columns)
      speaker = new Uint8Array(columns)
    }
  }

  const draw = (time: number, mode: State) => {
    const width = canvas.clientWidth
    const height = canvas.clientHeight
    context.clearRect(0, 0, width, height)
    if (columns === 0 || rows <= 0) return

    const left = (width - (columns * PITCH - (PITCH - LAMP))) / 2
    const top = (height - (rows * PITCH - (PITCH - LAMP))) / 2
    const half = (rows - 1) / 2
    const centre = (columns - 1) / 2
    const spectrum = mode === "live" ? read() : null
    const drift = still.matches ? 0 : time

    for (let column = 0; column < columns; column++) {
      const fromCentre = centre === 0 ? 0 : Math.abs(column - centre) / centre
      let target = 0
      if (spectrum !== null) {
        const step = centre === 0 ? 1 : 1 / centre
        const yours = bandLevel(spectrum.input, spectrum.binHz, fromCentre, fromCentre + step)
        const reply = bandLevel(spectrum.output, spectrum.binHz, fromCentre, fromCentre + step)
        target = Math.max(yours, reply)
        if (target > 0.05) {
          speaker[column] = reply > yours ? 1 : 0
        } else if ((levels[column] ?? 0) < 0.03) {
          // Silence belongs to nobody: the resting line goes back to neutral.
          speaker[column] = 0
        }
      } else if (mode === "connecting") {
        const head = (drift / 1100) % 1
        const position = columns === 1 ? 0 : column / (columns - 1)
        const distance = Math.abs(position - head)
        target = clamp(1 - Math.min(distance, 1 - distance) * 8) * 0.75
        speaker[column] = 1
      } else {
        target = 0.1 + 0.1 * Math.sin(column * 0.38 + drift * 0.0011) + 0.06 * Math.sin(column * 0.13 - drift * 0.0017)
        speaker[column] = 0
      }

      // Sound arrives at once and leaves slowly, as it does on a real meter.
      const current = levels[column] ?? 0
      const level = current + (target - current) * (target > current ? 0.6 : 0.14)
      levels[column] = level
      const peak = Math.max(level, (peaks[column] ?? 0) - 0.014)
      peaks[column] = peak

      const lit = Math.round(level * half)
      const hung = Math.round(peak * half)
      const colour = speaker[column] === 1 ? theirs : mine
      const x = left + column * PITCH
      for (let row = 0; row < rows; row++) {
        const distance = Math.abs(row - half)
        let alpha = 0.055
        if (distance <= lit) {
          // Brightest in the middle, dimmer toward the tip.
          alpha = mode === "off" ? 0.3 : 1 - (distance / (half + 1)) * 0.55
        } else if (mode === "live" && distance === hung && hung > lit) {
          alpha = 0.5
        }
        context.globalAlpha = alpha
        context.fillStyle = alpha <= 0.055 ? mine : colour
        context.fillRect(x, top + row * PITCH, LAMP, LAMP)
      }
    }
    context.globalAlpha = 1
  }

  const observer = new ResizeObserver(resize)
  observer.observe(canvas)
  resize()

  let frame = 0
  let request = 0
  const tick = (time: number) => {
    request = requestAnimationFrame(tick)
    const mode = state()
    // Only a live session needs every frame; the idle wave is slow.
    if (mode !== "live" && frame++ % 2 !== 0) return
    draw(time, mode)
  }
  request = requestAnimationFrame(tick)

  return () => {
    cancelAnimationFrame(request)
    observer.disconnect()
  }
}

/**
 * Draws the voice display on a canvas for as long as it is on screen. The
 * display follows `state` and, while a session is live, the sound of both
 * voices, read from `VoiceClient` every frame.
 */
export const DrawVoice = Mount.makeStream(
  "DrawVoice",
  { args: { state: State } },
  (node: HTMLCanvasElement, args, changes) =>
    Stream.unwrap(
      Effect.gen(function*() {
        const voice = yield* VoiceClient
        let state: State = args.state
        yield* Effect.acquireRelease(
          Effect.sync(() => runMatrix(node, () => state, voice.spectrum)),
          (stop) => Effect.sync(stop)
        )
        return changes.pipe(
          Stream.tap((next) =>
            Effect.sync(() => {
              state = next.state
            })
          ),
          Stream.drain
        )
      })
    )
)
