#!/usr/bin/env node
/**
 * PostToolUse hook for Write — detects markdown files and manages the viewer.
 *
 * Two modes:
 *   1. Server already running → silently adds the file via POST /api/add-file
 *   2. No server running → outputs additionalContext instructing the LLM to
 *      launch the server via Bash(run_in_background: true) as a tracked task
 *
 * IMPORTANT: Plain stdout from PostToolUse hooks is NOT visible to the LLM.
 * Only hookSpecificOutput.additionalContext is appended to the tool result
 * and seen by the LLM. This is why previous systemMessage/plain-text
 * approaches were silently ignored.
 *
 * Detection: any .md file triggers the viewer UNLESS it matches the deny list
 * (common config/meta files and ignored path segments).
 *
 * Input (stdin JSON from Claude Code):
 *   { "tool_input": { "file_path": "...", "content": "..." }, "tool_response": "..." }
 *
 * Output:
 *   - Silent (no stdout) when file is added to existing server or not viewable
 *   - JSON with hookSpecificOutput.additionalContext when server needs launching
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
    // Server is running — add file via API (silent, no stdout)
    await addFileToServer(entry.port, resolvedPath);
    process.exit(0);
  }

  // No server running — instruct the LLM to launch it as a tracked background task.
  // hookSpecificOutput.additionalContext is appended to the Write tool result
  // so the LLM actually sees it (unlike plain stdout which is hidden).
  const instruction = [
    `[live-md-viewer] A viewable markdown file was written: ${resolvedPath}`,
    ``,
    `You MUST now launch the live markdown viewer as a background task by running:`,
    ``,
    `Bash({`,
    `  command: "node ${SERVER_PATH} ${resolvedPath}",`,
    `  run_in_background: true,`,
    `  description: "Live markdown viewer"`,
    `})`,
    ``,
    `The browser will open automatically. Tell the user the viewer URL after it launches.`,
  ].join("\n");

  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: instruction,
      },
    })
  );
} catch (err) {
  console.error(`[live-md-viewer] Hook error: ${err.message}`);
}

process.exit(0);
