import {
  type CanUseTool,
  type Options,
  type PermissionMode as SdkPermissionMode,
  type Query,
  query,
  type SDKUserMessage
} from "@anthropic-ai/claude-agent-sdk"
import type { PermissionMode } from "../../shared/domain.ts"

/**
 * The user's messages for one agent session. The Agent SDK reads them as an
 * async iterable, which is what lets it ask for permissions and take a
 * message while a turn is still running.
 */
class InputQueue {
  private readonly buffered: Array<SDKUserMessage> = []
  private waiting: ((result: IteratorResult<SDKUserMessage>) => void) | null = null
  private ended = false

  push(text: string): void {
    const message: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      origin: { kind: "human" }
    }
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = null
      resolve({ done: false, value: message })
    } else {
      this.buffered.push(message)
    }
  }

  end(): void {
    this.ended = true
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = null
      resolve({ done: true, value: undefined })
    }
  }

  get pending(): number {
    return this.buffered.length
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const next = this.buffered.shift()
        if (next) return Promise.resolve({ done: false, value: next })
        if (this.ended) return Promise.resolve({ done: true, value: undefined })
        return new Promise((resolve) => {
          this.waiting = resolve
        })
      }
    }
  }
}

export interface AgentSession {
  readonly query: Query
  readonly input: InputQueue
}

export interface AgentSessionOptions {
  readonly cwd: string
  readonly model: string | null
  readonly permissionMode: PermissionMode
  readonly resume: string | null
  readonly preferSubscription: boolean
  readonly canUseTool: CanUseTool
}

/**
 * The environment the Claude Code process runs in. With `preferSubscription`
 * the API-key variables are dropped, so it signs in with the local Claude
 * login (the one `claude` uses) instead of billing an API key.
 */
export const agentEnv = (preferSubscription: boolean): Record<string, string | undefined> => {
  const env: Record<string, string | undefined> = { ...process.env }
  // Set when this app is itself started from inside a Claude Code session.
  for (const key of Object.keys(env)) {
    if (key === "CLAUDECODE" || key.startsWith("CLAUDE_CODE_") || key === "ELECTRON_RUN_AS_NODE") {
      delete env[key]
    }
  }
  if (preferSubscription) {
    delete env.ANTHROPIC_API_KEY
    delete env.ANTHROPIC_AUTH_TOKEN
  }
  return env
}

/**
 * The mode Claude Code itself runs in. Bypass is kept in the app: Claude Code
 * still asks, and the thread answers yes at once. That way it can be switched
 * on or off in the middle of a turn, including for a request already waiting.
 */
export const sdkMode = (mode: PermissionMode): SdkPermissionMode =>
  mode === "bypassPermissions" ? "default" : mode

/**
 * The interface shows a thread's task list in place of its individual tool
 * calls, so the agent is asked to keep one.
 */
const taskListBriefing = `The person you are working for watches your task list, not your individual tool calls.
For any work that takes more than two steps, create the tasks with TaskCreate before you start. Mark a task
in_progress with TaskUpdate when you begin it and completed as soon as it is done, one at a time. Give each
task a short activeForm such as "Running the tests". Skip the list for a quick answer or a single action.`

export const openSession = (options: AgentSessionOptions): AgentSession => {
  const input = new InputQueue()
  const sdkOptions: Options = {
    cwd: options.cwd,
    permissionMode: sdkMode(options.permissionMode),
    includePartialMessages: true,
    canUseTool: options.canUseTool,
    systemPrompt: { type: "preset", preset: "claude_code", append: taskListBriefing },
    // The task tools are only offered when asked for. They are bookkeeping, so they never prompt.
    allowedTools: ["TaskCreate", "TaskUpdate", "TaskList", "TaskGet"],
    // Questions would need their own UI; the agent asks in plain text instead.
    disallowedTools: ["AskUserQuestion"],
    env: agentEnv(options.preferSubscription),
    ...(options.model === null ? {} : { model: options.model }),
    ...(options.resume === null ? {} : { resume: options.resume })
  }
  return { query: query({ prompt: input, options: sdkOptions }), input }
}
