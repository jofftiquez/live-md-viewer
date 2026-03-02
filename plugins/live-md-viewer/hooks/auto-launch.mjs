#!/usr/bin/env node
/**
 * PostToolUse hook for Write — detects markdown files and adds them to a
 * running viewer server.
 *
 * This hook is a **silent file-adder only**. It does NOT launch the server.
 * Server launch is handled by the LLM via SKILL.md instructions, which
 * produces a tracked Claude Code background task.
 *
 * Behaviour:
 *   - Server running → silently adds the file via POST /api/add-file
 *   - No server running → exits silently (SKILL.md handles launch)
 *
 * Detection: any .md file triggers the hook UNLESS it matches the deny list
 * (common config/meta files and ignored path segments).
 *
 * Input (stdin JSON from Claude Code):
 *   { "tool_input": { "file_path": "...", "content": "..." }, "tool_response": "..." }
 *
 * Output:
 *   - Always silent (no stdout) — all communication goes through SKILL.md
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const REGISTRY_PATH = "/tmp/live-md-viewer-registry.json";

// ── Registry management ──────────────────────────────────────────────────────

function loadRegistry() {
  try {
    if (existsSync(REGISTRY_PATH)) {
      const data = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
      if (Array.isArray(data)) return data[0] ?? null;
      return data;
    }
  } catch (err) {
    console.error(`[live-md-viewer] Failed to load registry: ${err.message}`);
  }
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

// ── Markdown detection (deny-list approach) ─────────────────────────────────

const IGNORED_FILENAMES = new Set([
  "claude.md",
  "readme.md",
  "changelog.md",
  "contributing.md",
  "license.md",
  "code_of_conduct.md",
  "security.md",
]);

const IGNORED_PATH_SEGMENTS = ["/.claude/", "/node_modules/", "/.git/"];

function isViewableMarkdown(filePath) {
  if (!filePath.endsWith(".md")) return false;

  const lowerPath = filePath.toLowerCase();
  const lowerName = basename(filePath).toLowerCase();

  if (IGNORED_FILENAMES.has(lowerName)) return false;

  for (const seg of IGNORED_PATH_SEGMENTS) {
    if (lowerPath.includes(seg)) return false;
  }

  return true;
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

  if (!filePath) process.exit(0);

  const resolvedPath = resolve(filePath);

  if (!isViewableMarkdown(resolvedPath)) process.exit(0);

  // Check for running server
  const entry = loadRegistry();

  if (entry && isProcessAlive(entry.pid) && entry.port > 0) {
    // Server is running — add file via API (silent)
    await addFileToServer(entry.port, resolvedPath);
  }

  // No server running — do nothing; SKILL.md instructs the LLM to launch it
} catch (err) {
  console.error(`[live-md-viewer] Hook error: ${err.message}`);
}

process.exit(0);
