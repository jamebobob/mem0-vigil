/**
 * OpenClaw Memory (Mem0) Plugin
 *
 * Long-term memory via Mem0 — supports both the Mem0 platform
 * and the open-source self-hosted SDK. Uses the official `mem0ai` package.
 *
 * Features:
 * - 5 tools: memory_search, memory_list, memory_store, memory_get, memory_forget
 *   (with session/long-term scope support via scope and longTerm parameters)
 * - Short-term (session-scoped) and long-term (user-scoped) memory
 * - Auto-recall: injects relevant memories (both scopes) before each agent turn
 * - Auto-capture: stores key facts scoped to the current session after each agent turn
 * - Multi-pool memory: agents write/read from configurable named pools (via agentMemory
 *   config) with fail-closed boundary enforcement and provenance metadata
 * - Per-agent isolation: multi-agent setups write/read from separate userId namespaces
 *   automatically via sessionKey routing (zero breaking changes for single-agent setups)
 * - CLI: openclaw mem0 search, openclaw mem0 stats
 * - Dual mode: platform or open-source (self-hosted)
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import type {
  Mem0Config,
  Mem0Provider,
  MemoryItem,
  AddOptions,
  SearchOptions,
} from "./types.ts";
import { createProvider } from "./providers.ts";
import { mem0ConfigSchema } from "./config.ts";
import {
  filterMessagesForExtraction,
} from "./filtering.ts";
import {
  effectiveUserId,
  agentUserId,
  resolveUserId,
  isNonInteractiveTrigger,
  isSubagentSession,
} from "./isolation.ts";
import { logRecallEvent, mapCtx } from "./recall-telemetry.js";
import { filterCaptureMessages } from "./capture-filter.js";
import { applyRecallGuard } from "./recall-guard.js";

// ============================================================================
// Re-exports (for tests and external consumers)
// ============================================================================

export { extractAgentId, effectiveUserId, agentUserId, resolveUserId, isNonInteractiveTrigger, isSubagentSession } from "./isolation.ts";
export {
  isNoiseMessage,
  isGenericAssistantMessage,
  stripNoiseFromContent,
  filterMessagesForExtraction,
} from "./filtering.ts";
export { mem0ConfigSchema } from "./config.ts";
export { createProvider } from "./providers.ts";

// ============================================================================
// Helpers
// ============================================================================

/** Convert Record<string, string> categories to the array format mem0ai expects */
function categoriesToArray(
  cats: Record<string, string>,
): Array<Record<string, string>> {
  return Object.entries(cats).map(([key, value]) => ({ [key]: value }));
}

// ============================================================================
// Plugin Definition
// ============================================================================

const memoryPlugin = {
  id: "openclaw-mem0",
  name: "Memory (Mem0)",
  description:
    "Mem0 memory backend — Mem0 platform or self-hosted open-source",
  kind: "memory" as const,
  configSchema: mem0ConfigSchema,

  register(api: OpenClawPluginApi) {
    const cfg = mem0ConfigSchema.parse(api.pluginConfig);
    const provider = createProvider(cfg, api);

    // Track current session ID for tool-level session scoping.
    // NOTE: This is shared mutable state — tools don't receive ctx, so they
    // read this as a best-effort fallback. Hooks should use ctx.sessionKey
    // directly and avoid relying on this variable.
    let currentSessionId: string | undefined;
    let currentAgentId: string | undefined;

    // ========================================================================
    // Multi-pool helpers (agentMemory-based routing)
    // ========================================================================

    function extractSessionInfo(sessionKey: string | undefined): {
      agentId?: string;
      channel?: string;
      conversationType?: string;
      chatId?: string;
    } {
      if (!sessionKey) return {};
      const parts = sessionKey.split(":");
      // Pattern: agent:<agentId>:<channel>:<type>:<id>
      const agId = parts.length >= 2 && parts[0] === "agent" ? parts[1] : undefined;
      const channel = parts.length >= 3 ? parts[2] : undefined;
      if (channel === "cron") {
        return { agentId: agId, channel, conversationType: "cron", chatId: parts.length >= 4 ? parts.slice(3).join(":") : undefined };
      }
      const conversationType = parts.length >= 4 ? parts[3] : undefined;
      const chatId = parts.length >= 5 ? parts.slice(4).join(":") : undefined;
      return { agentId: agId, channel, conversationType, chatId };
    }

    function getCapturePool(agentId: string | undefined): string | undefined {
      if (!cfg.agentMemory) return cfg.userId;
      // Fail-closed: deny capture if agent unknown and multi-pool active
      if (!agentId) return undefined;
      const key = agentId ?? "main";
      // Fail-closed: deny capture if agent defined but not in pool map
      if (!cfg.agentMemory[key]) return undefined;
      return cfg.agentMemory[key].capture;
    }

    function getRecallPools(agentId: string | undefined): string[] {
      if (!cfg.agentMemory) return [cfg.userId];
      // Fail-closed: deny all recall if agent unknown and multi-pool active
      if (!agentId) return [];
      const key = agentId ?? "main";
      // Fail-closed: deny recall if agent defined but not in pool map
      if (!cfg.agentMemory[key]) return [];
      return cfg.agentMemory[key].recall;
    }

    function isPoolAllowed(pool: string, agentId: string | undefined): boolean {
      if (!cfg.agentMemory) return true; // no multi-pool config, allow all
      if (!agentId) return false;
      const allowed = getRecallPools(agentId);
      return allowed.includes(pool);
    }

    // ========================================================================
    // Per-agent isolation helpers (thin wrappers around exported functions)
    // ========================================================================
    const _effectiveUserId = (sessionKey?: string) =>
      effectiveUserId(cfg.userId, sessionKey);
    const _agentUserId = (id: string) => agentUserId(cfg.userId, id);
    const _resolveUserId = (opts: { agentId?: string; userId?: string }) =>
      resolveUserId(cfg.userId, opts, currentSessionId);

    api.logger.info(
      `openclaw-mem0: registered (mode: ${cfg.mode}, user: ${cfg.userId}, graph: ${cfg.enableGraph}, autoRecall: ${cfg.autoRecall}, autoCapture: ${cfg.autoCapture})`,
    );

    // Helper: build add options
    function buildAddOptions(userIdOverride?: string, runId?: string, sessionKey?: string, metadata?: Record<string, unknown>): AddOptions {
      const opts: AddOptions = {
        user_id: userIdOverride || _effectiveUserId(sessionKey),
        source: "OPENCLAW",
      };
      if (runId) opts.run_id = runId;
      if (metadata) opts.metadata = metadata;
      if (cfg.mode === "platform") {
        opts.custom_instructions = cfg.customInstructions;
        opts.custom_categories = categoriesToArray(cfg.customCategories);
        opts.enable_graph = cfg.enableGraph;
        opts.output_format = "v1.1";
      }
      return opts;
    }

    // Helper: build search options
    function buildSearchOptions(
      userIdOverride?: string,
      limit?: number,
      runId?: string,
      sessionKey?: string,
    ): SearchOptions {
      const opts: SearchOptions = {
        user_id: userIdOverride || _effectiveUserId(sessionKey),
        top_k: limit ?? cfg.topK,
        limit: limit ?? cfg.topK,
        threshold: cfg.searchThreshold,
        keyword_search: true,
        reranking: true,
        source: "OPENCLAW",
      };
      if (runId) opts.run_id = runId;
      return opts;
    }

    // ========================================================================
    // Tools
    // ========================================================================

    registerTools(api, provider, cfg, _resolveUserId, _effectiveUserId, _agentUserId, buildAddOptions, buildSearchOptions, () => currentSessionId, () => currentAgentId, { getCapturePool, getRecallPools, isPoolAllowed, extractSessionInfo });

    // ========================================================================
    // CLI Commands
    // ========================================================================

    registerCli(api, provider, cfg, _effectiveUserId, _agentUserId, buildSearchOptions, () => currentSessionId);

    // ========================================================================
    // Lifecycle Hooks
    // ========================================================================

    registerHooks(api, provider, cfg, _effectiveUserId, buildAddOptions, buildSearchOptions, {
      setCurrentSessionId: (id: string) => { currentSessionId = id; },
      setCurrentAgentId: (id: string | undefined) => { currentAgentId = id; },
      getCurrentAgentId: () => currentAgentId,
    }, { getCapturePool, getRecallPools, extractSessionInfo });

    // B7 FIX: Refresh currentAgentId right before each tool executes.
    // Fires synchronously before execute(), closing the race window.
    api.on("before_tool_call", async (_event, ctx) => {
      const hookAgentId = (ctx as any)?.agentId;
      if (hookAgentId) currentAgentId = hookAgentId;
    });

    // ========================================================================
    // Service
    // ========================================================================

    api.registerService({
      id: "openclaw-mem0",
      start: () => {
        api.logger.info(
          `openclaw-mem0: initialized (mode: ${cfg.mode}, user: ${cfg.userId}, autoRecall: ${cfg.autoRecall}, autoCapture: ${cfg.autoCapture})`,
        );
      },
      stop: () => {
        api.logger.info("openclaw-mem0: stopped");
      },
    });
  },
};

// ============================================================================
// Multi-pool helpers type
// ============================================================================

interface PoolHelpers {
  getCapturePool: (agentId: string | undefined) => string | undefined;
  getRecallPools: (agentId: string | undefined) => string[];
  isPoolAllowed: (pool: string, agentId: string | undefined) => boolean;
  extractSessionInfo: (sessionKey: string | undefined) => {
    agentId?: string;
    channel?: string;
    conversationType?: string;
    chatId?: string;
  };
}

// ============================================================================
// Tool Registration
// ============================================================================

function registerTools(
  api: OpenClawPluginApi,
  provider: Mem0Provider,
  cfg: Mem0Config,
  _resolveUserId: (opts: { agentId?: string; userId?: string }) => string,
  _effectiveUserId: (sessionKey?: string) => string,
  _agentUserId: (id: string) => string,
  buildAddOptions: (userIdOverride?: string, runId?: string, sessionKey?: string, metadata?: Record<string, unknown>) => AddOptions,
  buildSearchOptions: (userIdOverride?: string, limit?: number, runId?: string, sessionKey?: string) => SearchOptions,
  getCurrentSessionId: () => string | undefined,
  getCurrentAgentId: () => string | undefined,
  pool: PoolHelpers,
) {
  api.registerTool(
    {
      name: "memory_search",
      label: "Memory Search",
      description:
        "Search through long-term memories stored in Mem0. Use when you need context about user preferences, past decisions, or previously discussed topics.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query" }),
        limit: Type.Optional(
          Type.Number({
            description: `Max results (default: ${cfg.topK})`,
          }),
        ),
        userId: Type.Optional(
          Type.String({
            description:
              "User ID to scope search (default: configured userId)",
          }),
        ),
        agentId: Type.Optional(
          Type.String({
            description:
              "Agent ID to search memories for a specific agent (e.g. \"researcher\"). Overrides userId.",
          }),
        ),
        scope: Type.Optional(
          Type.Union([
            Type.Literal("session"),
            Type.Literal("long-term"),
            Type.Literal("all"),
          ], {
            description:
              'Memory scope: "session" (current session only), "long-term" (user-scoped only), or "all" (both). Default: "all"',
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const { query, limit, userId, agentId: paramAgentId, scope = "all" } = params as {
          query: string;
          limit?: number;
          userId?: string;
          agentId?: string;
          scope?: "session" | "long-term" | "all";
        };

        try {
          let results: MemoryItem[] = [];
          // B7 FIX: Snapshot agentId before any await
          const agentId = paramAgentId ?? getCurrentAgentId();
          const currentSessionId = getCurrentSessionId();

          // Pool boundary check when agentMemory is configured
          if (userId && !pool.isPoolAllowed(userId, agentId)) {
            return {
              content: [
                { type: "text", text: "Access denied: pool not in recall list" },
              ],
              details: { error: "pool_boundary" },
            };
          }

          if (cfg.agentMemory) {
            // Multi-pool routing
            if (scope === "session") {
              if (currentSessionId) {
                const capturePool = userId || pool.getCapturePool(agentId);
                if (!capturePool) {
                  return {
                    content: [
                      { type: "text", text: "Access denied: agent identity unknown" },
                    ],
                    details: { error: "unknown_agent" },
                  };
                }
                results = await provider.search(
                  query,
                  buildSearchOptions(capturePool, limit, currentSessionId),
                );
              }
            } else if (scope === "long-term") {
              if (userId) {
                results = await provider.search(query, buildSearchOptions(userId, limit));
              } else {
                const pools = pool.getRecallPools(agentId);
                for (const p of pools) {
                  const poolResults = await provider.search(query, buildSearchOptions(p, limit));
                  results.push(...poolResults);
                }
              }
            } else {
              // "all" — search all recall pools + session
              if (userId) {
                results = await provider.search(query, buildSearchOptions(userId, limit));
              } else {
                const pools = pool.getRecallPools(agentId);
                for (const p of pools) {
                  const poolResults = await provider.search(query, buildSearchOptions(p, limit));
                  results.push(...poolResults);
                }
              }
              if (currentSessionId) {
                const capturePool = userId || pool.getCapturePool(agentId);
                if (capturePool) {
                  const sessionResults = await provider.search(
                    query,
                    buildSearchOptions(capturePool, limit, currentSessionId),
                  );
                  results.push(...sessionResults);
                }
              }
            }
            // Deduplicate by ID
            const seen = new Set<string>();
            results = results.filter((r) => {
              if (seen.has(r.id)) return false;
              seen.add(r.id);
              return true;
            });
            // Sort by relevance, cap at topK
            results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
            results = results.slice(0, limit ?? cfg.topK);

            // Recall telemetry (explicit search)
            const searchSessionInfo = pool.extractSessionInfo(currentSessionId);
            const searchPools = userId ? [userId] : pool.getRecallPools(agentId);
            logRecallEvent({
              agent: agentId ?? "main",
              ctx: mapCtx(searchSessionInfo.conversationType),
              query,
              results,
              pools: searchPools,
              recallType: "explicit",
              threshold: cfg.searchThreshold,
              resolvePath: (p) => api.resolvePath(p),
            });
          } else {
            // Standard routing (no multi-pool)
            const uid = _resolveUserId({ agentId: paramAgentId, userId });

            if (scope === "session") {
              if (currentSessionId) {
                results = await provider.search(
                  query,
                  buildSearchOptions(uid, limit, currentSessionId),
                );
              }
            } else if (scope === "long-term") {
              results = await provider.search(
                query,
                buildSearchOptions(uid, limit),
              );
            } else {
              // "all" — search both scopes and combine
              const longTermResults = await provider.search(
                query,
                buildSearchOptions(uid, limit),
              );
              let sessionResults: MemoryItem[] = [];
              if (currentSessionId) {
                sessionResults = await provider.search(
                  query,
                  buildSearchOptions(uid, limit, currentSessionId),
                );
              }
              // Deduplicate by ID, preferring long-term
              const seen = new Set(longTermResults.map((r) => r.id));
              results = [
                ...longTermResults,
                ...sessionResults.filter((r) => !seen.has(r.id)),
              ];
            }
          }

          if (!results || results.length === 0) {
            return {
              content: [
                { type: "text", text: "No relevant memories found." },
              ],
              details: { count: 0 },
            };
          }

          const text = results
            .map(
              (r, i) =>
                `${i + 1}. ${r.memory} (score: ${((r.score ?? 0) * 100).toFixed(0)}%, id: ${r.id})`,
            )
            .join("\n");

          const sanitized = results.map((r) => ({
            id: r.id,
            memory: r.memory,
            score: r.score,
            categories: r.categories,
            created_at: r.created_at,
          }));

          return {
            content: [
              {
                type: "text",
                text: `Found ${results.length} memories:\n\n${text}`,
              },
            ],
            details: { count: results.length, memories: sanitized },
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: `Memory search failed: ${String(err)}`,
              },
            ],
            details: { error: String(err) },
          };
        }
      },
    },
    { name: "memory_search" },
  );

  api.registerTool(
    {
      name: "memory_store",
      label: "Memory Store",
      description:
        "Save important information in long-term memory via Mem0. Use for preferences, facts, decisions, and anything worth remembering.",
      parameters: Type.Object({
        text: Type.String({ description: "Information to remember" }),
        userId: Type.Optional(
          Type.String({
            description: "User ID to scope this memory",
          }),
        ),
        agentId: Type.Optional(
          Type.String({
            description:
              "Agent ID to store memory under a specific agent's namespace (e.g. \"researcher\"). Overrides userId.",
          }),
        ),
        metadata: Type.Optional(
          Type.Record(Type.String(), Type.Unknown(), {
            description: "Optional metadata to attach to this memory",
          }),
        ),
        longTerm: Type.Optional(
          Type.Boolean({
            description:
              "Store as long-term (user-scoped) memory. Default: true. Set to false for session-scoped memory.",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const { text, userId, agentId: paramAgentId, longTerm = true } = params as {
          text: string;
          userId?: string;
          agentId?: string;
          metadata?: Record<string, unknown>;
          longTerm?: boolean;
        };

        try {
          const agentId = paramAgentId ?? getCurrentAgentId();
          const currentSessionId = getCurrentSessionId();
          let uid: string;

          if (cfg.agentMemory) {
            const capturePool = userId || pool.getCapturePool(agentId);
            if (!capturePool) {
              return {
                content: [
                  { type: "text", text: "Access denied: agent identity unknown" },
                ],
                details: { error: "unknown_agent" },
              };
            }
            uid = capturePool;
          } else {
            uid = _resolveUserId({ agentId: paramAgentId, userId });
          }

          const runId = !longTerm && currentSessionId ? currentSessionId : undefined;

          // Pre-check for near-duplicates so the extraction model has
          // context about existing memories and can UPDATE rather than ADD
          const preview = text.slice(0, 200);
          const dedupOpts = buildSearchOptions(uid, 3);
          dedupOpts.threshold = 0.85;
          const existing = await provider.search(preview, dedupOpts);
          if (existing.length > 0) {
            api.logger.info(
              `openclaw-mem0: found ${existing.length} similar existing memories — mem0 may update instead of add`,
            );
          }

          const result = await provider.add(
            [{ role: "user", content: text }],
            buildAddOptions(uid, runId, currentSessionId),
          );

          const added =
            result.results?.filter((r) => r.event === "ADD") ?? [];
          const updated =
            result.results?.filter((r) => r.event === "UPDATE") ?? [];

          const summary = [];
          if (added.length > 0)
            summary.push(
              `${added.length} new memor${added.length === 1 ? "y" : "ies"} added`,
            );
          if (updated.length > 0)
            summary.push(
              `${updated.length} memor${updated.length === 1 ? "y" : "ies"} updated`,
            );
          if (summary.length === 0)
            summary.push("No new memories extracted");

          return {
            content: [
              {
                type: "text",
                text: `Stored: ${summary.join(", ")}. ${result.results?.map((r) => `[${r.event}] ${r.memory}`).join("; ") ?? ""}`,
              },
            ],
            details: {
              action: "stored",
              results: result.results,
            },
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: `Memory store failed: ${String(err)}`,
              },
            ],
            details: { error: String(err) },
          };
        }
      },
    },
    { name: "memory_store" },
  );

  api.registerTool(
    {
      name: "memory_get",
      label: "Memory Get",
      description: "Retrieve a specific memory by its ID from Mem0.",
      parameters: Type.Object({
        memoryId: Type.String({ description: "The memory ID to retrieve" }),
      }),
      async execute(_toolCallId, params) {
        const { memoryId } = params as { memoryId: string };

        try {
          // B7 FIX: Snapshot agentId before any await
          const agentId = getCurrentAgentId();
          const memory = await provider.get(memoryId);

          // Pool boundary check: deny if user_id missing OR not in allowed pools
          if (cfg.agentMemory && (!memory.user_id || !pool.isPoolAllowed(memory.user_id, agentId))) {
            return {
              content: [
                { type: "text", text: "Access denied: memory not in recall pools" },
              ],
              details: { error: "pool_boundary" },
            };
          }

          return {
            content: [
              {
                type: "text",
                text: `Memory ${memory.id}:\n${memory.memory}\n\nCreated: ${memory.created_at ?? "unknown"}\nUpdated: ${memory.updated_at ?? "unknown"}`,
              },
            ],
            details: { memory },
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: `Memory get failed: ${String(err)}`,
              },
            ],
            details: { error: String(err) },
          };
        }
      },
    },
    { name: "memory_get" },
  );

  api.registerTool(
    {
      name: "memory_list",
      label: "Memory List",
      description:
        "List all stored memories for a user or agent. Use this when you want to see everything that's been remembered, rather than searching for something specific.",
      parameters: Type.Object({
        userId: Type.Optional(
          Type.String({
            description:
              "User ID to list memories for (default: configured userId)",
          }),
        ),
        agentId: Type.Optional(
          Type.String({
            description:
              "Agent ID to list memories for a specific agent (e.g. \"researcher\"). Overrides userId.",
          }),
        ),
        scope: Type.Optional(
          Type.Union([
            Type.Literal("session"),
            Type.Literal("long-term"),
            Type.Literal("all"),
          ], {
            description:
              'Memory scope: "session" (current session only), "long-term" (user-scoped only), or "all" (both). Default: "all"',
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const { userId, agentId: paramAgentId, scope = "all" } = params as { userId?: string; agentId?: string; scope?: "session" | "long-term" | "all" };

        try {
          let memories: MemoryItem[] = [];
          // B7 FIX: Snapshot agentId before any await
          const agentId = paramAgentId ?? getCurrentAgentId();
          const currentSessionId = getCurrentSessionId();

          // Pool boundary check
          if (userId && !pool.isPoolAllowed(userId, agentId)) {
            return {
              content: [
                { type: "text", text: "Access denied: pool not in recall list" },
              ],
              details: { error: "pool_boundary" },
            };
          }

          if (cfg.agentMemory) {
            // Multi-pool routing
            if (scope === "session") {
              if (currentSessionId) {
                const capturePool = userId || pool.getCapturePool(agentId);
                if (!capturePool) {
                  return {
                    content: [
                      { type: "text", text: "Access denied: agent identity unknown" },
                    ],
                    details: { error: "unknown_agent" },
                  };
                }
                memories = await provider.getAll({
                  user_id: capturePool,
                  run_id: currentSessionId,
                  source: "OPENCLAW",
                });
              }
            } else if (scope === "long-term") {
              if (userId) {
                memories = await provider.getAll({ user_id: userId, source: "OPENCLAW" });
              } else {
                const pools = pool.getRecallPools(agentId);
                for (const p of pools) {
                  const poolMemories = await provider.getAll({ user_id: p, source: "OPENCLAW" });
                  memories.push(...poolMemories);
                }
              }
            } else {
              // "all" — list from all recall pools + session
              if (userId) {
                memories = await provider.getAll({ user_id: userId, source: "OPENCLAW" });
              } else {
                const pools = pool.getRecallPools(agentId);
                for (const p of pools) {
                  const poolMemories = await provider.getAll({ user_id: p, source: "OPENCLAW" });
                  memories.push(...poolMemories);
                }
              }
              if (currentSessionId) {
                const capturePool = userId || pool.getCapturePool(agentId);
                if (capturePool) {
                  const sessionMems = await provider.getAll({
                    user_id: capturePool,
                    run_id: currentSessionId,
                    source: "OPENCLAW",
                  });
                  const seenIds = new Set(memories.map((r) => r.id));
                  memories.push(...sessionMems.filter((r) => !seenIds.has(r.id)));
                }
              }
            }
            // Deduplicate by ID
            const dedup = new Set<string>();
            memories = memories.filter((r) => {
              if (dedup.has(r.id)) return false;
              dedup.add(r.id);
              return true;
            });
          } else {
            // Standard routing (no multi-pool)
            const uid = _resolveUserId({ agentId: paramAgentId, userId });

            if (scope === "session") {
              if (currentSessionId) {
                memories = await provider.getAll({
                  user_id: uid,
                  run_id: currentSessionId,
                  source: "OPENCLAW",
                });
              }
            } else if (scope === "long-term") {
              memories = await provider.getAll({ user_id: uid, source: "OPENCLAW" });
            } else {
              const longTerm = await provider.getAll({ user_id: uid, source: "OPENCLAW" });
              let session: MemoryItem[] = [];
              if (currentSessionId) {
                session = await provider.getAll({
                  user_id: uid,
                  run_id: currentSessionId,
                  source: "OPENCLAW",
                });
              }
              const seen = new Set(longTerm.map((r) => r.id));
              memories = [
                ...longTerm,
                ...session.filter((r) => !seen.has(r.id)),
              ];
            }
          }

          if (!memories || memories.length === 0) {
            return {
              content: [
                { type: "text", text: "No memories stored yet." },
              ],
              details: { count: 0 },
            };
          }

          const text = memories
            .map(
              (r, i) =>
                `${i + 1}. ${r.memory} (id: ${r.id})`,
            )
            .join("\n");

          const sanitized = memories.map((r) => ({
            id: r.id,
            memory: r.memory,
            categories: r.categories,
            created_at: r.created_at,
          }));

          return {
            content: [
              {
                type: "text",
                text: `${memories.length} memories:\n\n${text}`,
              },
            ],
            details: { count: memories.length, memories: sanitized },
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: `Memory list failed: ${String(err)}`,
              },
            ],
            details: { error: String(err) },
          };
        }
      },
    },
    { name: "memory_list" },
  );

  api.registerTool(
    {
      name: "memory_forget",
      label: "Memory Forget",
      description:
        "Delete memories from Mem0. Provide a specific memoryId to delete directly, or a query to search and delete matching memories. Supports agent-scoped deletion. GDPR-compliant.",
      parameters: Type.Object({
        query: Type.Optional(
          Type.String({
            description: "Search query to find memory to delete",
          }),
        ),
        memoryId: Type.Optional(
          Type.String({ description: "Specific memory ID to delete" }),
        ),
        agentId: Type.Optional(
          Type.String({
            description:
              "Agent ID to scope deletion to a specific agent's memories (e.g. \"researcher\").",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const { query, memoryId, agentId: paramAgentId } = params as {
          query?: string;
          memoryId?: string;
          agentId?: string;
        };

        try {
          const agentId = paramAgentId ?? getCurrentAgentId();

          if (memoryId) {
            // Pool boundary check before delete
            if (cfg.agentMemory) {
              const mem = await provider.get(memoryId);
              if (!mem.user_id || !pool.isPoolAllowed(mem.user_id, agentId)) {
                return {
                  content: [
                    { type: "text", text: "Access denied: memory not in recall pools" },
                  ],
                  details: { error: "pool_boundary" },
                };
              }
            }
            await provider.delete(memoryId);
            return {
              content: [
                { type: "text", text: `Memory ${memoryId} forgotten.` },
              ],
              details: { action: "deleted", id: memoryId },
            };
          }

          if (query) {
            let results: MemoryItem[] = [];

            if (cfg.agentMemory) {
              // Search across all recall pools for this agent
              const pools = pool.getRecallPools(agentId);
              for (const p of pools) {
                const poolResults = await provider.search(
                  query,
                  buildSearchOptions(p, 5),
                );
                results.push(...poolResults);
              }
              // Deduplicate
              const seenIds = new Set<string>();
              results = results.filter((r) => {
                if (seenIds.has(r.id)) return false;
                seenIds.add(r.id);
                return true;
              });
              results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
              results = results.slice(0, 5);
            } else {
              const uid = _resolveUserId({ agentId: paramAgentId });
              results = await provider.search(
                query,
                buildSearchOptions(uid, 5),
              );
            }

            if (!results || results.length === 0) {
              return {
                content: [
                  { type: "text", text: "No matching memories found." },
                ],
                details: { found: 0 },
              };
            }

            // If single high-confidence match, delete directly
            if (
              results.length === 1 ||
              (results[0].score ?? 0) > 0.9
            ) {
              // Pool boundary defense-in-depth before delete
              if (cfg.agentMemory && (!results[0].user_id || !pool.isPoolAllowed(results[0].user_id, agentId))) {
                return {
                  content: [
                    { type: "text", text: "Access denied: memory not in recall pools" },
                  ],
                  details: { error: "pool_boundary" },
                };
              }
              await provider.delete(results[0].id);
              return {
                content: [
                  {
                    type: "text",
                    text: `Forgotten: "${results[0].memory}"`,
                  },
                ],
                details: { action: "deleted", id: results[0].id },
              };
            }

            const list = results
              .map(
                (r) =>
                  `- [${r.id}] ${r.memory.slice(0, 80)}${r.memory.length > 80 ? "..." : ""} (score: ${((r.score ?? 0) * 100).toFixed(0)}%)`,
              )
              .join("\n");

            const candidates = results.map((r) => ({
              id: r.id,
              memory: r.memory,
              score: r.score,
            }));

            return {
              content: [
                {
                  type: "text",
                  text: `Found ${results.length} candidates. Specify memoryId to delete:\n${list}`,
                },
              ],
              details: { action: "candidates", candidates },
            };
          }

          return {
            content: [
              { type: "text", text: "Provide a query or memoryId." },
            ],
            details: { error: "missing_param" },
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: `Memory forget failed: ${String(err)}`,
              },
            ],
            details: { error: String(err) },
          };
        }
      },
    },
    { name: "memory_forget" },
  );
}

// ============================================================================
// CLI Registration
// ============================================================================

function registerCli(
  api: OpenClawPluginApi,
  provider: Mem0Provider,
  cfg: Mem0Config,
  _effectiveUserId: (sessionKey?: string) => string,
  _agentUserId: (id: string) => string,
  buildSearchOptions: (userIdOverride?: string, limit?: number, runId?: string, sessionKey?: string) => SearchOptions,
  getCurrentSessionId: () => string | undefined,
) {
  api.registerCli(
    ({ program }) => {
      const mem0 = program
        .command("mem0")
        .description("Mem0 memory plugin commands");

      mem0
        .command("search")
        .description("Search memories in Mem0")
        .argument("<query>", "Search query")
        .option("--limit <n>", "Max results", String(cfg.topK))
        .option("--scope <scope>", 'Memory scope: "session", "long-term", or "all"', "all")
        .option("--agent <agentId>", "Search a specific agent's memory namespace")
        .action(async (query: string, opts: { limit: string; scope: string; agent?: string }) => {
          try {
            const limit = parseInt(opts.limit, 10);
            const scope = opts.scope as "session" | "long-term" | "all";
            const currentSessionId = getCurrentSessionId();
            const uid = opts.agent ? _agentUserId(opts.agent) : _effectiveUserId(currentSessionId);

            let allResults: MemoryItem[] = [];

            if (scope === "session" || scope === "all") {
              if (currentSessionId) {
                const sessionResults = await provider.search(
                  query,
                  buildSearchOptions(uid, limit, currentSessionId),
                );
                if (sessionResults?.length) {
                  allResults.push(...sessionResults.map((r) => ({ ...r, _scope: "session" as const })));
                }
              } else if (scope === "session") {
                console.log("No active session ID available for session-scoped search.");
                return;
              }
            }

            if (scope === "long-term" || scope === "all") {
              const longTermResults = await provider.search(
                query,
                buildSearchOptions(uid, limit),
              );
              if (longTermResults?.length) {
                allResults.push(...longTermResults.map((r) => ({ ...r, _scope: "long-term" as const })));
              }
            }

            // Deduplicate by ID when searching "all"
            if (scope === "all") {
              const seen = new Set<string>();
              allResults = allResults.filter((r) => {
                if (seen.has(r.id)) return false;
                seen.add(r.id);
                return true;
              });
            }

            if (!allResults.length) {
              console.log("No memories found.");
              return;
            }

            const output = allResults.map((r) => ({
              id: r.id,
              memory: r.memory,
              score: r.score,
              scope: (r as any)._scope,
              categories: r.categories,
              created_at: r.created_at,
            }));
            console.log(JSON.stringify(output, null, 2));
          } catch (err) {
            console.error(`Search failed: ${String(err)}`);
          }
        });

      mem0
        .command("stats")
        .description("Show memory statistics from Mem0")
        .option("--agent <agentId>", "Show stats for a specific agent")
        .action(async (opts: { agent?: string }) => {
          try {
            const uid = opts.agent ? _agentUserId(opts.agent) : cfg.userId;
            const memories = await provider.getAll({
              user_id: uid,
              source: "OPENCLAW",
            });
            console.log(`Mode: ${cfg.mode}`);
            console.log(`User: ${uid}${opts.agent ? ` (agent: ${opts.agent})` : ""}`);
            console.log(
              `Total memories: ${Array.isArray(memories) ? memories.length : "unknown"}`,
            );
            console.log(`Graph enabled: ${cfg.enableGraph}`);
            console.log(
              `Auto-recall: ${cfg.autoRecall}, Auto-capture: ${cfg.autoCapture}`,
            );
          } catch (err) {
            console.error(`Stats failed: ${String(err)}`);
          }
        });
    },
    { commands: ["mem0"] },
  );
}

// ============================================================================
// Lifecycle Hook Registration
// ============================================================================

function registerHooks(
  api: OpenClawPluginApi,
  provider: Mem0Provider,
  cfg: Mem0Config,
  _effectiveUserId: (sessionKey?: string) => string,
  buildAddOptions: (userIdOverride?: string, runId?: string, sessionKey?: string, metadata?: Record<string, unknown>) => AddOptions,
  buildSearchOptions: (userIdOverride?: string, limit?: number, runId?: string, sessionKey?: string) => SearchOptions,
  session: {
    setCurrentSessionId: (id: string) => void;
    setCurrentAgentId: (id: string | undefined) => void;
    getCurrentAgentId: () => string | undefined;
  },
  pool: Pick<PoolHelpers, "getCapturePool" | "getRecallPools" | "extractSessionInfo">,
) {
  // Auto-recall: inject relevant memories before agent starts
  if (cfg.autoRecall) {
    api.on("before_agent_start", async (event, ctx) => {
      if (!event.prompt || event.prompt.length < 5) return;

      // Skip non-interactive triggers (cron, heartbeat, automation)
      const trigger = (ctx as any)?.trigger ?? undefined;
      const sessionId = (ctx as any)?.sessionKey ?? undefined;
      if (isNonInteractiveTrigger(trigger, sessionId)) {
        api.logger.info("openclaw-mem0: skipping recall for non-interactive trigger");
        return;
      }

      // Update shared state for tools (best-effort — tools don't have ctx)
      if (sessionId) session.setCurrentSessionId(sessionId);
      // B7 FIX: Set module-level agentId for tool handlers to snapshot
      const ctxAgentId = (ctx as any)?.agentId ?? pool.extractSessionInfo(sessionId).agentId;
      session.setCurrentAgentId(ctxAgentId);

      // Subagents have ephemeral UUIDs — their namespace is always empty.
      const isSubagent = isSubagentSession(sessionId);
      const recallSessionKey = isSubagent ? undefined : sessionId;

      try {
        const agentId = ctxAgentId;

        if (cfg.agentMemory) {
          // Multi-pool recall
          const pools = pool.getRecallPools(agentId);
          // B8 FIX: Fast-path if no pools (agent identity unknown)
          if (pools.length === 0) return;
          let allResults: MemoryItem[] = [];

          // Search each recall pool
          for (const p of pools) {
            const results = await provider.search(
              event.prompt,
              buildSearchOptions(p),
            );
            allResults.push(...results);
          }

          // Search session memories if we have a session ID
          if (sessionId) {
            const capturePool = pool.getCapturePool(agentId);
            if (capturePool) {
              const sessionResults = await provider.search(
                event.prompt,
                buildSearchOptions(capturePool, undefined, sessionId),
              );
              allResults.push(...sessionResults);
            }
          }

          // Deduplicate by ID
          const seen = new Set<string>();
          allResults = allResults.filter((r) => {
            if (seen.has(r.id)) return false;
            seen.add(r.id);
            return true;
          });

          // Sort by relevance, cap at topK total (not per pool)
          allResults.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
          allResults = allResults.slice(0, cfg.topK);

          // Recall guard: convention-based pool filtering
          const sessionInfo = pool.extractSessionInfo(sessionId);
          const ctxType = mapCtx(sessionInfo.conversationType);
          let filteredByGuard = 0;
          try {
            const guardResult = applyRecallGuard({
              results: allResults,
              agentId: agentId ?? "main",
            });
            allResults = guardResult.results;
            filteredByGuard = guardResult.removedCount;
          } catch (guardErr) {
            // Guard failure → fail-open, keep all results, log warning
            api.logger.warn(`openclaw-mem0: recall guard failed, passing all results: ${String(guardErr)}`);
          }

          // Recall telemetry
          logRecallEvent({
            agent: agentId ?? "main",
            ctx: ctxType,
            query: event.prompt,
            results: allResults,
            pools,
            recallType: "auto",
            filteredByGuard,
            threshold: cfg.searchThreshold,
            resolvePath: (p) => api.resolvePath(p),
          });

          if (allResults.length === 0) return;

          const memoryContext = allResults
            .map(
              (r) =>
                `- ${r.memory}${r.categories?.length ? ` [${r.categories.join(", ")}]` : ""}`,
            )
            .join("\n");

          api.logger.info(
            `openclaw-mem0: injecting ${allResults.length} memories into context (pools: ${pools.join(", ")})`,
          );

          return {
            prependContext: `<relevant-memories>\nThe following memories may be relevant to this conversation:\n${memoryContext}\n</relevant-memories>`,
          };
        } else {
          // Standard recall (no multi-pool) — upstream logic with dynamic thresholding
          const recallTopK = Math.max((cfg.topK ?? 5) * 2, 10);

          let longTermResults = await provider.search(
            event.prompt,
            buildSearchOptions(undefined, recallTopK, undefined, recallSessionKey),
          );

          // Stricter threshold for auto-recall
          const recallThreshold = Math.max(cfg.searchThreshold, 0.6);
          longTermResults = longTermResults.filter(
            (r) => (r.score ?? 0) >= recallThreshold,
          );

          // Dynamic thresholding: drop below 50% of top score
          if (longTermResults.length > 1) {
            const topScore = longTermResults[0]?.score ?? 0;
            if (topScore > 0) {
              longTermResults = longTermResults.filter(
                (r) => (r.score ?? 0) >= topScore * 0.5,
              );
            }
          }

          // Cold-start broadening for short prompts or new sessions
          if (event.prompt.length < 100) {
            const broadOpts = buildSearchOptions(undefined, 5, undefined, recallSessionKey);
            broadOpts.threshold = 0.5;
            const broadResults = await provider.search(
              "recent decisions, preferences, active projects, and configuration",
              broadOpts,
            );
            const existingIds = new Set(longTermResults.map((r) => r.id));
            for (const r of broadResults) {
              if (!existingIds.has(r.id)) {
                longTermResults.push(r);
              }
            }
          }

          longTermResults = longTermResults.slice(0, cfg.topK);

          // Session memories
          let sessionResults: MemoryItem[] = [];
          if (sessionId) {
            sessionResults = await provider.search(
              event.prompt,
              buildSearchOptions(undefined, undefined, sessionId, recallSessionKey),
            );
            sessionResults = sessionResults.filter(
              (r) => (r.score ?? 0) >= cfg.searchThreshold,
            );
          }

          const longTermIds = new Set(longTermResults.map((r) => r.id));
          const uniqueSessionResults = sessionResults.filter(
            (r) => !longTermIds.has(r.id),
          );

          if (longTermResults.length === 0 && uniqueSessionResults.length === 0) return;

          let memoryContext = "";
          if (longTermResults.length > 0) {
            memoryContext += longTermResults
              .map(
                (r) =>
                  `- ${r.memory}${r.categories?.length ? ` [${r.categories.join(", ")}]` : ""}`,
              )
              .join("\n");
          }
          if (uniqueSessionResults.length > 0) {
            if (memoryContext) memoryContext += "\n";
            memoryContext += "\nSession memories:\n";
            memoryContext += uniqueSessionResults
              .map((r) => `- ${r.memory}`)
              .join("\n");
          }

          const totalCount = longTermResults.length + uniqueSessionResults.length;
          api.logger.info(
            `openclaw-mem0: injecting ${totalCount} memories into context (${longTermResults.length} long-term, ${uniqueSessionResults.length} session)`,
          );

          const preamble = isSubagent
            ? `The following are stored memories for user "${cfg.userId}". You are a subagent — use these memories for context but do not assume you are this user.`
            : `The following are stored memories for user "${cfg.userId}". Use them to personalize your response:`;

          return {
            prependContext: `<relevant-memories>\n${preamble}\n${memoryContext}\n</relevant-memories>`,
          };
        }
      } catch (err) {
        api.logger.warn(`openclaw-mem0: recall failed: ${String(err)}`);
      }
    });
  }

  // Auto-capture: store conversation context after agent ends
  if (cfg.autoCapture) {
    api.on("agent_end", async (event, ctx) => {
      if (!event.success || !event.messages || event.messages.length === 0) {
        return;
      }

      // Skip non-interactive triggers (cron, heartbeat, automation)
      const trigger = (ctx as any)?.trigger ?? undefined;
      const sessionId = (ctx as any)?.sessionKey ?? undefined;
      if (isNonInteractiveTrigger(trigger, sessionId)) {
        api.logger.info("openclaw-mem0: skipping capture for non-interactive trigger");
        return;
      }

      // Skip capture for subagents — their ephemeral UUIDs create orphaned
      // namespaces that are never read again.
      if (isSubagentSession(sessionId)) {
        api.logger.info("openclaw-mem0: skipping capture for subagent (main agent captures consolidated result)");
        return;
      }

      // Update shared state for tools
      if (sessionId) session.setCurrentSessionId(sessionId);

      try {
        // Patterns indicating an assistant message contains a summary of
        // completed work — high-value for extraction
        const SUMMARY_PATTERNS = [
          /## What I (Accomplished|Built|Updated)/i,
          /✅\s*(Done|Complete|All done)/i,
          /Here's (what I updated|the recap|a summary)/i,
          /### Changes Made/i,
          /Implementation Status/i,
          /All locked in\. Quick summary/i,
        ];

        // First pass: extract all messages into a typed array
        const allParsed: Array<{
          role: string;
          content: string;
          index: number;
          isSummary: boolean;
        }> = [];

        for (let i = 0; i < event.messages.length; i++) {
          const msg = event.messages[i];
          if (!msg || typeof msg !== "object") continue;
          const msgObj = msg as Record<string, unknown>;

          const role = msgObj.role;
          if (role !== "user" && role !== "assistant") continue;

          let textContent = "";
          const content = msgObj.content;

          if (typeof content === "string") {
            textContent = content;
          } else if (Array.isArray(content)) {
            for (const block of content) {
              if (
                block &&
                typeof block === "object" &&
                "text" in block &&
                typeof (block as Record<string, unknown>).text === "string"
              ) {
                textContent +=
                  (textContent ? "\n" : "") +
                  ((block as Record<string, unknown>).text as string);
              }
            }
          }

          if (!textContent) continue;
          // Strip injected memory context, keep the actual user text
          if (textContent.includes("<relevant-memories>")) {
            textContent = textContent.replace(/<relevant-memories>[\s\S]*?<\/relevant-memories>\s*/g, "").trim();
            if (!textContent) continue;
          }

          const isSummary =
            role === "assistant" &&
            SUMMARY_PATTERNS.some((p) => p.test(textContent));

          allParsed.push({
            role: role as string,
            content: textContent,
            index: i,
            isSummary,
          });
        }

        if (allParsed.length === 0) return;

        // Select messages: last 20 + any earlier summary messages,
        // sorted by original index to preserve chronological order.
        const recentWindow = 20;
        const recentCutoff = allParsed.length - recentWindow;

        const candidates: typeof allParsed = [];

        // Include summary messages from anywhere in the conversation
        for (const msg of allParsed) {
          if (msg.isSummary && msg.index < recentCutoff) {
            candidates.push(msg);
          }
        }

        // Include recent messages
        const seenIndices = new Set(candidates.map((m) => m.index));
        for (const msg of allParsed) {
          if (msg.index >= recentCutoff && !seenIndices.has(msg.index)) {
            candidates.push(msg);
          }
        }

        // Sort by original position
        candidates.sort((a, b) => a.index - b.index);

        const selected = candidates.map((m) => ({
          role: m.role,
          content: m.content,
        }));

        // Apply noise filtering pipeline: drop noise, strip fragments, truncate
        let formattedMessages = filterMessagesForExtraction(selected);

        // LCM capture filter: restrict to user-role messages to prevent
        // re-extraction of compacted summaries (Vigil Track B, Blocker 1)
        formattedMessages = filterCaptureMessages(formattedMessages);

        if (formattedMessages.length === 0) return;

        // Skip if no meaningful user content remains after filtering
        if (!formattedMessages.some((m) => m.role === "user")) return;

        // Inject a timestamp preamble
        const timestamp = new Date().toISOString().split("T")[0];
        formattedMessages.unshift({
          role: "system",
          content: `Current date: ${timestamp}. The user is identified as "${cfg.userId}". Extract durable facts from this conversation. Include this date when storing time-sensitive information.`,
        });

        if (cfg.agentMemory) {
          // Multi-pool capture
          const agentId = (ctx as any)?.agentId ?? session.getCurrentAgentId();
          const safeSessionId = (ctx as any)?.sessionKey ?? sessionId;
          const capturePool = pool.getCapturePool(agentId);
          // B8 FIX: Skip capture if agent identity unknown (fail-closed)
          if (!capturePool) {
            api.logger.warn("openclaw-mem0: skipping capture -- agent identity unknown, fail-closed");
            return;
          }
          const sessionInfo = pool.extractSessionInfo(safeSessionId);
          const provenance: Record<string, unknown> = {
            is_private: sessionInfo.conversationType !== "group",
            source_channel: sessionInfo.channel ?? "unknown",
            conversation_type: sessionInfo.conversationType ?? "unknown",
            chat_id: sessionInfo.chatId,
            agent_id: agentId ?? "main",
          };
          const addOpts = buildAddOptions(capturePool, safeSessionId, safeSessionId, provenance);
          const result = await provider.add(formattedMessages, addOpts);

          const capturedCount = result.results?.length ?? 0;
          if (capturedCount > 0) {
            api.logger.info(
              `openclaw-mem0: auto-captured ${capturedCount} memories (pool: ${capturePool})`,
            );
          }
        } else {
          // Standard capture
          const addOpts = buildAddOptions(undefined, sessionId, sessionId);
          const result = await provider.add(formattedMessages, addOpts);

          const capturedCount = result.results?.length ?? 0;
          if (capturedCount > 0) {
            api.logger.info(
              `openclaw-mem0: auto-captured ${capturedCount} memories`,
            );
          }
        }
      } catch (err) {
        api.logger.warn(`openclaw-mem0: capture failed: ${String(err)}`);
      }
    });
  }
}

export default memoryPlugin;
