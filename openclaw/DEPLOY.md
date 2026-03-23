# Deploying the Mem0 Fork to Gateway

Step-by-step guide for switching homeserver's openclaw-mem0 plugin from
patched node_modules to the jamebobob/mem0-vigil fork.

**Audience:** A future Opus or Claude Code session deploying to homeserver
without prior context. Commands are copy-pasteable.

**Canonical roadmap:** `~/Downloads/project-vigil-v5.md`

---

## Pre-Deploy Checklist (run on homeserver)

### 1. Qdrant snapshot

```bash
curl -X POST http://localhost:6333/collections/memories/snapshots
```

Save the snapshot name from the response. This is your data rollback point.

### 2. Verify current patches still apply

```bash
python3 ~/.openclaw/workspace/verify-patches.py
```

All patches should report OK. If any fail, investigate before proceeding.

### 3. Back up config

```bash
cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.bak.pre-fork
```

### 4. Back up AGENTS.md for both agents

```bash
cp ~/.openclaw/workspace/AGENTS.md ~/.openclaw/workspace/AGENTS.md.bak.pre-fork
# If social-* agents have their own AGENTS.md, back those up too:
ls ~/.openclaw/workspace/agents/*/AGENTS.md 2>/dev/null && \
  for f in ~/.openclaw/workspace/agents/*/AGENTS.md; do cp "$f" "${f}.bak.pre-fork"; done
```

### 5. Note the current plugin version

```bash
cat ~/.openclaw/extensions/openclaw-mem0/package.json | grep version
```

Record this for rollback reference.

---

## Deploy

### 1. Clone the fork

```bash
cd ~
git clone https://github.com/jamebobob/mem0-vigil.git mem0-fork
```

### 2. Build the forked SDK

The plugin depends on the forked mem0 TypeScript SDK via a `file:`
dependency (`"mem0ai": "file:../mem0-ts"` in `openclaw/package.json`).
The SDK must be built first so that `mem0-ts/dist/` exists before the
plugin's `npm install` resolves it.

```bash
cd ~/mem0-fork/mem0-ts
npm install
npm run build
```

**Verify SDK build succeeds before continuing.** You should see:

```
CJS dist/oss/index.js     ~177 KB
ESM dist/oss/index.mjs    ~173 KB
```

If the build fails, stop. Do not proceed to the next step.

### 3. Build the plugin

```bash
cd ~/mem0-fork/openclaw
npm install
npx tsup
```

`npm install` creates a symlink at `node_modules/mem0ai -> ../mem0-ts`.
The plugin uses dynamic `import("mem0ai/oss")` at runtime, so the
forked SDK's patched code (dedup gates, score_threshold forwarding,
JSON resilience, max_tokens fix) is loaded from the symlinked dist,
not bundled into the plugin's own `dist/index.js`.

**Verify plugin build succeeds.** You should see:

```
ESM dist/index.js     ~52 KB
DTS dist/index.d.ts   ~3.5 KB
```

If the build fails, stop. Do not proceed to the next step.

### 4. Run the test suite

```bash
npx vitest run
```

Expected: 53 tests passing across 5 test files. If any fail, stop.

### 5. Link the fork plugin

```bash
openclaw plugins install -l ~/mem0-fork/openclaw
```

This tells OpenClaw to load the plugin from the fork's build output
(`dist/index.js`) instead of the published npm package. The `-l` flag
creates a symlink (no copy), so rebuilding the fork automatically
updates the plugin.

**Verify on homeserver:** Check that `openclaw.json` now references the
fork path. Look for `plugins.load.paths` containing the fork path,
or check that the `openclaw-mem0` entry is still enabled:

```bash
cat ~/.openclaw/openclaw.json | python3 -m json.tool | grep -A5 openclaw-mem0
```

The plugin config (`mode`, `userId`, `oss`, `agentMemory`, etc.) should
be preserved from the existing `openclaw.json`. The link command changes
where the code is loaded from, not the config.

### 6. Find the gateway service name

```bash
systemctl list-units --type=service | grep -i claw
```

Note the exact service name (e.g. `openclaw-gateway.service` or similar).

### 7. Restart the gateway

```bash
sudo systemctl restart <gateway-service-name>
```

**Do NOT use `openclaw` CLI commands to restart.** CLI restarts cause
blackouts. Use systemctl.

Watch the logs for startup errors:

```bash
sudo journalctl -u <gateway-service-name> -f --since "1 min ago"
```

Look for: `openclaw-mem0: registered (mode: open-source, ...)`

If you see errors about missing modules or config, check the build
output and plugin link.

---

## Post-Deploy Verification

### 1. Agent responds on Telegram

- Send a DM to your agent. It should respond normally.
- Send a message in a group. The corresponding social-* agent should respond.
- If either agent is unresponsive, check gateway logs immediately.

### 2. Qdrant health

```bash
python3 ~/.openclaw/workspace/qdrant-health.py
```

### 3. Telemetry files appear

After a few messages (triggering auto-recall), check:

```bash
ls -la ~/.openclaw/workspace/memory/recall-events-*.jsonl
```

If the file exists and has content, telemetry is working.

### 4. Check capture filter is active

After a conversation with both user and assistant messages, check
gateway logs for capture activity:

```bash
sudo journalctl -u <gateway-service-name> --since "5 min ago" | grep "auto-captured"
```

### 5. No errors in logs

```bash
sudo journalctl -u <gateway-service-name> --since "10 min ago" | grep -i "error\|warn" | grep mem0
```

---

## Adding a New Group (Per-Group Configuration)

When the agent joins a new Telegram group, five things must be configured
before the group's memories are captured and recalled correctly:

1. **Agent entry** -- Add a `social-<group>` agent to `agents.list`
2. **Binding** -- Bind the new agent to the Telegram group's chat ID
3. **agentMemory entry** -- Add a `"social-<group>"` key to the
   `agentMemory` block in `openclaw.json` with `capture` and `recall`
   set to the new pool name
4. **Main's recall array** -- Add the new pool name to `main`'s
   `recall` array so the DM agent can search the group's memories
5. **Workspace directory** -- Create the agent's workspace directory
   under `~/.openclaw/workspace/agents/`

**Operational tool:** Use `~/bin/provision-group.sh` on homeserver to
automate these steps. The script handles all five in sequence and
validates the result.

After provisioning, restart the gateway via `systemctl` (not the
openclaw CLI) and verify the new agent responds in the group.

---

## 7-Day Rollback Plan

For the first 7 days, keep the old patched node_modules and
verify-patches.py intact. If regressions are found:

### Revert to published package

```bash
# Unlink the fork and reinstall the published npm package
openclaw plugins install @mem0/openclaw-mem0

# Re-apply node_modules patches to the reinstalled package.
# The published package does NOT have the 6 SDK patches (dedup,
# threshold, max_tokens, etc.). These must be re-applied.
python3 ~/.openclaw/workspace/verify-patches.py --apply
# If verify-patches.py doesn't have an --apply flag, re-apply
# patches manually from the patch files in the workspace.
# Then verify:
python3 ~/.openclaw/workspace/verify-patches.py

# Restart gateway
sudo systemctl restart <gateway-service-name>
```

### Restore config if needed

```bash
cp ~/.openclaw/openclaw.json.bak.pre-fork ~/.openclaw/openclaw.json
sudo systemctl restart <gateway-service-name>
```

### Restore Qdrant from snapshot (nuclear option)

Only if data corruption is suspected:

```bash
# List snapshots
curl http://localhost:6333/collections/memories/snapshots

# Restore (DESTRUCTIVE -- replaces current data)
# The snapshot file path is typically /qdrant/snapshots/memories/<snapshot-name>
curl -X PUT "http://localhost:6333/collections/memories/snapshots/recover" \
  -H "Content-Type: application/json" \
  -d '{"location": "file:///qdrant/snapshots/memories/<snapshot-name>"}'
# If the path is wrong, check: ls /qdrant/snapshots/memories/
```

### After 7 clean days

- verify-patches.py is deprecated. The fork's 53-test suite is the
  new verification mechanism.
- Add a deprecation note to verify-patches.py (don't delete it --
  historical reference).
- The old node_modules patches can be archived but not deleted until
  you're confident the fork is stable.

---

## What NOT To Do

- **Don't delete node_modules patches during the 7-day window.**
  They are your rollback path.
- **Don't use `openclaw restart` or `openclaw reload` to restart
  the gateway.** These cause blackouts. Use `systemctl` for service
  management. (`openclaw plugins install` is safe — it modifies
  config without restarting the running process.)
- **Don't deploy on a day when homeserver can't be monitored** for at
  least 2-3 hours afterward. The agent needs to be observed in both DM
  and group contexts.
- **Don't deploy the recall guard without completing the family pool
  `is_private` audit.** See Vigil v5 "Day 3 pre-deploy step" for
  the Qdrant query. Batch-migrated memories may carry incorrect
  `is_private: true` tags.
