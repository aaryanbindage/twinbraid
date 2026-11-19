# Twinbraid

Pair **any two coding agents** in one workspace: Claude Code, Codex, a **local model** (Ollama, LM Studio, llama.cpp), Gemini CLI, Aider, or any OpenAI-compatible API. They share your project folder and message each other directly, so you never start something in one tool, ship it to another, and have it rewritten.

A desktop app (Windows and macOS) shows both working side by side: what each is thinking, what it is editing, tokens used, lines added and removed, and the conversation between them. Interrupt either one, or broadcast to both, at any time.

![Twinbraid running two agents](assets/screenshot.png)

## Why it doesn't rewrite your code

Handoff between tools usually means pasting context into a fresh session that re-derives everything. Twinbraid avoids that:

- Both agents run in **the same directory**. Whatever one writes is already there for the other. A handoff is a two-line message ("I own `src/parser.js`, it's done; please build the renderer and tests"), never a code dump.
- Each agent keeps its own **resumable session** across turns, so it remembers what it did.
- A small **protocol** lets the lead split the work into disjoint files. If both touch a file anyway, Twinbraid warns the earlier owner.

## What you see

| | |
|---|---|
| **Per-agent panel** | Pulsing avatar while active, a live "Now" line (`Editing src/parser.js (+300)`), thinking stream, activity feed with ✓/✕ per tool call |
| **Stats** | Tokens (in / out / cache / reasoning), cost, **lines added and removed**, files touched, tool calls, turns, active time |
| **Shared chat** | Every agent-to-agent message, your messages, interrupts, conflicts, "needs you" questions |
| **Controls** | Message *Both* or either agent; **⚡ Interrupt now**; per-agent Interrupt / Resume; Stop all |

Lines changed are measured by diffing the filesystem after each tool call, so the numbers are identical whatever the agent used to edit.

## Install

Download from [Releases](https://github.com/aaryanbindage/twinbraid/releases):

| Platform | File |
|---|---|
| Windows | `Twinbraid-Setup-x.y.z.exe` (installer) or `Twinbraid-x.y.z-win-portable.zip` |
| macOS (Apple Silicon) | `Twinbraid-x.y.z-mac-arm64.dmg` |
| macOS (Intel) | `Twinbraid-x.y.z-mac-x64.dmg` |

**macOS:** the app is not signed or notarized yet. The first time, right-click Twinbraid → **Open**, or run `xattr -dr com.apple.quarantine /Applications/Twinbraid.app`.

Twinbraid drives the agent CLIs you already have, so install and sign into whichever you want to use:

- Claude Code: <https://claude.com/claude-code>
- Codex: `npm i -g @openai/codex`, then `codex login`
- Local models: install [Ollama](https://ollama.com) (`ollama pull qwen2.5-coder`) or LM Studio and start its server

### From source

```bash
git clone https://github.com/aaryanbindage/twinbraid && cd twinbraid
npm install
npm start            # desktop app
npm run demo         # two scripted agents, no logins or models needed
npm run demo:sim     # simulated Codex + simulated local model through the real adapters
npm test
```

## Pick any two agents

| Kind | What it is |
|---|---|
| `claude` | Claude Code CLI |
| `codex` | OpenAI Codex CLI |
| `ollama`, `lmstudio`, `llamacpp`, `openai-compat` | Local or self-hosted models via an OpenAI-compatible `/v1` API |
| `openai`, `openrouter` | Cloud APIs (key from `$OPENAI_API_KEY` / `$OPENROUTER_API_KEY` or typed per run, never saved) |
| `gemini`, `aider`, `opencode`, `cli` | Plain-text CLIs, or any command that reads a prompt on stdin |
| `codex-sim`, `local-sim` | Simulators (below) |

Two of the same kind work too (e.g. two Claude sessions with different models).

**Local models get a real agent loop.** A chat endpoint can't edit files, so for `ollama`/`lmstudio`/etc. Twinbraid runs its own tool loop (Read, Write, Edit, LS, Glob, Grep, Bash) over streaming `/chat/completions`, with reasoning shown in the thinking panel and token usage tracked. The model must support **tool calling** (e.g. `qwen2.5-coder`, `llama3.1`, `mistral-nemo`; for llama.cpp start `llama-server` with `--jinja`). Twinbraid tells you clearly if it doesn't.

## Headless / terminal

```bash
node src/cli.js --a claude --b ollama:qwen2.5-coder --cwd path/to/project --task "add a /health endpoint with tests"
# while running:  text = broadcast   @agent text = one agent   !agent text = interrupt + send   /stop
```

## How the agents talk

Twinbraid runs each agent as a headless process or API session, one turn at a time, resuming the same session. The final message of a turn is routed to the peer's inbox; if the peer is mid-turn it is delivered when that turn ends. The protocol every agent is given:

- Your final message is always forwarded to the peer. Keep it short; say which files you touched.
- `[[silent]]`: nothing to say, don't forward. `[[done]]`: I think the task is complete (the session ends when both agree). `[[ask-user]]`: I need a human decision.
- The lead sends a plan that splits work by file; the other agent orients read-only on its first turn.

Safety rails: a cap on agent-to-agent messages without you (default 14) so two agents can't chat forever on your tokens, conflict warnings when both touch a file, and a router that a stray tag can't deadlock.

## Permissions

| Preset | Claude | Codex | Local models |
|---|---|---|---|
| **Workspace** (default) | edits auto-approved, shell allowed | `workspace-write` sandbox | writes confined to the project; shell allowed (not sandboxed) |
| **Careful** | edits only, no shell | read-only | read-only |
| **Full auto** | `bypassPermissions` | no sandbox | no path restriction. Throwaway folders only |

Headless agents can't answer permission prompts, so these presets decide up front what is allowed.

## Simulators

You don't need paid accounts or a GPU to try or test Twinbraid:

- `src/sim/fake-codex.js` speaks the real `codex exec --json` protocol (events, resume, usage, failures) and writes real files, so the actual Codex adapter is exercised end to end.
- `src/sim/fake-openai-server.js` is an OpenAI-compatible streaming server with tool calls, reasoning deltas, `<think>` tags and a usage chunk; run it standalone with `node src/sim/fake-openai-server.js --port 11500`.
- `src/sim/fake-cli.js` stands in for a plain-text CLI.

The test suite runs mixed pairs (simulated Codex + local model + plain CLI) through the full Room.

## Layout

```
src/core/        room.js (router, inboxes, stats), protocol.js, workspace.js (line diffing), registry.js, factory.js
src/core/agents/ claude.js, codex.js, openai.js + tools.js (local models), cli.js, mock.js, base.js
src/sim/         fake-codex.js, fake-openai-server.js, fake-cli.js
src/main/        Electron main + preload
src/renderer/    the UI (plain HTML/CSS/JS, no build step)
src/cli.js       headless runner
```

Adding another agent means one adapter: subclass `Agent`, implement `buildCommand()` and `handleLine()` (or override `runTurn()` for an API agent), emit the normalized events (`thinking`, `tool`, `usage`, ...), and register it in `registry.js`.

## Status and limits

- Verified against **real Claude Code** sessions (two-agent collaboration, resume, interrupt/redirect, usage and line stats).
- The **Codex adapter has only been run against the simulator**, which implements the documented `codex exec --json` protocol; it has not yet met a live signed-in Codex.
- The **local-model loop** is tested against the simulated server, not yet against a real Ollama/LM Studio model. Models differ a lot in tool-calling quality.
- **Gemini / Aider / OpenCode presets** are written from their documented non-interactive modes and have not been run against the real tools. Plain-text CLIs report no tokens or tool calls; lines changed are inferred from the filesystem (best effort while the peer is also writing).
- **macOS:** the code paths are covered by tests on a macOS CI runner and the app is smoke-launched there, but it has not been hands-on tested on a Mac. The build is unsigned.
- Claude's thinking text is often summarized or hidden by the model; the panel then shows a live thinking-token estimate. Cost is shown for Claude (API-equivalent) only.
- Sessions are logged to `~/.twinbraid/sessions/` (JSONL, without token-by-token deltas).

MIT licensed.
