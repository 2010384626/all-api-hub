import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import { createApp } from "../../web/server/app.mjs"
import { createExtensionRuntime } from "../../web/server/extension-runtime.mjs"

const password = "native-http-fixture-password"
const origin = "https://hub.example.com"

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "aah-native-http-"))
  const assets = path.join(directory, "assets")
  await mkdir(assets)
  await writeFile(
    path.join(assets, "options.html"),
    "<!doctype html><title>Fixture</title>",
  )
  const bundlePath = path.join(directory, "background.mjs")
  await writeFile(bundlePath, "export async function initialize() {}")
  const requests = []
  const app = await createApp({
    env: {
      ADMIN_PASSWORD: password,
      ENCRYPTION_KEY: "12".repeat(32),
      DATA_DIR: directory,
      PUBLIC_ORIGIN: origin,
      BASE_PATH: "/hub/",
    },
    nativeDirectory: assets,
    runtimeFactory: (options) =>
      createExtensionRuntime({ ...options, extensionPath: assets, bundlePath }),
    fetchImpl: async (url, init) => {
      requests.push({ url, init })
      return new Response("upstream", {
        status: 429,
        headers: { "retry-after": "15", "content-type": "text/plain" },
      })
    },
  })
  const server = createServer(app.handler)
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = `http://127.0.0.1:${server.address().port}/hub/`
  const request = (
    route,
    {
      session,
      method = "GET",
      body,
      headers = {},
      client = "fixture-client-123",
    } = {},
  ) =>
    fetch(address + route, {
      method,
      headers: {
        ...(session
          ? { cookie: session.cookie, "x-csrf-token": session.csrf }
          : {}),
        "x-aah-client": client,
        origin,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  const login = async () => {
    const result = await request("api/login", {
      method: "POST",
      body: { password },
    })
    assert.equal(result.status, 200)
    return {
      cookie: result.headers.get("set-cookie").split(";")[0],
      csrf: (await result.json()).csrfToken,
    }
  }
  t.after(async () => {
    await app.close()
    await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  })
  return { app, request, login, requests, directory }
}

test("native HTTP APIs enforce login, CSRF, origin, client identifiers and method allowlist", async (t) => {
  const f = await fixture(t)
  const call = { path: "storage.local.set", args: [{ private: "value" }] }
  assert.equal((await f.request("api/extension/bootstrap")).status, 401)
  assert.equal((await f.request("options.html")).status, 401)
  const session = await f.login()
  assert.equal(
    (await f.request("api/extension/bootstrap", { session, client: "" }))
      .status,
    400,
  )
  assert.equal(
    (
      await f.request("api/extension/bootstrap", {
        session,
        client: "bad:client",
      })
    ).status,
    400,
  )
  const bootstrap = await f.request("api/extension/bootstrap", { session })
  assert.equal(bootstrap.status, 200)
  assert.equal((await bootstrap.json()).id, "all-api-hub-web")
  assert.equal((await f.request("options.html", { session })).status, 200)
  assert.equal(
    (
      await f.request("api/extension/call", {
        session,
        method: "POST",
        body: call,
        headers: { "x-csrf-token": "wrong" },
      })
    ).status,
    403,
  )
  assert.equal(
    (
      await f.request("api/extension/call", {
        session,
        method: "POST",
        body: call,
        headers: { origin: "https://attacker.example" },
      })
    ).status,
    403,
  )
  assert.equal(
    (
      await f.request("api/extension/call", {
        session,
        method: "POST",
        body: { path: "runtime.constructor", args: [] },
      })
    ).status,
    400,
  )
  assert.equal(
    (
      await f.request("api/extension/call", {
        session,
        method: "POST",
        body: { path: "__proto__.constructor", args: [] },
      })
    ).status,
    400,
  )
  assert.equal(
    (
      await f.request("api/extension/call", {
        session,
        method: "POST",
        body: { path: "storage.local.get", args: "all" },
      })
    ).status,
    400,
  )
  assert.equal(
    (await f.request("api/extension/events?after=-1", { session })).status,
    400,
  )
  assert.equal(
    (
      await f.request("api/extension/call", {
        session,
        method: "POST",
        body: { path: "tabs.create", args: [{ url: "https://example.com" }] },
      })
    ).status,
    400,
  )
})

test("native HTTP writes preserve shared encrypted storage and accept backup-sized call payloads", async (t) => {
  const f = await fixture(t),
    first = await f.login(),
    second = await f.login()
  const secret = "native-http-private-secret"
  const value = { apiKey: secret, notes: "x".repeat(1024 * 1024 + 128) }
  const saved = await f.request("api/extension/call", {
    session: first,
    method: "POST",
    body: { path: "storage.local.set", args: [{ imported: value }] },
  })
  assert.equal(saved.status, 200)
  const read = await f.request("api/extension/call", {
    session: second,
    method: "POST",
    body: { path: "storage.local.get", args: ["imported"] },
  })
  assert.equal((await read.json()).value.imported.apiKey, secret)
  assert.equal(
    (await f.app.store.read()).extensionState.local.imported.notes.length,
    value.notes.length,
  )
  assert.equal(
    (await readFile(path.join(f.directory, "state.enc"))).includes(secret),
    false,
  )
  const events = await (
    await f.request("api/extension/events?after=0", { session: second })
  ).json()
  assert.ok(events.events.some((event) => event.event === "storage.onChanged"))
  const rejected = await f.request("api/extension/call", {
    session: first,
    method: "POST",
    body: {
      path: "storage.local.set",
      args: [{ tooLarge: "y".repeat(16 * 1024 * 1024) }],
    },
  })
  assert.equal(rejected.status, 413)
  assert.equal(
    (await f.app.store.read()).extensionState.local.tooLarge,
    undefined,
  )
})

test("native HTTP lock ownership includes login session and logout releases the client lease", async (t) => {
  const f = await fixture(t),
    first = await f.login(),
    second = await f.login()
  const acquired = await f.request("api/extension/lock/acquire", {
    session: first,
    method: "POST",
    body: { name: "all-api-hub:fixture" },
  })
  assert.equal(acquired.status, 200)
  const { id } = await acquired.json()
  const wrongOwner = await f.request("api/extension/lock/release", {
    session: second,
    method: "POST",
    body: { id },
  })
  assert.equal(wrongOwner.status, 403)
  assert.equal(
    (await f.request("api/logout", { session: first, method: "POST" })).status,
    200,
  )
  assert.equal(
    (await f.request("api/extension/bootstrap", { session: first })).status,
    401,
  )
  const next = await f.request("api/extension/lock/acquire", {
    session: second,
    method: "POST",
    body: { name: "all-api-hub:fixture" },
  })
  assert.equal(next.status, 200)
  await f.request("api/extension/lock/release", {
    session: second,
    method: "POST",
    body: { id: (await next.json()).id },
  })
})

test("native HTTP request proxy preserves response semantics while removing framing headers", async (t) => {
  const f = await fixture(t),
    session = await f.login()
  const response = await f.request("api/extension/fetch", {
    session,
    method: "POST",
    body: {
      url: "https://relay.example/api/user/self",
      method: "POST",
      headers: {
        Cookie: "session=private",
        "User-Agent": "custom-cli",
        Host: "localhost",
        Connection: "keep-alive",
        "Content-Length": "999",
      },
      bodyBase64: Buffer.from('{"probe":true}').toString("base64"),
    },
  })
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal(result.status, 429)
  assert.equal(result.headers["retry-after"], "15")
  assert.equal(Buffer.from(result.bodyBase64, "base64").toString(), "upstream")
  assert.equal(f.requests[0].init.headers.get("host"), null)
  assert.equal(f.requests[0].init.headers.get("content-length"), null)
  assert.equal(f.requests[0].init.headers.get("cookie"), "session=private")
  assert.equal(f.requests[0].init.headers.get("user-agent"), "custom-cli")
})
