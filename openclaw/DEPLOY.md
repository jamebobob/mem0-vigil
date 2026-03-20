# Deploying the Mem0 Fork to Gateway

Step-by-step guide for switching gateway's openclaw-mem0 plugin from
patched node_modules to the jamebobob/mem0 fork.

**Audience:** A future Opus or Claude Code session deploying to gateway
without prior context. Commands are copy-pasteable.

**Canonical roadmap:** `~/Downloads/project-vigil-v5.md`

---

## Pre-Deploy Checklist (run on gateway)

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
# If social agent has its own AGENTS.md, back that up too:
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
git clone https://github.com/jamebobob/mem0.git mem0-fork
cd ~/mem0-fork/openclaw
```

### 2. Install dependencies and build

```bash
npm install
npx tsup
```

**Verify build succeeds before continuing.** You should see:

```
ESM dist/index.js     ~51 KB
DTS dist/index.d.ts   ~3.5 KB
```

If the build fails, stop. Do not proceed to the next step.

### 3. Run the test suite

```bash
npx vitest run
```

Expected: 48 tests passing across 5 test files. If any fail, stop.

### 4. Link the fork plugin

```bash
openclaw plugins install -l ~/mem0-fork/openclaw
```

This tells OpenClaw to load the plugin from the fork's build output
(`dist/index.js`) instead of the published npm package. The `-l` flag
creates a symlink (no copy), so rebuilding the fork automatically
updates the plugin.

**Verify on gateway:** Check that `openclaw.json` now references the
fork path. Look for `plugins.load.paths` containing the fork path,
or check that the `openclaw-mem0` entry is still enabled:

```bash
cat ~/.openclaw/openclaw.json | python3 -m json.tool | grep -A5 openclaw-mem0
```

The plugin config (`mode`, `userId`, `oss`, `agentMemory`, etc.) should
be preserved from the existing `openclaw.json`. The link command changes
where the code is loaded from, not the config.

### 5. Find the gateway service name

```bash
systemctl list-units --type=service | grep -i claw
```

Note the exact service name (e.g. `openclaw-gateway.service` or similar).

### 6. Restart the gateway

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

### 1. the assistant responds on Telegram

- Send a DM to the assistant. She should respond normally.
- Send a message in the family group. Social agent should respond.
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

## 7-Day Rollback Plan

For the first 7 days, keep the old patched node_modules and
verify-patches.py intact. If regressions are found:

### Revert to published package

```bash
# Unlink the fork
openclaw plugins install @mem0/openclaw-mem0

# Restart gateway
sudo systemctl restart <gateway-service-name>

# Verify patches still apply to the reinstalled package
python3 ~/.openclaw/workspace/verify-patches.py
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
curl -X PUT "http://localhost:6333/collections/memories/snapshots/<snapshot-name>/recover"
```

### After 7 clean days

- verify-patches.py is deprecated. The fork's 48-test suite is the
  new verification mechanism.
- Add a deprecation note to verify-patches.py (don't delete it --
  historical reference).
- The old node_modules patches can be archived but not deleted until
  you're confident the fork is stable.

---

## What NOT To Do

- **Don't delete node_modules patches during the 7-day window.**
  They are your rollback path.
- **Don't run `openclaw` CLI commands during deploy** (e.g.
  `openclaw restart`, `openclaw reload`). These cause blackouts.
  Use `systemctl` for service management.
- **Don't deploy on a day when gateway can't be monitored** for at
  least 2-3 hours afterward. the assistant needs to be observed in both DM
  and group contexts.
- **Don't deploy the recall guard without completing the family pool
  `is_private` audit.** See Vigil v5 "Day 3 pre-deploy step" for
  the Qdrant query. Batch-migrated memories may carry incorrect
  `is_private: true` tags.
