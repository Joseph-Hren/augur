import { chromium } from "playwright-core";
import chromiumBinary from "@sparticuz/chromium-min";
import sharp from "sharp";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "fs";
import { rm } from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";

// Provider-agnostic evaluation pipeline (screenshot/axe capture, prompt,
// tool schema, normalization) shared between the deployed API route and any
// local scripts that need the same inputs — kept out of route.js because
// Next.js route files may only export HTTP handlers, not arbitrary consts.

export const MAX_IMAGE_DIMENSION = 8000;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // Anthropic's hard limit (10,485,760 bytes exactly)

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

export const SEVERITY_ENUM = ["Critical", "Severe", "Moderate", "Minor"];
export const CONFIDENCE_ENUM = ["High Confidence", "Confident", "Suspected", "Uncertain"];
export const RATING_ENUM = ["Excellent", "Efficient", "Strong", "Adequate"];

// The prompt already instructs "serious" (axe-core's own wording) to be
// reported as "Severe", and the schema's enum reinforces it — but neither
// is a hard guarantee, and this specific leak has been observed in the
// wild. Normalized here, closest to the source, rather than relying on the
// frontend alone to paper over it.
const SEVERITY_ALIASES = { Serious: "Severe" };

// A page with genuinely zero axe-core violations otherwise renders an
// empty, broken-looking Accessibility tab — this replaces that with an
// explicit positive result. Built here in code, not left to the model:
// whether to show this card is tied directly to the scan's own violation
// count (see analyzePage()'s hadNoViolations), not to trusting the model
// to correctly report an empty array.
//
// "Suspected" confidence is deliberate and unique to this one card — every
// other accessibility card is scan-verified fact and carries no confidence
// badge at all. A scanner finding nothing is a real, positive signal, but
// automated tools only cover a subset of WCAG (criteria needing human
// judgment — meaningful alt text, reading order, keyboard traps in custom
// widgets — aren't fully checkable this way), so "zero found" isn't the
// same claim as "certified compliant."
export const NO_VIOLATIONS_CARD = {
  severity: "Excellent",
  standard: "No WCAG 2.2 violations found",
  title: "Zero accessibility violations were found on this page.",
  elementsAffected: "N/A — no violations detected",
  description:
    "This automated scan found no rule violations against WCAG 2.2. Automated scanning covers a meaningful subset of WCAG, but not everything — criteria that require human judgment (meaningful alt text, logical reading order, keyboard traps in custom widgets) aren't fully checkable this way.",
  recommendation:
    "Treat this as a strong positive signal, not a compliance guarantee — periodic manual and assistive-technology testing is still the only way to confirm full WCAG 2.2 conformance.",
  confidence: "Suspected",
  confidenceReason:
    "This reflects the absence of any automated accessibility scan violations, not a full manual/visual audit.",
};

const CONFIDENCE_REASON_DESCRIPTION =
  "One-sentence explanation for the confidence level: whether this finding is based on evidence directly visible in the screenshot, an inference about intent or composition that can't be directly verified from the image alone, or something else.";

export function normalizeEvaluation(data) {
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

export const EVALUATION_TOOL = {
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
            confidenceReason: { type: "string", description: CONFIDENCE_REASON_DESCRIPTION },
          },
          required: ["rating", "standard", "summary", "confidence", "confidenceReason"],
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
            confidenceReason: { type: "string", description: CONFIDENCE_REASON_DESCRIPTION },
          },
          required: [
            "severity",
            "standard",
            "title",
            "description",
            "recommendation",
            "secondaryStandards",
            "confidence",
            "confidenceReason",
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

export const SYSTEM_PROMPT = `You are being given an image of a URL and a structured text block of accessibility findings (WCAG 2.2) for that same URL from an automated scan.

Conduct a heuristic evaluation of the URL image based on the Nielsen-Norman Group's 10 heuristic standards. Weight the content of the page as less than the structure and interaction elements of the page.

For heuristic issues: list in order of severity. Check your list of issues against the accessibility issues before finalizing — if a heuristic issue is already covered by one of the accessibility issues, skip it and surface the next most severe issue instead. If fewer than 4 real issues exist, return fewer. Do not invent issues to reach the limit.

For accessibility issues, treat the provided scan data as verified fact — do not evaluate or second-guess it, only describe and explain it. List in order of severity. If fewer than 5 real issues exist in the data, return fewer.

For every confidence rating you assign (working-well items and heuristic issues), give a one-sentence reason for it: is this based on evidence directly visible in the screenshot, an inference about intent or composition that can't be directly verified from the image alone, or something else.

Submit your evaluation using the submit_evaluation tool.`;

export function normalizeUrl(input) {
  try {
    return new URL(input).toString();
  } catch {
    return new URL(`https://${input}`).toString();
  }
}

export function formatViolations(violations) {
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

export async function analyzePage(url) {
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
  const viewport = { width: 1280, height: 800 };

  // A custom user-data-dir isn't a plain launch() arg in Playwright (unlike
  // Puppeteer) — it must go through launchPersistentContext(), which
  // launches the browser and its one context together and returns that
  // context directly, rather than a separate Browser to call
  // newContext() on.
  let browser = null;
  let context;
  if (userDataDir) {
    // WebGL on serverless only works via a software (CPU) GL backend
    // (swiftshader/ANGLE), which is inherently more fragile than real GPU
    // rendering — a WebGL/canvas-heavy real-world site (observed on
    // advisor360.com) can flood it with "Buffer Handle is null" GPU IPC
    // errors until the renderer process dies mid-screenshot. We only need
    // a screenshot for evaluation, not WebGL fidelity, so disabling it
    // removes the whole failure class rather than working around it.
    chromiumBinary.setGraphicsMode = false;
    context = await chromium.launchPersistentContext(userDataDir, {
      args: chromiumBinary.args,
      executablePath: await chromiumBinary.executablePath(CHROMIUM_PACK_URL),
      headless: true,
      viewport,
    });
  } else {
    browser = await chromium.launch();
    context = await browser.newContext({ viewport });
  }

  try {
    // AxeBuilder opens an auxiliary page internally, which a single-page
    // context created via newPage() doesn't allow — needs an explicit
    // context instead, which we already have either way above.
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
    const hadNoViolations = axeResults.violations.length === 0;

    // Chromium's native `fullPage: true` capture asks the browser to
    // composite and encode one giant surface in a single call — reliable on
    // a normal desktop Chromium, but a known failure point ("Unable to
    // capture screenshot") for chrome-headless-shell running single-process
    // with no GPU on Vercel, especially for long, image-heavy pages.
    // Capturing one viewport-sized tile at a time and stitching them with
    // sharp keeps every individual screenshot small regardless of page
    // length, sidestepping that failure class entirely.
    //
    // Fixed/sticky elements (e.g. a sticky header) would otherwise be
    // captured fresh — and so duplicated — in every tile, since they
    // re-pin to the viewport on each scroll. Converting them to `absolute`
    // at their current on-page position freezes them in place for the rest
    // of the capture, matching how Chromium's own fullPage capture already
    // handles them. Done after the axe scan so axe still audits the page's
    // real, unmodified styles.
    await page.evaluate(() => {
      document.querySelectorAll("*").forEach((el) => {
        const position = getComputedStyle(el).position;
        if (position === "fixed" || position === "sticky") {
          const rect = el.getBoundingClientRect();
          el.style.position = "absolute";
          el.style.top = `${rect.top + window.scrollY}px`;
          el.style.left = `${rect.left + window.scrollX}px`;
        }
      });
    });

    // Recomputed rather than reusing `height` above — the scroll-priming
    // loop can itself grow the page (lazy content revealed along the way),
    // so the pre-scroll measurement can undercount.
    const totalHeight = await page.evaluate(() => document.body.scrollHeight);
    const tileCount = Math.max(1, Math.ceil(totalHeight / viewport.height));
    const tiles = [];
    for (let i = 0; i < tileCount; i++) {
      const scrollY = Math.min(i * viewport.height, Math.max(totalHeight - viewport.height, 0));
      await page.evaluate((y) => window.scrollTo(0, y), scrollY);
      await page.waitForTimeout(100);
      let tileBuffer = await page.screenshot({ type: "png" });

      // page.screenshot() without fullPage always captures the entire
      // configured viewport, padded with blank space past the real content
      // if the page is shorter than that. For any page under one viewport
      // tall (or this final tile), that padding would overflow the
      // composite canvas below — sharp requires an overlay no larger than
      // its base and throws otherwise — so crop it down to just the
      // remaining real content height first.
      const remainingHeight = totalHeight - scrollY;
      if (remainingHeight < viewport.height) {
        tileBuffer = await sharp(tileBuffer)
          .extract({ left: 0, top: 0, width: viewport.width, height: remainingHeight })
          .png()
          .toBuffer();
      }

      tiles.push({ input: tileBuffer, top: scrollY, left: 0 });
    }

    const buffer = await sharp({
      create: {
        width: viewport.width,
        height: totalHeight,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .composite(tiles)
      .png()
      .toBuffer();

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

    return { screenshotBase64: output.toString("base64"), violationsText, hadNoViolations };
  } finally {
    // Closing a persistent context also closes the browser process that
    // owns it — there's no separate `browser` to close in that case.
    await context.close();
    if (browser) {
      await browser.close();
    }
    if (userDataDir) {
      await rm(userDataDir, { recursive: true, force: true });
    }
  }
}
