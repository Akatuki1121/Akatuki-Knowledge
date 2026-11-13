import assert from "node:assert/strict";
import { createHash } from "node:crypto";

// scheduler.ts uses only erasable TypeScript syntax, so Node's type
// stripping can import it directly; no build step is needed for this test.
const { PushScheduler } = await import("../plugins/akatuki-vault-push/src/scheduler.ts");

const hash = (text) => createHash("sha256").update(text).digest("hex");

class ManualClock {
  constructor() {
    this.now = 0;
    this.nextId = 1;
    this.timers = new Map();
  }
  setTimer = (fn, ms) => {
    const id = this.nextId++;
    this.timers.set(id, { fn, at: this.now + ms });
    return id;
  };
  clearTimer = (id) => {
    this.timers.delete(id);
  };
  async advance(ms) {
    const target = this.now + ms;
    for (;;) {
      let dueId = null;
      let dueAt = Infinity;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && timer.at < dueAt) { dueId = id; dueAt = timer.at; }
      }
      if (dueId === null) break;
      const timer = this.timers.get(dueId);
      this.timers.delete(dueId);
      this.now = timer.at;
      timer.fn();
      // Let promise continuations run so follow-up timers get scheduled.
      for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
    }
    this.now = target;
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  }
}

function makeScheduler({ sendImpl, debounceMs = 5000, retryDelaysMs = [2000, 8000, 32000] }) {
  const clock = new ManualClock();
  const state = { content: "# Note\n\nv1", sends: [], settled: [], failed: [], reads: 0 };
  const scheduler = new PushScheduler({
    debounceMs,
    retryDelaysMs,
    readContent: async () => { state.reads++; return state.content; },
    hashContent: async (content) => hash(content),
    send: async (path, content, contentHash) => {
      state.sends.push({ path, content, contentHash });
      return sendImpl(state.sends.length);
    },
    onSettled: (path, outcome, reason) => state.settled.push({ path, outcome, reason }),
    onFailed: (path, status) => state.failed.push({ path, status }),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { clock, state, scheduler };
}

const ok = (result) => ({ status: 200, body: { ok: true, result, reason: null } });

// Rapid edits coalesce into one send after the debounce window.
{
  const { clock, state, scheduler } = makeScheduler({ sendImpl: () => ok("applied") });
  scheduler.notifyChanged("Notes/a.md");
  await clock.advance(3000);
  scheduler.notifyChanged("Notes/a.md");
  await clock.advance(3000);
  scheduler.notifyChanged("Notes/a.md");
  await clock.advance(4999);
  assert.equal(state.sends.length, 0, "nothing is sent before the edit settles");
  await clock.advance(1);
  assert.equal(state.sends.length, 1, "settled edits send exactly once");
  assert.deepEqual(state.settled, [{ path: "Notes/a.md", outcome: "applied", reason: null }]);
  scheduler.dispose();
}

// Content the server already accepted is not sent again.
{
  const { clock, state, scheduler } = makeScheduler({ sendImpl: () => ok("unchanged") });
  scheduler.notifyChanged("Notes/a.md");
  await clock.advance(5000);
  assert.equal(state.sends.length, 1);
  scheduler.notifyChanged("Notes/a.md");
  await clock.advance(5000);
  assert.equal(state.reads, 2, "the file is still read to compare hashes");
  assert.equal(state.sends.length, 1, "an identical hash is not resent");
  scheduler.dispose();
}

// A temporary failure is retried after the first delay and then settles.
{
  const { clock, state, scheduler } = makeScheduler({
    sendImpl: (n) => (n === 1 ? { status: 500, body: null } : ok("applied")),
  });
  scheduler.notifyChanged("Notes/a.md");
  await clock.advance(5000);
  assert.equal(state.sends.length, 1);
  await clock.advance(1999);
  assert.equal(state.sends.length, 1, "no retry before the delay passes");
  await clock.advance(1);
  assert.equal(state.sends.length, 2, "the retry goes out after the delay");
  assert.equal(state.settled.length, 1);
  assert.equal(state.failed.length, 0);
  scheduler.dispose();
}

// Retries stop after the configured delays and the failure is reported once.
{
  const { clock, state, scheduler } = makeScheduler({
    sendImpl: () => { throw new Error("network down"); },
  });
  scheduler.notifyChanged("Notes/a.md");
  await clock.advance(5000 + 2000 + 8000 + 32000);
  assert.equal(state.sends.length, 4, "one first attempt plus three retries");
  assert.deepEqual(state.failed, [{ path: "Notes/a.md", status: null }]);
  await clock.advance(60000);
  assert.equal(state.sends.length, 4, "nothing is queued without bound");
  scheduler.dispose();
}

// An authentication failure is never retried.
{
  const { clock, state, scheduler } = makeScheduler({
    sendImpl: () => ({ status: 401, body: { error: "unauthorized" } }),
  });
  scheduler.notifyChanged("Notes/a.md");
  await clock.advance(5000);
  await clock.advance(60000);
  assert.equal(state.sends.length, 1);
  assert.deepEqual(state.failed, [{ path: "Notes/a.md", status: 401 }]);
  scheduler.dispose();
}

// A deferred answer is final for that edit, but the next edit sends again.
{
  const { clock, state, scheduler } = makeScheduler({
    sendImpl: (n) => (n === 1 ? { status: 200, body: { ok: true, result: "deferred", reason: "mapping_missing" } } : ok("applied")),
  });
  scheduler.notifyChanged("Notes/a.md");
  await clock.advance(5000);
  assert.deepEqual(state.settled, [{ path: "Notes/a.md", outcome: "deferred", reason: "mapping_missing" }]);
  state.content = "# Note\n\nv2";
  scheduler.notifyChanged("Notes/a.md");
  await clock.advance(5000);
  assert.equal(state.sends.length, 2, "a deferred hash is not recorded as accepted");
  assert.equal(state.settled.at(-1).outcome, "applied");
  scheduler.dispose();
}

console.log("test-vault-push-plugin: all assertions passed");
