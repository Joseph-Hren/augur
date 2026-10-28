import { randomUUID } from "crypto";
import { cookies } from "next/headers";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import {
  analyzePage,
  EVALUATION_TOOL,
  SYSTEM_PROMPT,
  NO_VIOLATIONS_CARD,
  normalizeEvaluation,
  normalizeUrl,
} from "../../../lib/evaluation";
import { callKimi } from "../../../lib/kimi";

// Casual/accidental overuse protection — this is not the account's real
// safety net. That's the spend cap set in the Moonshot (Kimi) console, which
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
  ? new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(10, "7 d"), prefix: "ratelimit:cookie" })
  : null;
const IP_LIMITER = redis
  ? new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(10, "7 d"), prefix: "ratelimit:ip" })
  : null;

const VISITOR_COOKIE_NAME = "augur_visitor_id";
const VISITOR_COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

// Lets the site owner test past the 3/week cap without it applying to
// everyone. Visiting once with ?dev=<DEV_BYPASS_TOKEN> sets a cookie so the
// query param isn't needed again. This only skips the count/block — the
// real work (and its cost) still happens exactly as normal.
const DEV_BYPASS_COOKIE_NAME = "augur_dev_bypass";
const DEV_BYPASS_COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

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
  // needs protecting. Must run before analyzePage() and the Kimi call
  // below: the whole point is avoiding that cost for requests over the
  // limit, not spending it and rejecting the result afterward.
  if (VISITOR_COOKIE_LIMITER && IP_LIMITER) {
    const cookieStore = await cookies();
    const isDevBypass =
      process.env.DEV_BYPASS_TOKEN &&
      cookieStore.get(DEV_BYPASS_COOKIE_NAME)?.value === process.env.DEV_BYPASS_TOKEN;

    if (!isDevBypass) {
      const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
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
              "Currently, users are only allowed 10 submissions for evaluation per week. Please return next week to test another 10 URLs.",
            note:
              "If you have reached this message, you find this app useful, and need more of it, please contact me. I cannot promise same-day response, but if you drop me a line and tell me your situation, I can probably help.\n\njoseph.r.hren@gmail.com",
          },
          { status: 429 },
        );
      }
    }
  }

  try {
    const { screenshotBase64, violationsText, hadNoViolations } = await analyzePage(url);

    const evaluationInput = await callKimi({
      url,
      screenshotBase64,
      violationsText,
      systemPrompt: SYSTEM_PROMPT,
      tool: EVALUATION_TOOL,
    });

    // The schema's "array" types are a strong steering signal, not a hard
    // guarantee the way enum values are — occasionally a field comes back
    // malformed (e.g. a stringified copy of the whole object instead of the
    // expected array). Catch that here rather than pass corrupted data on.
    const { workingWell, heuristicIssues, accessibilityIssues } = evaluationInput;
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

    const normalized = normalizeEvaluation(evaluationInput);
    if (hadNoViolations) {
      normalized.accessibilityIssues = [NO_VIOLATIONS_CARD];
    }

    return Response.json({ data: normalized });
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

    // Kimi's own service being rate-limited or temporarily overloaded
    // — otherwise leaks their raw JSON error shape.
    if (err.message.includes("Kimi API error (429)") || err.message.includes("Kimi API error (503)")) {
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

// Visiting this route directly (not through the app's UI) with
// ?dev=<DEV_BYPASS_TOKEN> sets the bypass cookie POST checks above for. A
// query param on the page you're browsing never reaches a separate fetch()
// call to this route, so the cookie has to be set here, from a request that
// actually carries the param — a direct visit to this URL.
export async function GET(request) {
  const devToken = new URL(request.url).searchParams.get("dev");
  if (!process.env.DEV_BYPASS_TOKEN || devToken !== process.env.DEV_BYPASS_TOKEN) {
    return Response.json({ status: "No change." }, { status: 400 });
  }

  const cookieStore = await cookies();
  cookieStore.set(DEV_BYPASS_COOKIE_NAME, process.env.DEV_BYPASS_TOKEN, {
    maxAge: DEV_BYPASS_COOKIE_MAX_AGE,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
  });
  return Response.json({ status: "Dev bypass enabled for this browser." });
}
