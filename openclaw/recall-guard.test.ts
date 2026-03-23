import { describe, it, expect } from "vitest";
import { applyRecallGuard, loadMemoryViewsConfig } from "./recall-guard.ts";
import type { MemoryViewConfig, GuardableResult } from "./recall-guard.ts";

const defaultCfg: MemoryViewConfig = {
  views: {
    dm: { mode: "allow-all" },
    group: { mode: "deny-private", allowed_pools: ["family"] },
    cron: { mode: "deny-private" },
  },
};

function makeResult(overrides: Partial<GuardableResult> = {}): GuardableResult {
  return {
    id: "test-id",
    memory: "test memory",
    score: 0.8,
    user_id: "operator",
    metadata: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// applyRecallGuard — DM context (allow-all)
// ---------------------------------------------------------------------------
describe("applyRecallGuard — dm (allow-all)", () => {
  it("passes all results through regardless of is_private", () => {
    const results = [
      makeResult({ id: "1", metadata: { is_private: true } }),
      makeResult({ id: "2", metadata: { is_private: false } }),
      makeResult({ id: "3", metadata: {} }),
    ];
    const out = applyRecallGuard({ results, ctx: "dm", config: defaultCfg });
    expect(out.results).toHaveLength(3);
    expect(out.removedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// applyRecallGuard — group context (deny-private)
// ---------------------------------------------------------------------------
describe("applyRecallGuard — group (deny-private)", () => {
  it("filters results with is_private=true", () => {
    const results = [
      makeResult({ id: "1", user_id: "family", metadata: { is_private: true } }),
      makeResult({ id: "2", user_id: "family", metadata: { is_private: false } }),
      makeResult({ id: "3", user_id: "family", metadata: {} }),
    ];
    const out = applyRecallGuard({ results, ctx: "group", config: defaultCfg });
    expect(out.results.map((r) => r.id)).toEqual(["2", "3"]);
    expect(out.removedCount).toBe(1);
  });

  it("filters results from pools not in allowed_pools", () => {
    const results = [
      makeResult({ id: "1", user_id: "family", metadata: {} }),
      makeResult({ id: "2", user_id: "operator", metadata: {} }),
    ];
    const out = applyRecallGuard({ results, ctx: "group", config: defaultCfg });
    expect(out.results.map((r) => r.id)).toEqual(["1"]);
    expect(out.removedCount).toBe(1);
  });

  it("filters both: private + wrong pool", () => {
    const results = [
      makeResult({ id: "1", user_id: "family", metadata: { is_private: true } }),
      makeResult({ id: "2", user_id: "operator", metadata: { is_private: false } }),
      makeResult({ id: "3", user_id: "family", metadata: { is_private: false } }),
    ];
    const out = applyRecallGuard({ results, ctx: "group", config: defaultCfg });
    expect(out.results.map((r) => r.id)).toEqual(["3"]);
    expect(out.removedCount).toBe(2);
  });

  it("passes results with no user_id when no allowed_pools check applies", () => {
    // If user_id is undefined, the allowed_pools check is skipped (no pool to test)
    const results = [
      makeResult({ id: "1", user_id: undefined, metadata: {} }),
    ];
    const out = applyRecallGuard({ results, ctx: "group", config: defaultCfg });
    expect(out.results).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// applyRecallGuard — cron context (deny-private, no allowed_pools)
// ---------------------------------------------------------------------------
describe("applyRecallGuard — cron (deny-private)", () => {
  it("filters is_private=true results", () => {
    const results = [
      makeResult({ id: "1", metadata: { is_private: true } }),
      makeResult({ id: "2", metadata: { is_private: false } }),
    ];
    const out = applyRecallGuard({ results, ctx: "cron", config: defaultCfg });
    expect(out.results.map((r) => r.id)).toEqual(["2"]);
    expect(out.removedCount).toBe(1);
  });

  it("does not filter by pool (no allowed_pools in cron config)", () => {
    const results = [
      makeResult({ id: "1", user_id: "operator", metadata: {} }),
      makeResult({ id: "2", user_id: "family", metadata: {} }),
    ];
    const out = applyRecallGuard({ results, ctx: "cron", config: defaultCfg });
    expect(out.results).toHaveLength(2);
    expect(out.removedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// applyRecallGuard — unknown context (fail-open)
// ---------------------------------------------------------------------------
describe("applyRecallGuard — unknown context", () => {
  it("defaults to allow-all for unknown context types", () => {
    const results = [
      makeResult({ id: "1", metadata: { is_private: true } }),
    ];
    const out = applyRecallGuard({ results, ctx: "unknown", config: defaultCfg });
    expect(out.results).toHaveLength(1);
    expect(out.removedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// applyRecallGuard — empty results
// ---------------------------------------------------------------------------
describe("applyRecallGuard — edge cases", () => {
  it("handles empty results", () => {
    const out = applyRecallGuard({ results: [], ctx: "group", config: defaultCfg });
    expect(out.results).toEqual([]);
    expect(out.removedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// loadMemoryViewsConfig
// ---------------------------------------------------------------------------
describe("loadMemoryViewsConfig", () => {
  it("returns default config when no resolvePath provided", () => {
    const cfg = loadMemoryViewsConfig();
    expect(cfg.views.dm.mode).toBe("allow-all");
    expect(cfg.views.group.mode).toBe("deny-private");
    expect(cfg.views.cron.mode).toBe("deny-private");
  });

  it("returns default config when runtime file does not exist", () => {
    const cfg = loadMemoryViewsConfig(() => "/nonexistent/memory-views.json");
    expect(cfg.views.dm.mode).toBe("allow-all");
  });
});
