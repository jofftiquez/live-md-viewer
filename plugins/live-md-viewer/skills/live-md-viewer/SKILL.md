---
name: live-md-viewer
description: Spawns a local web-based markdown viewer with live reload. Use whenever creating markdown reports, summaries, plans, or documentation that the user should review visually.
triggers:
  - Creating a markdown report or summary file
  - Writing plan.md or any analysis/audit document
  - User asks to "preview", "view", or "show" a markdown file
  - User asks for a visual/rendered view of markdown output
---

# Live MD Viewer

Renders any markdown file in a local browser with dark/light themes, syntax highlighting, mermaid diagram support, multi-file sidebar, and live reload via SSE.

## When to Use

Activate this skill **automatically** whenever you:

1. **Write a markdown report** to disk (analysis, audit, gap report, anatomy doc, etc.)
2. **Write a plan file** (`docs/plans/[name]/plan.md` or similar)
3. **Create a summary document** the user will want to review
4. **Generate any substantial markdown** (more than a few lines) saved to a file

Also activate when the user explicitly asks to preview/view/render a markdown file.

**Do NOT activate for:**
- Inline markdown responses in the conversation (the terminal already renders these)
- Trivial files (e.g., a 3-line README edit)
- Files the user hasn't asked to see

## How to Use

**IMPORTANT: Always run as a background process using the Bash tool's `run_in_background` parameter.** The server is long-lived — it runs until killed. Never run it in the foreground or it will block your session.

### Step 1: Launch in background

Use the Bash tool with `run_in_background: true`:

```typescript
// In Claude Code, call:
Bash({
  command: "node ${CLAUDE_PLUGIN_ROOT}/server.mjs /path/to/file.md",
  run_in_background: true,
  description: "Launch markdown viewer for file.md"
})
```

The first line of stdout is JSON:
```json
{ "pid": 12345, "port": 4900, "url": "http://localhost:4900", "file": "/path/to/file.md" }
```

### Step 2: Tell the user the URL

After launching, report the URL to the user. The browser opens automatically.

### Adding files to a running viewer

If the viewer is already running, add files via the API:

```bash
curl -X POST http://localhost:4900/api/add-file \
  -H 'Content-Type: application/json' \
  -d '{"file": "/path/to/file.md"}'
```

### Piping from stdin

```typescript
Bash({
  command: "echo '# My Report' | node ${CLAUDE_PLUGIN_ROOT}/server.mjs --stdin",
  run_in_background: true
})
```

### CLI Flags

| Flag | Default | Description |
|------|---------|-------------|
| `<file>` | *(required unless --stdin)* | Path to markdown file to serve |
| `--port <n>` | `4900` | Starting port (auto-increments if taken) |
| `--no-open` | `false` | Don't auto-open browser |
| `--stdin` | `false` | Read markdown from stdin instead of file |

### Live Reload

The viewer watches the file for changes (500ms poll interval). When the file changes on disk, all connected browsers refresh automatically via Server-Sent Events. This means:

- You can write a file, spawn the viewer, then continue editing — the browser updates live
- Multiple browser tabs can connect simultaneously
- If the connection drops, the client auto-reconnects after 2 seconds

### Stopping the Server

```bash
kill <pid>        # Graceful shutdown (use pid from the JSON output)
```

## Features

- Dark/light theme with toggle (persisted in localStorage)
- GFM tables, checkboxes, blockquotes
- Mermaid diagram rendering (flowcharts, Gantt, sequence, pie, quadrant)
- Syntax highlighting via highlight.js (theme-aware)
- Multi-file sidebar with live file addition
- Download button to save markdown files locally
- Sticky toolbar with file name and path
- DOMPurify sanitization of all rendered HTML
- Auto-finds open port if 4900 is taken
- Clean shutdown on SIGINT/SIGTERM

## Output Contract

**Input:** A markdown file path (or stdin content)
**Output:** JSON to stdout with `{ pid, port, url, files }`, then serves HTTP until killed
**Side effects:** Opens browser tab (unless `--no-open`), creates temp file if `--stdin`

## Auto-Launch (PostToolUse Hook)

A PostToolUse hook on `Write` automatically launches the viewer whenever a markdown file is written to disk. **No manual invocation needed** — just write the file and the viewer appears.

### How it works

1. Every `Write` tool call triggers `hooks/auto-launch.mjs`
2. The hook checks if the written file is a viewable markdown file (deny-list approach)
3. If a server is already running, it silently adds the file via API
4. If no server is running, the hook **spawns the server directly** as a detached process and emits a JSON `systemMessage` to inform the LLM (no action needed from the LLM)

### Detection (deny-list approach)

Any `.md` file triggers the viewer **unless** it matches the deny list:

**Ignored filenames:** `CLAUDE.md`, `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `LICENSE.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`

**Ignored paths:** `/.claude/`, `/node_modules/`, `/.git/`

### Duplicate prevention

A PID registry at `/tmp/live-md-viewer-registry.json` tracks active viewers. The hook adds files to the running server instead of spawning duplicates.

## Runtime API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/files` | GET | List tracked files |
| `/api/content?file=<path>` | GET | Get markdown content for a file |
| `/api/add-file` | POST | Add a new file `{"file": "/path"}` |
| `/api/events` | GET | SSE stream (reload, file-added, connected) |

## Manual Launch

You can also launch the viewer manually for files that don't match the auto-detection heuristics:

```typescript
Bash({
  command: "node ${CLAUDE_PLUGIN_ROOT}/server.mjs /path/to/file.md",
  run_in_background: true,
  description: "Launch markdown viewer for file.md"
})
```
