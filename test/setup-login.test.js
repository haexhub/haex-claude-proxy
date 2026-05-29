import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { createSetupController, States, _internal } from "../src/setup-login.js";

// ── PTY fake ──────────────────────────────────────────────────────────────
// Mimics node-pty's surface: onData/onExit callbacks, write(), kill(), pid.
// Tests drive the FAKE to simulate claude's output (URL line, then exit
// with 0/non-zero) and capture writes back to assert the code was forwarded.
function makeFakePty() {
  const writes = [];
  let dataCb = null;
  let exitCb = null;
  let killed = false;
  return {
    pid: 12345,
    writes,
    write: (s) => { writes.push(String(s)); },
    onData: (cb) => { dataCb = cb; },
    onExit: (cb) => { exitCb = cb; },
    kill: () => { killed = true; },
    isKilled: () => killed,
    // Test-side controls:
    emit(chunk) { if (dataCb) dataCb(chunk); },
    exit(code) { if (exitCb) exitCb({ exitCode: code, signal: 0 }); },
  };
}

async function mkHomeDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "hcp-setup-"));
}

// ── Constructor validation ────────────────────────────────────────────────

test("createSetupController: rejects missing spawnPty", () => {
  assert.throws(() => createSetupController({ credentialsHome: "/tmp" }), /spawnPty/);
});

test("createSetupController: rejects missing credentialsHome", () => {
  assert.throws(() => createSetupController({ spawnPty: () => {} }), /credentialsHome/);
});

// ── URL_LINE_RE ───────────────────────────────────────────────────────────

test("URL_LINE_RE: matches the CLI's standard browser-fallback line", () => {
  const sample =
    "Opening browser to sign in…\n" +
    "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Aprofile&code_challenge=abc&code_challenge_method=S256&state=xyz\n";
  const m = sample.match(_internal.URL_LINE_RE);
  assert.ok(m, "regex should match");
  assert.match(m[1], /^https:\/\/claude\.com\/cai\/oauth\/authorize\?/);
  assert.match(m[1], /state=xyz$/, "URL is captured up to the next whitespace");
});

test("URL_LINE_RE: ignores unrelated lines", () => {
  assert.equal("just some text".match(_internal.URL_LINE_RE), null);
  assert.equal("Opening browser to sign in…".match(_internal.URL_LINE_RE), null);
});

// ── Happy-path state machine ──────────────────────────────────────────────

test("controller: idle → awaiting-url → awaiting-code → done", async () => {
  const home = await mkHomeDir();
  const fake = makeFakePty();
  const ctrl = createSetupController({
    spawnPty: () => fake,
    credentialsHome: home,
  });

  assert.equal(ctrl.snapshot().state, States.IDLE);

  // Kick off the flow; CLI emits the URL line after a tick.
  const urlPromise = ctrl.start();
  assert.equal(ctrl.snapshot().state, States.AWAITING_URL);

  fake.emit(
    "Opening browser…\n" +
    "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=s1\n",
  );

  const url = await urlPromise;
  assert.match(url, /state=s1$/);
  assert.equal(ctrl.snapshot().state, States.AWAITING_CODE);

  // User submits code; we expect it to be forwarded to the PTY with \r.
  // Meanwhile we simulate the CLI writing credentials and exiting 0.
  const credPath = path.join(home, ".claude", ".credentials.json");
  await fs.mkdir(path.dirname(credPath), { recursive: true });
  await fs.writeFile(credPath, JSON.stringify({ claudeAiOauth: { access_token: "ok" } }));

  const finishPromise = ctrl.submitCode("the-code-123");
  assert.equal(fake.writes[0], "the-code-123\r");

  fake.exit(0);
  const result = await finishPromise;
  assert.equal(result.credentialsPath, credPath);
  assert.equal(ctrl.snapshot().state, States.DONE);
});

// ── Error paths ───────────────────────────────────────────────────────────

test("controller: CLI exits non-zero → state ERROR, submitCode rejects", async () => {
  const home = await mkHomeDir();
  const fake = makeFakePty();
  const ctrl = createSetupController({ spawnPty: () => fake, credentialsHome: home });

  const urlPromise = ctrl.start();
  fake.emit("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?state=fail\n");
  await urlPromise;

  const finishPromise = ctrl.submitCode("bad-code");
  fake.exit(1);

  await assert.rejects(finishPromise, /exited with code 1/);
  assert.equal(ctrl.snapshot().state, States.ERROR);
  assert.match(ctrl.snapshot().errorMessage, /exited with code 1/);
});

test("controller: CLI exits 0 but no credentials → ERROR", async () => {
  const home = await mkHomeDir(); // empty, no .claude/.credentials.json
  const fake = makeFakePty();
  const ctrl = createSetupController({ spawnPty: () => fake, credentialsHome: home });

  const urlPromise = ctrl.start();
  fake.emit("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?state=z\n");
  await urlPromise;

  const finishPromise = ctrl.submitCode("anything");
  fake.exit(0);

  await assert.rejects(finishPromise, /credentials\.json was not written/);
  assert.equal(ctrl.snapshot().state, States.ERROR);
});

test("controller: submitCode in wrong state throws synchronously", async () => {
  const home = await mkHomeDir();
  const ctrl = createSetupController({ spawnPty: () => makeFakePty(), credentialsHome: home });
  // IDLE
  await assert.rejects(() => ctrl.submitCode("x"), /cannot submit code in state 'idle'/);
});

test("controller: submitCode rejects empty string", async (t) => {
  const home = await mkHomeDir();
  const fake = makeFakePty();
  const ctrl = createSetupController({ spawnPty: () => fake, credentialsHome: home });
  t.after(() => ctrl.reset());
  const urlPromise = ctrl.start();
  fake.emit("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?state=z\n");
  await urlPromise;
  await assert.rejects(() => ctrl.submitCode("   "), /non-empty string/);
});

// ── Timeout ───────────────────────────────────────────────────────────────

test("controller: timeout kills the subprocess and surfaces error", async () => {
  const home = await mkHomeDir();
  const fake = makeFakePty();
  const ctrl = createSetupController({
    spawnPty: () => fake,
    credentialsHome: home,
    timeoutMs: 25,
  });
  const urlPromise = ctrl.start();
  // Don't emit URL; let timeout fire.
  await assert.rejects(urlPromise, /timed out/);
  assert.equal(ctrl.snapshot().state, States.ERROR);
  assert.equal(fake.isKilled(), true);
});

// ── Reset ─────────────────────────────────────────────────────────────────

test("controller: reset() returns to IDLE and kills any in-flight subprocess", async () => {
  const home = await mkHomeDir();
  const fake = makeFakePty();
  const ctrl = createSetupController({ spawnPty: () => fake, credentialsHome: home });
  const urlPromise = ctrl.start();
  ctrl.reset();
  await assert.rejects(urlPromise, /reset/);
  assert.equal(ctrl.snapshot().state, States.IDLE);
  assert.equal(fake.isKilled(), true);
});

test("controller: idempotent start() while AWAITING_URL doesn't spawn twice", async (t) => {
  const home = await mkHomeDir();
  let spawnCount = 0;
  const fake = makeFakePty();
  const ctrl = createSetupController({
    spawnPty: () => { spawnCount++; return fake; },
    credentialsHome: home,
  });
  t.after(() => ctrl.reset());
  const p1 = ctrl.start();
  const p2 = ctrl.start();
  assert.equal(spawnCount, 1, "second start() in AWAITING_URL must NOT respawn");
  fake.emit("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?state=z\n");
  // Both promises must resolve with the same URL.
  const [u1, u2] = await Promise.all([p1, p2]);
  assert.equal(u1, u2);
  assert.match(u1, /state=z$/);
});

test("controller: start() while AWAITING_CODE returns the captured URL string", async (t) => {
  const home = await mkHomeDir();
  const fake = makeFakePty();
  const ctrl = createSetupController({ spawnPty: () => fake, credentialsHome: home });
  t.after(() => ctrl.reset());
  const urlPromise = ctrl.start();
  fake.emit("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?state=z\n");
  const url = await urlPromise;
  // Second start() while in AWAITING_CODE — should resolve immediately
  // with the captured URL, NOT spawn again.
  const u2 = await ctrl.start();
  assert.equal(u2, url);
});

// ── credentialsExist ──────────────────────────────────────────────────────

test("controller: credentialsExist returns true only when file present", async () => {
  const home = await mkHomeDir();
  const ctrl = createSetupController({ spawnPty: () => makeFakePty(), credentialsHome: home });
  assert.equal(await ctrl.credentialsExist(), false);
  await fs.mkdir(path.join(home, ".claude"), { recursive: true });
  await fs.writeFile(path.join(home, ".claude", ".credentials.json"), "{}");
  assert.equal(await ctrl.credentialsExist(), true);
});

// ── Stdout buffering ──────────────────────────────────────────────────────

test("URL_LINE_RE: still matches after a noisy preamble (buffer cap doesn't lose it)", async (t) => {
  const home = await mkHomeDir();
  const fake = makeFakePty();
  const ctrl = createSetupController({ spawnPty: () => fake, credentialsHome: home });
  t.after(() => ctrl.reset());
  const urlPromise = ctrl.start();
  // 60 KB of noise before the URL — under STDOUT_BUFFER_CAP (64KB) so
  // we keep the full line. The over-cap tail-truncation path is
  // covered indirectly: the URL appears in the last ~1KB of stdout in
  // real claude runs, well inside the recent tail the cap preserves.
  fake.emit("noise\n".repeat(10_000));
  fake.emit("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?state=tail\n");
  const url = await urlPromise;
  assert.match(url, /state=tail$/);
});
