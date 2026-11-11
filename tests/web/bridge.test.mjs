import assert from "node:assert/strict"
import test from "node:test"

import { installWebBridge } from "../../web/client/bridge.mjs"

function fixture(respond = () => ({ value: undefined })) {
  const calls = [],
    timers = [],
    pageEvents = new Map()
  const target = {
    fetch: async (url, init) => {
      calls.push({ url: String(url), init })
      return Response.json(await respond(String(url), init))
    },
    crypto,
    btoa,
    atob,
    navigator: { language: "en-US" },
    location: {
      href: "https://hub.example/hub/options.html",
      replace(value) {
        this.redirect = value
      },
      assign() {},
      reload() {},
    },
    setTimeout: (callback) => {
      timers.push(callback)
      return timers.length
    },
    clearTimeout() {},
    addEventListener: (name, callback) => pageEvents.set(name, callback),
    console,
  }
  const installed = installWebBridge({
    baseUrl: "https://hub.example/hub/",
    manifest: { version: "4.9.0", manifest_version: 3 },
    id: "aah-vps",
    csrfToken: "csrf-test",
    target,
  })
  return { ...installed, target, calls, timers, pageEvents }
}

test("original storage works with promise and Chrome callback signatures without local copies", async () => {
  const f = fixture(() => ({ value: { accounts: "server-storage" } }))
  assert.equal(f.target.browser, f.target.chrome)
  assert.equal(
    f.browser.runtime.getURL("locales/en/ui.json"),
    "https://hub.example/hub/locales/en/ui.json",
  )
  assert.equal(f.browser.runtime.getManifest().version, "4.9.0")
  assert.deepEqual(await f.browser.storage.local.get("accounts"), {
    accounts: "server-storage",
  })
  assert.deepEqual(
    await new Promise((resolve) =>
      f.browser.storage.local.get("accounts", resolve),
    ),
    { accounts: "server-storage" },
  )
  assert.deepEqual(JSON.parse(f.calls[0].init.body), {
    path: "storage.local.get",
    args: ["accounts"],
  })
  assert.equal(f.calls[0].init.headers["x-csrf-token"], "csrf-test")
})

test("shared locks remain held across reads and writes and release on callback failure", async () => {
  const f = fixture((url) => (url.includes("acquire") ? { id: "lock-1" } : {}))
  await assert.rejects(
    f.target.navigator.locks.request(
      "all-api-hub:account-storage",
      async () => {
        assert.equal(f.calls.length, 1)
        throw new Error("save failed")
      },
    ),
    /save failed/,
  )
  assert.match(f.calls[1].url, /lock\/release$/)
  assert.equal(JSON.parse(f.calls[1].init.body).id, "lock-1")
})

test("upstream requests use authenticated transport preserving headers and binary payload", async () => {
  const f = fixture(() => ({
    status: 200,
    headers: { "content-type": "application/json" },
    bodyBase64: btoa('{"ok":true}'),
  }))
  const response = await f.target.fetch("https://relay.example/v1/messages", {
    method: "POST",
    headers: { "x-api-key": "fixture-secret" },
    body: "hello",
  })
  assert.deepEqual(await response.json(), { ok: true })
  const sent = JSON.parse(f.calls[0].init.body)
  assert.equal(sent.url, "https://relay.example/v1/messages")
  assert.equal(sent.headers["x-api-key"], "fixture-secret")
  assert.equal(atob(sent.bodyBase64), "hello")
  await f.target.fetch("https://hub.example/hub/locales/en/ui.json")
  assert.match(f.calls[1].url, /locales\/en\/ui.json$/)
})

test("storage and runtime events reach original UI subscriptions", async () => {
  const change = { accounts: { oldValue: "[]", newValue: "[1]" } }
  const f = fixture(() => ({
    cursor: 2,
    events: [
      { id: 1, event: "storage.onChanged", args: [change, "local"] },
      {
        id: 2,
        event: "runtime.onMessage",
        args: [{ action: "finished" }, { id: "aah-vps" }],
      },
    ],
  }))
  const received = []
  f.browser.storage.onChanged.addListener((...args) => received.push(args))
  f.browser.runtime.onMessage.addListener((message, sender, reply) => {
    received.push([message, sender])
    assert.equal(typeof reply, "function")
  })
  await f.timers.shift()()
  assert.deepEqual(received[0], [change, "local"])
  assert.equal(received[1][0].action, "finished")
  f.dispose()
})
