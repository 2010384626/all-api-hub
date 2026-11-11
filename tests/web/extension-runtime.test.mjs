import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"

import {
  createBrowserRuntime,
  RuntimeLocks,
} from "../../web/runtime/browser.mjs"
import {
  createExtensionRuntime,
  ExtensionEventBuffer,
} from "../../web/server/extension-runtime.mjs"
import { Store } from "../../web/server/store.mjs"

test("storage implements Chrome callback + promise semantics and preserves committed state on failed writes", async () => {
  let disk = {},
    fail = false
  const events = []
  const runtime = createBrowserRuntime({
    persist: async (state) => {
      if (fail) throw new Error("disk full")
      disk = structuredClone(state)
    },
    emit: (...args) => events.push(args),
  })
  await runtime.browser.storage.local.set({ stable: "original" })
  await new Promise((resolve) =>
    runtime.browser.storage.local.get(
      { stable: "fallback", other: 1 },
      (data) => {
        assert.deepEqual(data, { stable: "original", other: 1 })
        resolve()
      },
    ),
  )
  fail = true
  await assert.rejects(
    runtime.browser.storage.local.set({ stable: "lost" }),
    /disk full/,
  )
  assert.equal(disk.local.stable, "original")
  fail = false
  await runtime.browser.storage.local.set({ recovered: true })
  assert.deepEqual(await runtime.browser.storage.local.get(null), {
    stable: "original",
    recovered: true,
  })
  assert.equal(events.length, 2)
  await runtime.browser.storage.session.set({ transient: "secret" })
  assert.equal(disk.session, undefined)
  await runtime.close()
})

test("shared UI lock serializes against background and expires when client disappears", async () => {
  let now = 0
  const locks = new RuntimeLocks({ now: () => now, leaseMs: 50 })
  const first = await locks.acquire(
    "all-api-hub:accounts",
    "session-123:client-123",
  )
  let ran = false
  const background = locks.request("all-api-hub:accounts", {}, async () => {
    ran = true
  })
  await delay(2)
  assert.equal(ran, false)
  assert.throws(() => locks.release(first.id, "another-client"), /其他客户端/)
  now = 60
  locks.expire()
  await background
  assert.equal(ran, true)
  const next = await locks.acquire(
    "all-api-hub:accounts",
    "session-123:client-123",
  )
  locks.releaseClient("session-123")
  assert.equal(locks.leases.has(next.id), false)
})

test("original asynchronous runtime messages resolve callbacks, reject unavailable browser actions, and emit events", async () => {
  const events = []
  const runtime = createBrowserRuntime({
    persist: async () => {},
    emit: (...args) => events.push(args),
  })
  runtime.browser.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message.action !== "fixture") return
    setImmediate(() => respond({ success: true, count: message.count }))
    return true
  })
  assert.deepEqual(
    await runtime.call("runtime.sendMessage", [
      { action: "fixture", count: 7 },
    ]),
    { success: true, count: 7 },
  )
  assert.equal(events[0][0], "runtime.onMessage")
  await assert.rejects(
    runtime.call("tabs.create", [{ url: "https://example.com" }]),
    /本机浏览器扩展/,
  )
  await assert.rejects(runtime.call("runtime.constructor", []), /不支持/)
  await runtime.close()
})

test("alarms persist, fire, and remove one-shot state without a browser", async () => {
  let state
  const runtime = createBrowserRuntime({
    persist: async (next) => {
      state = structuredClone(next)
    },
  })
  const fired = new Promise((resolve) =>
    runtime.browser.alarms.onAlarm.addListener(resolve),
  )
  await runtime.browser.alarms.create("daily-fixture", {
    when: Date.now() + 20,
  })
  assert.ok(state.alarms["daily-fixture"])
  const alarm = await Promise.race([
    fired,
    delay(1000).then(() => {
      throw new Error("alarm did not fire")
    }),
  ])
  assert.equal(alarm.name, "daily-fixture")
  assert.equal(state.alarms["daily-fixture"], undefined)
  await runtime.close()
})

test("event cursor reports dropped history so clients can reload state", () => {
  const events = new ExtensionEventBuffer(2)
  events.push("one", [])
  events.push("two", [])
  events.push("three", [])
  assert.equal(events.since(0).reset, true)
  assert.deepEqual(
    events.since(2).events.map((event) => event.event),
    ["three"],
  )
  assert.throws(() => events.since(-1))
})

test("isolated Node worker persists encrypted original storage and sends requests through supplied transport", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "aah-node-runtime-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const bundlePath = path.join(directory, "fixture.mjs")
  await writeFile(
    bundlePath,
    `export async function initialize() {
    browser.runtime.onMessage.addListener((message, sender, respond) => {
      if (message.action !== 'fixture-fetch') return;
      fetch('https://relay.example/v1/models', {headers:{Authorization:'Bearer fixture-key'}}).then(r=>r.json()).then(respond); return true;
    });
  }`,
  )
  const store = new Store(directory, "ab".repeat(32)),
    requests = []
  await store.mutate((state) => {
    state.extensionState = { local: { original: "restored" }, sync: {} }
  })
  const runtime = await createExtensionRuntime({
    store,
    bundlePath,
    extensionPath: directory,
    fetchImpl: async (url, init) => {
      requests.push({ url, init })
      return Response.json({ data: [{ id: "fixture-model" }] })
    },
  })
  try {
    assert.deepEqual(await runtime.call("storage.local.get", ["original"]), {
      original: "restored",
    })
    await runtime.call("storage.local.set", [
      { secret: "persisted-only-encrypted" },
    ])
    assert.equal(
      (await store.read()).extensionState.local.secret,
      "persisted-only-encrypted",
    )
    assert.equal(
      (await readFile(store.file)).includes("persisted-only-encrypted"),
      false,
    )
    const result = await runtime.call("runtime.sendMessage", [
      { action: "fixture-fetch" },
    ])
    assert.equal(result.data[0].id, "fixture-model")
    assert.equal(requests.length, 1)
    assert.equal(
      new Headers(requests[0].init.headers).get("authorization"),
      "Bearer fixture-key",
    )
    const lock = await runtime.acquireLock(
      "all-api-hub:test",
      "a".repeat(64) + ":client-123",
    )
    await runtime.releaseLock(lock.id, "a".repeat(64) + ":client-123")
    assert.ok(
      runtime
        .events(0, "client-123")
        .events.some((e) => e.event === "storage.onChanged"),
    )
    assert.equal(runtime.failed, false)
  } finally {
    await runtime.close()
  }
})
