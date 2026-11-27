import { Command, Component, Mount, UiSchema } from "@effect/ui"
import { Html } from "@effect/ui/html"
import { Effect, Layer, Schema } from "effect"
import { AsyncResult } from "effect/reactivity"
import { type Artifact, type Item, PREVIEW_SCHEME, type Thread } from "../../../shared/domain.ts"
import { folderName, modelLabel } from "../format.ts"
import { ReadArtifact, WatchThread } from "../queries.ts"
import { Bridge } from "../services/Bridge.ts"
import { Icon, toolIcon } from "./icons.ts"
import { Prose } from "./markdown.ts"
import { FollowEnd } from "./mounts.ts"

const Tab = Schema.Literals(["thread", "artifacts"])

export const ThreadPanelMessage = UiSchema.TaggedEnum({
  ClickedTab: { tab: Tab },
  ClickedArtifact: { id: Schema.String },
  ClickedReveal: { id: Schema.String },
  ClickedDelete: {},
  ClickedClose: {}
})

export const ThreadPanelEvents = UiSchema.TaggedEnum({
  RequestedClose: {},
  Deleted: {}
})

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export class DeleteThread extends Command.Service<DeleteThread>()(
  "threads/DeleteThread",
  { args: { id: Schema.String } }
) {
  static readonly layer = this.toLayer(
    Effect.gen(function*() {
      const bridge = yield* Bridge
      return ({ id }) => Effect.ignore(bridge.call("threads.delete", { id }))
    })
  )
}

export class RevealArtifact extends Command.Service<RevealArtifact>()(
  "artifacts/RevealArtifact",
  { args: { threadId: Schema.String, artifactId: Schema.String } }
) {
  static readonly layer = this.toLayer(
    Effect.gen(function*() {
      const bridge = yield* Bridge
      return (args) => Effect.ignore(bridge.call("artifacts.reveal", args))
    })
  )
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const ThreadPanelModel = Schema.Struct({
  tab: Tab,
  artifactId: Schema.NullOr(Schema.String)
})
type ThreadPanelModel = typeof ThreadPanelModel.Type

const ThreadPanelDef = Html.component({
  name: "ThreadPanel",
  props: Schema.Struct({ id: Schema.String }),
  model: ThreadPanelModel,
  message: ThreadPanelMessage,
  events: ThreadPanelEvents,
  queries: {
    thread: { query: WatchThread, args: ({ props }) => ({ id: props.id }) },
    content: {
      query: ReadArtifact,
      args: ({ model, props, queries }) => {
        if (model.tab !== "artifacts" || !AsyncResult.isSuccess(queries.thread)) return undefined
        const artifacts = queries.thread.value?.artifacts ?? []
        const artifact = artifacts.find((artifact) => artifact.id === model.artifactId) ?? artifacts[0]
        return artifact === undefined
          ? undefined
          : { threadId: props.id, artifactId: artifact.id, version: artifact.edits }
      }
    }
  }
})

type H = Html.H<typeof ThreadPanelMessage.Type>

const toolRow = (h: H, item: Extract<Item, { _tag: "Tool" }>) =>
  h.details.key(item.id).class("tool", `is-${item.status}`).children(
    h.summary(
      h.span.class("tool-icon").children(Icon(h, toolIcon(item.name))),
      h.span.class("tool-name").children(item.name),
      h.span.class("tool-summary").children(item.summary),
      h.span.class("tool-state").children(
        item.status === "running" ? h.span.class("spinner") : Icon(h, item.status === "ok" ? "check" : "close")
      )
    ),
    h.div.class("tool-body").children(
      h.div.class("label").children("Input"),
      h.pre(item.input),
      item.output !== null && item.output !== "" && h.div.class("label").children("Output"),
      item.output !== null && item.output !== "" && h.pre(item.output)
    )
  )

const permissionCard = (h: H, item: Extract<Item, { _tag: "Permission" }>) =>
  h.div.key(item.id).class("permission", `is-${item.status}`).attr("role", item.status === "pending" ? "alert" : undefined)
    .children(
      h.div.class("permission-head").children(
        Icon(h, "shield"),
        h.span.class("permission-title").children(
          item.status === "pending"
            ? `Claude wants to use ${item.toolName}`
            : item.status === "allowed"
            ? `Allowed ${item.toolName}`
            : `Declined ${item.toolName}`
        )
      ),
      item.summary !== "" && h.code.class("permission-summary").children(item.summary),
      item.status === "pending" && h.details.class("permission-detail").children(
        h.summary("Details"),
        h.pre(item.input)
      ),
      item.status === "pending" &&
        h.p.class("permission-hint").children(Icon(h, "mic"), "Say “allow it” or “decline it”.")
    )

type ItemOf<Tag extends Item["_tag"]> = Extract<Item, { _tag: Tag }>

/**
 * What a thread has stopped to ask. While it waits, the question and its
 * choices are laid out to be answered aloud. Afterwards it is one line: what
 * was asked and what was said.
 */
const questionCard = (h: H, item: ItemOf<"Question">) =>
  item.status === "pending"
    ? h.div.key(item.id).class("question is-pending").attr("role", "alert").children(
      ...item.questions.map((question, index) =>
        h.div.key(String(index)).class("question-block").children(
          item.questions.length > 1 && question.header !== "" && h.div.class("label").children(question.header),
          h.p.class("question-text").children(question.question),
          h.ul.class("question-options").children(
            ...question.options.map((option) =>
              h.li.key(option.label).children(
                h.span.class("option-label").children(option.label),
                option.description !== "" && h.span.class("option-note").children(option.description)
              )
            )
          )
        )
      ),
      h.p.class("permission-hint").children(
        Icon(h, "mic"),
        item.questions.some((question) => question.multiSelect)
          ? "Say your answer. You can pick more than one, or say something else."
          : "Say your answer: one of these, or something else."
      )
    )
    : h.div.key(item.id).class("question", `is-${item.status}`).children(
      ...item.questions.map((question, index) =>
        h.p.key(String(index)).class("question-line").children(
          h.span.class("question-asked").children(question.question),
          h.span.class("question-answer").children(
            item.status === "answered" ? (item.answers[index] ?? "") : "No answer"
          )
        )
      )
    )

/**
 * One request and everything that came of it. The view shows what matters:
 * what was asked, what is being decided, and the answer. The steps in between
 * are counted and folded away.
 */
interface Turn {
  readonly key: string
  readonly user: ItemOf<"User"> | null
  readonly steps: ReadonlyArray<Item>
  readonly pending: ReadonlyArray<ItemOf<"Permission">>
  /** What the agent asked the user in this turn, answered or not. */
  readonly questions: ReadonlyArray<ItemOf<"Question">>
  /** The tasks the agent set itself for this request. */
  readonly tasks: ReadonlyArray<ItemOf<"Tasks">>
  readonly errors: ReadonlyArray<ItemOf<"Notice">>
  /** The text that closes the turn, or the latest text while it is still running. */
  readonly reply: ItemOf<"Assistant"> | null
}

const turnsOf = (items: ReadonlyArray<Item>): ReadonlyArray<Turn> => {
  const groups: Array<{ user: ItemOf<"User"> | null; rest: Array<Item> }> = []
  for (const item of items) {
    if (item._tag === "User") {
      groups.push({ user: item, rest: [] })
    } else {
      if (groups.length === 0) groups.push({ user: null, rest: [] })
      groups.at(-1)!.rest.push(item)
    }
  }
  return groups.map(({ rest, user }) => {
    // The reply is the text after the last piece of work. Earlier text is commentary.
    const lastWork = rest.findLastIndex((item) =>
      item._tag === "Tool" || item._tag === "Permission" || item._tag === "Question"
    )
    const reply = rest.findLast((item, index): item is ItemOf<"Assistant"> =>
      item._tag === "Assistant" && index > lastWork && item.text.trim() !== ""
    ) ?? null
    return {
      key: user?.id ?? "start",
      user,
      reply,
      pending: rest.filter((item): item is ItemOf<"Permission"> =>
        item._tag === "Permission" && item.status === "pending"
      ),
      questions: rest.filter((item): item is ItemOf<"Question"> => item._tag === "Question"),
      tasks: rest.filter((item): item is ItemOf<"Tasks"> => item._tag === "Tasks" && item.todos.length > 0),
      errors: rest.filter((item): item is ItemOf<"Notice"> => item._tag === "Notice" && item.level === "error"),
      steps: rest.filter((item) =>
        item !== reply &&
        item._tag !== "Question" &&
        item._tag !== "Tasks" &&
        !(item._tag === "Permission" && item.status === "pending") &&
        !(item._tag === "Notice" && item.level === "error") &&
        !(item._tag === "Assistant" && item.text.trim() === "")
      )
    }
  })
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`

/** What a turn's folded steps amounted to, in a phrase. */
const stepsSummary = (steps: ReadonlyArray<Item>) => {
  const tools = steps.filter((item): item is ItemOf<"Tool"> => item._tag === "Tool")
  const edits = tools.filter((tool) => ["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool.name)).length
  const commands = tools.filter((tool) => tool.name === "Bash").length
  const failed = tools.filter((tool) => tool.status === "error").length
  return [
    plural(tools.length, "step"),
    edits > 0 && plural(edits, "edit"),
    commands > 0 && plural(commands, "command"),
    failed > 0 && `${failed} failed`
  ].filter(Boolean).join(" · ")
}

const stepView = (h: H, item: Item) => {
  switch (item._tag) {
    case "Tool":
      return toolRow(h, item)
    case "Permission":
      return permissionCard(h, item)
    case "Assistant":
      return h.p.key(item.id).class("step-note").children(item.text)
    case "Notice":
      return h.p.key(item.id).class("step-note is-notice").children(item.text)
    case "User":
    case "Question":
    case "Tasks":
      return null
  }
}

/** What the agent is doing right now, in a line. */
const nowLine = (h: H, turn: Turn) => {
  const last = turn.steps.at(-1)
  const text = turn.reply !== null
    ? turn.reply.text
    : last?._tag === "Tool" && last.status === "running"
    ? `${last.name} ${last.summary}`.trim()
    : "Thinking"
  return h.div.key("now").class("now").attrs({ role: "status", "aria-live": "polite" }).children(
    h.span.class("pulse"),
    h.span.class("now-text").children(text)
  )
}

/**
 * The tasks the agent set itself for one request: what is done, what it is
 * on, what is left. They sit in the conversation under the request they are
 * for, and stay there, ticked off, once the work is finished.
 */
const tasksView = (h: H, item: ItemOf<"Tasks">) => {
  const done = item.todos.filter((todo) => todo.status === "completed").length
  const allDone = done === item.todos.length
  return h.section.key(item.id).class("tasks", allDone && "all-done").attr("aria-label", "Tasks").children(
    h.div.class("tasks-head").children(
      h.span.class("tasks-title").children("Tasks"),
      h.span.class("tasks-count").children(`${done} of ${item.todos.length}`),
      h.span.class("tasks-bar").children(
        h.span.class("tasks-fill").style({ transform: `scaleX(${done / item.todos.length})` })
      )
    ),
    h.ul.class("task-list").children(
      ...item.todos.map((todo) =>
        h.li.key(todo.id).class("task", `is-${todo.status}`).children(
          h.span.class("task-mark").children(
            todo.status === "completed"
              ? Icon(h, "check")
              : todo.status === "in_progress"
              ? h.span.class("spinner")
              : null
          ),
          h.span.class("task-text").children(todo.status === "in_progress" ? todo.activeForm : todo.content)
        )
      )
    )
  )
}

const turnView = (h: H, turn: Turn, running: boolean) =>
  h.div.key(turn.key).class("turn-group").children(
    turn.user !== null && h.div.key(turn.user.id).class("asked").children(turn.user.text),
    ...turn.tasks.map((item) => tasksView(h, item)),
    turn.steps.some((item) => item._tag === "Tool") &&
      h.details.key("steps").class("steps").children(
        h.summary(Icon(h, "chevron"), stepsSummary(turn.steps)),
        h.div.class("steps-body").children(...turn.steps.map((item) => stepView(h, item)))
      ),
    ...turn.questions.map((item) => questionCard(h, item)),
    ...turn.pending.map((item) => permissionCard(h, item)),
    running
      ? turn.pending.length === 0 && !turn.questions.some((item) => item.status === "pending") && nowLine(h, turn)
      : turn.reply !== null && h.div.key(turn.reply.id).class("reply").children(Prose(h, turn.reply.text)),
    ...turn.errors.map((item) => h.div.key(item.id).class("notice is-error").children(item.text))
  )

/** A number that changes whenever the transcript grows, for `FollowEnd`. */
const revision = (thread: Thread) =>
  thread.items.reduce(
    (total, item) =>
      total + 1 + ("text" in item ? item.text.length : 0) + ("status" in item ? item.status.length : 0) +
      (item._tag === "Tasks" ? item.todos.reduce((sum, todo) => sum + todo.status.length, 0) : 0),
    0
  )

const transcript = ThreadPanelDef.fragment((h, thread: Thread) => {
  const turns = turnsOf(thread.items)
  const busy = thread.status === "running" || thread.status === "waiting"
  return h.div.class("transcript").onMount(FollowEnd({ revision: revision(thread) }).pipe(Mount.map((never) => never)))
    .children(
      h.div.class("transcript-inner").children(
        ...turns.map((turn, index) => turnView(h, turn, busy && index === turns.length - 1))
      )
    )
})

/**
 * Where an HTML artifact is served from, or `null` when it lives outside the
 * thread's folder. `revision` changes with every edit in the thread, so the
 * frame reloads when the page or anything it links to is rewritten.
 */
const previewUrl = (threadId: string, artifact: Artifact, revision: number) =>
  artifact.relPath.startsWith("..") || artifact.relPath.startsWith("/")
    ? null
    : `${PREVIEW_SCHEME}://${threadId}/${artifact.relPath.split(/[\\/]/).map(encodeURIComponent).join("/")}?v=${revision}`

const artifactPreview = ThreadPanelDef.fragment((h, artifact: Artifact, revision: number) =>
  AsyncResult.match(h.queries.content, {
    onInitial: () => h.div.class("empty").children("Reading file"),
    onFailure: () => h.div.class("empty").children("This file could not be read."),
    onSuccess: ({ value }) => {
      switch (value.format) {
        case "missing":
          return h.div.class("empty").children("This file no longer exists on disk.")
        case "binary":
          return h.div.class("empty").children("This file is not text, so there is nothing to preview.")
        case "image":
          return h.div.class("preview-image").children(h.img.attrs({ src: value.dataUrl ?? "", alt: artifact.relPath }))
        case "html": {
          // Served from the thread's folder, so the page's stylesheets and
          // images load. Scripts are off either way: the page is shown, never run.
          const url = previewUrl(h.props.id, artifact, revision)
          return url === null
            ? h.iframe.class("preview-frame").attrs({ sandbox: "", srcdoc: value.text, title: artifact.relPath })
            : h.iframe.key(url).class("preview-frame").attrs({ sandbox: "", src: url, title: artifact.relPath })
        }
        case "text":
          return h.pre.class("code").children(
            value.text,
            value.truncated && h.span.class("truncated").children("\n… file truncated for preview")
          )
      }
    }
  })
)

const filesView = ThreadPanelDef.fragment((h, thread: Thread, selectedId: string | null) => {
  const selected = thread.artifacts.find((artifact) => artifact.id === selectedId) ?? thread.artifacts[0]
  return selected === undefined
    ? h.div.class("empty").children("No files yet")
    : h.div.class("files").children(
      h.div.class("file-bar").children(
        h.div.class("file-names").attrs({ role: "group", "aria-label": "Files" }).children(
          ...thread.artifacts.map((artifact) =>
            h.button.key(artifact.id).class("file-name", artifact.id === selected.id && "selected")
              .attrs({ type: "button", "aria-pressed": String(artifact.id === selected.id), title: artifact.relPath })
              .on("click", ThreadPanelMessage.ClickedArtifact({ id: artifact.id }))
              .children(artifact.relPath.split(/[\\/]/).at(-1) ?? artifact.relPath)
          )
        ),
        h.button.class("icon-btn").attrs({ type: "button", title: "Show in Finder", "aria-label": "Show in Finder" })
          .on("click", ThreadPanelMessage.ClickedReveal({ id: selected.id })).children(Icon(h, "reveal"))
      ),
      artifactPreview(h, selected, thread.artifacts.reduce((total, artifact) => total + artifact.edits, 0))
    )
})

const threadView = ThreadPanelDef.fragment((h, model: ThreadPanelModel, thread: Thread) => {
  const files = thread.artifacts.length
  return h.section.class("panel thread-panel").attr("aria-label", thread.title).children(
    h.header.class("panel-head").children(
      h.div.class("panel-title").children(
        h.h2(thread.title),
        h.p.class("panel-sub").children(
          folderName(thread.cwd),
          thread.model !== null && ` · ${modelLabel(thread.model)}`,
          thread.permissionMode === "bypassPermissions" && " · ",
          thread.permissionMode === "bypassPermissions" &&
            h.span.class("bypass").attr("title", "Claude runs commands and edits files here without asking")
              .children("Bypass")
        )
      ),
      h.div.class("panel-actions").children(
        // The files view only exists once there is something to look at.
        files > 0 &&
          h.button.class("text-btn", model.tab === "artifacts" && "active")
            .attrs({ type: "button", "aria-pressed": String(model.tab === "artifacts") })
            .on("click", ThreadPanelMessage.ClickedTab({ tab: model.tab === "artifacts" ? "thread" : "artifacts" }))
            .children(files === 1 ? "1 file" : `${files} files`),
        h.button.class("icon-btn").attrs({ type: "button", title: "Delete thread", "aria-label": "Delete thread" })
          .on("click", ThreadPanelMessage.ClickedDelete()).children(Icon(h, "trash")),
        h.button.class("icon-btn").attrs({ type: "button", title: "Close", "aria-label": "Close thread" })
          .on("click", ThreadPanelMessage.ClickedClose()).children(Icon(h, "close"))
      )
    ),
    model.tab === "thread" ? transcript(h, thread) : filesView(h, thread, model.artifactId)
  )
})

export const ThreadPanelNoDeps = ThreadPanelDef.make({
  init: () => ({ tab: "thread" as const, artifactId: null }),
  update: {
    // The thread and its files trade places in one panel.
    ClickedTab: ($, { tab }) => $.evolve({ tab }).viewTransition(["switch"]),
    ClickedArtifact: ($, { id }) => $.evolve({ artifactId: id }),
    ClickedReveal: ($, { id }) => $.run(RevealArtifact.make({ threadId: $.props.id, artifactId: id })),
    ClickedDelete: ($) => $.run(DeleteThread.make({ id: $.props.id })).emit(ThreadPanelEvents.Deleted()),
    ClickedClose: ($) => $.emit(ThreadPanelEvents.RequestedClose())
  },
  view: (h, model) =>
    AsyncResult.match(h.queries.thread, {
      onInitial: () => h.section.class("panel thread-panel loading").children(h.div.class("empty").children("Opening thread")),
      onFailure: () =>
        h.section.class("panel thread-panel").children(h.div.class("empty").children("This thread could not be loaded.")),
      onSuccess: ({ value: thread }) =>
        thread === null
          ? h.section.class("panel thread-panel").children(h.div.class("empty").children("This thread was deleted."))
          : threadView(h, model, thread)
    })
})

const commands = Layer.mergeAll(DeleteThread.layer, RevealArtifact.layer).pipe(Layer.provide(Bridge.layer))

export const ThreadPanel = ThreadPanelNoDeps.pipe(
  Component.provide([commands, WatchThread.layer, ReadArtifact.layer])
)
