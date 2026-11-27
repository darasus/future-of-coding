import type { ThreadStatus } from "../../shared/domain.ts"

export const statusLabel: Record<ThreadStatus, string> = {
  idle: "Queued",
  running: "Working",
  waiting: "Needs you",
  done: "Ready",
  error: "Failed"
}

/** A model as the board shows it: `fable[1m]` reads as "Fable". */
export const modelLabel = (model: string) => {
  const name = model.replace(/\[.*\]$/, "").replace(/^claude-/, "")
  return name.charAt(0).toUpperCase() + name.slice(1)
}

export const folderName = (cwd: string) => cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

/** A clock time for today, a short date otherwise. */
export const shortTime = (at: number, now = new Date()) => {
  const date = new Date(at)
  return sameDay(date, now)
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" })
}

export const duration = (ms: number) => {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export const bytes = (count: number) =>
  count < 1024 ? `${count} B` : count < 1024 * 1024 ? `${(count / 1024).toFixed(1)} KB` : `${(count / 1024 / 1024).toFixed(1)} MB`
