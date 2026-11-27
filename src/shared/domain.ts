import { Schema } from "effect"

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

/**
 * - `idle`: created, nothing has run yet
 * - `running`: the agent is working on a turn
 * - `waiting`: the agent is blocked on a permission decision
 * - `done`: the last turn finished
 * - `error`: the last turn failed
 */
export const ThreadStatus = Schema.Literals(["idle", "running", "waiting", "done", "error"])
export type ThreadStatus = typeof ThreadStatus.Type

/**
 * - `default`: ask before anything that changes files or runs commands
 * - `acceptEdits`: file edits go through, commands still ask
 * - `plan`: read and plan, change nothing
 * - `bypassPermissions`: never ask
 */
export const PermissionMode = Schema.Literals(["default", "acceptEdits", "plan", "bypassPermissions"])
export type PermissionMode = typeof PermissionMode.Type

export const InputSource = Schema.Literals(["typed", "voice"])
export type InputSource = typeof InputSource.Type

export const UserItem = Schema.TaggedStruct("User", {
  id: Schema.String,
  text: Schema.String,
  source: InputSource,
  at: Schema.Number
})

export const AssistantItem = Schema.TaggedStruct("Assistant", {
  id: Schema.String,
  text: Schema.String,
  streaming: Schema.Boolean,
  at: Schema.Number
})

export const ToolStatus = Schema.Literals(["running", "ok", "error"])

export const ToolItem = Schema.TaggedStruct("Tool", {
  id: Schema.String,
  name: Schema.String,
  summary: Schema.String,
  input: Schema.String,
  output: Schema.NullOr(Schema.String),
  status: ToolStatus,
  at: Schema.Number
})

export const PermissionStatus = Schema.Literals(["pending", "allowed", "denied"])

export const PermissionItem = Schema.TaggedStruct("Permission", {
  id: Schema.String,
  toolName: Schema.String,
  summary: Schema.String,
  input: Schema.String,
  status: PermissionStatus,
  canAlwaysAllow: Schema.Boolean,
  at: Schema.Number
})

export const NoticeItem = Schema.TaggedStruct("Notice", {
  id: Schema.String,
  level: Schema.Literals(["info", "error"]),
  text: Schema.String,
  at: Schema.Number
})

/** One thing a thread wants the user to decide, with the choices it offers. */
export const Question = Schema.Struct({
  question: Schema.String,
  /** A word or two naming the subject, such as "Provider". */
  header: Schema.String,
  options: Schema.Array(Schema.Struct({ label: Schema.String, description: Schema.String })),
  multiSelect: Schema.Boolean
})
export type Question = typeof Question.Type

/**
 * - `pending`: the thread is waiting for the answer
 * - `answered`: the user answered, with an option or in their own words
 * - `unanswered`: the turn ended before anyone answered
 */
export const QuestionStatus = Schema.Literals(["pending", "answered", "unanswered"])

/** A thread stopping to ask. It works on nothing else until it is answered. */
export const QuestionItem = Schema.TaggedStruct("Question", {
  id: Schema.String,
  questions: Schema.Array(Question),
  /** The answer to each question, in the same order. Empty until answered. */
  answers: Schema.Array(Schema.String),
  status: QuestionStatus,
  at: Schema.Number
})

export const Item = Schema.Union([UserItem, AssistantItem, ToolItem, PermissionItem, QuestionItem, NoticeItem])
export type Item = typeof Item.Type

export const ArtifactKind = Schema.Literals(["created", "edited"])

/** A file the agent wrote or changed during a thread. */
export const Artifact = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  relPath: Schema.String,
  kind: ArtifactKind,
  edits: Schema.Number,
  updatedAt: Schema.Number
})
export type Artifact = typeof Artifact.Type

export const ThreadStats = Schema.Struct({
  turns: Schema.Number,
  costUsd: Schema.Number,
  durationMs: Schema.Number
})

/** One entry of the task list an agent keeps while it works. */
export const Todo = Schema.Struct({
  id: Schema.String,
  content: Schema.String,
  /** The task as an activity in progress, such as "Running the tests". */
  activeForm: Schema.String,
  status: Schema.Literals(["pending", "in_progress", "completed"])
})
export type Todo = typeof Todo.Type

const threadFields = {
  id: Schema.String,
  title: Schema.String,
  cwd: Schema.String,
  status: ThreadStatus,
  model: Schema.NullOr(Schema.String),
  permissionMode: PermissionMode,
  sessionId: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  stats: ThreadStats,
  artifacts: Schema.Array(Artifact),
  todos: Schema.Array(Todo)
}

export const Thread = Schema.Struct({
  ...threadFields,
  items: Schema.Array(Item)
})
export type Thread = typeof Thread.Type

/** What the board shows for a thread: everything but the transcript. */
export const ThreadSummary = Schema.Struct({
  ...threadFields,
  preview: Schema.String,
  activity: Schema.String,
  pendingPermissions: Schema.Number,
  /** How many questions the thread is waiting on the user to answer. */
  pendingQuestions: Schema.Number,
  messages: Schema.Number
})
export type ThreadSummary = typeof ThreadSummary.Type

// ---------------------------------------------------------------------------
// Artifact contents
// ---------------------------------------------------------------------------

/**
 * The scheme HTML artifacts are previewed from. A preview is addressed as
 * `foc-preview://<thread id>/<path inside the thread's folder>`, so the page's
 * own relative links to stylesheets and images resolve.
 */
export const PREVIEW_SCHEME = "foc-preview"

export const ArtifactContent = Schema.Struct({
  path: Schema.String,
  format: Schema.Literals(["text", "html", "image", "binary", "missing"]),
  text: Schema.String,
  dataUrl: Schema.NullOr(Schema.String),
  truncated: Schema.Boolean,
  bytes: Schema.Number
})
export type ArtifactContent = typeof ArtifactContent.Type

// ---------------------------------------------------------------------------
// Settings and account
// ---------------------------------------------------------------------------

export const Settings = Schema.Struct({
  defaultCwd: Schema.String,
  defaultModel: Schema.NullOr(Schema.String),
  defaultPermissionMode: PermissionMode,
  /** Ignore ANTHROPIC_API_KEY in the environment and use the local Claude login. */
  preferSubscription: Schema.Boolean,
  hasOpenAiKey: Schema.Boolean,
  voiceModel: Schema.String,
  voiceBackendModel: Schema.String
})
export type Settings = typeof Settings.Type

export const SettingsPatch = Schema.Struct({
  defaultCwd: Schema.optionalKey(Schema.String),
  defaultModel: Schema.optionalKey(Schema.NullOr(Schema.String)),
  defaultPermissionMode: Schema.optionalKey(PermissionMode),
  preferSubscription: Schema.optionalKey(Schema.Boolean),
  /** An empty string clears the stored key. */
  openAiKey: Schema.optionalKey(Schema.String),
  voiceModel: Schema.optionalKey(Schema.String),
  voiceBackendModel: Schema.optionalKey(Schema.String)
})
export type SettingsPatch = typeof SettingsPatch.Type

export const Account = Schema.Struct({
  state: Schema.Literals(["unknown", "subscription", "apiKey", "signedOut"]),
  detail: Schema.String,
  claudeVersion: Schema.String
})
export type Account = typeof Account.Type

/**
 * How much intelligence a task needs, as someone would say it. Each level is a
 * model: a thread nobody gave a level runs on the Claude Code default.
 */
export const Intelligence = Schema.Literals(["low", "medium", "high", "best"])
export type Intelligence = typeof Intelligence.Type

/** The Claude Code model names each level stands for. */
export const intelligenceModels: Record<Intelligence, string> = {
  low: "haiku",
  medium: "sonnet",
  high: "opus",
  best: "fable[1m]"
}
