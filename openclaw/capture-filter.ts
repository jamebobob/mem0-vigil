/**
 * Capture Filter for LCM (Vigil Track B, Blocker 1)
 *
 * Prevents the Mem0 re-extraction loop by restricting auto-capture to
 * user-role messages only. When LCM injects compacted summaries back
 * into context, they appear as assistant or system messages. Filtering
 * to user-role ensures summaries are never re-extracted as memories.
 *
 * This is the "blunt but reliable" approach from Vigil v5: user-role-
 * only filtering. If LCM summary markers become reliably identifiable
 * (Q5 clearly yes), a more precise filter can replace this one.
 */

export function filterCaptureMessages(
  messages: Array<{ role: string; content: string }>,
): Array<{ role: string; content: string }> {
  return messages.filter((m) => m.role === "user");
}
