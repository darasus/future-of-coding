# Future of Coding

A local desktop workbench for running Claude coding agents as a board of threads. Each thread is
one agent working in a folder on your machine. You direct all of it by voice: there are no text boxes
and no buttons for starting, steering, approving or stopping a thread. The screen is for reading:
open a thread to see its task list, what it is doing now and what it answered, and to preview the
files it wrote. The individual tool calls are counted and folded away.

Everything runs on this machine in Electron. Threads, transcripts and settings are JSON files in the
app's data folder (`~/Library/Application Support/future-of-coding` on macOS).

## Run it

```bash
pnpm install
```

```bash
node node_modules/electron/install.js
```

```bash
pnpm dev
```

The second command downloads the Electron binary, which pnpm does not do on install. `pnpm build`
followed by `pnpm start` runs the production bundles.

## Claude

Agents run through the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview), which
starts the Claude Code binary bundled with the SDK. With **Use my Claude login** on (the default),
the app drops `ANTHROPIC_API_KEY` from the agent's environment, so it signs in the way the `claude`
CLI does: with your Claude subscription. If you are not signed in, run `claude` in a terminal and
use `/login`. Turn the setting off to bill an API key from your environment instead.

Anthropic does not allow third-party products to offer claude.ai login to their users without
approval. Using your own login on your own machine is what this app does; distributing it to other
people would need API-key authentication.

## Live voice

Voice uses OpenAI's Live API (`gpt-live-1.1`) over WebRTC. Add an OpenAI API key in Settings; it is
encrypted with the OS keychain and stays in the main process, which starts the session on the page's
behalf. In development the key can also come from `OPENAI_API_KEY` in `.env.local`.

Press Space, or click the display at the foot of the list, to start talking; press it again to stop.
The display shows the pitch and loudness of both voices: yours in white, the assistant's in blue.

What you can say:

| Say | What happens |
| --- | --- |
| "Start a thread that…" (optionally "in the folder…") | A new thread starts in that folder, or your default one |
| "…this one is simple" / "…this needs the best model" | The thread runs on a model to match: Haiku for low, Sonnet for medium, Opus for high, Fable for best. Unsaid, it uses the Claude Code default |
| "Tell that thread to…" | A follow-up is sent to an existing thread |
| "Allow it" / "Decline it" | Answers what a paused thread is asking for, once it has been read to you |
| "Stop asking, bypass permissions" | That thread, or every thread in the conversation, runs without asking |
| "Ask me again" | Turns permission prompts back on |
| "Stop that thread" | Interrupts a thread that is working |

The assistant also speaks up on its own when a thread needs approval, finishes or fails. Decisions
made by voice leave a line in the thread's transcript, and a thread running without permission
prompts carries a red **Bypass** marker.

## Layout

| Path | What it holds |
| --- | --- |
| `src/shared` | Schemas for threads, artifacts and settings, and the typed request contract between the two processes |
| `src/main` | The Electron main process: Effect services for storage, settings, threads (the Agent SDK), artifacts and voice |
| `src/preload` | The sandboxed bridge exposed to the page as `window.foc` |
| `src/renderer` | The interface, written with `@effect/ui`: stream queries for live data, one component per panel |

`@effect/ui` is not on npm yet and is installed from the Effect team's snapshot builds, so its API
may change. `node_modules/@effect/ui/AGENTS.md` is the reference to read before changing the UI.
