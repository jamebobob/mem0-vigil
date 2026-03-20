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
});
