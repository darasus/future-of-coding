import { desktopCapturer, nativeImage, screen, systemPreferences } from "electron"
import * as fs from "node:fs/promises"

/** A picture of the screen, small enough to hand to an agent with a message. */
export interface Shot {
  readonly mediaType: "image/jpeg"
  /** The picture, base64 encoded. */
  readonly data: string
}

/** The longest side of the picture an agent is given. Text stays readable at this size. */
const LONG_EDGE = 1568
const QUALITY = 82

const NOT_ALLOWED =
  "This app is not allowed to see the screen yet. Allow it in System Settings, Privacy & Security, " +
  "Screen & System Audio Recording, then quit and reopen the app."

const shrink = (image: Electron.NativeImage): Shot => {
  const { height, width } = image.getSize()
  const scale = Math.min(1, LONG_EDGE / Math.max(width, height))
  const sized = scale < 1 ? image.resize({ width: Math.round(width * scale), quality: "best" }) : image
  return { mediaType: "image/jpeg", data: sized.toJPEG(QUALITY).toString("base64") }
}

/**
 * Takes a picture of the display the pointer is on, which is the one the
 * person is looking at when they say "look at this". Rejects with a sentence
 * that can be read to them when macOS has not been told to allow it.
 *
 * `FAI_SCREEN_FIXTURE` names an image to use in place of the screen, for
 * trying this without the permission.
 */
export const captureScreen = async (): Promise<Shot> => {
  const fixture = process.env.FAI_SCREEN_FIXTURE
  if (fixture !== undefined && fixture !== "") {
    const image = nativeImage.createFromBuffer(await fs.readFile(fixture))
    if (image.isEmpty()) throw new Error(`${fixture} is not an image.`)
    return shrink(image)
  }
  const allowed = process.platform !== "darwin" || systemPreferences.getMediaAccessStatus("screen") === "granted"
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const width = display.size.width * display.scaleFactor
  const height = display.size.height * display.scaleFactor
  const scale = Math.min(1, LONG_EDGE / Math.max(width, height))
  // Asking is what makes macOS show its own request the first time, so it is
  // asked even when the answer cannot be used yet.
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) }
  }).catch(() => [])
  if (!allowed) throw new Error(NOT_ALLOWED)
  const source = sources.find((candidate) => candidate.display_id === String(display.id)) ?? sources[0]
  if (source === undefined || source.thumbnail.isEmpty()) throw new Error(NOT_ALLOWED)
  return shrink(source.thumbnail)
}
