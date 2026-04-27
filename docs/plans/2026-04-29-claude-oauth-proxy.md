# Claude-OAuth-Proxy für haex-corp Implementation Plan

> **For Claude (fresh session):** REQUIRED SUB-SKILL: Use superpowers:executing-plans
> to implement this plan task-by-task. Read this entire plan first, then check current
> state in `proxies/claude-oauth/` before starting.

**Goal:** Anthropic-API-kompatibler HTTP-Proxy bauen, der die `claude` CLI als
Subprocess wraps. Damit kann hermes-agent (und jeder andere Anthropic-API-Client)
eine Claude Pro/Max-Subscription via OAuth nutzen statt API-Credits zu verbrauchen.

**Architecture:** Stateless HTTP-Proxy in Node.js (zero deps, stdlib only).
Empfängt `POST /v1/messages` im Anthropic-Format, transformiert zu `claude --print
--output-format json` Subprocess-Aufruf, übersetzt Response zurück. Streaming via
`--output-format stream-json` → Anthropic-SSE-Format. Tool-Use bleibt als Daten
durchgereicht (claude läuft mit `--allowed-tools ""` → führt keine Tools aus, gibt
Tool-Use-Intents als content-blocks zurück).

```
hermes-agent container             claude-oauth-proxy             claude CLI
(--provider anthropic              (~/.claude bind-mount)          (uses OAuth)
 ANTHROPIC_BASE_URL=                                                              ↓ HTTPS
 http://claude-proxy:8080)         POST /v1/messages       →     api.anthropic.com
              ↓ HTTPS                       ↓ subprocess
              POST /v1/messages       ←     claude --print …
                                            (json or stream-json)
```

**Tech Stack:** Node.js 22+ (stdlib only — `http`, `child_process`, `crypto`),
`@anthropic-ai/claude-code` (npm — provides the `claude` CLI). Docker container
basiert auf `node:22-bookworm-slim`.

---

## Why this exists

- haex-corp's hermes-agent containers benötigen einen Anthropic-Inference-Endpoint
- User hat **Claude Max** Subscription, will diese statt zusätzlicher API-Costs nutzen
- Anthropic blockt direkten OAuth-Token-Forward an `api.anthropic.com` (User-Agent /
  Client-Fingerprint Validierung) — daher braucht's einen Subprocess der die offizielle
  `claude` CLI nutzt, welche OAuth-Tokens aus `~/.claude/.credentials.json` korrekt einsetzt
- Hermes muss bleiben (User-Anforderung: "self-learning feature unbedingt behalten")
- Existing `joesobo/claude-max-api-proxy` ist OpenAI-Format, fragiles CLI-Output-Parsing,
  3 Stars, single-maintainer — nicht production-ready, daher selber ordentlich bauen

---

## Current State (von einer früheren Session)

**Existiert bereits in `proxies/claude-oauth/`:**

| File | Status | Notiz |
|---|---|---|
| `package.json` | ✅ done | Zero-deps, ESM, Node 22+ |
| `src/server.js` | ⚠️ **Skeleton — nicht getestet** | Phase-1 MVP-Code drin, **noch nicht gegen echte claude CLI verifiziert**. Format-Annahmen müssen Phase 1 bewiesen werden. |
| `Dockerfile` | ❌ fehlt | TBD Phase 4 |
| `test/` (dir) | ❌ leer | TBD Phase 1 |

**Critical: das `server.js` enthält UNGETESTETE Annahmen über:**
1. `claude --output-format stream-json`-Event-Shape (vermutet: `{type, message: {content: [...]}}`)
2. `claude --output-format json`-Output-Shape (vermutet: `{result, usage, ...}`)
3. Multi-turn-Behandlung via flatten-to-text ist Phase-1-Approach (Phase 2 verbessert via stdin-stream-json)

**Diese drei MÜSSEN als allererstes verifiziert werden** durch echten claude-CLI-Aufruf
mit OAuth-Login. Falls die Annahmen falsch sind: `mapClaudeStreamEvent()` und
`claudeJsonToAnthropic()` müssen entsprechend angepasst werden.

---

## Final Decisions Locked-In

| # | Decision | Rationale |
|---|---|---|
| 1 | **Anthropic-Format-Wire-Protocol** (nicht OpenAI) | hermes spricht nativ Anthropic-API, weniger Translation-Layer, bessere Fehler-Mapping. |
| 2 | **claude CLI als Subprocess** (nicht Library/SDK) | OAuth-Tokens funktionieren NUR via offizielle CLI; SDK liest gleiche Credentials aber ist als full agent designed (auto-tool-execution). CLI mit `--allowed-tools ""` ist der einzige saubere Pfad zu reinem LLM-Inference mit OAuth. |
| 3 | **Tools als Pass-Through, nicht Translation** | Wir definieren die Tools im System-Prompt, claude liefert `tool_use` als content-block (nativ Anthropic-Format) zurück, hermes führt selbst aus. Keine eigene Tool-Use-Format-Translation nötig. |
| 4 | **Stateless: `--no-session-persistence` + jede Request fresh subprocess** | Kein Session-State-Bleed zwischen Workers, kein Cleanup-Risiko. Trade-off: ~200ms Spawn-Overhead pro Call. Akzeptabel für Multi-Agent-Volumen (≤10 Calls/min typisch). |
| 5 | **Multi-turn: Phase 1 via flatten-to-text mit `<turn role="...">`-Tags, Phase 2 via stdin stream-json** | Phase 1 schippt schnell. Phase 2 verbessert Treue. Beide Phasen sind API-kompatibel — Caller merkt nicht welche Variante läuft. |
| 6 | **Streaming via SSE map: claude stream-json → Anthropic SSE-events** | Anthropic SDK clients (inkl. hermes) erwarten `event: content_block_delta\ndata: {...}` Format. Mapping ist mechanisch. |
| 7 | **Auth-Header inbound werden ignoriert** | Proxy sitzt im internen Docker-Netz, nicht öffentlich exposed. Wer auf den Port kommt, kann ihn nutzen — gleiche Trust-Boundary wie hermes-agent-Containers selbst. |
| 8 | **Rate-Limiting/Token-Refresh delegation an `claude` CLI** | Die CLI handhabt OAuth-Token-Refresh und Rate-Limit-Backoff intern. Wir müssen nichts davon nachbauen — surfacen aber non-zero exits als HTTP 502 mit stderr-Inhalt. |
| 9 | **Docker-Image bind-mount `~/.claude` von Host** | Auf dem Server einmal `claude auth login` interaktiv (device-code-flow via SSH), dann lebt `~/.claude/.credentials.json` auf dem Host. Container mountet readonly. Kein Token-Plumbing in Compose-Variablen. |
| 10 | **Standalone deployment, separat von haex-corp** | Eigener Container `claude-oauth-proxy:latest`, eigenes Image, eigener CI-Workflow. haex-corp config bekommt nur `ANTHROPIC_BASE_URL=http://claude-oauth-proxy:8080`. Sauber separierte Verantwortlichkeiten. |

---

## Files Touched (overview)

**In `proxies/claude-oauth/` (haex-corp repo):**

| Path | Action | What |
|---|---|---|
| `src/server.js` | modify | MVP-Skeleton existiert, Phase 1 verifiziert + repariert. Phase 2 fügt stdin-stream-json hinzu. |
| `src/cli-format.js` | create | Pure helpers: `anthropicMessagesToPrompt()`, `claudeJsonToAnthropic()`, `mapClaudeStreamEvent()`. Aktuell in server.js inline — auslagern für Test-Isolation. |
| `Dockerfile` | create | node:22-bookworm-slim + `@anthropic-ai/claude-code` global install + COPY src/. EXPOSE 8080. |
| `test/format.test.js` | create | Unit tests für die Pure-helpers (kein Subprocess). |
| `test/integration.test.js` | create | E2E gegen echtes claude CLI (gated via env `CLAUDE_PROXY_E2E=1` weil OAuth-Login nötig). |
| `.github/workflows/build-claude-oauth-proxy.yml` | create | Multi-arch GHCR push, analog zu existing build-haex-corp-image.yml. |

**In `haex-corp/server/api/projects/[slug]/company/start.post.ts`:**
- Optional: env-Pass-Through `ANTHROPIC_BASE_URL` an spawned worker containers,
  damit sie auf den Proxy zeigen statt auf api.anthropic.com.

**In ansible repo (`~/Projekte/ansible/roles/`):**
- `roles/claude-oauth-proxy/` (NEU) — eigene Role analog zu fwbg/haex-corp.
- `inventory/haex.cloud.yml` — `claude_oauth_proxy:` Sektion.
- `haex.cloud.play.yml` — Role-Eintrag VOR haex-corp (haex-corp ist Konsument).

---

## Phased Implementation

### Phase 0 — Verification (1-2h, MUST-DO erst)

Bevor irgendwelcher Code committet wird: verifizieren dass die Annahmen
in `server.js` stimmen. Ohne diesen Schritt wird Phase 1 mit hoher Wahrscheinlichkeit
in falschen Format-Mappings landen.

#### Task 0.1: claude CLI lokal installieren und login

```bash
npm install -g @anthropic-ai/claude-code
claude auth login                # interaktiv, device-code-flow
claude --version                 # verify
ls -la ~/.claude/                # verify .credentials.json existiert
```

#### Task 0.2: Format-Probes — capture die echten Outputs

```bash
# JSON output (non-streaming)
claude --print --output-format json --no-session-persistence \
  --allowed-tools "" \
  --model claude-sonnet-4-6 \
  "Say hello" \
  > /tmp/claude-probe-json.txt 2>&1
cat /tmp/claude-probe-json.txt | jq

# Stream-JSON output (streaming)
claude --print --output-format stream-json --include-partial-messages \
  --no-session-persistence --allowed-tools "" \
  --model claude-sonnet-4-6 \
  "Say hello" \
  > /tmp/claude-probe-stream.txt 2>&1
cat /tmp/claude-probe-stream.txt
```

**Decision-Point**: vergleiche die echten Shapes mit den Annahmen in:
- `claudeJsonToAnthropic()` in `server.js` Zeile ~280
- `mapClaudeStreamEvent()` in `server.js` Zeile ~245

Falls Abweichungen: anpassen + dokumentieren. Erst dann Phase 1 committen.

#### Task 0.3: hermes-Verhalten verifizieren — `ANTHROPIC_BASE_URL` Override

```bash
# In einem hermes-agent container:
docker run --rm -e ANTHROPIC_API_KEY=test -e ANTHROPIC_BASE_URL=http://localhost:9999 \
  hermes-agent:dev hermes chat --provider anthropic -q "hi" 2>&1 | head -20
```

Erwartetes Behavior: hermes versucht, `localhost:9999` zu erreichen (curl fail
oder connection refused — das beweist dass die env durchschlägt). Falls hermes
die env IGNORIERT und trotzdem `api.anthropic.com` aufruft, müssen wir
`hermes config set model.base_url …` per init in den Container injizieren.

**Decision-Point**: ergebnisse in einer kurzen Notiz im Plan ergänzen. Falls
env nicht durchschlägt: Phase 4 muss einen `entrypoint.sh`-Wrapper schreiben
der `hermes config set` vor dem ersten chat-Call ausführt.

---

### Phase 1 — MVP: Text-only End-to-End (3-4h)

Ziel: ein User kann `curl -X POST http://localhost:8080/v1/messages -d {…}` machen
und kriegt eine echte Claude-Antwort via OAuth-Subscription. Ohne Streaming, ohne
Tool-Use-Round-Trip. NUR text-in / text-out.

#### Task 1.1: Pure helpers extrahieren

**Files:** Create: `proxies/claude-oauth/src/cli-format.js`

Ziehe die folgenden Funktionen aus `server.js` in `cli-format.js` und exportiere
sie:

- `validateMessagesBody(body)`
- `anthropicMessagesToPrompt(body)`
- `flattenContent(content)`
- `buildClaudeArgs({model, systemPrompt, streaming})`
- `claudeJsonToAnthropic(claudeOut, model)`
- `mapClaudeStreamEvent(claudeEvt, alreadyStarted)`

In `server.js` per `import` einbinden. Zweck: Unit-Tests können die helpers
isoliert ausführen, ohne HTTP-Setup.

**Test:** `node -c src/server.js && node -c src/cli-format.js` — syntax-clean.

**Commit:** `refactor(claude-oauth-proxy): extract format helpers into cli-format.js`

#### Task 1.2: Unit-Tests für format helpers

**Files:** Create: `proxies/claude-oauth/test/format.test.js`

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import {
  validateMessagesBody,
  anthropicMessagesToPrompt,
  buildClaudeArgs,
  claudeJsonToAnthropic,
  mapClaudeStreamEvent,
} from "../src/cli-format.js";

test("validateMessagesBody: accepts well-formed body", () => {
  const r = validateMessagesBody({
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.deepEqual(r, { ok: true });
});

test("validateMessagesBody: rejects missing model", () => {
  const r = validateMessagesBody({
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /model/);
});

test("anthropicMessagesToPrompt: flattens single-turn user message", () => {
  const { promptText, systemText } = anthropicMessagesToPrompt({
    model: "claude-sonnet-4-6",
    system: "You are helpful",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(systemText, "You are helpful");
  assert.match(promptText, /<turn role="user">hi<\/turn>/);
});

test("anthropicMessagesToPrompt: includes tools spec when provided", () => {
  const { promptText } = anthropicMessagesToPrompt({
    model: "x",
    messages: [{ role: "user", content: "x" }],
    tools: [{ name: "foo", description: "Does foo", input_schema: { type: "object" } }],
  });
  assert.match(promptText, /<available_tools>/);
  assert.match(promptText, /foo: Does foo/);
});

test("buildClaudeArgs: streaming flag adds stream-json + input-format", () => {
  const args = buildClaudeArgs({ model: "x", systemPrompt: null, streaming: true });
  assert.ok(args.includes("--output-format"));
  assert.ok(args.includes("stream-json"));
  assert.ok(args.includes("--input-format"));
});

test("claudeJsonToAnthropic: maps result text to content array", () => {
  const r = claudeJsonToAnthropic({ result: "hello", usage: { input_tokens: 5 } }, "claude-sonnet-4-6");
  assert.equal(r.type, "message");
  assert.equal(r.role, "assistant");
  assert.deepEqual(r.content, [{ type: "text", text: "hello" }]);
  assert.equal(r.usage.input_tokens, 5);
});

// Add tests for mapClaudeStreamEvent based on REAL claude output captured in
// Phase 0 — don't write tests against assumed shapes, write against actual.
```

**Run:** `node --test test/format.test.js` — alle grün.

**Commit:** `test(claude-oauth-proxy): unit coverage for format helpers`

#### Task 1.3: Smoke-Test gegen echte claude CLI

**Files:** Create: `proxies/claude-oauth/test/integration.test.js`

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const E2E = process.env.CLAUDE_PROXY_E2E === "1";
const MAYBE = E2E ? test : test.skip;

MAYBE("integration: claude CLI returns parseable JSON for simple prompt", async () => {
  const proc = spawn("claude", [
    "--print",
    "--output-format", "json",
    "--no-session-persistence",
    "--allowed-tools", "",
    "--model", "claude-sonnet-4-6",
    "Say only the word 'pong'.",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  proc.stdout.on("data", (c) => { out += c.toString(); });
  proc.stderr.on("data", (c) => { err += c.toString(); });
  await new Promise((resolve, reject) => {
    proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(`exit ${code}: ${err}`)));
  });
  const parsed = JSON.parse(out);
  assert.ok(parsed, "expected non-empty json output");
  // Snapshot: log shape so plan-author can verify mappings hold.
  console.log("[integration] claude json shape keys:", Object.keys(parsed));
});
```

Lokal ausführen mit `CLAUDE_PROXY_E2E=1 node --test test/integration.test.js`.

**Commit:** `test(claude-oauth-proxy): add gated integration smoke against claude CLI`

#### Task 1.4: server.js bug-hunt + Phase-0-Fixes anwenden

Falls Phase 0 Format-Abweichungen gefunden hat: jetzt einarbeiten in
`cli-format.js`. Tests aus 1.2 müssen weiterhin grün bleiben (oder
angepasst werden falls die Annahmen falsch waren).

**Run:** Server lokal starten + curl testen.

```bash
cd proxies/claude-oauth && node src/server.js &
PROXY=$!

curl -sX POST http://localhost:8080/v1/messages \
  -H 'content-type: application/json' \
  -d '{
    "model": "claude-sonnet-4-6",
    "max_tokens": 200,
    "messages": [{"role":"user","content":"Say only the word pong."}]
  }' | jq

kill $PROXY
```

Erwartet: HTTP 200 mit Body `{"type":"message","content":[{"type":"text","text":"pong"}], …}`.

**Commit:** `feat(claude-oauth-proxy): MVP working — text-only Anthropic→claude proxy`

---

### Phase 2 — Streaming + Multi-turn-Treue (3-4h)

#### Task 2.1: Streaming-Map gegen echtes claude-stream-json validieren

Capture tatsächliche stream-json-events von claude CLI (Phase 0 Probe), schreibe
fixture-Tests gegen `mapClaudeStreamEvent`. Korrigiere falls Mapping falsch.

#### Task 2.2: Streaming-Test gegen Server

```bash
curl -sN -X POST http://localhost:8080/v1/messages \
  -H 'content-type: application/json' \
  -d '{
    "model": "claude-sonnet-4-6",
    "stream": true,
    "messages": [{"role":"user","content":"Count from 1 to 5."}]
  }'
```

Erwartet: `event: message_start\ndata: …` gefolgt von `event: content_block_delta`-events.

#### Task 2.3: Multi-turn via stdin-stream-json

Statt `--print PROMPT` mit flatten-to-text: schreibe NDJSON-events von messages
in stdin des subprocess. Format-Spec aus Phase 0 gelernten claude-Behavior
ableiten.

Code-change-area: `server.js`'s `handleMessages()` Funktion — proc anders
spawnen + stdin schreiben.

**Commit:** `feat(claude-oauth-proxy): streaming SSE + multi-turn via stdin stream-json`

---

### Phase 3 — Production-Hardening (2-3h)

#### Task 3.1: Concurrent-Request-Limit

Heute: jede Request spawnt einen subprocess. Bei hermes-agents die parallel
arbeiten → potenziell viele claude-Subprocesses gleichzeitig. Limit via
Semaphore (z.B. max 5 parallel).

#### Task 3.2: Subprocess-Timeout

Bei hängender claude (Network-Outage, OAuth-Token-Refresh-Probleme): SIGTERM
nach z.B. 120s, dann SIGKILL nach 5s.

#### Task 3.3: Structured-Logging

`console.log` heute → strukturiertes JSON mit `requestId`, `model`,
`durationMs`, `exitCode`. Damit Operator-Visibility was passiert.

#### Task 3.4: /healthz hardening

`claude --version` ist OK aber sagt nicht ob OAuth funktioniert. Phase-3
Erweiterung: `/healthz?deep=1` macht einen Trivial-Inference-Call (eg.
"Reply OK") und prüft non-zero-exit.

**Commit:** je task einzeln, prefix `feat(claude-oauth-proxy):`

---

### Phase 4 — Deployment (2-3h)

#### Task 4.1: Dockerfile

```dockerfile
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl tini \
    && rm -rf /var/lib/apt/lists/*

# Install claude CLI globally — uses npm to fetch @anthropic-ai/claude-code
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app
COPY package.json src/ ./
EXPOSE 8080
ENV NODE_ENV=production

USER node
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]
```

#### Task 4.2: GitHub Actions Build-Workflow

Mirror der existing `build-haex-corp-image.yml`:
- Multi-arch (amd64 + arm64)
- Tags: `:latest`, `:sha-<short>`, `:<branch>`
- Image: `ghcr.io/<owner>/claude-oauth-proxy`

#### Task 4.3: Ansible Role

`roles/claude-oauth-proxy/` mit Tasks/Templates analog fwbg:
- `tasks/main.yml` — mkdir, deploy template files, docker-compose pull+up
- `templates/docker-compose.yml.j2` — ein Service mit `~/.claude` bind-mount,
  joined to `companies` network so haex-corp's spawned containers reach it.

```yaml
services:
  claude-oauth-proxy:
    image: ghcr.io/{{ ghcr_account }}/claude-oauth-proxy:{{ image_tag }}
    container_name: claude-oauth-proxy
    restart: unless-stopped
    volumes:
      # OAuth tokens come from the host's interactive `claude auth login`.
      # Read-only mount so the proxy can't accidentally invalidate them.
      - "{{ ansible_env.HOME }}/.claude:/home/node/.claude:ro"
    networks:
      - companies
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:8080/healthz').then(r=>process.exit(r.ok?0:1))"]
      interval: 30s
      timeout: 10s
networks:
  companies:
    external: true
    name: companies
```

#### Task 4.4: Server-side claude auth login

Einmaliger Setup-Schritt nach Deploy:

```bash
# Auf haex.cloud:
ssh haex.cloud
npm install -g @anthropic-ai/claude-code  # oder via apt nodejs
claude auth login    # → device-code URL, am Phone öffnen + bestätigen
ls -la ~/.claude/.credentials.json   # verify
```

Dokumentieren in role's README oder im playbook-Comment.

#### Task 4.5: haex-corp Worker-Container env

In `server/api/projects/[slug]/company/start.post.ts`'s `secretsResolver`:

```ts
const env: Record<string, string> = {
  COMPANY_OPS_TOKEN: opsToken,
  COMPANY_OPS_URL: `${opsUrl}/${slug}`,
  // Route Anthropic API calls through the OAuth-proxy sidecar.
  // Workers see this as a normal HTTPS endpoint — they don't know it's a proxy.
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL ?? "http://claude-oauth-proxy:8080",
};
if (process.env.ANTHROPIC_API_KEY) {
  env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
} else {
  // Even though the proxy ignores auth, hermes refuses to call Anthropic
  // without an API key in env. Provide a placeholder.
  env.ANTHROPIC_API_KEY = "proxy-no-auth-needed";
}
```

#### Task 4.6: Inventory + Playbook

`inventory/haex.cloud.yml`:
```yaml
claude_oauth_proxy:
  image_tag: latest
  ghcr_owner: haexhub
```

`haex.cloud.play.yml`:
```yaml
roles:
  - docker_debian
  - vim_debian
  - ghcr-login
  - traefik
  - claude-oauth-proxy   # ← VOR haex-corp (consumer of)
  - haex-corp
  - portainer
```

#### Task 4.7: Run + verify

```bash
ansible-playbook -i inventory/haex.cloud.yml haex.cloud.play.yml \
  --tags claude-oauth-proxy
ssh haex.cloud "docker logs claude-oauth-proxy 2>&1 | tail -20"
```

E2E: starte eine haex-corp Company, dispatcht einen Task, beobachte:
- Worker-Container-Log: hermes versucht api.anthropic.com (oder unsere proxy?)
- claude-oauth-proxy log: zeigt POST /v1/messages
- haex-corp event log: dispatch-completed mit content vom Claude-Subscription
- console.anthropic.com: zeigt KEINE neue API-Spend (weil OAuth statt API-Key)

**Commit:** `feat(deploy): claude-oauth-proxy ansible role + haex-corp wiring`

---

## Verification Checklist (final)

- [ ] Phase 0 alle Annahmen verifiziert oder Code-Pfade angepasst
- [ ] `node --test test/format.test.js` grün ohne CLAUDE_PROXY_E2E
- [ ] `CLAUDE_PROXY_E2E=1 node --test test/integration.test.js` grün
- [ ] curl smoke gegen `/v1/messages` (sync + streaming) funktioniert mit echter
  Claude-Antwort
- [ ] hermes-agent in Docker mit `ANTHROPIC_BASE_URL=http://claude-oauth-proxy:8080`
  bekommt Antworten ohne API-Key zu verbrauchen
- [ ] Auf haex.cloud deployed: container running, bind-mount ok, healthcheck grün
- [ ] haex-corp dispatch zu echter Worker-Task → claude-oauth-proxy sieht den Call,
  Anthropic-Console zeigt KEINE API-Spend, Claude-Subscription-Usage steigt im
  console.claude.com Dashboard

---

## Critical Risks + Mitigation

| Risk | Likelihood | Mitigation |
|---|---|---|
| Anthropic ändert Bearer-Auth-Mechanism für claude CLI → Proxy bricht | Niedrig (CLI ist offizielles Tool) | Pin a specific `@anthropic-ai/claude-code` version; integration test in CI catches breakage. |
| Claude.ai TOS interpretiert Multi-Agent-Use via OAuth als Verstoß | Niedrig-Mittel (Anthropic vermarktet Claude Code für genau Coding-Agent-Use; aber Multi-Agent-Volumen aus headless servers könnte als unusual flag) | Single-User-Setup, niedriges Volumen (10-100 calls/day). Bei Account-Warning: schnell auf API-Key zurückwechseln (env var change, kein Code). |
| OAuth-Token expires + container kann nicht reauth | Mittel | claude CLI handhabt Refresh — falls Refresh-Token expired (typisch Wochen+), manuell `claude auth login` per SSH neu. Healthz fängt das auf. |
| `--allowed-tools ""` doch nicht ganz Tool-Use disabled | Niedrig | Phase 0 verifizieren: erstes Probe-Run mit Tool-Definition + Erwartung dass tool_use als content-block kommt, nicht ausgeführt wird. |
| Subprocess-Spawn-Overhead bei hohem Volumen → Latenz | Mittel | Phase 3 setzt Limit + Timeout. Falls real ein Issue: long-running claude subprocess via interactive REPL und structured stdin-protocol — aber das ist ein eigener Inkrement (Phase 5). |
| ANTHROPIC_BASE_URL wird von hermes ignoriert | Mittel — muss verifiziert werden | Phase 0 Task 0.3. Fallback: `hermes config set model.base_url` per init im Container. |

---

## Out of Scope (für diese Inkrement)

- **Token-Refresh-Automation**: claude CLI macht das selbst, wir konfigurieren nichts.
- **Multi-User / multi-account proxying**: ein Proxy pro Maschine, ein Account.
- **Persistence der gespawnten claude sessions**: bewusst stateless mit `--no-session-persistence`.
- **OpenAI-format alternative endpoint**: Anthropic-only. Falls nötig, separater Proxy.
- **Tool-Use mit auto-execution**: claude bleibt mit `--allowed-tools ""`. Tools werden vom Caller (hermes) ausgeführt.
- **Cost-tracking / quota-management**: Anthropic-Console zeigt das selbst.

---

## Wie diese Plan in fresh session ausführen

```
Lies diese Plan (docs/plans/2026-04-29-claude-oauth-proxy.md) vollständig.
Check current state in proxies/claude-oauth/.
Mache Phase 0 zuerst — verifiziere alle Format-Annahmen mit echten claude-CLI-Calls.
Dann Phase 1 task-für-task. Commits klein halten.
Stop nach Phase 1 für review-checkpoint.
```

Schätzung gesamt: 12-16h aufgeteilt in 5 Phasen. Empfehlung: Phase 0 + 1 in
einer Session (4-6h), dann Pause + Review. Phase 2-4 als nächste Session(s).
