# Future of AI Interface

A local desktop workbench for running Claude coding agents as a board of threads. Each thread is
one agent working in a folder on your machine. You direct all of it by voice: there are no text boxes
and no buttons for starting, steering, approving or stopping a thread. The screen is for reading:
click a thread and it opens to fill the window, with its task list, what it is doing now, what it
answered and the files it wrote; Escape or the close button takes you back to the list. The
individual tool calls are counted and folded away.

Everything runs on this machine in Electron. Threads, transcripts and settings are kept in one SQLite
database, `future-of-ai-interface.db`, in the app's data folder (`~/Library/Application Support/future-of-ai-interface`
on macOS). It is opened with Node's built-in `node:sqlite` through `@effect/sql-sqlite-node`, so there
is no native module to compile. The tables are created by migrations in `src/main/services/Database.ts`;
JSON files left by earlier versions are copied in the first time the database is created.

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

Every push to `main` and every pull request is type-checked and built by GitHub Actions
(`.github/workflows/ci.yml`). It runs `pnpm typecheck` and `pnpm build`, the same two commands you
can run here before pushing.

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

Press Space, or click the line of lamps that runs across the window, to start talking; press it again
to stop. The lamps show the pitch and loudness of both voices: yours in white, the assistant's in
blue. The line is the floor of the window: the threads are listed from the top down above it, and an
open thread fills the window.

What you can say:

| Say | What happens |
| --- | --- |
| "Start a thread that…" (optionally "in the folder…") | A new thread starts in that folder, or your default one. The assistant gives it a title of a few words, which is how it is listed and referred to afterwards |
| "…this one is simple" / "…this needs the best model" | The thread runs on a model to match: Haiku for low, Sonnet for medium, Opus for high, Fable for best. Unsaid, it uses the Claude Code default |
| "Tell that thread to…" | A follow-up is sent to an existing thread |
| "Allow it" / "Decline it" | Answers what a paused thread is asking for, once it has been read to you |
| (your answer to a question) | When a thread stops to ask you something, the assistant reads you the question and its options and passes on what you say: one of the options, or your own words |
| "Stop asking, bypass permissions" | That thread, or every thread in the conversation, runs without asking |
| "Ask me again" | Turns permission prompts back on |
| "Stop that thread" | Interrupts a thread that is working |
| "Open the thread about…" / "Go back to the list" | Shows that thread in the window, or returns to the list |
| "Delete that thread" / "Delete the finished ones" | Removes threads for good. One idle thread goes at once; several, or one still working, are read back to you first and go only after you say yes. Files they wrote stay on disk |

The assistant also speaks up on its own when a thread needs approval, has a question for you, finishes
or fails. A thread that has asked something waits until you answer; the assistant cannot answer for
you. Decisions made by voice leave a line in the thread's transcript, and a thread running without
permission prompts shows a red **Bypass** beside its name when you open it.

## Updates

An installed copy keeps itself up to date. It looks for a new version a few seconds after it starts
and every four hours after that, and the header says so when there is something to do: **Update
available**, **Downloading update**, then **Restart to update**. Settings has the rest: the running
version, a button to check now, what is new in the version found, and how far the app goes on its own:

| Setting | What happens with a new version |
| --- | --- |
| Tell me | The app says there is one and waits for you to download it |
| Download it (the default) | It is downloaded in the background, and waits for you to restart |
| Install it | It is downloaded, and the app restarts into it once the window is out of sight and no thread is working |

A downloaded version also goes in when you quit the app in the ordinary way. By voice: "is there an
update?", "check for updates", "restart to update". A copy run from source with `pnpm dev` has nothing
to update and says so.

The installed app keeps its threads in `~/Library/Application Support/future-of-ai-interface`. A copy
run from source keeps its own in `future-of-ai-interface-dev` beside it, started from a copy of the installed
app's, so the two never write over each other.

## Releasing

Bump `version` in `package.json`, commit, tag `vX.Y.Z` and push the tag. The release workflow
(`.github/workflows/release.yml`) builds the macOS app for Apple silicon and publishes it to GitHub
Releases, which is where installed copies look. `pnpm build:mac` makes the same build on this machine,
in `release/`.

Add `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and
`APPLE_TEAM_ID` as repository secrets to sign and notarize the build. Without them it is signed ad
hoc: it runs, and finds new versions, but cannot install them, because macOS only lets a properly
signed app be replaced in place.

## Layout

| Path | What it holds |
| --- | --- |
| `src/shared` | Schemas for threads, artifacts and settings, and the typed request contract between the two processes |
| `src/main` | The Electron main process: Effect services for the database, settings, threads (the Agent SDK), artifacts and voice |
| `src/preload` | The sandboxed bridge exposed to the page as `window.fai` |
| `src/renderer` | The interface, written with `@effect/ui`: stream queries for live data, one component per panel |

`@effect/ui` is not on npm yet and is installed from the Effect team's snapshot builds, so its API
may change. `node_modules/@effect/ui/AGENTS.md` is the reference to read before changing the UI.

## License

MIT. See [LICENSE](LICENSE).

The skills under `.claude/skills` are from [emilkowalski/skills](https://github.com/emilkowalski/skills)
and are covered by their own MIT licence, which is in that folder. They guide Claude Code when it
works on this repository's animations; they are not part of the app.
