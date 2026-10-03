# agent-canvas

A live board for each Claude Code session, in a pane beside the transcript. The agent keeps it current every reply, with diagrams, tables, charts and the state of the work. The board is a real web page drawn by headless Chrome, so you can click, type, hover and scroll in it. Nothing opens in a browser tab, and the board belongs to the session that made it.

It is a Claude Code [mod](https://code.claude.com/docs/en/plugins/mods/overview): a plugin whose hooks run inside Claude Code.

## How it works

- **The agent writes files.** While the board is on, the mod adds the rules in [RULES.md](RULES.md) to the system prompt. Each reply, the agent rewrites `turn.html` (this reply's news), edits the panels that changed (`panels/<name>.html`, kept across turns) and appends a line to `log.txt`. The files live in `~/.claude/agent-canvas/sessions/<session id>/`.
- **The mod checks the work.** When the agent tries to end a turn without writing `turn.html` after its last tool call, the mod blocks the Stop event and tells it why.
- **The bridge draws the page.** `bridge/bridge.mjs` builds `board.html` from those files, runs headless Chrome on it over a pipe (no open port), and writes each frame as a PNG. Panels written this turn come first, marked "updated". Every turn keeps a snapshot, linked from "earlier turns".
- **The pane shows it.** The mod draws the frames with Claude Code's `Image` element and swaps each new one in with `$.ui.blit`. A `Client` region laid over the picture sends clicks, keys and the pane size back to Chrome, and the mouse wheel scrolls the page.

## Requirements

- Claude Code 2.1.287 or later
- A terminal that draws images for Claude Code: Ghostty, kitty or WezTerm
- Google Chrome or Chromium
- Node.js 18 or later

## Install

From a Claude Code session:

    /plugin marketplace add sebi75/agent-canvas
    /plugin install agent-canvas@agent-canvas

Or clone the repository and load the folder in every session by adding `CLAUDE_CODE_PLUGIN_DIRS` with the clone's path to the `env` block of `~/.claude/settings.json`.

## Use

| command | what it does |
|---|---|
| `/agent-canvas` | turns the board on and opens its pane; when it shows another page, goes back to the board |
| `/agent-canvas off` | turns the board off and closes the pane |
| `/agent-canvas <url or path>` | shows that page instead, for example a local dev server |

Click the page to type into it. Esc gives the keyboard back to Claude Code. The board stays on across a plugin reload, and `AGENT_CANVAS_OPEN=1` turns it on when a session starts.

## Herdr

Claude Code turns images off when the terminal reports itself as "libghostty", which [Herdr](https://herdr.dev) does. Its own switch turns them back on: set `CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1` in the shell that starts `claude` inside Herdr, for example in `~/.zshrc` when `HERDR_ENV` is set.

Herdr currently draws a few images per second from a program inside a pane, so the mod caps the board at 4 frames per second at 1× scale there. In plain Ghostty the same page measured about 53 frames per second on screen.

## Configuration

| variable | default |
|---|---|
| `AGENT_CANVAS_FPS` | 60, or 4 inside Herdr |
| `AGENT_CANVAS_SCALE` | 2 device pixels per CSS pixel, or 1 inside Herdr |
| `AGENT_CANVAS_CHROME` | the first Chrome or Chromium found |
| `AGENT_CANVAS_OPEN` | unset; `1` turns the board on at session start |

## Limits

- The terminal shows pictures of the page, so text on it cannot be selected or copied.
- The Desktop app and the VS Code extension have no `Image` element. The pane says so there.
- Frames travel as PNG files. Shared-memory raw pixels would be faster if a terminal needs it.

## History

agent-canvas started as [herdr-canvas](https://github.com/sebi75/herdr-canvas), which rendered the same kind of board to a static image in a Herdr pane next to the agent. Claude Code mods made it possible to put a live, clickable page inside Claude Code itself.

## Test

    node test/board.test.mjs

## License

MIT
