# Contributing to openclaw-mem0

Guidelines for the OpenClaw Mem0 plugin in the jamebobob/mem0-vigil fork.

---

## Multi-Pool Architecture

The plugin routes memory reads and writes to named Qdrant pools based
on agent identity. Each Telegram group gets its own pool, preventing
private DM memories from leaking into group chat contexts and keeping
group memories isolated from each other.

**Config** (`agentMemory` in openclaw.json):

```json
"agentMemory": {
  "main":              { "capture": "operator", "recall": ["operator", "household", "friends", "family", "parents", "partner"] },
  "social-household":  { "capture": "household",  "recall": ["household"] },
  "social-friends":       { "capture": "friends",       "recall": ["friends"] },
  "social-family":    { "capture": "family",     "recall": ["family"] },
  "social-parents":    { "capture": "parents",     "recall": ["parents"] },
  "social-partner":   { "capture": "partner",    "recall": ["partner"] }
}
```

The `main` agent handles private DMs: it captures to the `operator` pool
and recalls from all pools. Each `social-*` agent is bound to a single
Telegram group and captures/recalls only within that group's pool.

**Four helper functions** (inside `register()` in index.ts):

| Function | Purpose |
|----------|---------|
| `extractSessionInfo(sessionKey)` | Parses `agent:<id>:<channel>:<type>:<chatId>` into structured fields |
| `getCapturePool(agentId)` | Which pool to write to. Fail-closed if agent unknown. |
| `getRecallPools(agentId)` | Which pools to search. Fail-closed (empty array) if agent unknown. |
| `isPoolAllowed(pool, agentId)` | Boundary check for explicit userId overrides on tools. |

Without `agentMemory` config, everything falls back to `cfg.userId`
(single-pool mode). Zero breaking changes for single-agent setups.

---

## Vigil Modules

Three independent modules, each in its own file:

| Module | File | Purpose |
|--------|------|---------|
| Recall Telemetry | `recall-telemetry.ts` | Logs every recall event to JSONL + gap journal |
| Capture Filter | `capture-filter.ts` | Restricts auto-capture to user-role messages (LCM safety) |
| Recall Guard | `recall-guard.ts` | Filters recall results by privacy context (dm/group/cron) |

Each module is independently revertable. If one needs to be disabled,
remove its import and wiring from index.ts without touching the others.

---

## Adding a New Vigil Module

1. **Create the module file**: `openclaw/<module-name>.ts`
2. **Create the test file alongside it**: `openclaw/<module-name>.test.ts`
3. **Wire into index.ts**: import the module, call it at the correct hook point
4. **Run all tests**: `npx vitest run` — all existing tests must still pass
5. **Build**: `npx tsup` — must succeed (ESM + DTS)
6. **Commit with a descriptive message**
7. **Push immediately**: `git push origin main` — do not batch commits

---

## Coding Standards

### Synchronous writes in the recall path

The recall path (`before_agent_start`) must not introduce async I/O
beyond the Qdrant search calls. Telemetry uses `fs.appendFileSync`.
The guard is a pure synchronous function. Never add `await` calls to
telemetry or guard logic.

### Fail-safe error handling

Every module wired into the recall path must be wrapped in try/catch
so that a failure in one module does not kill the entire recall:

```typescript
// Correct: guard failure → fail-open, telemetry still fires
let filteredByGuard = 0;
try {
  const guardResult = applyRecallGuard({...});
  allResults = guardResult.results;
  filteredByGuard = guardResult.removedCount;
} catch (err) {
  api.logger.warn(`guard failed: ${err}`);
}
```

Telemetry writes are wrapped in try/catch internally. The capture
filter is called before provider.add() with an early return on empty.

### Separate files per module

Do not inline new Vigil logic into index.ts. Each module is a separate
file with its own test file. This enables independent revert via git
and keeps index.ts focused on wiring.

### Push after each commit

Every commit gets pushed immediately. Unpushed work is lost if the
session crashes. This is a hard-learned lesson.

### Import paths

Use `.js` extensions in import paths (not `.ts`). The tsup build
requires this for DTS generation:

```typescript
import { logRecallEvent } from "./recall-telemetry.js";  // correct
import { logRecallEvent } from "./recall-telemetry.ts";   // breaks DTS build
```

---

## Anti-Patterns

These are documented findings from PR #50447 analysis (March 2026).
Do not implement any of the following:

### 1. No access-count popularity bias

Do not track how often a memory is recalled and boost its score.
Creates rich-get-richer loops where frequently recalled memories get
recalled more, regardless of actual relevance.

*Source: PR #50447 salience-scoring.ts, `log(access_count + 1)` formula*

### 2. No global salience decay

Do not apply a multiplicative decay factor to all memories per cycle.
Everything converges to the floor unless frequently accessed, defeating
the purpose of significance tagging.

*Source: PR #50447 forgetting.ts, `synapticScalingDecay` (0.95/cycle, floor 0.1)*

### 3. No pattern-based memory suppression

Do not use regex patterns to reduce memory salience. Risk of
accidentally suppressing critical memories that happen to match a
pattern intended for noise.

*Source: PR #50447 neural-forgetting.ts, `motivatedForgetting()`*

### 4. No emotional tagging without a validated classifier

Boosting salience by emotion requires reliable emotion detection we
don't have. Misclassified emotions corrupt the salience signal.

*Source: PR #50447 neural-forgetting.ts, `emotionalTagging()`*

### 5. No string-prefix similarity as cosine substitute

Their `calculateSimpleSimilarity` compares first/last 10 chars of
embedding strings. This is not real similarity measurement. Use
actual cosine similarity from Qdrant.

*Source: PR #50447 neural-forgetting.ts*

### 6. No score annotation in injected memories

The LLM cannot interpret numeric cosine scores meaningfully. Scores
don't survive context compaction. Filter bad results via the recall
guard (A2) instead of annotating them with numbers.
