import {
  analyzePage,
  EVALUATION_TOOL,
  SYSTEM_PROMPT,
  NO_VIOLATIONS_CARD,
  normalizeEvaluation,
  normalizeUrl,
} from "../../../lib/evaluation";
import { callKimi } from "../../../lib/kimi";

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
