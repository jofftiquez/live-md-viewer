#!/usr/bin/env node
/**
 * PostToolUse hook for Write — detects markdown reports and manages the viewer.
 *
 * Two modes:
 *   1. Server already running → silently adds the file via POST /api/add-file
 *   2. No server running → outputs a launch directive for the LLM to execute
 *      via Bash(run_in_background: true) so it's tracked as a Claude Code task
 *
 * The hook NEVER spawns the server itself — that's the LLM's job, so the
 * process is tracked and can be killed through Claude Code's task management.
 *
 * Input (stdin JSON from Claude Code):
 *   { "tool_input": { "file_path": "...", "content": "..." }, "tool_response": "..." }
 *
 * Output:
 *   - Silent (no stdout) when file is added to existing server or not a report
 *   - Launch directive to stdout when a new server is needed
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = "/tmp/live-md-viewer-registry.json";
const SERVER_PATH = resolve(__dirname, "..", "server.mjs");

// ── Registry management ──────────────────────────────────────────────────────

function loadRegistry() {
  try {
    if (existsSync(REGISTRY_PATH)) {
      const data = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
      if (Array.isArray(data)) return data[0] ?? null;
      return data;
    }
  } catch {}
  return null;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── Report detection ─────────────────────────────────────────────────────────

const IGNORED_FILENAMES = new Set([
  "claude.md",
  "readme.md",
  "changelog.md",
  "contributing.md",
  "license.md",
  "code_of_conduct.md",
  "security.md",
]);

const IGNORED_PATH_SEGMENTS = [
  "/.claude/skills/",
  "/.claude/agents/",
  "/.claude/commands/",
  "/.claude/plugins/",
  "/node_modules/",
];

const REPORT_PATH_SIGNALS = [
  "/docs/",
  "/temp/",
  "/plans/",
  "/reports/",
  "/tmp/",
  "/analysis/",
  "/audits/",
];

const REPORT_FILENAME_SIGNALS = [
  "report",
  "summary",
  "anatomy",
  "audit",
  "gap",
  "analysis",
  "breakdown",
  "review",
  "flow",
  "overview",
  "findings",
  "assessment",
  "diagnostic",
  "plan",
];

function isReportMarkdown(filePath, content) {
  if (!filePath.endsWith(".md")) return false;

  const lowerPath = filePath.toLowerCase();
  const lowerName = basename(filePath).toLowerCase();

  if (IGNORED_FILENAMES.has(lowerName)) return false;

  for (const seg of IGNORED_PATH_SEGMENTS) {
    if (lowerPath.includes(seg)) return false;
  }

  let hasSignal = false;

  for (const sig of REPORT_PATH_SIGNALS) {
    if (lowerPath.includes(sig)) {
      hasSignal = true;
      break;
    }
  }

  if (!hasSignal) {
    const nameNoExt = lowerName.replace(/\.md$/, "");
    for (const sig of REPORT_FILENAME_SIGNALS) {
      if (nameNoExt.includes(sig)) {
        hasSignal = true;
        break;
      }
    }
  }

  if (!hasSignal) {
    const lineCount = content.split("\n").length;
    if (lineCount > 30) {
      const hasStructure =
        (content.match(/^#{1,3} /gm) || []).length >= 3 ||
        content.includes("| ") ||
        (content.match(/^- /gm) || []).length >= 5;
      if (hasStructure) hasSignal = true;
    }
  }

  return hasSignal;
}

// ── Add file to running server ───────────────────────────────────────────────

async function addFileToServer(port, filePath) {
  try {
    const resp = await fetch(`http://localhost:${port}/api/add-file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: filePath }),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

// ── Stdin reader ─────────────────────────────────────────────────────────────

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString();
}

// ── Main ─────────────────────────────────────────────────────────────────────

const input = await readStdin();

try {
  const data = JSON.parse(input);
  const filePath = data.tool_input?.file_path;
  const content = data.tool_input?.content ?? "";

  if (!filePath) process.exit(0);

  const resolvedPath = resolve(filePath);

  if (!isReportMarkdown(resolvedPath, content)) process.exit(0);

  // Check for running server
  const entry = loadRegistry();

  if (entry && isProcessAlive(entry.pid) && entry.port > 0) {
    // Server is running — add file via API (silent)
    await addFileToServer(entry.port, resolvedPath);
    process.exit(0);
  }

  // No server running — output launch directive for the LLM
  // The LLM should run this via Bash with run_in_background: true
  console.log(
    `[live-md-viewer] Report detected: ${resolvedPath}\n` +
    `Launch the viewer as a background task:\n` +
    `node ${SERVER_PATH} "${resolvedPath}"`
  );
} catch {
  // Hook must never block — silently exit on any error
}

process.exit(0);
