import { Context, Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { randomUUID } from "node:crypto"
import type { MemoryNote, Recap } from "../../shared/domain.ts"
import { Events } from "./Events.ts"

/** A note is something said in a breath, not a document. */
const MAX_NOTE = 300
const MAX_NOTES = 100
const MAX_RECAP = 1600

const tidy = (text: string, max: number) => {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

interface Row {
  readonly id: string
  readonly kind: string
  readonly text: string
  readonly created_at: number
}

/**
 * What the app carries from one conversation to the next: the things the
 * person asked it to remember, and how the last conversation ended. Both live
 * in the database on this machine and nowhere else.
 */
export class Memory extends Context.Service<Memory, {
  /** What the person asked to have remembered, oldest first. */
  readonly list: Effect.Effect<ReadonlyArray<MemoryNote>>
  /** Remembers something. Saying the same thing twice keeps one note. */
  add(text: string): Effect.Effect<MemoryNote>
  remove(id: string): Effect.Effect<void>
  /** The end of the last conversation, or `null` when there was none. */
  readonly recap: Effect.Effect<Recap | null>
  setRecap(text: string): Effect.Effect<void>
}>()("fai/main/Memory") {
  static readonly layer = Layer.effect(
    Memory,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const events = yield* Events
      const rows = yield* sql<Row>`SELECT id, kind, text, created_at FROM memories ORDER BY created_at`.pipe(Effect.orDie)
      let notes: Array<MemoryNote> = rows
        .filter((row) => row.kind === "note")
        .map((row) => ({ id: row.id, text: row.text, createdAt: row.created_at }))
      const last = rows.findLast((row) => row.kind === "recap")
      let recap: Recap | null = last === undefined ? null : { text: last.text, at: last.created_at }

      const logged = <A>(what: string, effect: Effect.Effect<A, unknown>) =>
        Effect.catchCause(effect, (cause) => Effect.logError(what, cause))
      const changed = () => events.publish({ _tag: "Memories", memories: notes })

      return Memory.of({
        list: Effect.sync(() => notes),
        add: Effect.fn("Memory.add")(function*(text) {
          const line = tidy(text, MAX_NOTE)
          const same = notes.find((note) => note.text.toLowerCase() === line.toLowerCase())
          if (same !== undefined) return same
          const note: MemoryNote = { id: randomUUID(), text: line, createdAt: Date.now() }
          // The oldest notes make room once there are more than anyone could say aloud.
          const dropped = notes.length >= MAX_NOTES ? notes.slice(0, notes.length - MAX_NOTES + 1) : []
          notes = [...notes.slice(dropped.length), note]
          yield* logged(
            "Could not save a memory",
            sql.withTransaction(Effect.gen(function*() {
              for (const old of dropped) yield* sql`DELETE FROM memories WHERE id = ${old.id}`
              yield* sql`INSERT INTO memories ${
                sql.insert({ id: note.id, kind: "note", text: note.text, created_at: note.createdAt })
              }`
            }))
          )
          changed()
          return note
        }),
        remove: Effect.fn("Memory.remove")(function*(id) {
          if (!notes.some((note) => note.id === id)) return
          notes = notes.filter((note) => note.id !== id)
          yield* logged("Could not delete a memory", sql`DELETE FROM memories WHERE id = ${id}`)
          changed()
        }),
        recap: Effect.sync(() => recap),
        setRecap: Effect.fn("Memory.setRecap")(function*(text) {
          const line = text.trim().slice(-MAX_RECAP)
          if (line === "") return
          recap = { text: line, at: Date.now() }
          const next = recap
          yield* logged(
            "Could not save the conversation's recap",
            sql.withTransaction(Effect.gen(function*() {
              yield* sql`DELETE FROM memories WHERE kind = 'recap'`
              yield* sql`INSERT INTO memories ${
                sql.insert({ id: randomUUID(), kind: "recap", text: next.text, created_at: next.at })
              }`
            }))
          )
        })
      })
    })
  )
}
