import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"
import { Effect, Layer, Option, Predicate, Schema } from "effect"
import { SqlClient } from "effect/sql"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { Thread } from "../../shared/domain.ts"
import { writeThread } from "./ThreadStore.ts"

/** The database file, inside the app's data directory. */
export const DATABASE_FILE = "future-of-ai-interface.db"

const createTables = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      cwd TEXT NOT NULL,
      status TEXT NOT NULL,
      model TEXT,
      permission_mode TEXT NOT NULL,
      session_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      turns INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0
    )
  `
  // One row per transcript entry, in order. `body` is the entry as JSON; the
  // columns beside it are there to query by.
  yield* sql`
    CREATE TABLE items (
      thread_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      id TEXT NOT NULL,
      tag TEXT NOT NULL,
      at INTEGER NOT NULL,
      body TEXT NOT NULL,
      PRIMARY KEY (thread_id, position)
    )
  `
  yield* sql`
    CREATE TABLE artifacts (
      thread_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      id TEXT NOT NULL,
      path TEXT NOT NULL,
      rel_path TEXT NOT NULL,
      kind TEXT NOT NULL,
      edits INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (thread_id, position)
    )
  `
  yield* sql`
    CREATE TABLE todos (
      thread_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      id TEXT NOT NULL,
      content TEXT NOT NULL,
      active_form TEXT NOT NULL,
      status TEXT NOT NULL,
      PRIMARY KEY (thread_id, position)
    )
  `
  // Each setting is a row; `value` is JSON.
  yield* sql`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`
})

/** What the assistant was asked to remember (`note`) and how the last conversation ended (`recap`). */
const createMemories = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `
})

const readJson = (file: string) =>
  Effect.promise(() =>
    fs.readFile(file, "utf8").then(
      (text) => {
        try {
          return JSON.parse(text) as unknown
        } catch {
          return null
        }
      },
      () => null
    )
  )

/**
 * Earlier versions kept `settings.json` and one `threads/<id>.json` per thread.
 * This copies them into the database once. The files are left where they are.
 */
const importJsonFiles = (root: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const decodeThread = Schema.decodeUnknownOption(Thread)
    const files = yield* Effect.promise(() => fs.readdir(path.join(root, "threads")).catch(() => []))
    for (const file of files) {
      if (!file.endsWith(".json")) continue
      const raw = yield* readJson(path.join(root, "threads", file))
      // Threads saved before task lists existed simply have none.
      const thread = decodeThread(Predicate.isObject(raw) ? { todos: [], ...raw } : raw)
      if (Option.isSome(thread)) yield* writeThread(thread.value)
    }
    const settings = yield* readJson(path.join(root, "settings.json"))
    if (Predicate.isObject(settings)) {
      for (const [key, value] of Object.entries(settings)) {
        yield* sql`INSERT OR REPLACE INTO settings ${sql.insert({ key, value: JSON.stringify(value) })}`
      }
    }
  })

/**
 * The app's SQLite database, under `root`, with its tables in place. Everything
 * the app remembers lives in this one file, on this machine.
 */
export const layer = (root: string) =>
  SqliteMigrator.layer({
    loader: SqliteMigrator.fromRecord({
      "0001_create_tables": createTables,
      "0002_import_json_files": importJsonFiles(root),
      "0003_create_memories": createMemories
    })
  }).pipe(
    Layer.provideMerge(SqliteClient.layer({ filename: path.join(root, DATABASE_FILE) })),
    Layer.provide(Layer.effectDiscard(Effect.promise(() => fs.mkdir(root, { recursive: true }))))
  )
