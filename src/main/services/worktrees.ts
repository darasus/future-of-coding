import { execFile } from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { ThreadChanges, Worktree } from "../../shared/domain.ts"

/** Runs git in a folder. Resolves with what it printed, or `null` when it failed. */
const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  new Promise<string | null>((resolve) => {
    execFile("git", ["-C", cwd, ...args], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? null : stdout.replace(/\n+$/, ""))
    })
  })

/** The top folder of the repository a folder is in, or `null` when it is in none. */
export const repoRoot = (cwd: string) => git(cwd, "rev-parse", "--show-toplevel")

const slug = (text: string) =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/, "") || "thread"

/**
 * Gives a thread its own working copy of a repository: a git worktree on a
 * new branch, made from the commit the repository is on now. The thread can
 * then change files without touching, or being touched by, whoever else is
 * working in the original folder. Changes there that are not committed are
 * not in the copy.
 *
 * Resolves with the copy and the folder inside it that matches `cwd`, or
 * `null` when the folder is not in a repository or the repository has no
 * commit to start from.
 */
export const createWorktree = async (options: {
  readonly cwd: string
  readonly title: string
  readonly threadId: string
  /** Where the app keeps working copies. */
  readonly root: string
}): Promise<{ readonly worktree: Worktree; readonly cwd: string } | null> => {
  const repo = await repoRoot(options.cwd)
  if (repo === null) return null
  const base = await git(repo, "rev-parse", "HEAD")
  if (base === null) return null
  const name = `${slug(options.title)}-${options.threadId.slice(0, 6)}`
  const branch = `fai/${name}`
  const folder = path.join(options.root, `${path.basename(repo)}-${name}`)
  await fs.mkdir(options.root, { recursive: true })
  if ((await git(repo, "worktree", "add", "-b", branch, folder, base)) === null) return null
  // The folder the thread was asked to work in, inside the copy.
  const inside = (await git(options.cwd, "rev-parse", "--show-prefix")) ?? ""
  return { worktree: { repo, path: folder, branch, base }, cwd: path.join(folder, inside) }
}

/**
 * Removes a working copy and its branch, but only when nothing was done in
 * it: no commit and no changed or new file. Anything else is somebody's work
 * and stays where it is. Resolves with whether it was removed.
 */
export const removeUntouchedWorktree = async (worktree: Worktree) => {
  const status = await git(worktree.path, "status", "--porcelain")
  const head = await git(worktree.path, "rev-parse", "HEAD")
  if (status !== "" || head !== worktree.base) return false
  if ((await git(worktree.repo, "worktree", "remove", worktree.path)) === null) return false
  await git(worktree.repo, "branch", "-D", worktree.branch)
  return true
}

/**
 * What has changed in a thread's folder. For a thread with its own working
 * copy that is everything since the copy was made, committed or not; for any
 * other folder in a repository it is what is not committed yet.
 */
export const changesIn = async (cwd: string, worktree: Worktree | null): Promise<ThreadChanges> => {
  const nothing: ThreadChanges = { repository: false, branch: null, separate: false, commits: 0, files: [] }
  if ((await repoRoot(cwd)) === null) return nothing
  const against = worktree?.base ?? "HEAD"
  const [branch, numstat, status, ahead] = await Promise.all([
    git(cwd, "rev-parse", "--abbrev-ref", "HEAD"),
    git(cwd, "diff", "--numstat", against),
    git(cwd, "status", "--porcelain", "--untracked-files=all"),
    worktree === null ? Promise.resolve("0") : git(cwd, "rev-list", "--count", `${worktree.base}..HEAD`)
  ])
  const files: Array<ThreadChanges["files"][number]> = []
  for (const line of (numstat ?? "").split("\n")) {
    const [added, deleted, ...name] = line.split("\t")
    if (added === undefined || deleted === undefined || name.length === 0) continue
    // A binary file has no line counts.
    files.push({ path: name.join("\t"), added: Number(added) || 0, deleted: Number(deleted) || 0, state: "changed" })
  }
  for (const line of (status ?? "").split("\n")) {
    if (line.startsWith("?? ")) files.push({ path: line.slice(3), added: 0, deleted: 0, state: "new" })
  }
  return {
    repository: true,
    branch,
    separate: worktree !== null,
    commits: Number(ahead ?? "0") || 0,
    files
  }
}
