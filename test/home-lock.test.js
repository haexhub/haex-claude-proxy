import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { acquireHomeLock, acquireHomeLockIfStale, isAccessTokenFresh } from "../src/home-lock.js";

async function makeHome(creds) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hcp-lock-"));
  if (creds !== undefined) {
    await fs.mkdir(path.join(dir, ".claude"), { recursive: true });
    await fs.writeFile(path.join(dir, ".claude", ".credentials.json"), creds, "utf8");
  }
  return dir;
}

test("acquireHomeLock: a single caller gets the lock immediately", async () => {
  const release = await acquireHomeLock("/home/a");
  assert.equal(typeof release, "function");
  release();
});

test("acquireHomeLock: second caller for the same home waits for the first to release", async () => {
  const order = [];

  const release1 = await acquireHomeLock("/home/shared");

  let secondReady = false;
  const second = acquireHomeLock("/home/shared").then((release2) => {
    secondReady = true;
    order.push("second-acquired");
    release2();
  });

  // Give the event loop a beat — second must NOT have resolved yet.
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(secondReady, false, "second caller must not acquire before first releases");

  order.push("first-releases");
  release1();
  await second;

  assert.deepEqual(order, ["first-releases", "second-acquired"]);
});

test("acquireHomeLock: callers for different homes never block each other", async () => {
  const releaseA = await acquireHomeLock("/home/a2");
  let bReady = false;
  const b = acquireHomeLock("/home/b2").then((releaseB) => {
    bReady = true;
    releaseB();
  });
  await b;
  assert.equal(bReady, true, "different home must not wait on /home/a2's holder");
  releaseA();
});

test("acquireHomeLock: three queued callers run strictly in FIFO order", async () => {
  const order = [];

  async function task(n, holdMs) {
    const release = await acquireHomeLock("/home/fifo");
    order.push(`start-${n}`);
    await new Promise((r) => setTimeout(r, holdMs));
    order.push(`end-${n}`);
    release();
  }

  // Start all three back-to-back; each should fully run before the next starts.
  await Promise.all([task(1, 15), task(2, 5), task(3, 1)]);

  assert.deepEqual(order, ["start-1", "end-1", "start-2", "end-2", "start-3", "end-3"]);
});

test("acquireHomeLock: a held lock for one home doesn't starve a brand-new home queue", async () => {
  // Regression guard: the per-home tail must not leak into unrelated homes.
  const releaseHeld = await acquireHomeLock("/home/held-forever");
  const release = await acquireHomeLock("/home/fresh");
  release();
  releaseHeld();
});

test("isAccessTokenFresh: true when expiresAt is well past the safety margin", async () => {
  const now = () => 1_000_000;
  const home = await makeHome(JSON.stringify({ claudeAiOauth: { expiresAt: now() + 20 * 60 * 1000 } }));
  assert.equal(await isAccessTokenFresh(home, { now, marginMs: 15 * 60 * 1000 }), true);
});

test("isAccessTokenFresh: false when expiresAt is within the safety margin", async () => {
  const now = () => 1_000_000;
  const home = await makeHome(JSON.stringify({ claudeAiOauth: { expiresAt: now() + 5 * 60 * 1000 } }));
  assert.equal(await isAccessTokenFresh(home, { now, marginMs: 15 * 60 * 1000 }), false);
});

test("isAccessTokenFresh: false when the token already expired", async () => {
  const now = () => 1_000_000;
  const home = await makeHome(JSON.stringify({ claudeAiOauth: { expiresAt: now() - 1000 } }));
  assert.equal(await isAccessTokenFresh(home, { now }), false);
});

test("isAccessTokenFresh: false when credentials.json is missing", async () => {
  const home = await makeHome(undefined);
  assert.equal(await isAccessTokenFresh(home), false);
});

test("isAccessTokenFresh: false when credentials.json is malformed", async () => {
  const home = await makeHome("not json");
  assert.equal(await isAccessTokenFresh(home), false);
});

test("isAccessTokenFresh: false when expiresAt is missing or not a number", async () => {
  const home = await makeHome(JSON.stringify({ claudeAiOauth: {} }));
  assert.equal(await isAccessTokenFresh(home), false);
});

test("acquireHomeLockIfStale: fresh token — concurrent callers never queue behind each other", async () => {
  const now = () => 1_000_000;
  const home = await makeHome(JSON.stringify({ claudeAiOauth: { expiresAt: now() + 60 * 60 * 1000 } }));

  const releaseA = await acquireHomeLockIfStale(home, { now });
  let bReady = false;
  const b = acquireHomeLockIfStale(home, { now }).then((releaseB) => {
    bReady = true;
    releaseB();
  });
  await b;
  assert.equal(bReady, true, "fresh-token callers must run concurrently, not queue");
  releaseA();
});

test("acquireHomeLockIfStale: stale token — falls back to full serialization", async () => {
  const now = () => 1_000_000;
  const home = await makeHome(JSON.stringify({ claudeAiOauth: { expiresAt: now() - 1000 } }));

  const releaseA = await acquireHomeLockIfStale(home, { now });
  let bReady = false;
  const b = acquireHomeLockIfStale(home, { now }).then((releaseB) => {
    bReady = true;
    releaseB();
  });

  await new Promise((r) => setTimeout(r, 10));
  assert.equal(bReady, false, "stale-token second caller must wait for the first to release");

  releaseA();
  await b;
  assert.equal(bReady, true);
});
