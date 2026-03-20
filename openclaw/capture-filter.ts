/**
 * Capture Filter for LCM (Vigil Track B, Blocker 1)
 *
 * Prevents the Mem0 re-extraction loop by filtering messages before
 * they reach the Mem0 capture hook. Two layers:
 *
 * 1. Role filter: only user-role messages pass (drops assistant/system).
 * 2. LCM summary filter: drops user-role messages whose content is an
 *    LCM summary (wrapped in <summary ...> XML tags). LCM injects
 *    summaries as role:"user" messages during assemble(). They should
 *    never appear in event.messages, but if they leak, this catches them.
 */

/**
 * Extract the text content from a message content field.
 * Handles both string content and multi-part array content
 * (e.g. [{type: "text", text: "..."}]).
 */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        "text" in block &&
        typeof (block as { text: unknown }).text === "string"
      ) {
        return (block as { text: string }).text;
      }
    }
  }
  return "";
}

/**
 * Detect LCM summary content. LCM wraps summaries in:
 *   <summary id="sum_..." kind="..." depth="..." ...>
 * The tag always starts at the beginning of the content (possibly
 * after leading whitespace).
 */
function isLcmSummary(content: unknown): boolean {
  const text = extractText(content);
  return /^\s*<summary\s/.test(text);
}

export function filterCaptureMessages(
  messages: Array<{ role: string; content: string }>,
): Array<{ role: string; content: string }> {
  return messages.filter(
    (m) => m.role === "user" && !isLcmSummary(m.content),
  );
}
