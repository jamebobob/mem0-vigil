/**
 * Recall Guard (Vigil A2)
 *
 * Convention-based recall filter. No config file needed — new agents
 * just work based on their ID prefix.
 *
 * Rules:
 *   - agentId "main": all results pass (operator sees everything, cron runs as main)
 *   - agentId "social-*": keep only results where user_id matches the pool
 *     name (agentId minus "social-" prefix) AND is_private !== true
 *   - any other agentId: fail-closed, return empty results
 *
 * Separate file from telemetry for independent revert capability.
 */

export interface GuardableResult {
  id: string;
  memory: string;
  score?: number;
  user_id?: string;
  metadata?: Record<string, unknown>;
}

export interface GuardOutput<T extends GuardableResult> {
  results: T[];
  removedCount: number;
}

/**
 * Apply the recall guard to a set of search results.
 *
 * Returns the filtered results and the count of removed items (for
 * the telemetry module's filtered_by_guard field).
 */
export function applyRecallGuard<T extends GuardableResult>(opts: {
  results: T[];
  agentId: string;
}): GuardOutput<T> {
  const { results, agentId } = opts;

  // Main agent sees everything (cron also runs as main)
  if (agentId === "main") {
    return { results, removedCount: 0 };
  }

  // Social agents: pool name derived from agent ID
  if (agentId.startsWith("social-")) {
    const allowedPool = agentId.slice(7); // strip "social-"
    const filtered = results.filter((r) => {
      // Drop private results
      if (r.metadata?.is_private === true) return false;
      // Keep only results from this agent's pool
      if (r.user_id !== allowedPool) return false;
      return true;
    });
    return {
      results: filtered,
      removedCount: results.length - filtered.length,
    };
  }

  // Unknown agent: fail-closed
  return { results: [], removedCount: results.length };
}
