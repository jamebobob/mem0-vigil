import { describe, it, expect } from "vitest";
import { applyRecallGuard } from "./recall-guard.ts";
import type { GuardableResult } from "./recall-guard.ts";

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
// main agent: sees everything
// ---------------------------------------------------------------------------
describe("applyRecallGuard — main agent", () => {
  it("passes all results through regardless of is_private", () => {
    const results = [
      makeResult({ id: "1", metadata: { is_private: true } }),
      makeResult({ id: "2", metadata: { is_private: false } }),
      makeResult({ id: "3", metadata: {} }),
    ];
    const out = applyRecallGuard({ results, agentId: "main" });
    expect(out.results).toHaveLength(3);
    expect(out.removedCount).toBe(0);
  });

  it("passes results from any pool", () => {
    const results = [
      makeResult({ id: "1", user_id: "operator" }),
      makeResult({ id: "2", user_id: "household" }),
      makeResult({ id: "3", user_id: "friends" }),
    ];
    const out = applyRecallGuard({ results, agentId: "main" });
    expect(out.results).toHaveLength(3);
    expect(out.removedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// social-* agents: own pool only, no private results
// ---------------------------------------------------------------------------
describe("applyRecallGuard — social agent", () => {
  it("keeps only results from the agent's own pool", () => {
    const results = [
      makeResult({ id: "1", user_id: "household" }),
      makeResult({ id: "2", user_id: "operator" }),
      makeResult({ id: "3", user_id: "friends" }),
    ];
    const out = applyRecallGuard({ results, agentId: "social-household" });
    expect(out.results.map((r) => r.id)).toEqual(["1"]);
    expect(out.removedCount).toBe(2);
  });

  it("drops results with is_private=true even from own pool", () => {
    const results = [
      makeResult({ id: "1", user_id: "household", metadata: { is_private: true } }),
      makeResult({ id: "2", user_id: "household", metadata: { is_private: false } }),
      makeResult({ id: "3", user_id: "household", metadata: {} }),
    ];
    const out = applyRecallGuard({ results, agentId: "social-household" });
    expect(out.results.map((r) => r.id)).toEqual(["2", "3"]);
    expect(out.removedCount).toBe(1);
  });

  it("drops both: private + wrong pool", () => {
    const results = [
      makeResult({ id: "1", user_id: "household", metadata: { is_private: true } }),
      makeResult({ id: "2", user_id: "operator", metadata: { is_private: false } }),
      makeResult({ id: "3", user_id: "household", metadata: { is_private: false } }),
    ];
    const out = applyRecallGuard({ results, agentId: "social-household" });
    expect(out.results.map((r) => r.id)).toEqual(["3"]);
    expect(out.removedCount).toBe(2);
  });

  it("returns empty for results all from wrong pool", () => {
    const results = [
      makeResult({ id: "1", user_id: "operator" }),
      makeResult({ id: "2", user_id: "friends" }),
    ];
    const out = applyRecallGuard({ results, agentId: "social-household" });
    expect(out.results).toEqual([]);
    expect(out.removedCount).toBe(2);
  });

  it("handles results with undefined user_id (drops them — no pool match)", () => {
    const results = [
      makeResult({ id: "1", user_id: undefined }),
    ];
    const out = applyRecallGuard({ results, agentId: "social-household" });
    expect(out.results).toEqual([]);
    expect(out.removedCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// unknown agent: fail-closed
// ---------------------------------------------------------------------------
describe("applyRecallGuard — unknown agent", () => {
  it("returns empty results for unknown agent IDs", () => {
    const results = [
      makeResult({ id: "1" }),
      makeResult({ id: "2" }),
    ];
    const out = applyRecallGuard({ results, agentId: "custom-agent" });
    expect(out.results).toEqual([]);
    expect(out.removedCount).toBe(2);
  });

  it("returns empty results for empty agent ID", () => {
    const results = [makeResult({ id: "1" })];
    const out = applyRecallGuard({ results, agentId: "" });
    expect(out.results).toEqual([]);
    expect(out.removedCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// edge cases
// ---------------------------------------------------------------------------
describe("applyRecallGuard — edge cases", () => {
  it("handles empty results", () => {
    const out = applyRecallGuard({ results: [], agentId: "social-household" });
    expect(out.results).toEqual([]);
    expect(out.removedCount).toBe(0);
  });

  it("handles empty results for main", () => {
    const out = applyRecallGuard({ results: [], agentId: "main" });
    expect(out.results).toEqual([]);
    expect(out.removedCount).toBe(0);
  });
});
