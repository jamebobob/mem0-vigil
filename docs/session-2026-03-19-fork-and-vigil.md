# Session Record: 2026-03-19 — Mem0 Fork + Vigil Modules

## Summary

Forked `mem0ai/mem0` under `jamebobob/mem0` on GitHub. Applied 6 core
Mem0 SDK patches as proper commits (from 12 original node_modules
patches — 2 were already fixed upstream). Built 4 multi-pool plugin
patches and 3 Vigil modules (recall telemetry, capture filter, recall
guard). All code pushed to GitHub.

**Fork:** https://github.com/jamebobob/mem0
**Total commits in fork:** 1959 (upstream history + 18 new commits)
**Canonical roadmap:** `~/Downloads/project-vigil-v5.md`

---

## Commit History (18 new commits, oldest first)

### Core Mem0 SDK Patches (6 commits)

These fix bugs and add features in the mem0ai TypeScript OSS SDK.
Correspond to upstream PRs #4409-4412 (sitting in 2-month backlog).

| Hash | Description |
|------|-------------|
| `c21dd88b` | feat(oss): pass score_threshold from QdrantVectorStore.search() to Qdrant |
| `fca9bd62` | feat(oss): forward threshold from Memory.search() to vector store |
| `b47c0c32` | feat(oss): add MD5 hash dedup gate in createMemory() |
| `637e0f6c` | feat(oss): add cosine similarity dedup gate in createMemory() |
| `3526d468` | fix(oss): add JSON extraction fallback to removeCodeBlocks |
| `d95a6939` | fix(oss): bump AnthropicLLM max_tokens from 4096 to 8192 |

### Multi-Pool Plugin Patches (4 commits)

Replace the old per-agent userId namespacing system with configurable
named pool routing via `agentMemory` config.

| Hash | Description |
|------|-------------|
| `575fc2a4` | feat(plugin): add extractSessionInfo and multi-pool infrastructure |
| `24b0ef52` | feat(plugin): add getCapturePool and getRecallPools |
| `6787fe8c` | feat(plugin): add isPoolAllowed pool boundary enforcement |
| `e26fa3be` | feat(plugin): rewire tools and hooks for multi-pool memory system |

### Vigil Modules (4 commits)

| Hash | Description |
|------|-------------|
| `d12957ed` | feat(plugin): add recall telemetry module (Vigil A1a+A1b) |
| `144025f4` | feat(plugin): add capture filter for LCM re-extraction prevention (Vigil B1) |
| `0f64ca46` | feat(plugin): add recall guard with privacy boundary enforcement (Vigil A2) |
| `afad44ed` | fix(plugin): wrap recall guard in independent try/catch (fail-open) |

### Documentation + Tooling (4 commits)

| Hash | Description |
|------|-------------|
| `278c59a7` | docs(plugin): add deployment guide for switching gateway to fork |
| `57d605fd` | docs(plugin): add contributing guide with anti-patterns and standards |
| `09ee8b95` | feat(scripts): add A6 never-recalled cleanup candidate report (Vigil) |
| *(this)* | docs: add session summary |

---

## Files Created

### Plugin source (`openclaw/`)

| File | Purpose | Lines |
|------|---------|-------|
| `index.ts` | Main plugin — multi-pool routing, 5 tools, 3 hooks, CLI | ~1740 |
| `recall-telemetry.ts` | JSONL telemetry + gap journal (A1a+A1b) | ~120 |
| `capture-filter.ts` | User-role + LCM summary detection filter for LCM (B1) | ~53 |
| `recall-guard.ts` | Privacy boundary filter by context (A2) | ~100 |
| `memory-views.default.json` | Default recall guard config | 10 |

### Tests (`openclaw/`)

| File | Tests |
|------|-------|
| `index.test.ts` | 8 (config schema + allowed keys) |
| `sqlite-resilience.test.ts` | 11 (pre-existing) |
| `recall-telemetry.test.ts` | 13 (JSONL, gap detection, gap journal) |
| `capture-filter.test.ts` | 10 (role filtering, LCM summary detection, edge cases) |
| `recall-guard.test.ts` | 11 (dm/group/cron contexts, edge cases) |
| **Total** | **53 TypeScript tests passing** |

### Documentation (`openclaw/`)

| File | Purpose |
|------|---------|
| `DEPLOY.md` | Step-by-step gateway deployment guide with rollback plan |
| `CONTRIBUTING.md` | Multi-pool overview, module guide, anti-patterns |

### Scripts (`scripts/`)

| File | Purpose |
|------|---------|
| `never-recalled-cleanup.py` | A6 candidate report generator (~60 lines) |
| `test_never_recalled_cleanup.py` | 9 Python unit tests (mock data, no live Qdrant) |

### SDK patches (`mem0-ts/src/oss/src/`)

| File | Changes |
|------|---------|
| `memory/index.ts` | MD5 hash dedup, cosine similarity dedup |
| `memory/memory.types.ts` | threshold field added |
| `vector_stores/qdrant.ts` | score_threshold passthrough |
| `vector_stores/base.ts` | scoreThreshold in base interface |
| `prompts/index.ts` | JSON extraction fallback |
| `llms/anthropic.ts` | max_tokens bump |

---

## Build Status

- TypeScript build: ESM + DTS clean (tsup)
- 53 TypeScript tests passing (vitest)
- 9 Python tests passing (unittest)
- All code pushed to GitHub

---

## What's NOT Done Yet

### Deploy to gateway
The fork is built and pushed but not deployed. See `openclaw/DEPLOY.md`
for the procedure. Requires SSH access to gateway.

### LCM install and testing (Vigil Track B)
LCM plugin not installed. Q4-5 testing (postCompactionSections, summary
markers) not done. The capture filter is ready and will activate once
LCM is deployed, but LCM itself is OpenClaw-side work.

### Family pool is_private audit (Vigil A2 prerequisite)
Must run before enabling the recall guard in production. Batch-migrated
memories may carry incorrect `is_private: true` tags. See Vigil v5
"Day 3 pre-deploy step" for the Qdrant query.

### Gateway SSH key setup for Claude Code
No SSH access to gateway from this machine. Deploy requires either:
- SSH key exchange, or
- Running the deploy steps manually on gateway, or
- A future Claude Code session with gateway access

### Telemetry data collection
A5 (significance-weighted recall) and A6 (never-recalled cleanup) both
require 2-4 weeks of telemetry data before they can be designed or run.
The telemetry module is recording data from the moment it's deployed.

### Cron audit (Vigil Day 6)
Review of cron job behavior, first telemetry data review, and LCM
compaction cycle quality check if LCM is enabled.

### Test suites from PRs #4409-4412
The Vigil v5 plan mentions porting test suites from the upstream PRs.
Not done. The 6 SDK patches have no dedicated unit tests beyond the
existing fork-level test suite.

---

## Patch Count Reconciliation

Vigil v5 references "12 existing patches." During fork setup, 2 of the
12 were found to be already fixed in the current upstream HEAD:
- Ollama embedder fix (PR #4176 — merged upstream)
- OSS threshold normalization (PR #4224 — merged upstream)

This reduced 12 patches to 10 that needed applying. Of those 10:
- 6 are core SDK patches (commits c21dd88b through d95a6939)
- 4 are multi-pool plugin patches (commits 575fc2a4 through e26fa3be)

The guard try/catch fix (afad44ed) was found during audit and is a
bugfix on top of the Vigil recall guard wiring, not one of the
original 10 patches.
