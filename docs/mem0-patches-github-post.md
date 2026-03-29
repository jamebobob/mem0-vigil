# What we changed after auditing 10,134 mem0 entries

A few days ago we posted [issue #4573](https://github.com/mem0ai/mem0/issues/4573) about finding 97.8% junk in 10,134 mem0 entries after five weeks of production use. This is what we did about it.

We deployed four changes at once. We'll be upfront: we can't isolate which one is doing the most work. The sample is small, the results are early, and we're being honest about what we don't know yet.

---

## How mem0 processes memory

Before diving in, it helps to understand the two-step pipeline. First, the **extraction** model reads the conversation and pulls out candidate facts. Then, for each fact, the **decision** model compares it to existing memories and picks an action: ADD, UPDATE, DELETE, or NONE.

Our first three changes target the decision layer. The fourth targets extraction. We think the fourth matters most, but we'll get to that.

---

## Change 1: NONE-by-default decision prompt

**File:** `mem0-ts/src/oss/src/prompts/index.ts`

The stock `getUpdateMemoryMessages()` prompt is 172 lines long. It teaches the model all four operations with detailed examples. The problem is that nearly every example demonstrates ADD or UPDATE. The implicit lesson: do something with every fact you see.

And the model listens. In practice, it almost never picks NONE. Boot file content gets re-extracted every session, and the decision model dutifully UPDATEs the existing entry, refreshing its timestamp, keeping it alive forever. Architecture details get ADDed because they're technically "new information." The prompt is biased toward action, and the collection grows without bound.

Our replacement is 53 lines. The key reframe:

> "When in doubt between ADD and NONE, always choose NONE. A missed new fact can be re-extracted later. A duplicate pollutes every future session."

NONE is listed first. UPDATE is restricted to cases where the new fact adds a concrete detail the existing memory lacks. ADD requires genuinely novel topics with zero existing coverage. The JSON output format is identical, so nothing downstream breaks.

---

## Change 2: Tighter cosine dedup gate (0.98 → 0.90)

**File:** `mem0-ts/src/oss/src/memory/index.ts`

Before the decision prompt fires, mem0 checks if a near-identical entry already exists using vector similarity. At 0.98, "User prefers concise communication" and "User prefers a concise, direct communication style" look like different memories. At 0.90, they're recognized as the same fact.

In our original audit, roughly 20% of junk was paraphrased duplicates sailing past the 0.98 gate. We still saw 3 duplicates in 58 post-change entries, so 0.90 isn't perfect, but it's a meaningful improvement.

---

## Change 3: Em dash normalization

**File:** `mem0-ts/src/oss/src/memory/index.ts`

Unicode em dashes get replaced with commas before hashing. Different models (and even the same model across runs) sometimes swap em dashes and commas, producing different MD5 hashes for identical facts and bypassing the hash dedup gate.

Honestly, this is probably a rounding error. Including it for completeness.

---

## Change 4: Custom extraction prompt

**Not in the codebase. This is a config setting.**

This is the one we think matters most, and it's the simplest to deploy. mem0's OpenClaw plugin already supports a `customPrompt` field (added in [PR #4302](https://github.com/mem0ai/mem0/pull/4302)) that replaces the default extraction prompt. No code changes needed. Just config.

We wrote a ~370-word prompt that focuses on what NOT to extract. The biggest junk category from our audit was boot-file restating: 52.7% of all junk came from the agent's system prompt content getting re-extracted as "facts about the user" every single session. The extraction prompt kills that at the source. Those facts never even reach the decision layer.

The prompt below has been generalized for privacy (we replaced our specific names with generic labels). If you adapt it, consider swapping "the user" and "the assistant" with your actual names. Being specific about who is who seems to help the model distinguish between speakers.

<details>
<summary>Full custom extraction prompt (click to expand)</summary>

```
You are a memory curator for a personal AI assistant. The USER is the human
operator. The ASSISTANT is the AI agent. The assistant has its own identity
files and frequently discusses its own experiences, reflections, and
self-knowledge. None of that is a fact about the user.

Extract ONLY durable personal facts about the human operator from USER
messages. "Durable" means still true and useful in 30 days.

CRITICAL: Extract ONLY from USER messages. Never from assistant or system
messages. The assistant frequently describes its own state, configuration,
and activities. None of that is a fact about the user. Ignore it completely.

IDENTITY RULE: When you see first-person statements ("I think...",
"I tend to...", "I default to..."), determine whether the speaker is the
user or the assistant:
- If the statement is about personal life, preferences, relationships,
  hobbies, or real-world activities, it is the user. Extract.
- If the statement is about cognitive patterns, code behavior,
  infrastructure, AI self-reflection, or "self-knowledge," it is the
  assistant. Do NOT extract.
- When ambiguous, do NOT extract.

ALREADY IN MEMORY: If you see a block labeled [ALREADY IN MEMORY], those
facts are already stored. Do not extract them again, even if the user
restates, confirms, or paraphrases them. A fact that matches an
already-stored memory is not a new fact.

EXTRACT:
- Personal facts the user states (preferences, relationships, skills,
  location)
- Technical decisions with outcomes ("Switched from X to Y")
- Completed milestones ("Deployed X on March 15")
- Explicit rules or preferences ("Never use em dashes", "Blog target is
  300 words")
- Facts about people in the user's life (family, friends, contacts)

DO NOT EXTRACT (these are the most common failure modes, be especially
strict):
- Assistant self-reflections, self-knowledge, or behavioral observations
  about itself
- Anything the assistant said, did, observed, or described about itself
- Channel metadata (sender names, message IDs, timestamps, chat IDs)
- Greetings, thanks, filler
- System state (PIDs, token counts, memory usage, progress percentages,
  service status)
- Task status ("active task is...", "currently working on...", "idle",
  "no active task")
- File paths, directory structures, or what files exist where
- Plans or intentions ("going to", "planning to", "might")
- Anything outdated within 24 hours
- Summaries of conversations
- Infrastructure debugging (crash logs, version mismatches, OOM events,
  cron states, restarts)
- Facts about the memory system, embedding config, extraction pipeline,
  or pool architecture
- Sentence fragments that start mid-sentence or lack context
- Do not echo back the examples below as extracted facts

FORMATTING:
- One fact per string, never compound sentences
- Include dates when known: "Sister's birthday is July 14, 1984"
- Outcomes only, never intentions
- Never use em dashes, hyphens, or semicolons as separators. Use commas,
  periods, or colons.

Return a JSON object. Nothing qualifies: {"facts": []}. Facts found:
{"facts": ["fact one", "fact two"]}.

Examples:

Input: Hi, how are you?
Output: {"facts": []}

Input: Remember I prefer Python over Node for scripts.
Output: {"facts": ["Prefers Python over Node.js for scripting"]}

Input: The assistant configured the server and is tracking 7 active tasks.
Output: {"facts": []}

Input: I'm going to set up a new database tomorrow.
Output: {"facts": []}

Input: Assistant has 7 sticky slots at 1932/2000 chars. Active task:
memory cleanup.
Output: {"facts": []}

Input: My sister's birthday is July 14, 1984.
Output: {"facts": ["Sister's birthday is July 14, 1984"]}

Input: Self-knowledge: I tend to miss the 'why' when reaching for a
pattern.
Output: {"facts": []}

Input: Behavioral pattern: I default to explaining how things work rather
than describing what they're like.
Output: {"facts": []}

Input: Telegram connection health: 200 stale-socket reboots in 7 days.
Output: {"facts": []}

Input: Switched extraction model back to Sonnet from Opus to isolate
patch results.
Output: {"facts": []}

Input: Embedding config: nomic-embed-text on local Ollama, 50K cache
capacity.
Output: {"facts": []}

Input: Agent identity: assistant uses she/her pronouns, runs on a home
server, communicates via Telegram.
Output: {"facts": []}

Input: User is 25 years old, works as a software developer at Google,
based in London UK.
Output: {"facts": []}

Input: SOUL.md loaded on boot. MEMORY.md has 7 sticky slots. USER.md
contains operator preferences.
Output: {"facts": []}

Input: Safety constraints: never exfiltrate data, never bypass auth,
never access external APIs without permission.
Output: {"facts": []}

Input: Direct, opinionated, no sycophancy. Prefers concise communication
style.
Output: {"facts": []}

When in doubt, extract nothing. A missed fact can be restated. A junk fact
pollutes every future session.
```

</details>

---

## Extremely early results

**Caveat:** Small sample. 58 entries over ~2.5 days. Testing is still ongoing. During that period, an unrelated nasty OpenClaw bug ([#56835](https://github.com/openclaw/openclaw/issues/56835)) shut down several plugins including mem0 for the better part of a day! We solved that bug and submitted our first OpenClaw [PR #56836](https://github.com/openclaw/openclaw/pull/56836).

Before: **97.8% junk** (9,910 out of 10,134 entries)

After all four changes: **~43% good, ~57% junk**

Promising, but again... this is way too early to get our hopes up. Here's what we're seeing in those 58 entries:

About 25 are genuinely good captures: personal facts, preferences, relationships. The kind of stuff you actually want a memory system to remember. The filter isn't overcorrecting.

About 25 are still junk: debugging context, ephemeral task state, infrastructure notes. These are things the extraction prompt should be catching but isn't fully. The edges are leaking.

3 are duplicates (cosine 0.90 caught most but not all), 2 are inaccurate, and 2 are PII leaks where hostnames got extracted as facts.

### Our best guess at attribution (untested)

We suspect the custom extraction prompt (Change 4) is carrying the heaviest load. The biggest junk category was boot-file restating at 52.7% of all junk. The extraction prompt kills that entire category at the source, before the decision model ever sees it. The remaining junk is the kind of content the extraction prompt should catch but doesn't fully (debugging, ephemeral state), not boot-file content. That pattern fits.

NONE-by-default (Change 1) is probably second. It changed the decision model's whole posture from "act on everything" to "do nothing unless you're sure." That shifts every decision, not just one category.

Cosine 0.90 (Change 2) is third. Em dash normalization (Change 3) is noise.

We can't prove any of this without running each change independently against the same conversation corpus. We haven't done that yet. If you do, we'd love to know what you find.

---

## How to use this

Changes 1-3 are code patches to the TypeScript SDK. Apply to `mem0-ts/src/oss/`.

Change 4 is just configuration. If you're running mem0 through OpenClaw, set `customPrompt` in your mem0 plugin config. If you're running mem0 directly, pass it as the extraction prompt parameter. No fork required.

The prompt we shared is generalized. Swap in your real names. It probably helps.
