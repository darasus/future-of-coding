import type { Html } from "@effect/ui/html"

const paths = {
  board: ["M4 4h7v7H4z", "M13 4h7v7h-7z", "M4 13h7v7H4z", "M13 13h7v7h-7z"],
  plus: ["M12 5v14", "M5 12h14"],
  settings: ["M4 7h10", "M18 7h2", "M4 17h2", "M10 17h10", "M16 5a2 2 0 1 0 0 4a2 2 0 0 0 0-4z", "M8 15a2 2 0 1 0 0 4a2 2 0 0 0 0-4z"],
  mic: ["M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z", "M5 11a7 7 0 0 0 14 0", "M12 18v3"],
  send: ["M12 19V5", "M6 11l6-6 6 6"],
  stop: ["M7 7h10v10H7z"],
  folder: ["M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"],
  file: ["M7 3h7l5 5v13H7z", "M14 3v5h5"],
  terminal: ["M4 6l6 6-6 6", "M12 18h8"],
  check: ["M5 12l5 5 9-10"],
  close: ["M6 6l12 12", "M18 6L6 18"],
  chevron: ["M9 6l6 6-6 6"],
  spark: ["M12 3v18", "M3 12h18", "M5.6 5.6l12.8 12.8", "M18.4 5.6L5.6 18.4"],
  trash: ["M5 7h14", "M10 7V4h4v3", "M7 7l1 13h8l1-13"],
  reveal: ["M4 12s3-6 8-6 8 6 8 6-3 6-8 6-8-6-8-6z", "M12 9.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 0 0 0-5z"],
  shield: ["M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"],
  search: ["M11 4a7 7 0 1 0 0 14a7 7 0 0 0 0-14z", "M20 20l-4-4"],
  globe: ["M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18z", "M3 12h18", "M12 3c3 3 3 15 0 18", "M12 3c-3 3-3 15 0 18"],
  pencil: ["M4 20l4-1L19 8l-3-3L5 16z"],
  layers: ["M12 3l9 5-9 5-9-5z", "M3 13l9 5 9-5", "M3 17l9 5 9-5"]
} as const

export type IconName = keyof typeof paths

/** A line icon. The stroke comes from CSS, so it follows the text colour. */
export const Icon = <M>(h: Html.H<M>, name: IconName) =>
  h.svg.class("icon").attrs({ viewBox: "0 0 24 24", "aria-hidden": "true" }).children(
    ...paths[name].map((d) => h.path.attr("d", d))
  )

const toolIcons: Record<string, IconName> = {
  Bash: "terminal",
  Read: "file",
  Write: "pencil",
  Edit: "pencil",
  MultiEdit: "pencil",
  NotebookEdit: "pencil",
  Glob: "search",
  Grep: "search",
  WebFetch: "globe",
  WebSearch: "globe",
  Task: "layers",
  Agent: "layers"
}

export const toolIcon = (name: string): IconName => toolIcons[name] ?? "spark"
