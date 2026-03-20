/**
 * Recall Telemetry Module (Vigil A1a+A1b combined)
 *
 * Logs every recall event (auto-recall and explicit memory_search) to two
 * output streams:
 *   1. recall-events-YYYY-MM.jsonl — structured telemetry (monthly rotation)
 *   2. memory/gap-journal.md — human-readable log of gap events
 *
 * All writes are synchronous (fs.appendFileSync) to avoid blocking the
 * recall path with async I/O promises.
 */

import { mkdirSync, appendFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export interface RecallEventInput {
  agent: string;
  ctx: string; // "dm" | "group" | "cron"
  query: string;
  results: Array<{ id: string; score?: number }>;
  pools: string[];
  recallType: "auto" | "explicit";
  filteredByGuard?: number;
  threshold: number;
  resolvePath: (p: string) => string;
}

interface RecallEventRecord {
  ts: string;
  agent: string;
  ctx: string;
  query: string;
  found: number;
  top_score: number;
  scores: number[];
  point_ids: string[];
  pool: string;
  filtered_by_guard: number;
  recall_type: string;
  gap?: boolean;
}

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Map extractSessionInfo().conversationType to the ctx values used in
 * telemetry and the recall guard.
 */
export function mapCtx(conversationType: string | undefined): string {
  if (conversationType === "group") return "group";
  if (conversationType === "cron") return "cron";
  return "dm"; // "private", undefined, or anything else → dm
}

/**
 * Log a recall event to the JSONL telemetry file and, on gap events,
 * to the human-readable gap journal.
 */
export function logRecallEvent(opts: RecallEventInput): void {
  const {
    agent,
    ctx,
    query,
    results,
    pools,
    recallType,
    filteredByGuard = 0,
    threshold,
    resolvePath,
  } = opts;

  const found = results.length;
  const scores = results.map((r) => r.score ?? 0);
  const topScore = scores.length > 0 ? Math.max(...scores) : 0;
  const pointIds = results.map((r) => r.id);
  const pool = pools.join(",");
  const isGap = found === 0 || topScore < threshold;

  const record: RecallEventRecord = {
    ts: new Date().toISOString(),
    agent,
    ctx,
    query,
    found,
    top_score: topScore,
    scores,
    point_ids: pointIds,
    pool,
    filtered_by_guard: filteredByGuard,
    recall_type: recallType,
  };
  if (isGap) record.gap = true;

  // Stream 1: JSONL (monthly rotation)
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const jsonlPath = resolvePath(`memory/recall-events-${month}.jsonl`);
  try {
    ensureDir(jsonlPath);
    appendFileSync(jsonlPath, JSON.stringify(record) + "\n");
  } catch {
    // Telemetry must never break the recall path
  }

  // Stream 2: gap journal (only on gap events)
  if (isGap) {
    const journalPath = resolvePath("memory/gap-journal.md");
    const localTime = now.toISOString().replace("T", " ").slice(0, 16);
    const entry = `## ${localTime} | ${agent} | ${ctx} | ${pool} pool\nQuery: ${query.slice(0, 200)}\nResult: ${found} found\n---\n\n`;
    try {
      ensureDir(journalPath);
      appendFileSync(journalPath, entry);
    } catch {
      // Telemetry must never break the recall path
    }
  }
}
