import Anthropic from "@anthropic-ai/sdk";
import { chromium } from "playwright-core";
import chromiumBinary from "@sparticuz/chromium-min";
import sharp from "sharp";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "fs";
import { rm } from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { cookies } from "next/headers";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

const MAX_IMAGE_DIMENSION = 8000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // Anthropic's hard limit (10,485,760 bytes exactly)

// The full @sparticuz/chromium package bundles a 64MB+ Chromium binary,
// which exceeds Vercel's serverless function size limit and gets silently
// dropped from the deployed bundle. @sparticuz/chromium-min instead fetches
// this official prebuilt pack from GitHub at cold start (cached in /tmp for
// warm invocations after that). Version pinned to match the installed
// package version — update both together.
const CHROMIUM_PACK_URL =
  "https://github.com/Sparticuz/chromium/releases/download/v149.0.0/chromium-v149.0.0-pack.x64.tar";

// @axe-core/playwright's default source loading breaks under Next.js's
// server bundler ("exports is not defined" when injected into the page).
// Reading axe-core's prebuilt browser bundle directly sidesteps that.
// (A plain path.join, not require.resolve — Next.js's bundler statically
// rewrites require.resolve() into an internal reference that isn't a real
// file path at runtime.)
const axeSource = readFileSync(
  path.join(process.cwd(), "node_modules/axe-core/axe.min.js"),
  "utf8",
);

// Casual/accidental overuse protection — this is not the account's real
// safety net. That's the spend cap set in the Anthropic Console, which
// caps total spend regardless of how a request got made. This limiter
// only exists to stop the common case (someone repeatedly submitting
// URLs) well before that cap is ever relevant.
//
// Only constructed on Vercel: the Upstash credentials are Marketplace
// secrets, readable by a real deployment at runtime but never exportable
// back out (not via `vercel env pull`, not via the dashboard) — a
// deliberate security property, not a gap. Local dev has no way to hold
// those values, so it skips rate limiting entirely rather than requiring
// them; only the deployed app is a shared resource worth protecting.
const redis = process.env.VERCEL ? Redis.fromEnv() : null;

// Two independent limiters, blocked if either is exhausted, rather than
// one limiter keyed on ip+cookie together — a combined key means either
// signal alone (e.g. clearing cookies, or an incognito window) resets the
// count to zero. Requiring both to be defeated at once is a meaningfully
// higher bar for the casual case this exists to stop.
const VISITOR_COOKIE_LIMITER = redis
  ? new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(3, "7 d"), prefix: "ratelimit:cookie" })
  : null;
const IP_LIMITER = redis
  ? new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(3, "7 d"), prefix: "ratelimit:ip" })
  : null;

const VISITOR_COOKIE_NAME = "augur_visitor_id";
const VISITOR_COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

const SEVERITY_ENUM = ["Critical", "Severe", "Moderate", "Minor"];
const CONFIDENCE_ENUM = ["High Confidence", "Confident", "Suspected", "Uncertain"];
const RATING_ENUM = ["Excellent", "Efficient", "Strong", "Adequate"];

// The prompt already instructs "serious" (axe-core's own wording) to be
// reported as "Severe", and the schema's enum reinforces it — but neither
// is a hard guarantee, and this specific leak has been observed in the
// wild. Normalized here, closest to the source, rather than relying on the
// frontend alone to paper over it.
const SEVERITY_ALIASES = { Serious: "Severe" };

function normalizeEvaluation(data) {
  const normalizeIssue = (issue) => ({
    ...issue,
    severity: SEVERITY_ALIASES[issue.severity] ?? issue.severity,
  });
  return {
    ...data,
    heuristicIssues: data.heuristicIssues.map(normalizeIssue),
    accessibilityIssues: data.accessibilityIssues.map(normalizeIssue),
  };
}

const EVALUATION_TOOL = {
  name: "submit_evaluation",
  description:
    "Submit the structured heuristic and accessibility evaluation of the webpage screenshot.",
  input_schema: {
    type: "object",
    properties: {
      workingWell: {
        type: "array",
        description: "Exactly 2 things about the page that are working well.",
        minItems: 2,
        maxItems: 2,
        items: {
          type: "object",
          properties: {
            rating: { type: "string", enum: RATING_ENUM },
            standard: {
              type: "string",
              description: "The one Nielsen-Norman heuristic standard this most relates to.",
            },
            summary: {
              type: "string",
              description: "1-2 sentence summary of what is working well and why.",
            },
            confidence: { type: "string", enum: CONFIDENCE_ENUM },
          },
          required: ["rating", "standard", "summary", "confidence"],
        },
      },
      heuristicIssues: {
        type: "array",
        description: "Up to 4 of the most important heuristic issues, in order of severity.",
        maxItems: 4,
        items: {
          type: "object",
          properties: {
            severity: { type: "string", enum: SEVERITY_ENUM },
            standard: {
              type: "string",
              description:
                "The one primary Nielsen-Norman heuristic standard this issue most relates to.",
            },
            title: { type: "string", description: "What's wrong, in plain English." },
            description: {
              type: "string",
              description:
                "Short paragraph: what it is, how/why it violates the standard, why it matters.",
            },
            recommendation: { type: "string" },
            secondaryStandards: {
              type: "array",
              description:
                "Other heuristic standards this issue also relates to. Empty array if none.",
              items: { type: "string" },
            },
            confidence: { type: "string", enum: CONFIDENCE_ENUM },
          },
          required: [
            "severity",
            "standard",
            "title",
            "description",
            "recommendation",
            "secondaryStandards",
            "confidence",
          ],
        },
      },
      accessibilityIssues: {
        type: "array",
        description:
          "Up to 5 of the most important accessibility issues from the scan data, in order of severity.",
        maxItems: 5,
        items: {
          type: "object",
          properties: {
            severity: {
              type: "string",
              enum: SEVERITY_ENUM,
              description: "Use the scan's own severity, mapping 'serious' to 'Severe'.",
            },
            standard: { type: "string", description: "The WCAG 2.2 standard violated." },
            title: { type: "string" },
            description: { type: "string" },
            elementsAffected: {
              type: "string",
              description:
                "The elements on the page affected, with approximate location if applicable.",
            },
            recommendation: { type: "string" },
          },
          required: [
            "severity",
            "standard",
            "title",
            "description",
            "elementsAffected",
            "recommendation",
          ],
        },
      },
    },
    required: ["workingWell", "heuristicIssues", "accessibilityIssues"],
  },
};

const SYSTEM_PROMPT = `You are being given an image of a URL and a structured text block of accessibility findings (WCAG 2.2) for that same URL from an automated scan.

Conduct a heuristic evaluation of the URL image based on the Nielsen-Norman Group's 10 heuristic standards. Weight the content of the page as less than the structure and interaction elements of the page.

For heuristic issues: list in order of severity. Check your list of issues against the accessibility issues before finalizing — if a heuristic issue is already covered by one of the accessibility issues, skip it and surface the next most severe issue instead. If fewer than 4 real issues exist, return fewer. Do not invent issues to reach the limit.

For accessibility issues, treat the provided scan data as verified fact — do not evaluate or second-guess it, only describe and explain it. List in order of severity. If fewer than 5 real issues exist in the data, return fewer.

Submit your evaluation using the submit_evaluation tool.`;

function normalizeUrl(input) {
  try {
    return new URL(input).toString();
  } catch {
    return new URL(`https://${input}`).toString();
  }
}

function formatViolations(violations) {
  if (violations.length === 0) {
    return "No automated accessibility violations detected.";
  }
  return violations
    .map((v, i) => {
      const wcagTags = v.tags.filter((t) => t.startsWith("wcag")).join(", ");
      const count = v.nodes.length;
      return `${i + 1}. [${v.impact}] ${v.id} — ${v.help} (${count} element${count === 1 ? "" : "s"} affected)${wcagTags ? ` — ${wcagTags}` : ""}`;
    })
    .join("\n");
}

async function analyzePage(url) {
  // Vercel has no browser pre-installed — @sparticuz/chromium supplies one
  // built for serverless environments. Locally, playwright-core still finds
  // the Chromium already installed in the standard cache (via `npx
  // playwright install`, done once early in this project), so no special
  // config is needed there.
  //
  // On Vercel, a unique --user-data-dir per invocation is required too —
  // Playwright never cleans up its default profile directory between
  // invocations, and Vercel's runtime can reuse the same warm container
  // across many requests. Without this, that shared/never-cleaned profile
  // is a documented cause of the Chromium process failing outright on a
  // later invocation (github.com/Sparticuz/chromium — "Lambda /tmp fills
  // up after repeated invocations").
  const userDataDir = process.env.VERCEL ? `/tmp/pw-${randomUUID()}` : null;
  const browser = process.env.VERCEL
    ? await chromium.launch({
        args: [...chromiumBinary.args, `--user-data-dir=${userDataDir}`],
        executablePath: await chromiumBinary.executablePath(CHROMIUM_PACK_URL),
        headless: true,
      })
    : await chromium.launch();
  try {
    // AxeBuilder opens an auxiliary page internally, which the single-page
    // context browser.newPage() creates doesn't allow — needs an explicit
    // context instead.
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(1000);

    // A single full-page capture never actually scrolls the page, so
    // scroll-triggered reveals and lazy-loaded images (common on marketing
    // sites) stay blank. Stepping through the page first gives them a
    // chance to fire before the real screenshot.
    const height = await page.evaluate(() => document.body.scrollHeight);
    for (let y = 0; y < height; y += 800) {
      await page.evaluate((y) => window.scrollTo(0, y), y);
      await page.waitForTimeout(250);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(500);

    const axeResults = await new AxeBuilder({ page, axeSource }).analyze();
    const violationsText = formatViolations(axeResults.violations);

    const buffer = await page.screenshot({ fullPage: true, type: "png" });

    // Claude's API rejects any image over 8000px on a side; a full-page
    // screenshot of a long marketing site can easily exceed that. Only
    // resize when it actually would — most pages never hit this.
    let output = await sharp(buffer)
      .resize({
        width: MAX_IMAGE_DIMENSION,
        height: MAX_IMAGE_DIMENSION,
        fit: "inside",
        withoutEnlargement: true,
      })
      .png()
      .toBuffer();

    // Separately, Claude's API also rejects any image over 10MB — rare,
    // but a visually dense page (lots of embedded images/textures) can
    // exceed it even well under the pixel cap above. Shrinking dimensions
    // further (not just re-compressing at the same size) is a deliberate
    // choice: fewer pixels means both a smaller file and a lower token
    // cost, since Claude's image tokens scale with pixel count, not file
    // size — an acceptable tradeoff for an extreme edge case.
    let { width: imgWidth, height: imgHeight } = await sharp(output).metadata();
    let attempts = 0;
    while (output.length > MAX_IMAGE_BYTES && attempts < 8) {
      // Recompute the needed shrink ratio from the actual overage each pass,
      // rather than guessing a fixed decrement — file size doesn't scale
      // linearly with pixel area for visually dense images (e.g. a page
      // built from many small photos), so a fixed step can undershoot
      // repeatedly. A 10% safety margin covers that non-linearity.
      const scale = Math.sqrt(MAX_IMAGE_BYTES / output.length) * 0.9;
      imgWidth = Math.round(imgWidth * scale);
      imgHeight = Math.round(imgHeight * scale);
      output = await sharp(buffer)
        .resize({ width: imgWidth, height: imgHeight, fit: "inside" })
        .png()
        .toBuffer();
      attempts++;
    }

    return { screenshotBase64: output.toString("base64"), violationsText };
  } finally {
    await browser.close();
    if (userDataDir) {
      await rm(userDataDir, { recursive: true, force: true });
    }
  }
}

export async function POST(request) {
  const { text } = await request.json();

  if (!text || typeof text !== "string") {
    return Response.json({ error: "Please enter a valid URL" }, { status: 400 });
  }

  let url;
  try {
    url = normalizeUrl(text.trim());
  } catch {
    return Response.json({ error: "Please enter a valid URL" }, { status: 400 });
  }

  // No-op locally (see the `redis` const above) — only the deployed app
  // needs protecting. Must run before analyzePage() and the Anthropic call
  // below: the whole point is avoiding that cost for requests over the
  // limit, not spending it and rejecting the result afterward.
  if (VISITOR_COOKIE_LIMITER && IP_LIMITER) {
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    const cookieStore = await cookies();
    let visitorId = cookieStore.get(VISITOR_COOKIE_NAME)?.value;
    if (!visitorId) {
      visitorId = randomUUID();
      cookieStore.set(VISITOR_COOKIE_NAME, visitorId, {
        maxAge: VISITOR_COOKIE_MAX_AGE,
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
      });
    }

    const [cookieResult, ipResult] = await Promise.all([
      VISITOR_COOKIE_LIMITER.limit(visitorId),
      IP_LIMITER.limit(ip),
    ]);
    if (!cookieResult.success || !ipResult.success) {
      return Response.json(
        {
          error:
            "Currently, users are only allowed 3 submissions for evaluation per week. Please return next week to test another 3 URLs.",
        },
        { status: 429 },
      );
    }
  }

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  try {
    const { screenshotBase64, violationsText } = await analyzePage(url);

    const message = await anthropic.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 3800,
      system: SYSTEM_PROMPT,
      tools: [EVALUATION_TOOL],
      tool_choice: { type: "tool", name: "submit_evaluation" },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: screenshotBase64,
              },
            },
            {
              type: "text",
              text: `URL: ${url}`,
            },
            {
              type: "text",
              text: `Automated accessibility scan (axe-core) — confirmed violations:\n\n${violationsText}`,
            },
          ],
        },
      ],
    });

    const toolUse = message.content.find((block) => block.type === "tool_use");
    if (!toolUse) {
      return Response.json({ error: "Model did not return a structured evaluation" }, { status: 500 });
    }

    // The schema's "array" types are a strong steering signal, not a hard
    // guarantee the way enum values are — occasionally a field comes back
    // malformed (e.g. a stringified copy of the whole object instead of the
    // expected array). Catch that here rather than pass corrupted data on.
    const { workingWell, heuristicIssues, accessibilityIssues } = toolUse.input;
    if (
      !Array.isArray(workingWell) ||
      !Array.isArray(heuristicIssues) ||
      !Array.isArray(accessibilityIssues)
    ) {
      return Response.json(
        { error: "Model returned a malformed evaluation — please try again" },
        { status: 500 },
      );
    }

    return Response.json({ data: normalizeEvaluation(toolUse.input) });
  } catch (err) {
    // Vercel's dashboard only shows request metadata (timing, memory) for
    // requests we handle ourselves and return a normal response for — the
    // actual error/stack trace is otherwise only visible in the JSON we
    // send the browser. Logging it server-side too means a future
    // occurrence is diagnosable from the logs alone.
    console.error(err);

    // A domain that doesn't resolve (a typo, or plain nonsense like
    // "banana") surfaces as a raw Chromium network error otherwise —
    // technically accurate, not helpful to read.
    if (err.message.includes("ERR_NAME_NOT_RESOLVED")) {
      return Response.json(
        { error: "Sorry, this URL does not exist. Please enter a valid URL." },
        { status: 400 },
      );
    }

    // A real site that's just too slow to load within the 30s navigation
    // timeout — distinct from the domain not existing at all.
    if (err.message.includes("Timeout") && err.message.includes("exceeded")) {
      return Response.json(
        {
          error:
            "You found a rare URL we couldn't evaluate - it takes too long to load. Our current evaluation is to fix that first.",
        },
        { status: 400 },
      );
    }

    // Other ways a browser can fail to reach a page at all (connection
    // refused, unreachable address, a broken/untrusted certificate) —
    // different Chromium error codes, same practical outcome as an
    // invalid URL, so reuse that same message rather than a distinct one
    // per failure mode.
    if (
      err.message.includes("ERR_CONNECTION_REFUSED") ||
      err.message.includes("ERR_CONNECTION_TIMED_OUT") ||
      err.message.includes("ERR_ADDRESS_UNREACHABLE") ||
      err.message.includes("ERR_CERT_")
    ) {
      return Response.json({ error: "Please enter a valid URL" }, { status: 400 });
    }

    // Anthropic's own service being rate-limited or temporarily overloaded
    // — otherwise leaks their raw JSON error shape.
    if (err.message.includes("rate_limit_error") || err.message.includes("overloaded_error")) {
      return Response.json(
        {
          error:
            "Our apologies, our tool is too popular right now. Please try again in just a moment.",
        },
        { status: 429 },
      );
    }

    return Response.json({ error: err.message }, { status: 500 });
  }
}
