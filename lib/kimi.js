// Kimi (Moonshot AI) calling code — the evaluation model behind the live
// app, shared between route.js and the standalone test script
// (scripts/test-kimi.mjs) so there's one place defining how the
// request/response is shaped.

const KIMI_ENDPOINT = "https://api.moonshot.ai/v1/chat/completions";
const KIMI_MODEL = "kimi-k2.6";

// 5 minutes — thinking mode ON was observed to run this long (or longer,
// unbounded) regardless of input complexity; thinking OFF finishes in well
// under a minute. Vercel's 300s function
// limit cuts this off first in production; thinking stays OFF there.
const KIMI_TIMEOUT_MS = 5 * 60 * 1000;

// Kimi's tool_choice only accepts "auto" or "none" — unlike Anthropic's API,
// there's no way to force a specific tool call. Callers should treat a
// missing tool call as a real failure, not retry-and-hope.
export async function callKimi({ url, screenshotBase64, violationsText, systemPrompt, tool, thinking = false }) {
  const kimiTool = {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  };

  const body = {
    model: KIMI_MODEL,
    thinking: { type: thinking ? "enabled" : "disabled" },
    messages: [
      { role: "system", content: systemPrompt },
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
    tools: [kimiTool],
    tool_choice: "auto",
  };

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), KIMI_TIMEOUT_MS);
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
      throw new Error(`Kimi request timed out after ${KIMI_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutHandle);
  }

  const json = await response.json();
  if (!response.ok) {
    throw new Error(`Kimi API error (${response.status}): ${JSON.stringify(json).slice(0, 500)}`);
  }

  const message = json.choices?.[0]?.message;
  const toolCall = message?.tool_calls?.[0];
  if (!toolCall) {
    throw new Error("Kimi did not return a structured evaluation (no tool call)");
  }

  return JSON.parse(toolCall.function.arguments);
}
