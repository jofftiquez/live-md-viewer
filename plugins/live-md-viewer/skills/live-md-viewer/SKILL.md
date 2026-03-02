---
name: live-md-viewer
description: Spawns a local web-based markdown viewer with live reload. Use whenever creating markdown reports, summaries, plans, or documentation that the user should review visually.
triggers:
  - Creating a markdown report or summary file
  - Writing plan.md or any analysis/audit document
  - User asks to "preview", "view", or "show" a markdown file
  - User asks for a visual/rendered view of markdown output
---

## MANDATORY: After Writing Any .md File

You MUST follow this procedure every time you write a `.md` file to disk. Do not skip any step.

### Step 1: Check the deny list

Stop here (take no action) if the file matches ANY of these:

**Ignored filenames** (case-insensitive): `CLAUDE.md`, `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `LICENSE.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`

**Ignored path segments**: `/.claude/`, `/node_modules/`, `/.git/`

If the file is on the deny list, **stop — do nothing**.

### Step 2: Check the server registry

Run this command to check if a viewer server is already running:

```bash
cat /tmp/live-md-viewer-registry.json 2>/dev/null
```

If the file exists and contains a JSON object with `pid` and `port`:
- Verify the process is alive: `kill -0 <pid> 2>/dev/null && echo "alive" || echo "dead"`
- If **alive**, go to Step 3a
- If **dead** (or the file doesn't exist), go to Step 3b

### Step 3a: Add file to running server

The server is already running. Add the file via the API:

```bash
curl -s -X POST http://localhost:<port>/api/add-file \
  -H 'Content-Type: application/json' \
  -d '{"file": "<absolute-path-to-md-file>"}'
```

Done. No further action needed.

### Step 3b: Launch a new server

No server is running. You MUST launch it as a **background task** so it appears as a tracked Claude Code task:

```
Bash({
  command: "node ${CLAUDE_PLUGIN_ROOT}/server.mjs <absolute-path-to-md-file>",
  run_in_background: true,
  description: "Launch markdown viewer for <filename>"
})
```

The first line of stdout is JSON: `{ "pid": ..., "port": ..., "url": "http://localhost:...", "file": "..." }`

After launching, tell the user the URL. The browser opens automatically.

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

## CLI Flags

| Flag | Default | Description |
|------|---------|-------------|
| `<file>` | *(required unless --stdin)* | Path to markdown file to serve |
| `--port <n>` | `4900` | Starting port (auto-increments if taken) |
| `--no-open` | `false` | Don't auto-open browser |
| `--stdin` | `false` | Read markdown from stdin instead of file |

## Piping from stdin

```
Bash({
  command: "echo '# My Report' | node ${CLAUDE_PLUGIN_ROOT}/server.mjs --stdin",
  run_in_background: true
})
```

## Live Reload

The viewer watches the file for changes (500ms poll interval). When the file changes on disk, all connected browsers refresh automatically via Server-Sent Events. This means:

- You can write a file, spawn the viewer, then continue editing — the browser updates live
- Multiple browser tabs can connect simultaneously
- If the connection drops, the client auto-reconnects after 2 seconds

## Stopping the Server

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

## Runtime API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/files` | GET | List tracked files |
| `/api/content?file=<path>` | GET | Get markdown content for a file |
| `/api/add-file` | POST | Add a new file `{"file": "/path"}` |
| `/api/events` | GET | SSE stream (reload, file-added, connected) |

## Auto-Launch (PostToolUse Hook)

A PostToolUse hook on `Write` automatically launches the viewer whenever a markdown file is written to disk. **No manual invocation needed** — just write the file and the viewer appears. If a server is already running, the hook silently adds new files via the API.

### Detection (deny-list approach)

Any `.md` file triggers the hook **unless** it matches the deny list:

**Ignored filenames:** `CLAUDE.md`, `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `LICENSE.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`

**Ignored paths:** `/.claude/`, `/node_modules/`, `/.git/`

### Duplicate prevention

A PID registry at `/tmp/live-md-viewer-registry.json` tracks active viewers. The hook adds files to the running server instead of spawning duplicates.
