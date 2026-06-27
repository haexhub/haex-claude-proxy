import test from "node:test";
import assert from "node:assert/strict";

import { acquireHomeLock } from "../src/home-lock.js";

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
