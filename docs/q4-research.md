# Q4 Research: postCompactionSections with LCM

Deep source code analysis of OpenClaw v2026.3.13 core and
`@martian-engineering/lossless-claw` v0.4.0 plugin.

---

## TL;DR

**postCompactionSections does NOT fire when LCM owns compaction.** The
mechanism is bypassed entirely. However, AGENTS.md sections likely
survive through a different path: the system prompt is rebuilt by the
core every turn and LCM does not replace it. Runtime testing required
to confirm the sections the assistant needs are actually in the system prompt
and not only in the bootstrap context message.

---

## Code Trace: postCompactionSections Injection Path

### Where sections are read from AGENTS.md

**File:** `reply-Bm8VrLQh.js` lines 99774-99810

```javascript
async function readPostCompactionContext(workspaceDir, cfg, nowMs) {
    const agentsPath = path.join(workspaceDir, "AGENTS.md");
    // ... reads file, extracts configured sections ...
    const configuredSections = cfg?.agents?.defaults?.compaction?.postCompactionSections;
    const sectionNames = Array.isArray(configuredSections)
        ? configuredSections
        : DEFAULT_POST_COMPACTION_SECTIONS;
    // ... extracts sections, formats with date substitution ...
    return `[Post-compaction context refresh] ...`;
}
```

Re-reads AGENTS.md from disk every time (not cached). Extracts named
sections (`## Session Startup`, `## Red Lines`, etc.) and formats them
as a system event.

### Where the injection is triggered

**File:** `reply-Bm8VrLQh.js` line 166517-166528

```javascript
if (autoCompactionCompleted) {
    // ... increment compaction count ...
    if (sessionKey) readPostCompactionContext(process.cwd(), cfg).then((contextContent) => {
        if (contextContent) enqueueSystemEvent(contextContent, { sessionKey });
    }).catch(() => {});
}
```

Injected as a **system event** (enqueued message) ONLY when
`autoCompactionCompleted === true`.

### How autoCompactionCompleted gets set

**File:** `reply-Bm8VrLQh.js` lines 164998-165002 and 166008-166010

```javascript
// Inside the agent event handler:
if (evt.stream === "compaction") {
    const phase = typeof evt.data.phase === "string" ? evt.data.phase : "";
    if (phase === "end") {
        autoCompactionCompleted = true;
    }
}
```

This listens for compaction stream events (`{stream: "compaction",
data: {phase: "end"}}`) emitted by the **built-in Pi auto-compaction
handlers**.

### The compaction events are emitted by built-in handlers

**File:** `reply-Bm8VrLQh.js` lines 105831-105881
(`pi-embedded-subscribe.handlers.compaction.ts`)

```javascript
function handleAutoCompactionStart(ctx) {
    emitAgentEvent({ runId, stream: "compaction", data: { phase: "start" } });
    ctx.params.onAgentEvent?.({ stream: "compaction", data: { phase: "start" } });
}

function handleAutoCompactionEnd(ctx, evt) {
    emitAgentEvent({ runId, stream: "compaction", data: { phase: "end", willRetry } });
    ctx.params.onAgentEvent?.({ stream: "compaction", data: { phase: "end", willRetry } });
}
```

These handlers fire when Pi's **built-in** compaction runs.

---

## Why It Doesn't Fire with LCM

### Step 1: LCM declares ownsCompaction: true

**File:** `lossless-claw/src/engine.ts` lines 821-828

```typescript
// Only claim ownership of compaction when the DB is operational.
// Without a working schema, ownsCompaction would disable the runtime's
// built-in compaction safeguard and inflate the context budget.
this.info = {
    id: "lcm",
    name: "Lossless Context Management Engine",
    version: "0.1.0",
    ownsCompaction: migrationOk,  // true when DB is operational
};
```

### Step 2: Core disables Pi's built-in compaction

**File:** `reply-Bm8VrLQh.js` lines 56918-56935
(`agents/pi-embedded-compaction-guard.ts`)

```javascript
function shouldDisablePiAutoCompaction(params) {
    return params.contextEngineInfo?.ownsCompaction === true;
}

function applyPiAutoCompactionGuard(params) {
    const disable = shouldDisablePiAutoCompaction({...});
    if (!disable || !hasMethod) return { supported: hasMethod, disabled: false };
    params.settingsManager.setCompactionEnabled(false);
    return { supported: true, disabled: true };
}
```

When `ownsCompaction === true`, Pi's internal compaction is **turned off**.

### Step 3: Built-in compaction events never fire

Since Pi's compaction is disabled:
- `handleAutoCompactionStart` never executes
- `handleAutoCompactionEnd` never executes
- The `{stream: "compaction", data: {phase: "end"}}` event is never emitted
- `autoCompactionCompleted` stays `false`
- `readPostCompactionContext` is never called

### Step 4: Overflow compaction path also doesn't trigger it

The core's overflow recovery (line 110867) calls `contextEngine.compact()`
directly. After success, it increments `autoCompactionCount` and retries
the model call. But it does NOT set `autoCompactionCompleted` and does
NOT emit compaction stream events. LCM doesn't emit these events either
(confirmed: no `stream: "compaction"` in LCM source).

The core does call `runPostCompactionSideEffects` after overflow compact
(line 103061 when `engineOwnsCompaction === true`), but that function only
does transcript update + index sync — NOT section injection.

---

## Why Sections Likely Survive Anyway

### The system prompt is separate from conversation messages

**File:** `reply-Bm8VrLQh.js` lines 109583-109598

```javascript
if (params.contextEngine) try {
    const assembled = await params.contextEngine.assemble({
        sessionId, sessionKey,
        messages: activeSession.messages,  // conversation messages
        tokenBudget: params.contextTokenBudget
    });
    // LCM replaces conversation messages only:
    if (assembled.messages !== activeSession.messages)
        activeSession.agent.replaceMessages(assembled.messages);
    // LCM adds to system prompt, doesn't replace it:
    if (assembled.systemPromptAddition) {
        systemPromptText = prependSystemPromptAddition({
            systemPrompt: systemPromptText,
            systemPromptAddition: assembled.systemPromptAddition
        });
    }
}
```

LCM's `assemble()`:
1. **Replaces** conversation messages with summaries + raw tail
2. **Prepends** its `systemPromptAddition` (LCM recall guidance) to the system prompt
3. Does **NOT replace** the base system prompt

The base `systemPromptText` is built at line 109337 by
`createSystemPromptOverride(appendPrompt)()`, which runs BEFORE context
engine assembly. This includes core agent instructions built by
`buildAgentSystemPrompt` (line 101805) — tool descriptions, behavioral
rules, runtime info.

### Bootstrap files (AGENTS.md) are in the conversation, not the system prompt

AGENTS.md content is loaded by `resolveBootstrapContextForRun` (line 109087)
and injected as **bootstrap context files** into the conversation messages
— typically the first user message containing workspace context. The
base system prompt (built by `buildAgentSystemPrompt`) contains core tool
instructions and runtime info, NOT AGENTS.md sections.

When LCM compacts:
- The bootstrap message (containing AGENTS.md) becomes part of the DAG
- LCM summarizes it into leaf/condensed nodes
- The specific sections are compressed, not literally preserved
- The summary is still accessible via `lcm_expand` tools

### What this means for the assistant's sections

The Safety and Memory Rules sections from AGENTS.md will be:
- **Literally present** in the first few conversations (before compaction)
- **Summarized** after LCM compaction (compressed but in the DAG)
- **NOT re-injected literally** via `postCompactionSections` (bypassed)
- **Recoverable** via `lcm_expand` tools if the model needs exact text

---

## Risk Assessment

**MEDIUM RISK.** The sections survive as summaries but lose their
literal precision. A summary of "Never share private DM memories in
group chat" might compress to "Privacy rules exist." The behavioral
specificity that makes these sections effective may be lost.

### Mitigation Options (in order of preference)

1. **sticky-context slots** (RECOMMENDED): The existing sticky-context
   plugin injects content at prompt build time, not in the conversation
   transcript. It's immune to compaction of any kind. Move Safety and
   Memory Rules into sticky slots. This is the structural fix.

2. **LCM's systemPromptAddition**: The context engine can prepend
   arbitrary content to the system prompt. If LCM exposed a config
   option for custom system prompt additions, critical rules could be
   injected every turn. LCM currently only adds recall guidance here
   — would need a feature request to Martian Engineering.

3. **postCompactionSections workaround**: After LCM compaction,
   manually enqueue the sections as a system event via a custom hook.
   The `after_compaction` hook fires after overflow compaction (line
   103066). Note: the streaming compaction path (line 105882) does NOT
   fire when LCM is active because Pi's built-in compaction is
   disabled. Only the overflow recovery path triggers `after_compaction`
   with LCM. A hook on that path could call `readPostCompactionContext`
   and inject the result.

4. **Accept summary compression**: Trust that LCM summaries preserve
   the intent of the sections even if not the literal text. Monitor
   for behavioral drift.

---

## Definitive Answers

| Question | Answer | Confidence |
|----------|--------|------------|
| Does `postCompactionSections` fire with LCM? | **NO** | DEFINITIVE (traced code) |
| Why not? | Built-in compaction disabled when `ownsCompaction: true` | DEFINITIVE |
| Does LCM emit compaction events? | **NO** | DEFINITIVE (grep of LCM source) |
| Is the system prompt preserved? | **YES** | DEFINITIVE (line 109590-109596) |
| Are AGENTS.md sections in the system prompt? | **NO** — they're in bootstrap messages | HIGH confidence (from code structure) |
| Do sections survive compaction? | **As summaries only** (compressed) | HIGH confidence |
| Can sections be recovered? | **YES** — via `lcm_expand` tools | DEFINITIVE (LCM design) |

---

## Recommended Test on Gateway (Day 2 Morning)

1. Enable LCM on main agent
2. Chat until compaction triggers
3. Ask the assistant: "What are your Safety rules?" and "What are your Memory Rules?"
4. If she answers with specific rules: sections survived (as bootstrap context or summary)
5. If she answers vaguely: sections were over-compressed. Deploy sticky-context mitigation.
6. Regardless: verify sticky-context slots survive compaction (expected YES since they're prompt-time injection)

If sticky-context slots work (expected), move critical sections there
as the permanent fix. `postCompactionSections` is irrelevant with LCM.
