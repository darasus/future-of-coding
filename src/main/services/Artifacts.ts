import { Context, Effect, Layer } from "effect"
import { shell } from "electron"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { ArtifactContent } from "../../shared/domain.ts"
import { Threads } from "./Threads.ts"

const MAX_TEXT_BYTES = 400_000
const MAX_IMAGE_BYTES = 8_000_000

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml"
}

const missing = (file: string): ArtifactContent => ({
  path: file,
  format: "missing",
  text: "",
  dataUrl: null,
  truncated: false,
  bytes: 0
})

/**
 * Reads the files a thread produced. Only a path the thread recorded as an
 * artifact can be read, so the renderer cannot ask for arbitrary files.
 */
export class Artifacts extends Context.Service<Artifacts, {
  read(threadId: string, artifactId: string): Effect.Effect<ArtifactContent>
  reveal(threadId: string, artifactId: string): Effect.Effect<void>
}>()("fai/main/Artifacts") {
  static readonly layer = Layer.effect(
    Artifacts,
    Effect.gen(function*() {
      const threads = yield* Threads

      const read = Effect.fn("Artifacts.read")(function*(threadId: string, artifactId: string) {
        const artifact = yield* threads.artifact(threadId, artifactId)
        if (artifact === null) return missing("")
        const file = artifact.path
        return yield* Effect.promise(async (): Promise<ArtifactContent> => {
          const stat = await fs.stat(file).catch(() => null)
          if (stat === null || !stat.isFile()) return missing(file)
          const extension = path.extname(file).toLowerCase()
          const imageType = IMAGE_TYPES[extension]
          if (imageType !== undefined) {
            if (stat.size > MAX_IMAGE_BYTES) {
              return { path: file, format: "binary", text: "", dataUrl: null, truncated: true, bytes: stat.size }
            }
            const data = await fs.readFile(file)
            return {
              path: file,
              format: "image",
              text: extension === ".svg" ? data.toString("utf8") : "",
              dataUrl: `data:${imageType};base64,${data.toString("base64")}`,
              truncated: false,
              bytes: stat.size
            }
          }
          const handle = await fs.open(file, "r")
          try {
            const buffer = Buffer.alloc(Math.min(stat.size, MAX_TEXT_BYTES))
            await handle.read(buffer, 0, buffer.length, 0)
            if (buffer.includes(0)) {
              return { path: file, format: "binary", text: "", dataUrl: null, truncated: false, bytes: stat.size }
            }
            return {
              path: file,
              format: extension === ".html" || extension === ".htm" ? "html" : "text",
              text: buffer.toString("utf8"),
              dataUrl: null,
              truncated: stat.size > MAX_TEXT_BYTES,
              bytes: stat.size
            }
          } finally {
            await handle.close()
          }
        }).pipe(Effect.catchCause(() => Effect.succeed(missing(file))))
      })

      return Artifacts.of({
        read,
        reveal: (threadId, artifactId) =>
          Effect.gen(function*() {
            const artifact = yield* threads.artifact(threadId, artifactId)
            if (artifact !== null) shell.showItemInFolder(artifact.path)
          })
      })
    })
  )
}
