/**
 * Tests for the openclaw-mem0 plugin config schema, including
 * agentMemory multi-pool configuration parsing.
 *
 * Note: extractSessionInfo, getCapturePool, getRecallPools, and
 * isPoolAllowed are closures inside register() and cannot be tested
 * directly. Their behavior is validated through integration tests.
 * These unit tests cover the config parsing layer that feeds them.
 */
import { describe, it, expect } from "vitest";
import { mem0ConfigSchema } from "./index.ts";

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
