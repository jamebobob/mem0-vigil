/**
 * Regression tests for per-agent memory isolation helpers,
 * message filtering logic, and agentMemory multi-pool configuration parsing.
 */
import { describe, it, expect } from "vitest";
import {
  extractAgentId,
  effectiveUserId,
  agentUserId,
  resolveUserId,
  isNonInteractiveTrigger,
  isSubagentSession,
  isNoiseMessage,
  isGenericAssistantMessage,
  stripNoiseFromContent,
  filterMessagesForExtraction,
  mem0ConfigSchema,
} from "./index.ts";

// ---------------------------------------------------------------------------
// Config schema: agentMemory parsing
// ---------------------------------------------------------------------------
describe("mem0ConfigSchema agentMemory", () => {
  const base = {
    mode: "open-source" as const,
    userId: "testuser",
  };

  it("parses agentMemory with capture and recall arrays", () => {
    const cfg = mem0ConfigSchema.parse({
      ...base,
      agentMemory: {
        main: { capture: "testuser", recall: ["testuser", "family"] },
        social: { capture: "family", recall: ["family"] },
      },
    });
    expect(cfg.agentMemory).toEqual({
      main: { capture: "testuser", recall: ["testuser", "family"] },
      social: { capture: "family", recall: ["family"] },
    });
  });

  it("skips entry when capture is missing (fail-closed)", () => {
    const cfg = mem0ConfigSchema.parse({
      ...base,
      agentMemory: {
        main: { recall: ["testuser"] },
      },
    });
    // Fail-closed: missing capture → entry skipped entirely
    expect(cfg.agentMemory).toBeUndefined();
  });

  it("skips entry when recall is missing (fail-closed)", () => {
    const cfg = mem0ConfigSchema.parse({
      ...base,
      agentMemory: {
        main: { capture: "testuser" },
      },
    });
    // Fail-closed: missing recall → entry skipped entirely
    expect(cfg.agentMemory).toBeUndefined();
  });

  it("returns undefined agentMemory when not provided", () => {
    const cfg = mem0ConfigSchema.parse(base);
    expect(cfg.agentMemory).toBeUndefined();
  });

  it("returns undefined agentMemory for empty object", () => {
    const cfg = mem0ConfigSchema.parse({ ...base, agentMemory: {} });
    expect(cfg.agentMemory).toBeUndefined();
  });

  it("skips non-object entries in agentMemory", () => {
    const cfg = mem0ConfigSchema.parse({
      ...base,
      agentMemory: {
        main: { capture: "testuser", recall: ["testuser"] },
        bad: "not-an-object",
        worse: null,
      },
    });
    expect(cfg.agentMemory).toEqual({
      main: { capture: "testuser", recall: ["testuser"] },
    });
  });

  it("filters non-string entries from recall array", () => {
    const cfg = mem0ConfigSchema.parse({
      ...base,
      agentMemory: {
        main: { capture: "testuser", recall: ["testuser", 42, null, "family"] },
      },
    });
    expect(cfg.agentMemory?.main.recall).toEqual(["testuser", "family"]);
  });
});

// ---------------------------------------------------------------------------
// Config schema: ALLOWED_KEYS includes agentMemory
// ---------------------------------------------------------------------------
describe("mem0ConfigSchema allowed keys", () => {
  it("accepts agentMemory as a valid config key", () => {
    expect(() =>
      mem0ConfigSchema.parse({
        mode: "open-source",
        userId: "test",
        agentMemory: { main: { capture: "test", recall: ["test"] } },
      }),
    ).not.toThrow();
  });

  it("rejects unknown keys", () => {
    expect(() =>
      mem0ConfigSchema.parse({
        mode: "open-source",
        userId: "test",
        badKey: true,
      }),
    ).toThrow(/unknown keys.*badKey/);
  });
});

// ---------------------------------------------------------------------------
// extractAgentId
// ---------------------------------------------------------------------------
describe("extractAgentId", () => {
  it("returns agentId from a named agent session key", () => {
    expect(extractAgentId("agent:researcher:550e8400-e29b")).toBe("researcher");
  });

  it("returns subagent namespace from subagent session key", () => {
    // OpenClaw subagent format: agent:main:subagent:<uuid>
    expect(extractAgentId("agent:main:subagent:3b85177f-69e0-412d-8ecd-fbe542f362ce")).toBe(
      "subagent-3b85177f-69e0-412d-8ecd-fbe542f362ce",
    );
  });

  it("returns undefined for the main agent session (agent:main:main)", () => {
    expect(extractAgentId("agent:main:main")).toBeUndefined();
  });

  it("returns undefined for the 'main' sentinel", () => {
    expect(extractAgentId("agent:main:abc-123")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// isNonInteractiveTrigger
// ---------------------------------------------------------------------------
describe("isNonInteractiveTrigger", () => {
  it("returns true for cron trigger", () => {
    expect(isNonInteractiveTrigger("cron", undefined)).toBe(true);
  });

  it("returns true for heartbeat trigger", () => {
    expect(isNonInteractiveTrigger("heartbeat", undefined)).toBe(true);
  });

  it("returns true for automation trigger", () => {
    expect(isNonInteractiveTrigger("automation", undefined)).toBe(true);
  });

  it("returns true for schedule trigger", () => {
    expect(isNonInteractiveTrigger("schedule", undefined)).toBe(true);
  });

  it("is case-insensitive for trigger", () => {
    expect(isNonInteractiveTrigger("CRON", undefined)).toBe(true);
    expect(isNonInteractiveTrigger("Heartbeat", undefined)).toBe(true);
  });

  it("returns false for user-initiated triggers", () => {
    expect(isNonInteractiveTrigger("user", undefined)).toBe(false);
    expect(isNonInteractiveTrigger("webchat", undefined)).toBe(false);
    expect(isNonInteractiveTrigger("telegram", undefined)).toBe(false);
  });

  it("returns false when trigger is undefined and session key is normal", () => {
    expect(isNonInteractiveTrigger(undefined, "agent:main:main")).toBe(false);
  });

  it("detects cron from session key as fallback", () => {
    expect(isNonInteractiveTrigger(undefined, "agent:main:cron:c85abdb2-d900-4cd8-8601-9dd960c560c9")).toBe(true);
  });

  it("detects heartbeat from session key as fallback", () => {
    expect(isNonInteractiveTrigger(undefined, "agent:main:heartbeat:abc123")).toBe(true);
  });

  it("returns false when both trigger and sessionKey are undefined", () => {
    expect(isNonInteractiveTrigger(undefined, undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isSubagentSession
// ---------------------------------------------------------------------------
describe("isSubagentSession", () => {
  it("returns true for subagent session keys", () => {
    expect(isSubagentSession("agent:main:subagent:3b85177f-69e0-412d-8ecd-fbe542f362ce")).toBe(true);
  });

  it("returns false for main agent session", () => {
    expect(isSubagentSession("agent:main:main")).toBe(false);
  });

  it("returns false for named agent session", () => {
    expect(isSubagentSession("agent:researcher:550e8400-e29b")).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isSubagentSession(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isNoiseMessage
// ---------------------------------------------------------------------------
describe("isNoiseMessage", () => {
  it("detects HEARTBEAT_OK", () => {
    expect(isNoiseMessage("HEARTBEAT_OK")).toBe(true);
    expect(isNoiseMessage("heartbeat_ok")).toBe(true);
  });

  it("detects NO_REPLY", () => {
    expect(isNoiseMessage("NO_REPLY")).toBe(true);
  });

  it("detects current-time stamps", () => {
    expect(
      isNoiseMessage("Current time: Friday, February 20th, 2026 — 3:58 AM (America/New_York)"),
    ).toBe(true);
  });

  it("detects single-word acknowledgments", () => {
    for (const word of ["ok", "yes", "sir", "done", "cool", "Got it", "it's on"]) {
      expect(isNoiseMessage(word)).toBe(true);
    }
  });

  it("detects system routing messages", () => {
    expect(
      isNoiseMessage("System: [2026-02-19 19:51:31 PST] Slack message edited in #D0AFV2LDGDS."),
    ).toBe(true);
    expect(
      isNoiseMessage("System: [2026-02-19 22:15:42 PST] Exec failed (gentle-b, signal 15)"),
    ).toBe(true);
  });

  it("detects compaction audit messages", () => {
    expect(
      isNoiseMessage(
        "System: [2026-02-20 16:12:04 EST] ⚠️ Post-Compaction Audit: The following required startup files were not read",
      ),
    ).toBe(true);
  });

  it("preserves real content", () => {
    expect(isNoiseMessage("User runs a digital marketing LLC")).toBe(false);
    expect(isNoiseMessage("Can you check the project discord?")).toBe(false);
    expect(isNoiseMessage("I approve the installation")).toBe(false);
  });

  it("treats empty/whitespace as noise", () => {
    expect(isNoiseMessage("")).toBe(true);
    expect(isNoiseMessage("   ")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isGenericAssistantMessage
// ---------------------------------------------------------------------------
describe("isGenericAssistantMessage", () => {
  it("detects 'I see you've shared' openers", () => {
    expect(isGenericAssistantMessage("I see you've shared an update. How can I help?")).toBe(true);
    expect(isGenericAssistantMessage("I see you've shared a summary of the configuration update. Is there anything specific you'd like me to help with?")).toBe(true);
  });

  it("detects 'Thanks for sharing' openers", () => {
    expect(isGenericAssistantMessage("Thanks for sharing that update! Would you like me to review the changes?")).toBe(true);
  });

  it("detects 'How can I help' standalone", () => {
    expect(isGenericAssistantMessage("How can I help you with this?")).toBe(true);
  });

  it("detects 'Got it' + follow-up", () => {
    expect(isGenericAssistantMessage("Got it! How can I assist?")).toBe(true);
    expect(isGenericAssistantMessage("Got it. Let me know what you need.")).toBe(true);
  });

  it("detects 'I'll help/review/look into'", () => {
    expect(isGenericAssistantMessage("I'll review that for you.")).toBe(true);
    expect(isGenericAssistantMessage("I'll look into this right away.")).toBe(true);
  });

  it("preserves substantive assistant content", () => {
    expect(isGenericAssistantMessage("## What I Accomplished\n\nDeployed the API to production with Vercel.")).toBe(false);
    expect(isGenericAssistantMessage("The SDK has been installed and configured. Voice skill is ready.")).toBe(false);
    expect(isGenericAssistantMessage("Updated the call scripts sheet with messaging templates.")).toBe(false);
  });

  it("preserves long messages even with generic openers", () => {
    const longMsg = "I see you've shared an update. " + "Here are the detailed changes I made to the configuration. ".repeat(10);
    expect(isGenericAssistantMessage(longMsg)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// stripNoiseFromContent
// ---------------------------------------------------------------------------
describe("stripNoiseFromContent", () => {
  it("removes conversation metadata JSON blocks", () => {
    const input = `Conversation info (untrusted metadata):
\`\`\`json
{
  "message_id": "499",
  "sender": "6039555582"
}
\`\`\`

What models are you currently using?`;
    const result = stripNoiseFromContent(input);
    expect(result).toBe("What models are you currently using?");
  });

  it("removes media attachment lines", () => {
    const input = "[media attached: /path/to/file.jpg (image/jpeg) | /path/to/file.jpg]\nActual question here";
    const result = stripNoiseFromContent(input);
    expect(result).toContain("Actual question here");
    expect(result).not.toContain("[media attached:");
  });

  it("removes image sending boilerplate", () => {
    const input =
      "To send an image back, prefer the message tool (media/path/filePath). If you must inline, use MEDIA:https://example.com/image.jpg. Keep caption in the text body.\nReal content here";
    const result = stripNoiseFromContent(input);
    expect(result).toContain("Real content here");
    expect(result).not.toContain("prefer the message tool");
  });

  it("preserves content when no noise is present", () => {
    const input = "User wants to deploy to production via Vercel.";
    expect(stripNoiseFromContent(input)).toBe(input);
  });

  it("collapses excessive blank lines after stripping", () => {
    const input = "Line one\n\n\n\n\nLine two";
    expect(stripNoiseFromContent(input)).toBe("Line one\n\nLine two");
  });
});

// ---------------------------------------------------------------------------
// filterMessagesForExtraction
// ---------------------------------------------------------------------------
describe("filterMessagesForExtraction", () => {
  it("drops noise messages entirely", () => {
    const messages = [
      { role: "user", content: "HEARTBEAT_OK" },
      { role: "assistant", content: "Real response with durable facts." },
      { role: "user", content: "ok" },
    ];
    const result = filterMessagesForExtraction(messages);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("Real response with durable facts.");
  });

  it("strips noise fragments but keeps the rest", () => {
    const messages = [
      {
        role: "user",
        content: `Conversation info (untrusted metadata):
\`\`\`json
{
  "message_id": "123",
  "sender": "456"
}
\`\`\`

What is the deployment plan?`,
      },
    ];
    const result = filterMessagesForExtraction(messages);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("What is the deployment plan?");
  });

  it("truncates long messages", () => {
    const longContent = "A".repeat(3000);
    const messages = [{ role: "assistant", content: longContent }];
    const result = filterMessagesForExtraction(messages);
    expect(result).toHaveLength(1);
    expect(result[0].content.length).toBeLessThan(2100);
    expect(result[0].content).toContain("[...truncated]");
  });

  it("returns empty array when all messages are noise", () => {
    const messages = [
      { role: "user", content: "NO_REPLY" },
      { role: "user", content: "ok" },
      { role: "user", content: "Current time: Friday, February 20th, 2026" },
    ];
    expect(filterMessagesForExtraction(messages)).toHaveLength(0);
  });

  it("handles a realistic mixed payload", () => {
    const messages = [
      { role: "user", content: "Pre-compaction memory flush. Store durable memories now." },
      {
        role: "assistant",
        content: "## What I Accomplished\n\nDeployed the API to production with Vercel.",
      },
      { role: "user", content: "sir" },
    ];
    const result = filterMessagesForExtraction(messages);
    expect(result).toHaveLength(1);
    expect(result[0].content).toContain("Deployed the API");
  });

  it("drops generic assistant acknowledgments", () => {
    const messages = [
      { role: "user", content: "[ASSISTANT]: Updated the Google Sheet with new scripts." },
      { role: "assistant", content: "I see you've shared an update. How can I help?" },
    ];
    const result = filterMessagesForExtraction(messages);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
    expect(result[0].content).toContain("Google Sheet");
  });

  it("returns only assistant messages when all user messages are noise", () => {
    const messages = [
      { role: "user", content: "ok" },
      { role: "user", content: "HEARTBEAT_OK" },
      { role: "assistant", content: "I deployed the API to production." },
    ];
    const result = filterMessagesForExtraction(messages);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("assistant");
    expect(result.some((m) => m.role === "user")).toBe(false);
  });

  it("keeps substantive assistant messages even with generic opener", () => {
    const messages = [
      { role: "user", content: "What did you do?" },
      { role: "assistant", content: "I deployed the API to production and configured the webhook endpoints for Stripe integration." },
    ];
    const result = filterMessagesForExtraction(messages);
    expect(result).toHaveLength(2);
  });
});
