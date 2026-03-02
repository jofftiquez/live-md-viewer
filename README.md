# live-md-viewer

A [Claude Code](https://docs.anthropic.com/en/docs/claude-code) skill that renders markdown files in a local browser with live reload, syntax highlighting, mermaid diagrams, multi-file sidebar, and light/dark themes.

When installed, it **automatically launches** whenever Claude Code writes a markdown file to disk — no manual invocation needed.

## Features

- **Live reload** — file changes stream instantly via SSE (500ms poll)
- **Syntax highlighting** — theme-aware highlight.js (github / github-dark)
- **Mermaid diagrams** — flowcharts, sequence, Gantt, pie, quadrant
- **Multi-file sidebar** — add files on the fly, "new" badges on arrival
- **Light/dark themes** — toggle persisted in localStorage
- **Sticky toolbar** — file name + full path always visible
- **Download button** — save the raw markdown locally
- **GFM support** — tables, checkboxes, blockquotes, nested lists
- **DOMPurify** — all rendered HTML is sanitized
- **Auto port discovery** — if 4900 is taken, tries the next 100 ports
- **Graceful shutdown** — cleans up watchers, registry, and temp files on SIGINT/SIGTERM

## Requirements

- [Node.js](https://nodejs.org) v18.0+ (uses native `fetch`, ESM, and `http` module)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI

No `npm install` needed — the server uses Node's built-in HTTP module and fetches client-side dependencies from CDN.

## Installation

From a Claude Code session:

```
/plugin marketplace add jofftiquez/live-md-viewer
/plugin install live-md-viewer@live-md-viewer
```

Once installed, the PostToolUse hook activates automatically — any markdown report Claude Code writes will open in the viewer.

## Usage

### Automatic (recommended)

Just use Claude Code normally. When it writes a markdown file, the viewer launches automatically and opens in your browser. Subsequent files are added to the sidebar without spawning a new server.

### Manual

```bash
/live-md-viewer ./report.md
```

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `<file>` | *(required unless --stdin)* | Path to markdown file to serve |
| `--port <n>` | `4900` | Starting port (auto-increments if taken) |
| `--no-open` | `false` | Don't auto-open browser |
| `--stdin` | `false` | Read markdown from stdin instead of file |

### Adding files to a running viewer

If the viewer is already open, add more files via the API:

```bash
curl -X POST http://localhost:4900/api/add-file \
  -H 'Content-Type: application/json' \
  -d '{"file": "/absolute/path/to/file.md"}'
```

Or just keep writing markdown files — the hook adds them automatically.

## Auto-detection

The PostToolUse hook fires on every `Write` tool call and launches the viewer for **any `.md` file** unless it matches the deny list:

**Ignored filenames:** `CLAUDE.md`, `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `LICENSE.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`

**Ignored paths:** `/.claude/`, `/node_modules/`, `/.git/`

The hook spawns the server directly as a detached process — no LLM action required.

## REST API

The viewer server exposes an API for programmatic use:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | HTML viewer page |
| `/api/files` | GET | List tracked files (`[{path, name}]`) |
| `/api/content?file=<path>` | GET | Raw markdown content for a file |
| `/api/add-file` | POST | Add a file: `{"file": "/path"}` |
| `/api/events` | GET | SSE stream (`reload`, `file-added`, `connected`) |

## How it works

1. **Claude Code writes a file** using the `Write` tool
2. **PostToolUse hook fires** — `auto-launch.mjs` receives the file path on stdin
3. **Deny-list check** — skips ignored filenames (`README.md`, etc.) and ignored paths (`/.claude/`, `/node_modules/`, `/.git/`)
4. **Server routing**:
   - Server already running → file is silently added via `POST /api/add-file`
   - No server running → hook spawns the server directly as a detached child process
5. **Live reload** — the server watches all tracked files with `fs.watchFile`. Changes trigger SSE events to all connected browsers
6. **Browser rendering** — marked.js parses GFM, highlight.js colorizes code blocks, mermaid.js renders diagrams, DOMPurify sanitizes everything

A PID registry at `/tmp/live-md-viewer-registry.json` prevents duplicate servers. Stale PIDs are detected and ignored.

## Plugin structure

```
live-md-viewer/
├── .claude-plugin/
│   └── marketplace.json          # Marketplace catalog
├── plugins/
│   └── live-md-viewer/
│       ├── .claude-plugin/
│       │   └── plugin.json       # Plugin manifest
│       ├── hooks/
│       │   ├── hooks.json        # PostToolUse hook registration
│       │   └── auto-launch.mjs   # Report detection + server management
│       ├── skills/
│       │   └── live-md-viewer/
│       │       └── SKILL.md      # Skill instructions for Claude Code
│       └── server.mjs            # Node HTTP server + HTML viewer
├── README.md
└── LICENSE
```

## Client-side dependencies (CDN)

- [marked](https://github.com/markedjs/marked) v15 — GFM markdown parser
- [highlight.js](https://highlightjs.org/) v11 — syntax highlighting
- [mermaid](https://mermaid.js.org/) v11 — diagram rendering
- [DOMPurify](https://github.com/cure53/DOMPurify) v3 — HTML sanitization

## License

MIT
