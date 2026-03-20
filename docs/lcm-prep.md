# LCM (Lossless Claw) Deployment Preparation

Research conducted 2026-03-19. Source: installed `@martian-engineering/lossless-claw@0.4.0`
on workstation and read the actual source code.

---

## Plugin Identity

| Field | Value |
|-------|-------|
| **npm package** | `@martian-engineering/lossless-claw` |
| **GitHub repo** | `Martian-Engineering/lossless-claw` |
| **Version** | 0.4.0 |
| **License** | MIT |
| **Plugin ID** | `lossless-claw` |
| **Kind** | `context-engine` (occupies `plugins.slots.contextEngine`) |
| **Install** | `openclaw plugins install @martian-engineering/lossless-claw` |
| **Requires** | OpenClaw v2026.3.7+ (ContextEngine slot API) |

Gateway runs v2026.3.13 — **compatible**.

---

## Verified Config Block

From the plugin's `openclaw.plugin.json` configSchema (`additionalProperties: false`):

```json
{
  "plugins": {
    "slots": {
      "contextEngine": "lossless-claw"
    },
    "entries": {
      "lossless-claw": {
        "enabled": true,
        "config": {
          "freshTailCount": 32,
          "contextThreshold": 0.75,
          "incrementalMaxDepth": -1,
          "ignoreSessionPatterns": ["agent:*:cron:**", "agent:social:**"],
          "summaryModel": "claude-haiku-4-5",
          "summaryProvider": "anthropic"
        }
      }
    }
  }
}
```

### Vigil v5 Config Key Audit

| Vigil v5 Key | Actual Key | Status |
|-------------|------------|--------|
| `freshTailCount` | `freshTailCount` | **CORRECT** |
| `contextThreshold` | `contextThreshold` | **CORRECT** |
| `incrementalMaxDepth` | `incrementalMaxDepth` | **CORRECT** |
| `ignoreSessionPatterns` | `ignoreSessionPatterns` | **CORRECT** |
| `summaryModel: "anthropic/claude-haiku-4-5"` | `summaryModel` + `summaryProvider` | **WRONG FORMAT** |

**summaryModel fix**: Vigil v5 specifies `"summaryModel": "anthropic/claude-haiku-4-5"`.
The plugin supports two formats:
1. **`provider/model`** format: `"summaryModel": "anthropic/claude-haiku-4-5"` — the plugin
   strips the provider prefix automatically.
2. **Separate fields**: `"summaryModel": "claude-haiku-4-5"` + `"summaryProvider": "anthropic"`.

Either works. The Vigil v5 format is technically valid but the separate-fields
approach is clearer. Use the separate-fields approach in production config.

### Additional Config Keys Not in Vigil v5

These are available but not needed for initial deployment:

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `dbPath` | string | `~/.openclaw/lcm.db` | SQLite database location |
| `leafMinFanout` | integer (min 2) | — | Minimum messages per leaf summary |
| `condensedMinFanout` | integer (min 2) | — | Minimum children per condensed node |
| `condensedMinFanoutHard` | integer (min 2) | — | Hard minimum for condensed fanout |
| `statelessSessionPatterns` | string[] | — | Sessions that can read but not write LCM |
| `skipStatelessSessions` | boolean | — | Skip LCM entirely for stateless sessions |
| `largeFileThresholdTokens` | integer (min 1000) | — | Threshold for large file handling |
| `expansionModel` | string | — | Model for lcm_expand_query sub-agent |
| `expansionProvider` | string | — | Provider for lcm_expand_query sub-agent |

---

## Q4: postCompactionSections Support

**Answer: NEEDS TESTING**

`postCompactionSections` is a **core OpenClaw feature** (`agents.defaults.compaction.postCompactionSections`),
not a plugin feature. The string `postCompactionSections` appears **nowhere** in the
lossless-claw source code.

When lossless-claw is active, it owns the `compact()` and `assemble()` lifecycle hooks.
The OpenClaw core's built-in compaction path (which injects postCompactionSections) is
bypassed entirely. Whether the core still injects postCompactionSections alongside the
plugin's `assemble()` output is unclear from the source.

The plugin's `assemble()` returns `{ messages, estimatedTokens, systemPromptAddition }`.
The `systemPromptAddition` field is used for LCM-specific guidance (recall instructions).
The core may add postCompactionSections to the system prompt independently of the
context engine's output — but this requires testing.

**Test procedure for Day 2 morning:**

1. Enable lossless-claw on main agent only
2. Chat until compaction triggers (send enough messages to exceed `contextThreshold`)
3. After compaction, check if the assistant still has Safety and Memory Rules sections
4. If sections are missing: **dealbreaker** — disable LCM immediately
5. If sections survive: Q4 = YES, proceed with LCM

**Fallback if Q4 fails:** The sections could potentially be injected via sticky-context
slots instead of postCompactionSections. Sticky-context injects at prompt build time
(not in the transcript), so it should survive any context engine.

---

## Q5: Summary Markers

**Answer: YES — summaries have clear XML markers**

From `assembler.ts` lines 550-588 and 841-853:

LCM summaries are injected into context as **`role: "user"` messages** with XML-wrapped
content in this format:

```xml
<summary id="sum_abc123" kind="leaf" depth="0" descendant_count="3"
         earliest_at="2026-03-19T14:30:00" latest_at="2026-03-19T15:45:00">
  <parents>
    <summary_ref id="sum_def456" />
  </parents>
  <content>
  The actual summary text here...
  </content>
</summary>
```

Key attributes:
- `id`: unique summary ID (`sum_` prefix)
- `kind`: `"leaf"` (direct message summary) or `"condensed"` (summary of summaries)
- `depth`: DAG depth (0 = leaf, 1+ = condensed)
- `descendant_count`: number of original messages covered
- `earliest_at` / `latest_at`: time range of covered messages

### Impact on Capture Filter

**CRITICAL FINDING**: Summaries are injected as `role: "user"` messages.

Our current capture filter (`capture-filter.ts`) passes user-role messages through.
However, this is **not a problem** because:

1. The capture filter runs in the `agent_end` hook, which receives `event.messages` —
   the **actual conversation transcript** (user input + assistant response + tool calls).
2. LCM summaries are injected by the context engine's `assemble()` hook during prompt
   construction, NOT as messages in the transcript.
3. The transcript never contains the assembled context's summaries — they exist only
   in the model's input, not in `event.messages`.

**Verification needed on gateway**: After enabling LCM and triggering compaction, check
`event.messages` in the agent_end hook (add temporary debug logging) to confirm summaries
do NOT appear. If they do appear, upgrade the capture filter to detect and strip
`<summary>` XML content from user messages.

If precise filtering is needed later, the detection is trivial:
```typescript
const isSummary = content.trimStart().startsWith("<summary ");
```

---

## Step-by-Step Plan for Tomorrow (Day 2)

### Morning: Install + Test (fork-independent)

```bash
# 1. Install the plugin (don't enable yet)
openclaw plugins install @martian-engineering/lossless-claw

# 2. Verify it installed
ls ~/.openclaw/extensions/lossless-claw/

# 3. Add config to openclaw.json (but set enabled: false initially)
# Edit ~/.openclaw/openclaw.json, add to plugins section:
#   "slots": { "contextEngine": "lossless-claw" },
#   "entries": { "lossless-claw": { "enabled": false, "config": { ... } } }

# 4. Restart gateway to load the plugin (inactive)
sudo systemctl restart <gateway-service-name>

# 5. Verify plugin loaded (check logs)
sudo journalctl -u <gateway-service-name> --since "1 min ago" | grep -i lossless

# 6. Enable the plugin
# Edit openclaw.json: set "enabled": true

# 7. Restart gateway
sudo systemctl restart <gateway-service-name>

# 8. Test Q4: Chat with the assistant until compaction triggers
#    Send enough messages to exceed 75% of context window
#    After compaction, ask the assistant to recall her Safety rules
#    If she can: Q4 = YES
#    If she can't: DISABLE LCM IMMEDIATELY

# 9. Test Q5 (verification): Check that summaries don't leak into event.messages
#    Add temporary debug logging to agent_end hook if needed

# 10. Test Blocker 3: Verify sticky-context slots survive compaction
#     After compaction, check if sticky slots are still injected
```

### Afternoon: Wire capture filter + enable

If Q4 passes:
- Deploy the Mem0 fork (see DEPLOY.md)
- Capture filter is already wired into agent_end
- LCM is safe to leave enabled

If Q4 fails:
- Disable LCM
- Track B is dead until Martian Engineering patches postCompactionSections support
  or we migrate the sections to sticky-context slots

---

## What to Look For in Gateway Logs

### Healthy LCM

```
[lossless-claw] bootstrap: opened lcm.db (N conversations, M summaries)
[lossless-claw] ingest: stored message xxxxxxxx (user, 45 tokens)
[lossless-claw] compact: created 2 leaf summaries from 8 messages
[lossless-claw] assemble: 3 summaries + 32 raw messages (est. 12400 tokens)
```

### Problems

| Log pattern | Meaning | Action |
|------------|---------|--------|
| `[lossless-claw] bootstrap: FAILED` | SQLite init failed | Check `dbPath`, permissions |
| `[lossless-claw] compact: summarization failed` | LLM call for summary failed | Check `summaryModel`/`summaryProvider`, API keys |
| `[lossless-claw] assemble: fallback to raw messages` | Assembly failed, degraded to pass-through | Check logs for underlying error |
| No `[lossless-claw]` logs at all | Plugin not loading | Check `plugins.slots.contextEngine` config |
| `openclaw-mem0: auto-captured N memories` after compaction with high N | Possible re-extraction loop | Check if summaries are leaking into captures |

---

## What Failure Looks Like

**Quick detection** (within 5 minutes):

1. **the assistant stops responding**: Gateway crashed or LCM assembly broke the prompt.
   Action: `sudo systemctl status <gateway-service-name>`, check logs.

2. **the assistant responds but has amnesia**: postCompactionSections not working.
   Action: Ask the assistant about her Safety rules. If blank: disable LCM.

3. **Qdrant memory count spikes**: Re-extraction loop (summaries being captured as memories).
   Action: Check `python3 ~/.openclaw/workspace/qdrant-health.py` before and after.
   A jump of 10+ new memories per compaction cycle = loop active.

**Slow detection** (over hours/days):

4. **Memory quality degrades**: Summary-derived memories are vaguer than real ones.
   Action: Sample recent captures in Qdrant, check if content looks like summaries.

5. **Context assembly gets slow**: DAG too deep, assembly takes >1s.
   Action: Check `lcm_describe` tool output, consider increasing `freshTailCount`.
