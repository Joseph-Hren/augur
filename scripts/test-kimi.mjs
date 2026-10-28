#!/usr/bin/env node
// Local-only comparison harness for trying Kimi (Moonshot AI) as AUGUR's
// evaluation model instead of Claude. Not part of the deployed app — run
// with: node --env-file=.env.local scripts/test-kimi.mjs <url> [--thinking=on|off]
//
// Reuses the same screenshot/axe capture, system prompt, and tool schema as
// the real API route (lib/evaluation.js) so this is a fair comparison: only
// the model call itself differs.

import { mkdir, writeFile } from "fs/promises";
import path from "path";
import {
  analyzePage,
  EVALUATION_TOOL,
  SYSTEM_PROMPT,
  NO_VIOLATIONS_CARD,
  normalizeEvaluation,
  normalizeUrl,
} from "../lib/evaluation.js";

// 5 minutes — long enough to tell "still thinking" apart from genuinely
// stuck, per the runaway-whitespace failure seen with thinking mode ON in
// an earlier project.
const TIMEOUT_MS = 5 * 60 * 1000;
const KIMI_ENDPOINT = "https://api.moonshot.ai/v1/chat/completions";
const KIMI_MODEL = "kimi-k2.6";
const OUTPUT_DIR = path.join(process.cwd(), "kimi-test-output");

function parseArgs(argv) {
  const args = { thinking: true };
  for (const arg of argv) {
    if (arg.startsWith("--thinking=")) {
      args.thinking = arg.split("=")[1] !== "off";
    } else if (!arg.startsWith("--")) {
      args.url = arg;
    }
  }
  return args;
}

// Kimi's tool_choice only accepts "auto" or "none" — unlike Anthropic's
// API, there's no way to force the submit_evaluation call specifically. If
// the model answers in plain text instead, that's a real failure mode to
// fix with prompt tweaking, not something to paper over here.
const KIMI_TOOL = {
  type: "function",
  function: {
    name: EVALUATION_TOOL.name,
    description: EVALUATION_TOOL.description,
    parameters: EVALUATION_TOOL.input_schema,
  },
};

async function main() {
  const { url: rawUrl, thinking } = parseArgs(process.argv.slice(2));
  if (!rawUrl) {
    console.error("Usage: node --env-file=.env.local scripts/test-kimi.mjs <url> [--thinking=on|off]");
    process.exit(1);
  }
  if (!process.env.KIMI_API_KEY) {
    console.error("KIMI_API_KEY not set. Run with: node --env-file=.env.local scripts/test-kimi.mjs ...");
    process.exit(1);
  }

  const url = normalizeUrl(rawUrl.trim());
  console.log(`[1/2] Capturing screenshot + axe scan for ${url}...`);
  const { screenshotBase64, violationsText, hadNoViolations } = await analyzePage(url);

  console.log(`[2/2] Calling Kimi (thinking=${thinking ? "on" : "off"}, timeout=${TIMEOUT_MS / 1000}s)...`);
  const body = {
    model: KIMI_MODEL,
    thinking: { type: thinking ? "enabled" : "disabled" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:image/png;base64,${screenshotBase64}` } },
          { type: "text", text: `URL: ${url}` },
          {
            type: "text",
            text: `Automated accessibility scan (axe-core) — confirmed violations:\n\n${violationsText}`,
          },
        ],
      },
    ],
    tools: [KIMI_TOOL],
    tool_choice: "auto",
  };

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const start = Date.now();
  let response;
  try {
    response = await fetch(KIMI_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.KIMI_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") {
      console.error(`\n✗ TIMED OUT after ${TIMEOUT_MS / 1000}s. Treat as a failed run — try --thinking=off.`);
      process.exit(1);
    }
    throw err;
  } finally {
    clearTimeout(timeoutHandle);
  }
  const elapsedSec = ((Date.now() - start) / 1000).toFixed(1);

  const json = await response.json();
  await mkdir(OUTPUT_DIR, { recursive: true });
  const stamp = Date.now();
  const rawFile = path.join(OUTPUT_DIR, `raw-${stamp}.json`);
  await writeFile(rawFile, JSON.stringify(json, null, 2));

  if (!response.ok) {
    console.error(`\n✗ Kimi API error (${response.status}). Full response saved to ${rawFile}`);
    console.error(JSON.stringify(json, null, 2).slice(0, 1000));
    process.exit(1);
  }

  const message = json.choices?.[0]?.message;
  const reasoning = message?.reasoning_content || "";
  const usage = json.usage || {};
  console.log(`\nElapsed: ${elapsedSec}s`);
  console.log(
    `Tokens — prompt: ${usage.prompt_tokens}, completion: ${usage.completion_tokens}, total: ${usage.total_tokens}`,
  );
  console.log(`Reasoning length: ${reasoning.length} chars`);

  // The known failure mode: a flood of near-whitespace "reasoning" content
  // is a distinct signal from a normal (verbose but real) thinking trace —
  // flag it explicitly instead of silently treating a huge blob as fine.
  const nonWhitespaceRatio = reasoning.length
    ? reasoning.replace(/\s/g, "").length / reasoning.length
    : 1;
  if (reasoning.length > 20000 && nonWhitespaceRatio < 0.5) {
    console.warn(
      "⚠ Reasoning content is huge and mostly whitespace — looks like the runaway-thinking failure mode. Try --thinking=off.",
    );
  }

  const toolCall = message?.tool_calls?.[0];
  if (!toolCall) {
    console.error(`\n✗ No tool call returned — Kimi answered in plain text instead of calling submit_evaluation.`);
    console.error("finish_reason:", json.choices?.[0]?.finish_reason);
    console.error("content:", (message?.content || "").slice(0, 500));
    console.error(`Full response saved to ${rawFile}`);
    process.exit(1);
  }

  let evaluation;
  try {
    evaluation = JSON.parse(toolCall.function.arguments);
  } catch (err) {
    console.error(`\n✗ Tool call arguments were not valid JSON: ${err.message}`);
    console.error(toolCall.function.arguments.slice(0, 500));
    console.error(`Full response saved to ${rawFile}`);
    process.exit(1);
  }

  if (
    !Array.isArray(evaluation.workingWell) ||
    !Array.isArray(evaluation.heuristicIssues) ||
    !Array.isArray(evaluation.accessibilityIssues)
  ) {
    console.error("\n✗ Malformed evaluation — missing expected arrays.");
    console.error(JSON.stringify(evaluation, null, 2).slice(0, 1000));
    console.error(`Full response saved to ${rawFile}`);
    process.exit(1);
  }

  const normalized = normalizeEvaluation(evaluation);
  if (hadNoViolations) {
    normalized.accessibilityIssues = [NO_VIOLATIONS_CARD];
  }

  console.log("\n✓ Got a structured evaluation:");
  console.log(`  workingWell: ${normalized.workingWell.length}`);
  console.log(`  heuristicIssues: ${normalized.heuristicIssues.length}`);
  console.log(`  accessibilityIssues: ${normalized.accessibilityIssues.length}`);

  const evalFile = path.join(OUTPUT_DIR, `evaluation-${stamp}.json`);
  await writeFile(evalFile, JSON.stringify(normalized, null, 2));
  console.log(`\nRaw response:          ${rawFile}`);
  console.log(`Normalized evaluation: ${evalFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
