#!/usr/bin/env node
/**
 * live-md-viewer server — Multi-file markdown viewer with sidebar and live reload
 *
 * Usage:
 *   node server.mjs <markdown-file> [--port <port>] [--no-open]
 *   node server.mjs --stdin [--port <port>] [--no-open]
 *   echo "# Hello" | node server.mjs --stdin
 *
 * Runtime API:
 *   POST /api/add-file  { "file": "/absolute/path.md" }  — add a file to the sidebar
 *   GET  /api/files                                       — list tracked files
 *   GET  /api/content?file=<path>                         — get content for a file
 *   GET  /api/events                                      — SSE stream (reload, file-added)
 *
 * Output (JSON to stdout):
 *   { "pid": 12345, "port": 4900, "url": "http://localhost:4900", "files": ["/path/to/file.md"] }
 */

import http from "node:http";
import net from "node:net";
import { existsSync, readFileSync, writeFileSync, watchFile, unwatchFile, unlinkSync } from "node:fs";
import { basename, resolve } from "node:path";
import { spawn } from "node:child_process";

const REGISTRY_PATH = "/tmp/live-md-viewer-registry.json";

// ── Parse arguments ──────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const config = { file: null, port: 4900, noOpen: false, fromStdin: false };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--port":
        config.port = parseInt(args[++i], 10);
        break;
      case "--no-open":
        config.noOpen = true;
        break;
      case "--stdin":
        config.fromStdin = true;
        break;
      default:
        if (!args[i].startsWith("-")) {
          config.file = resolve(args[i]);
        }
        break;
    }
  }

  return config;
}

// ── Port finder ──────────────────────────────────────────────────────────────

function findOpenPort(startPort) {
  return new Promise((resolve, reject) => {
    let port = startPort;
    const tryPort = () => {
      if (port >= startPort + 100) {
        reject(new Error(`No open port found in range ${startPort}-${startPort + 99}`));
        return;
      }
      const srv = net.createServer();
      srv.once("error", () => { port++; tryPort(); });
      srv.once("listening", () => srv.close(() => resolve(port)));
      srv.listen(port);
    };
    tryPort();
  });
}

// ── Multi-file state ─────────────────────────────────────────────────────────

const trackedFiles = new Map(); // path → content
let activeFile = "";
let stdinTmpFile = null;

function readMarkdown(filePath) {
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return `*File not found: ${filePath}*`;
  }
}

function addFile(filePath) {
  if (trackedFiles.has(filePath)) return false;

  const content = readMarkdown(filePath);
  trackedFiles.set(filePath, content);

  // Watch for changes
  watchFile(filePath, { interval: 500 }, () => {
    const newContent = readMarkdown(filePath);
    if (newContent !== trackedFiles.get(filePath)) {
      trackedFiles.set(filePath, newContent);
      notifyClients("reload", filePath);
    }
  });

  return true;
}

function getFileList() {
  return Array.from(trackedFiles.keys()).map((p) => ({
    path: p,
    name: basename(p, ".md"),
  }));
}

// ── SSE connections ──────────────────────────────────────────────────────────

const sseClients = new Set(); // Set of http.ServerResponse

function notifyClients(event, filePath) {
  const data = filePath ? JSON.stringify({ event, file: filePath }) : JSON.stringify({ event });
  for (const client of sseClients) {
    try {
      client.write(`data: ${data}\n\n`);
    } catch {
      sseClients.delete(client);
    }
  }
}

// ── Request body helper ─────────────────────────────────────────────────────

function getBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

// ── Stdin reader ─────────────────────────────────────────────────────────────

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString();
}

// ── HTML template ────────────────────────────────────────────────────────────
// NOTE: All user-generated content in the client-side code is sanitized via
// DOMPurify before DOM insertion. The innerHTML usage below is intentional —
// marked.js output is passed through DOMPurify.sanitize() before rendering.

function htmlPage() {
  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Live MD Viewer</title>
  <style>
    /* ── Dark theme (default) ──────────────────── */
    [data-theme="dark"] {
      --bg: #0d1117;
      --fg: #e6edf3;
      --muted: #8b949e;
      --border: #30363d;
      --link: #58a6ff;
      --code-bg: #161b22;
      --accent: #1f6feb;
      --table-alt: #161b22;
      --blockquote-border: #3b82f6;
      --blockquote-bg: rgba(59, 130, 246, 0.05);
      --sidebar-bg: #010409;
      --sidebar-hover: #161b22;
      --sidebar-active: #1f6feb;
      --btn-bg: #21262d;
      --btn-hover: #30363d;
      --btn-fg: #c9d1d9;
    }

    /* ── Light theme ───────────────────────────── */
    [data-theme="light"] {
      --bg: #ffffff;
      --fg: #1f2328;
      --muted: #656d76;
      --border: #d0d7de;
      --link: #0969da;
      --code-bg: #f6f8fa;
      --accent: #0969da;
      --table-alt: #f6f8fa;
      --blockquote-border: #0969da;
      --blockquote-bg: rgba(9, 105, 218, 0.04);
      --sidebar-bg: #f6f8fa;
      --sidebar-hover: #eaeef2;
      --sidebar-active: #0969da;
      --btn-bg: #f3f4f6;
      --btn-hover: #e5e7eb;
      --btn-fg: #1f2328;
    }

    --sidebar-width: 240px;

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--fg);
      line-height: 1.7;
      display: flex;
      height: 100vh;
      overflow: hidden;
    }

    /* ── Sidebar ─────────────────────────────────── */

    .sidebar {
      width: 240px;
      min-width: 240px;
      background: var(--sidebar-bg);
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .sidebar-header {
      padding: 0.75rem 1rem;
      border-bottom: 1px solid var(--border);
      font-size: 0.75rem;
      font-weight: 600;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .live-dot {
      width: 7px; height: 7px;
      border-radius: 50%;
      background: #3fb950;
      display: inline-block;
      animation: pulse 2s ease-in-out infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }

    .file-list {
      flex: 1;
      overflow-y: auto;
      padding: 0.25rem 0;
    }

    .file-item {
      display: flex;
      align-items: center;
      padding: 0.5rem 1rem;
      cursor: pointer;
      font-size: 0.8rem;
      color: var(--muted);
      border-left: 2px solid transparent;
      transition: all 0.15s ease;
      gap: 8px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .file-item:hover {
      background: var(--sidebar-hover);
      color: var(--fg);
    }

    .file-item.active {
      background: var(--sidebar-hover);
      color: var(--fg);
      border-left-color: var(--sidebar-active);
    }

    .file-icon {
      flex-shrink: 0;
      width: 14px;
      height: 14px;
      opacity: 0.6;
    }

    .file-name {
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .sidebar-footer {
      padding: 0.5rem 1rem;
      border-top: 1px solid var(--border);
      font-size: 0.65rem;
      color: var(--muted);
      opacity: 0.5;
    }

    /* ── Main content ────────────────────────────── */

    .main {
      flex: 1;
      overflow-y: auto;
    }

    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.75rem 2.5rem;
      border-bottom: 1px solid var(--border);
      position: sticky;
      top: 0;
      background: var(--bg);
      z-index: 10;
    }

    .container {
      max-width: 900px;
      margin: 0 auto;
      padding: 2rem 2.5rem;
    }

    .header-info {
      min-width: 0;
      overflow: hidden;
    }

    .header-name {
      font-size: 0.9rem;
      font-weight: 600;
      color: var(--fg);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .header-path {
      font-size: 0.7rem;
      color: var(--muted);
      font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      margin-top: 2px;
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 4px 10px;
      font-size: 0.75rem;
      color: var(--btn-fg);
      background: var(--btn-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      cursor: pointer;
      transition: background 0.15s ease;
      font-family: inherit;
      line-height: 1.4;
    }

    .btn:hover { background: var(--btn-hover); }

    .btn svg {
      width: 14px;
      height: 14px;
      flex-shrink: 0;
    }

    #content h1, #content h2, #content h3,
    #content h4, #content h5, #content h6 {
      margin-top: 2rem;
      margin-bottom: 0.75rem;
      font-weight: 600;
      line-height: 1.3;
    }

    #content h1 { font-size: 2rem; padding-bottom: 0.5rem; border-bottom: 1px solid var(--border); }
    #content h2 { font-size: 1.5rem; padding-bottom: 0.4rem; border-bottom: 1px solid var(--border); }
    #content h3 { font-size: 1.25rem; }
    #content h4 { font-size: 1rem; }

    #content p { margin-bottom: 1rem; }

    #content a { color: var(--link); text-decoration: none; }
    #content a:hover { text-decoration: underline; }

    #content code {
      font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
      font-size: 0.875em;
      background: var(--code-bg);
      padding: 0.15em 0.4em;
      border-radius: 4px;
      border: 1px solid var(--border);
    }

    #content pre {
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1rem 1.25rem;
      overflow-x: auto;
      margin-bottom: 1.25rem;
      line-height: 1.5;
    }

    #content pre code {
      background: none;
      border: none;
      padding: 0;
      font-size: 0.85rem;
    }

    #content blockquote {
      border-left: 3px solid var(--blockquote-border);
      background: var(--blockquote-bg);
      padding: 0.75rem 1rem;
      margin: 0 0 1rem;
      border-radius: 0 6px 6px 0;
      color: var(--muted);
    }

    #content blockquote p { margin-bottom: 0; }

    #content table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 1.25rem;
      font-size: 0.9rem;
    }

    #content th, #content td {
      padding: 0.5rem 0.75rem;
      border: 1px solid var(--border);
      text-align: left;
    }

    #content th {
      background: var(--code-bg);
      font-weight: 600;
    }

    #content tr:nth-child(even) { background: var(--table-alt); }

    #content ul, #content ol {
      padding-left: 1.5rem;
      margin-bottom: 1rem;
    }

    #content li { margin-bottom: 0.35rem; }
    #content li > ul, #content li > ol { margin-bottom: 0; margin-top: 0.25rem; }

    #content hr {
      border: none;
      border-top: 1px solid var(--border);
      margin: 2rem 0;
    }

    #content img { max-width: 100%; border-radius: 6px; }

    #content input[type="checkbox"] {
      margin-right: 0.5rem;
      accent-color: var(--accent);
    }

    #content strong { font-weight: 600; }

    .mermaid {
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1rem;
      margin-bottom: 1.25rem;
      text-align: center;
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 60vh;
      color: var(--muted);
      font-size: 0.9rem;
      gap: 0.5rem;
    }

    .empty-state-icon { font-size: 2rem; opacity: 0.3; }

    .disconnected .live-dot { background: #f85149; animation: none; }

    .new-badge {
      background: var(--accent);
      color: white;
      font-size: 0.6rem;
      padding: 1px 5px;
      border-radius: 8px;
      margin-left: auto;
      flex-shrink: 0;
      animation: fadeIn 0.3s ease;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: scale(0.8); }
      to { opacity: 1; transform: scale(1); }
    }
  </style>
</head>
<body>
  <div class="sidebar">
    <div class="sidebar-header" id="status">
      <span class="live-dot"></span>
      Files
    </div>
    <div class="file-list" id="file-list"></div>
    <div class="sidebar-footer" id="file-count">0 files</div>
  </div>

  <div class="main">
    <div class="header">
      <div class="header-info">
        <div class="header-name" id="current-name">Select a file</div>
        <div class="header-path" id="current-path"></div>
      </div>
      <div class="header-actions">
        <button class="btn" id="download-btn" onclick="downloadFile()" title="Download markdown">
          <svg viewBox="0 0 16 16" fill="currentColor"><path d="M2.75 14A1.75 1.75 0 011 12.25v-2.5a.75.75 0 011.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 00.25-.25v-2.5a.75.75 0 011.5 0v2.5A1.75 1.75 0 0113.25 14H2.75z"/><path d="M7.25 7.689V2a.75.75 0 011.5 0v5.689l1.97-1.969a.749.749 0 111.06 1.06l-3.25 3.25a.749.749 0 01-1.06 0L4.22 6.78a.749.749 0 111.06-1.06l1.97 1.969z"/></svg>
          Save
        </button>
        <button class="btn" id="theme-btn" onclick="toggleTheme()" title="Toggle light/dark mode">
          <svg id="theme-icon-sun" viewBox="0 0 16 16" fill="currentColor" style="display:none"><path d="M8 12a4 4 0 100-8 4 4 0 000 8zM8 0a.75.75 0 01.75.75v1.5a.75.75 0 01-1.5 0V.75A.75.75 0 018 0zm0 13a.75.75 0 01.75.75v1.5a.75.75 0 01-1.5 0v-1.5A.75.75 0 018 13zM2.343 2.343a.75.75 0 011.061 0l1.06 1.061a.75.75 0 01-1.06 1.06l-1.06-1.06a.75.75 0 010-1.06zm9.193 9.193a.75.75 0 011.06 0l1.061 1.06a.75.75 0 01-1.06 1.061l-1.061-1.06a.75.75 0 010-1.061zM0 8a.75.75 0 01.75-.75h1.5a.75.75 0 010 1.5H.75A.75.75 0 010 8zm13 0a.75.75 0 01.75-.75h1.5a.75.75 0 010 1.5h-1.5A.75.75 0 0113 8zM2.343 13.657a.75.75 0 010-1.06l1.06-1.061a.75.75 0 111.061 1.06l-1.06 1.061a.75.75 0 01-1.061 0zm9.193-9.193a.75.75 0 010-1.06l1.061-1.061a.75.75 0 111.06 1.06l-1.06 1.061a.75.75 0 01-1.061 0z"/></svg>
          <svg id="theme-icon-moon" viewBox="0 0 16 16" fill="currentColor"><path d="M9.598 1.591a.749.749 0 01.785-.175 7.001 7.001 0 11-8.967 8.967.75.75 0 01.961-.96 5.5 5.5 0 007.046-7.046.75.75 0 01.175-.786z"/></svg>
        </button>
      </div>
    </div>
    <div class="container">
      <div id="content">
        <div class="empty-state">
          <div class="empty-state-icon">&#128196;</div>
          <div>Waiting for reports...</div>
        </div>
      </div>
    </div>
  </div>

  <link id="hljs-theme" rel="stylesheet" href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/styles/github-dark.min.css">
  <script src="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/highlight.min.js"><\/script>
  <script src="https://cdn.jsdelivr.net/npm/marked@15/marked.min.js"><\/script>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"><\/script>
  <script src="https://cdn.jsdelivr.net/npm/dompurify@3/dist/purify.min.js"><\/script>

  <script>
    // ── Theme management ────────────────────────
    var currentTheme = localStorage.getItem('plv-theme') || 'dark';
    document.documentElement.setAttribute('data-theme', currentTheme);
    updateMermaidTheme();
    updateThemeIcons();

    function toggleTheme() {
      currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', currentTheme);
      localStorage.setItem('plv-theme', currentTheme);
      updateThemeIcons();
      updateMermaidTheme();
      renderContent();
    }

    function updateThemeIcons() {
      document.getElementById('theme-icon-sun').style.display = currentTheme === 'dark' ? 'none' : 'block';
      document.getElementById('theme-icon-moon').style.display = currentTheme === 'dark' ? 'block' : 'none';
      document.getElementById('hljs-theme').href = currentTheme === 'dark'
        ? 'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/styles/github-dark.min.css'
        : 'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/styles/github.min.css';
    }

    function updateMermaidTheme() {
      var isDark = currentTheme === 'dark';
      mermaid.initialize({
        startOnLoad: false,
        theme: isDark ? 'dark' : 'default',
        themeVariables: isDark ? {
          darkMode: true,
          background: '#0d1117',
          primaryColor: '#1f6feb',
          primaryTextColor: '#e6edf3',
          lineColor: '#8b949e',
        } : {
          darkMode: false,
          background: '#ffffff',
          primaryColor: '#0969da',
          primaryTextColor: '#1f2328',
          lineColor: '#656d76',
        }
      });
    }

    // ── Marked renderer ─────────────────────────
    var renderer = new marked.Renderer();

    renderer.code = function({ text, lang }) {
      if (lang === 'mermaid') {
        return '<div class="mermaid">' + DOMPurify.sanitize(text) + '</div>';
      }
      var langClass = lang ? ' class="language-' + DOMPurify.sanitize(lang) + '"' : '';
      var escaped = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      return '<pre><code' + langClass + '>' + escaped + '</code></pre>';
    };

    renderer.listitem = function({ text, task, checked }) {
      if (task) {
        return '<li><input type="checkbox" disabled' + (checked ? ' checked' : '') + '> ' + text + '</li>\\n';
      }
      return '<li>' + text + '</li>\\n';
    };

    marked.setOptions({ renderer: renderer, gfm: true, breaks: false });

    // ── State ───────────────────────────────────
    var files = [];
    var activeFile = null;
    var lastMarkdown = '';
    var newFiles = new Set();

    // ── Download ────────────────────────────────
    function downloadFile() {
      if (!activeFile || !lastMarkdown) return;
      var name = activeFile.split('/').pop() || 'document.md';
      var blob = new Blob([lastMarkdown], { type: 'text/markdown;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    }

    // ── File list rendering ─────────────────────
    // File list items use DOMPurify.sanitize() for file names.
    // The SVG icon is a static trusted string, not user content.
    function renderFileList() {
      var listEl = document.getElementById('file-list');
      var countEl = document.getElementById('file-count');
      listEl.textContent = '';

      files.forEach(function(f) {
        var item = document.createElement('div');
        item.className = 'file-item' + (f.path === activeFile ? ' active' : '');
        item.onclick = function() { selectFile(f.path); };

        // Build icon via DOM
        var icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        icon.setAttribute('class', 'file-icon');
        icon.setAttribute('viewBox', '0 0 16 16');
        icon.setAttribute('fill', 'currentColor');
        var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M3.75 1.5a.25.25 0 00-.25.25v12.5c0 .138.112.25.25.25h8.5a.25.25 0 00.25-.25V4.664a.25.25 0 00-.073-.177l-2.914-2.914a.25.25 0 00-.177-.073H3.75zM2 1.75C2 .784 2.784 0 3.75 0h5.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0112.25 16h-8.5A1.75 1.75 0 012 14.25V1.75z');
        icon.appendChild(path);
        item.appendChild(icon);

        var nameSpan = document.createElement('span');
        nameSpan.className = 'file-name';
        nameSpan.textContent = f.name;
        item.appendChild(nameSpan);

        if (newFiles.has(f.path)) {
          var badge = document.createElement('span');
          badge.className = 'new-badge';
          badge.textContent = 'new';
          item.appendChild(badge);
        }

        listEl.appendChild(item);
      });

      countEl.textContent = files.length + ' file' + (files.length !== 1 ? 's' : '');
    }

    // ── File selection & rendering ──────────────
    function selectFile(path) {
      activeFile = path;
      newFiles.delete(path);
      renderFileList();
      renderContent();
      var f = files.find(function(f) { return f.path === path; });
      document.getElementById('current-name').textContent = f ? f.name : 'Unknown';
      document.getElementById('current-path').textContent = path;
    }

    // Markdown is rendered via marked.js and sanitized through DOMPurify
    // before being inserted into the DOM.
    async function renderContent() {
      if (!activeFile) return;
      try {
        var resp = await fetch('/api/content?file=' + encodeURIComponent(activeFile));
        var md = await resp.text();
        lastMarkdown = md;
        var rawHtml = marked.parse(md);
        var clean = DOMPurify.sanitize(rawHtml, {
          ADD_TAGS: ['input'],
          ADD_ATTR: ['checked', 'disabled', 'type', 'class'],
          ALLOW_DATA_ATTR: false
        });
        var contentEl = document.getElementById('content');
        contentEl.textContent = '';
        contentEl.insertAdjacentHTML('afterbegin', clean);
        // Syntax highlighting
        document.querySelectorAll('#content pre code').forEach(function(block) {
          block.removeAttribute('data-highlighted');
          hljs.highlightElement(block);
        });
        // Mermaid diagrams
        var charts = document.querySelectorAll('.mermaid');
        if (charts.length > 0) {
          for (var el of charts) { el.removeAttribute('data-processed'); }
          await mermaid.run({ nodes: charts });
        }
      } catch (e) {
        console.error('Render error:', e);
      }
    }

    // ── Load initial file list ──────────────────
    async function loadFiles() {
      try {
        var resp = await fetch('/api/files');
        files = await resp.json();
        renderFileList();
        if (!activeFile && files.length > 0) {
          selectFile(files[files.length - 1].path);
        }
      } catch (e) {
        console.error('Failed to load files:', e);
      }
    }

    // ── SSE for live reload ─────────────────────
    function connectSSE() {
      var evtSource = new EventSource('/api/events');
      var statusEl = document.getElementById('status');

      evtSource.onmessage = function(e) {
        try {
          var msg = JSON.parse(e.data);

          if (msg.event === 'reload' && msg.file === activeFile) {
            renderContent();
          }

          if (msg.event === 'file-added') {
            var name = msg.file.split('/').pop().replace(/\\.md$/, '');
            files.push({ path: msg.file, name: name });
            newFiles.add(msg.file);
            renderFileList();
            selectFile(msg.file);
          }
        } catch {}
      };

      evtSource.onopen = function() {
        statusEl.classList.remove('disconnected');
      };

      evtSource.onerror = function() {
        statusEl.classList.add('disconnected');
        evtSource.close();
        setTimeout(connectSSE, 2000);
      };
    }

    loadFiles();
    connectSSE();
  <\/script>
</body>
</html>`;
}

// ── Main ─────────────────────────────────────────────────────────────────────

const config = parseArgs();

// Handle stdin mode
if (config.fromStdin) {
  const stdinContent = await readStdin();
  if (!stdinContent.trim()) {
    console.error("ERROR: --stdin specified but no input received");
    process.exit(1);
  }
  stdinTmpFile = `/tmp/live-md-viewer-${Date.now()}.md`;
  writeFileSync(stdinTmpFile, stdinContent);
  config.file = stdinTmpFile;
} else if (!config.file) {
  console.error("Usage: node server.mjs <markdown-file> [--port <port>] [--no-open]");
  console.error("       node server.mjs --stdin [--port <port>] [--no-open]");
  process.exit(1);
} else if (!existsSync(config.file)) {
  console.error(`ERROR: File not found: ${config.file}`);
  process.exit(1);
}

// Add initial file
addFile(config.file);
activeFile = config.file;

// Find open port
const port = await findOpenPort(config.port);

// HTTP server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);

  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(htmlPage());
    return;
  }

  // ── API: list files ───────────────────────
  if (url.pathname === "/api/files") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getFileList()));
    return;
  }

  // ── API: get content for a file ───────────
  if (url.pathname === "/api/content") {
    const filePath = url.searchParams.get("file");
    if (!filePath || !trackedFiles.has(filePath)) {
      res.writeHead(404);
      res.end("File not found");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(trackedFiles.get(filePath));
    return;
  }

  // ── API: add a new file ───────────────────
  if (url.pathname === "/api/add-file" && req.method === "POST") {
    try {
      const body = await getBody(req);
      const { file: filePath } = JSON.parse(body);
      if (!filePath || typeof filePath !== "string") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing 'file' field" }));
        return;
      }
      const resolved = resolve(filePath);
      if (!existsSync(resolved)) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "File not found" }));
        return;
      }
      const isNew = addFile(resolved);
      if (isNew) notifyClients("file-added", resolved);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ added: isNew, file: resolved, files: getFileList() }));
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
    }
    return;
  }

  // ── API: SSE events ───────────────────────
  if (url.pathname === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    sseClients.add(res);
    res.write(`data: ${JSON.stringify({ event: "connected" })}\n\n`);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(port, () => {
  // Write registry so the hook can find us
  writeFileSync(REGISTRY_PATH, JSON.stringify({ pid: process.pid, port, startedAt: new Date().toISOString() }, null, 2));

  // Output structured info to stdout
  const info = {
    pid: process.pid,
    port,
    url: `http://localhost:${port}`,
    files: Array.from(trackedFiles.keys()),
  };
  console.log(JSON.stringify(info));

  // Open browser
  if (!config.noOpen) {
    const cmd = process.platform === "darwin" ? "open"
      : process.platform === "win32" ? "start"
      : "xdg-open";
    spawn(cmd, [`http://localhost:${port}`], { stdio: "ignore", detached: true }).unref();
  }
});

// Graceful shutdown
function shutdown() {
  for (const filePath of trackedFiles.keys()) {
    unwatchFile(filePath);
  }
  server.close();
  try { writeFileSync(REGISTRY_PATH, "null"); } catch {}
  if (stdinTmpFile && existsSync(stdinTmpFile)) {
    try { unlinkSync(stdinTmpFile); } catch {}
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
