import { Context, Effect, Layer, Option, Predicate, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { Thread } from "../../shared/domain.ts"

/** What was last written for a thread, so a save only touches what changed. */
interface Written {
  row: string
  readonly items: Array<string>
  artifacts: string
  todos: string
}

const decodeThread = Schema.decodeUnknownOption(Thread)

const parse = (text: unknown): unknown => {
  try {
    return Predicate.isString(text) ? JSON.parse(text) : null
  } catch {
    return null
  }
}

/**
 * Writes a thread in one transaction. The thread's own row, each transcript
 * item, the artifact list and the task list are compared with `last` and only
 * rewritten when they differ, so saving a long thread mid-turn costs one or
 * two rows. Returns what is now in the database.
 */
export const writeThread = Effect.fnUntraced(function*(thread: Thread, last?: Written) {
  const sql = yield* SqlClient.SqlClient
  const row = {
    id: thread.id,
    title: thread.title,
    cwd: thread.cwd,
    status: thread.status,
    model: thread.model,
    permission_mode: thread.permissionMode,
    session_id: thread.sessionId,
    created_at: thread.createdAt,
    updated_at: thread.updatedAt,
    turns: thread.stats.turns,
    cost_usd: thread.stats.costUsd,
    duration_ms: thread.stats.durationMs
  }
  const next: Written = {
    row: JSON.stringify(row),
    items: thread.items.map((item) => JSON.stringify(item)),
    artifacts: JSON.stringify(thread.artifacts),
    todos: JSON.stringify(thread.todos)
  }

  yield* sql.withTransaction(Effect.gen(function*() {
    if (next.row !== last?.row) yield* sql`INSERT OR REPLACE INTO threads ${sql.insert(row)}`

    for (const [position, body] of next.items.entries()) {
      if (body === last?.items[position]) continue
      const item = thread.items[position]!
      yield* sql`INSERT OR REPLACE INTO items ${
        sql.insert({ thread_id: thread.id, position, id: item.id, tag: item._tag, at: item.at, body })
      }`
    }
    if (last !== undefined && last.items.length > next.items.length) {
      yield* sql`DELETE FROM items WHERE thread_id = ${thread.id} AND position >= ${next.items.length}`
    }

    if (next.artifacts !== last?.artifacts) {
      yield* sql`DELETE FROM artifacts WHERE thread_id = ${thread.id}`
      for (const [position, artifact] of thread.artifacts.entries()) {
        yield* sql`INSERT INTO artifacts ${
          sql.insert({
            thread_id: thread.id,
            position,
            id: artifact.id,
            path: artifact.path,
            rel_path: artifact.relPath,
            kind: artifact.kind,
            edits: artifact.edits,
            updated_at: artifact.updatedAt
          })
        }`
      }
    }

    if (next.todos !== last?.todos) {
      yield* sql`DELETE FROM todos WHERE thread_id = ${thread.id}`
      for (const [position, todo] of thread.todos.entries()) {
        yield* sql`INSERT INTO todos ${
          sql.insert({
            thread_id: thread.id,
            position,
            id: todo.id,
            content: todo.content,
            active_form: todo.activeForm,
            status: todo.status
          })
        }`
      }
    }
  }))
  return next
})

/** Threads and their transcripts, artifacts and task lists, kept in SQLite. */
export class ThreadStore extends Context.Service<ThreadStore, {
  /** Every saved thread. Rows that no longer fit the schema are left out. */
  readonly all: Effect.Effect<ReadonlyArray<Thread>>
  save(thread: Thread): Effect.Effect<void>
  remove(id: string): Effect.Effect<void>
}>()("fai/main/ThreadStore") {
  static readonly layer = Layer.effect(
    ThreadStore,
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const written = new Map<string, Written>()

      const group = <A extends { readonly thread_id: string }>(rows: ReadonlyArray<A>) => {
        const byThread = new Map<string, Array<A>>()
        for (const row of rows) {
          const list = byThread.get(row.thread_id)
          if (list) list.push(row)
          else byThread.set(row.thread_id, [row])
        }
        return byThread
      }

      const all = Effect.gen(function*() {
        const threads = yield* sql<Record<string, unknown> & { readonly id: string }>`SELECT * FROM threads`
        const items = group(
          yield* sql<{ readonly thread_id: string; readonly body: string }>`
            SELECT thread_id, body FROM items ORDER BY thread_id, position
          `
        )
        const artifacts = group(
          yield* sql<Record<string, unknown> & { readonly thread_id: string }>`
            SELECT * FROM artifacts ORDER BY thread_id, position
          `
        )
        const todos = group(
          yield* sql<Record<string, unknown> & { readonly thread_id: string }>`
            SELECT * FROM todos ORDER BY thread_id, position
          `
        )
        return threads.flatMap((row) => {
          const decoded = decodeThread({
            id: row.id,
            title: row.title,
            cwd: row.cwd,
            status: row.status,
            model: row.model,
            permissionMode: row.permission_mode,
            sessionId: row.session_id,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            stats: { turns: row.turns, costUsd: row.cost_usd, durationMs: row.duration_ms },
            artifacts: (artifacts.get(row.id) ?? []).map((artifact) => ({
              id: artifact.id,
              path: artifact.path,
              relPath: artifact.rel_path,
              kind: artifact.kind,
              edits: artifact.edits,
              updatedAt: artifact.updated_at
            })),
            todos: (todos.get(row.id) ?? []).map((todo) => ({
              id: todo.id,
              content: todo.content,
              activeForm: todo.active_form,
              status: todo.status
            })),
            items: (items.get(row.id) ?? []).map((item) => parse(item.body))
          })
          return Option.isSome(decoded) ? [decoded.value] : []
        })
      }).pipe(Effect.orDie)

      return ThreadStore.of({
        all,
        save: (thread) =>
          writeThread(thread, written.get(thread.id)).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.map((next) => {
              written.set(thread.id, next)
            }),
            Effect.catchCause((cause) => Effect.logError("Could not save thread", thread.id, cause))
          ),
        remove: (id) =>
          sql.withTransaction(Effect.gen(function*() {
            yield* sql`DELETE FROM items WHERE thread_id = ${id}`
            yield* sql`DELETE FROM artifacts WHERE thread_id = ${id}`
            yield* sql`DELETE FROM todos WHERE thread_id = ${id}`
            yield* sql`DELETE FROM threads WHERE id = ${id}`
          })).pipe(
            Effect.ensuring(Effect.sync(() => written.delete(id))),
            Effect.catchCause((cause) => Effect.logError("Could not delete thread", id, cause))
          )
      })
    })
  )
}
