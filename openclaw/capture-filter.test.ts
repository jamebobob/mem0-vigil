import { describe, it, expect } from "vitest";
import { filterCaptureMessages } from "./capture-filter.ts";

describe("filterCaptureMessages", () => {
  it("keeps user messages and drops assistant messages", () => {
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
      { role: "user", content: "remember this" },
      { role: "assistant", content: "stored" },
    ];
    const filtered = filterCaptureMessages(messages);
    expect(filtered).toEqual([
      { role: "user", content: "hello" },
      { role: "user", content: "remember this" },
    ]);
  });

  it("drops system messages (LCM summaries appear as system/assistant)", () => {
    const messages = [
      { role: "system", content: "compacted summary from LCM" },
      { role: "user", content: "actual user input" },
      { role: "assistant", content: "agent response" },
    ];
    const filtered = filterCaptureMessages(messages);
    expect(filtered).toEqual([
      { role: "user", content: "actual user input" },
    ]);
  });

  it("returns empty array when no user messages exist", () => {
    const messages = [
      { role: "assistant", content: "nothing from user" },
      { role: "system", content: "system prompt" },
    ];
    expect(filterCaptureMessages(messages)).toEqual([]);
  });

  it("returns empty array for empty input", () => {
    expect(filterCaptureMessages([])).toEqual([]);
  });

  it("preserves message order", () => {
    const messages = [
      { role: "assistant", content: "1" },
      { role: "user", content: "2" },
      { role: "assistant", content: "3" },
      { role: "user", content: "4" },
      { role: "user", content: "5" },
    ];
    const filtered = filterCaptureMessages(messages);
    expect(filtered.map((m) => m.content)).toEqual(["2", "4", "5"]);
  });

  // -----------------------------------------------------------------------
  // LCM summary detection
  // -----------------------------------------------------------------------

  it("drops role:user messages that are LCM summaries", () => {
    const messages = [
      { role: "user", content: '<summary id="sum_abc123" kind="leaf" depth="0" descendant_count="3">\n  <content>\nUser discussed project plans\n  </content>\n</summary>' },
      { role: "user", content: "what should we do next?" },
    ];
    const filtered = filterCaptureMessages(messages);
    expect(filtered).toEqual([
      { role: "user", content: "what should we do next?" },
    ]);
  });

  it("drops LCM summaries with leading whitespace", () => {
    const messages = [
      { role: "user", content: '  \n<summary id="sum_def" kind="condensed" depth="1">\n  <content>...</content>\n</summary>' },
    ];
    expect(filterCaptureMessages(messages)).toEqual([]);
  });

  it("does NOT filter normal user messages that mention 'summary'", () => {
    const messages = [
      { role: "user", content: "Can you give me a summary of what we discussed?" },
      { role: "user", content: "The summary report is on my desk" },
      { role: "user", content: "Here is a <summary> tag in my text" },
    ];
    const filtered = filterCaptureMessages(messages);
    expect(filtered).toHaveLength(3);
  });

  it("drops LCM summaries in multi-part array content", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: '<summary id="sum_xyz" kind="leaf" depth="0">\n<content>...</content>\n</summary>' }] as any },
      { role: "user", content: "normal message" },
    ];
    const filtered = filterCaptureMessages(messages);
    expect(filtered).toEqual([
      { role: "user", content: "normal message" },
    ]);
  });

  it("keeps messages with non-string non-array content", () => {
    const messages = [
      { role: "user", content: null as any },
      { role: "user", content: "real message" },
    ];
    const filtered = filterCaptureMessages(messages);
    // null content isn't a summary, passes the summary check but is still role:user
    expect(filtered).toHaveLength(2);
  });
});
