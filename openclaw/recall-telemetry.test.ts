import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { logRecallEvent, mapCtx } from "./recall-telemetry.ts";

const TMP_DIR = join(import.meta.dirname!, "__test_telemetry_tmp__");

function resolvePath(p: string): string {
  return join(TMP_DIR, p);
}

beforeEach(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// mapCtx
// ---------------------------------------------------------------------------
describe("mapCtx", () => {
  it("maps 'group' to 'group'", () => {
    expect(mapCtx("group")).toBe("group");
  });
  it("maps 'cron' to 'cron'", () => {
    expect(mapCtx("cron")).toBe("cron");
  });
  it("maps 'private' to 'dm'", () => {
    expect(mapCtx("private")).toBe("dm");
  });
  it("maps undefined to 'dm'", () => {
    expect(mapCtx(undefined)).toBe("dm");
  });
});

// ---------------------------------------------------------------------------
// logRecallEvent — JSONL output
// ---------------------------------------------------------------------------
describe("logRecallEvent JSONL", () => {
  it("writes a valid JSONL line with correct fields", () => {
    logRecallEvent({
      agent: "main",
      ctx: "dm",
      query: "test query",
      results: [
        { id: "aaa", score: 0.85 },
        { id: "bbb", score: 0.60 },
      ],
      pools: ["testuser"],
      recallType: "auto",
      threshold: 0.5,
      resolvePath,
    });

    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const jsonlPath = resolvePath(`memory/recall-events-${month}.jsonl`);
    expect(existsSync(jsonlPath)).toBe(true);

    const line = readFileSync(jsonlPath, "utf-8").trim();
    const record = JSON.parse(line);

    expect(record.agent).toBe("main");
    expect(record.ctx).toBe("dm");
    expect(record.query).toBe("test query");
    expect(record.found).toBe(2);
    expect(record.top_score).toBe(0.85);
    expect(record.scores).toEqual([0.85, 0.60]);
    expect(record.point_ids).toEqual(["aaa", "bbb"]);
    expect(record.pool).toBe("testuser");
    expect(record.filtered_by_guard).toBe(0);
    expect(record.recall_type).toBe("auto");
    expect(record.gap).toBeUndefined(); // not a gap
    expect(record.ts).toBeDefined();
  });

  it("uses comma-joined pools for multi-pool searches", () => {
    logRecallEvent({
      agent: "main",
      ctx: "dm",
      query: "multi pool",
      results: [{ id: "x", score: 0.7 }],
      pools: ["testuser", "family"],
      recallType: "auto",
      threshold: 0.5,
      resolvePath,
    });

    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const line = readFileSync(
      resolvePath(`memory/recall-events-${month}.jsonl`),
      "utf-8",
    ).trim();
    expect(JSON.parse(line).pool).toBe("testuser,family");
  });

  it("defaults filteredByGuard to 0", () => {
    logRecallEvent({
      agent: "social",
      ctx: "group",
      query: "q",
      results: [{ id: "a", score: 0.9 }],
      pools: ["family"],
      recallType: "explicit",
      threshold: 0.5,
      resolvePath,
    });

    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const line = readFileSync(
      resolvePath(`memory/recall-events-${month}.jsonl`),
      "utf-8",
    ).trim();
    expect(JSON.parse(line).filtered_by_guard).toBe(0);
  });

  it("passes through explicit filteredByGuard value", () => {
    logRecallEvent({
      agent: "main",
      ctx: "group",
      query: "q",
      results: [{ id: "a", score: 0.8 }],
      pools: ["family"],
      recallType: "auto",
      filteredByGuard: 3,
      threshold: 0.5,
      resolvePath,
    });

    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const line = readFileSync(
      resolvePath(`memory/recall-events-${month}.jsonl`),
      "utf-8",
    ).trim();
    expect(JSON.parse(line).filtered_by_guard).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// logRecallEvent — gap detection
// ---------------------------------------------------------------------------
describe("logRecallEvent gap detection", () => {
  it("marks gap when found=0", () => {
    logRecallEvent({
      agent: "social",
      ctx: "group",
      query: "missing info",
      results: [],
      pools: ["family"],
      recallType: "auto",
      threshold: 0.5,
      resolvePath,
    });

    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const line = readFileSync(
      resolvePath(`memory/recall-events-${month}.jsonl`),
      "utf-8",
    ).trim();
    const record = JSON.parse(line);
    expect(record.gap).toBe(true);
    expect(record.found).toBe(0);
    expect(record.top_score).toBe(0);
  });

  it("marks gap when top_score < threshold", () => {
    logRecallEvent({
      agent: "main",
      ctx: "dm",
      query: "low relevance",
      results: [{ id: "z", score: 0.3 }],
      pools: ["testuser"],
      recallType: "explicit",
      threshold: 0.5,
      resolvePath,
    });

    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const line = readFileSync(
      resolvePath(`memory/recall-events-${month}.jsonl`),
      "utf-8",
    ).trim();
    expect(JSON.parse(line).gap).toBe(true);
  });

  it("does NOT mark gap when top_score >= threshold", () => {
    logRecallEvent({
      agent: "main",
      ctx: "dm",
      query: "good match",
      results: [{ id: "a", score: 0.8 }],
      pools: ["testuser"],
      recallType: "auto",
      threshold: 0.5,
      resolvePath,
    });

    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const line = readFileSync(
      resolvePath(`memory/recall-events-${month}.jsonl`),
      "utf-8",
    ).trim();
    expect(JSON.parse(line).gap).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// logRecallEvent — gap journal
// ---------------------------------------------------------------------------
describe("logRecallEvent gap journal", () => {
  it("appends to gap-journal.md on gap events", () => {
    logRecallEvent({
      agent: "social",
      ctx: "group",
      query: "where is the thing",
      results: [],
      pools: ["family"],
      recallType: "auto",
      threshold: 0.5,
      resolvePath,
    });

    const journalPath = resolvePath("memory/gap-journal.md");
    expect(existsSync(journalPath)).toBe(true);

    const content = readFileSync(journalPath, "utf-8");
    expect(content).toContain("| social | group | family pool");
    expect(content).toContain("Query: where is the thing");
    expect(content).toContain("Result: 0 found");
    expect(content).toContain("---");
  });

  it("does NOT write gap journal for non-gap events", () => {
    logRecallEvent({
      agent: "main",
      ctx: "dm",
      query: "good query",
      results: [{ id: "a", score: 0.9 }],
      pools: ["testuser"],
      recallType: "auto",
      threshold: 0.5,
      resolvePath,
    });

    const journalPath = resolvePath("memory/gap-journal.md");
    expect(existsSync(journalPath)).toBe(false);
  });
});
