import { Context, Effect, Layer } from "effect"
import * as fs from "node:fs/promises"
import * as path from "node:path"

/**
 * JSON files under the app's data directory. Everything the app remembers
 * lives here, on this machine.
 */
export class Storage extends Context.Service<Storage, {
  readonly root: string
  /** The parsed file, or `null` when it is missing or unreadable. */
  readJson(name: string): Effect.Effect<unknown>
  writeJson(name: string, value: unknown): Effect.Effect<void>
  remove(name: string): Effect.Effect<void>
  /** File names directly under a directory. Empty when it does not exist. */
  list(dir: string): Effect.Effect<ReadonlyArray<string>>
}>()("foc/main/Storage") {
  static readonly layer = (root: string) =>
    Layer.succeed(
      Storage,
      Storage.of({
        root,
        readJson: (name) =>
          Effect.promise(() =>
            fs.readFile(path.join(root, name), "utf8").then(
              (text) => {
                try {
                  return JSON.parse(text) as unknown
                } catch {
                  return null
                }
              },
              () => null
            )
          ),
        // Write beside the target and rename, so a crash never leaves half a file.
        writeJson: (name, value) =>
          Effect.promise(async () => {
            const target = path.join(root, name)
            const temp = `${target}.${process.pid}.tmp`
            await fs.mkdir(path.dirname(target), { recursive: true })
            await fs.writeFile(temp, JSON.stringify(value), "utf8")
            await fs.rename(temp, target)
          }).pipe(
            Effect.catchCause((cause) => Effect.logError("Could not write", name, cause))
          ),
        remove: (name) => Effect.promise(() => fs.rm(path.join(root, name), { force: true })),
        list: (dir) => Effect.promise(() => fs.readdir(path.join(root, dir)).catch(() => []))
      })
    )
}
