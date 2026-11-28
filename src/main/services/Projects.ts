import { Context, Effect, Layer } from "effect"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import type { Project } from "../../shared/domain.ts"
import { SettingsStore } from "./SettingsStore.ts"

/** Folders people commonly keep their projects in, under the home folder. */
const USUAL_ROOTS = [
  "projects",
  "Projects",
  "code",
  "Code",
  "dev",
  "Developer",
  "src",
  "work",
  "repos",
  "Documents/GitHub",
  "Documents/Projects"
]

/** A file or folder whose presence makes a folder a project. */
const MARKERS = [
  ".git",
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "Gemfile",
  "pom.xml",
  "build.gradle",
  "Package.swift",
  "deno.json",
  "requirements.txt",
  "CLAUDE.md"
]

const exists = (file: string) => fs.access(file).then(() => true, () => false)

/** The projects directly inside one folder. */
const scan = async (root: string): Promise<Array<Project>> => {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  const found = await Promise.all(
    entries
      .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith("."))
      .map(async (entry): Promise<Project | null> => {
        const folder = path.join(root, entry.name)
        const marks = await Promise.all(MARKERS.map((marker) => exists(path.join(folder, marker))))
        if (!marks.includes(true)) return null
        const stat = await fs.stat(folder).catch(() => null)
        if (stat === null || !stat.isDirectory()) return null
        return { name: entry.name, path: folder, modifiedAt: stat.mtimeMs }
      })
  )
  return found.filter((project) => project !== null)
}

/** A name as the words in it, however it was written: `source-kickChat` is source, kick, chat. */
const words = (text: string) =>
  text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter((word) => word !== "")

const editDistance = (a: string, b: string) => {
  let row = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    const next = [i]
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(next[j - 1]! + 1, row[j]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    row = next
  }
  return row[b.length]!
}

/** How well one spoken word fits one word of a name, from 0 to 1. */
const wordFit = (said: string, word: string) => {
  if (said === word) return 1
  if (word.startsWith(said) || said.startsWith(word)) return 0.85
  if (word.includes(said) || said.includes(word)) return 0.7
  // A word misheard by a letter or two, which speech often is.
  const slack = Math.max(said.length, word.length) >= 7 ? 2 : Math.min(said.length, word.length) >= 4 ? 1 : 0
  return slack > 0 && editDistance(said, word) <= slack ? 0.6 : 0
}

/**
 * How well what someone said fits a project's name, from 0 to 1. Every word
 * they said has to find a place in the name, and each word of the name that
 * nothing they said accounts for counts against it, so "chat" prefers `chat`
 * to `chat-archive`.
 */
export const fit = (said: string, name: string) => {
  const saidWords = words(said)
  const nameWords = words(name)
  if (saidWords.length === 0 || nameWords.length === 0) return 0
  if (saidWords.join("") === nameWords.join("")) return 1
  const best = (word: string, among: ReadonlyArray<string>) => Math.max(...among.map((other) => wordFit(word, other)))
  const covered = saidWords.reduce((total, word) => total + best(word, nameWords), 0) / saidWords.length
  const unexplained = nameWords.filter((word) => best(word, saidWords) === 0).length
  return covered * (1 - Math.min(0.45, unexplained * 0.15))
}

/** Close enough to be worth offering. */
const WORTH_OFFERING = 0.5
/** Close enough to start work in without asking, when nothing else comes near. */
const SURE = 0.8
const CLEAR_LEAD = 0.1

export interface Match {
  readonly project: Project
  readonly score: number
}

/**
 * The project folders on this machine, so a thread can be started "in the
 * billing app" without anyone spelling out a path, and without a thread spent
 * on looking for it. They are the folders with a repository or a manifest in
 * them, directly inside the default folder and the usual places for projects.
 */
export class Projects extends Context.Service<Projects, {
  /** Every project found, most recently changed first. */
  readonly list: Effect.Effect<ReadonlyArray<Project>>
  /** The projects whose names fit what was said, best first. */
  find(said: string): Effect.Effect<ReadonlyArray<Match>>
  /** The one project that was clearly meant, or `null` when none or several fit. */
  resolve(said: string): Effect.Effect<Project | null>
}>()("fai/main/Projects") {
  static readonly layer = Layer.effect(
    Projects,
    Effect.gen(function*() {
      const settings = yield* SettingsStore
      let cached: { readonly at: number; readonly root: string; readonly projects: ReadonlyArray<Project> } | null = null

      const list = Effect.gen(function*() {
        const { defaultCwd } = yield* settings.get
        if (cached !== null && cached.root === defaultCwd && Date.now() - cached.at < 60_000) return cached.projects
        const roots = [...new Set([defaultCwd, ...USUAL_ROOTS.map((root) => path.join(os.homedir(), root))])]
        const found = yield* Effect.promise(() => Promise.all(roots.map(scan)))
        const byPath = new Map<string, Project>()
        // Two spellings of one folder, as on a Mac's case-blind disk, are one project.
        for (const project of found.flat()) {
          const real = yield* Effect.promise(() => fs.realpath(project.path).catch(() => project.path))
          if (!byPath.has(real)) byPath.set(real, { ...project, path: real })
        }
        const projects = [...byPath.values()].sort((a, b) => b.modifiedAt - a.modifiedAt)
        cached = { at: Date.now(), root: defaultCwd, projects }
        return projects
      })

      const find = (said: string) =>
        Effect.map(list, (projects) =>
          projects
            .map((project) => ({ project, score: fit(said, project.name) }))
            .filter((match) => match.score >= WORTH_OFFERING)
            .sort((a, b) => b.score - a.score || b.project.modifiedAt - a.project.modifiedAt)
            .slice(0, 6))

      return Projects.of({
        list,
        find,
        resolve: (said) =>
          Effect.map(find(said), ([best, next]) =>
            best !== undefined && best.score >= SURE && (next === undefined || best.score - next.score >= CLEAR_LEAD)
              ? best.project
              : null)
      })
    })
  )
}
