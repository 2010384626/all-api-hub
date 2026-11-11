import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createServer, request } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"

import {
  listKeys,
  parseImport,
  refreshAccount,
  validateAccount,
} from "../../web/server/accounts.mjs"
import { createApp } from "../../web/server/app.mjs"
import * as network from "../../web/server/network.mjs"
import { Store } from "../../web/server/store.mjs"

const credential = {
  name: "Fixture",
  siteType: "new-api",
  baseUrl: "https://api.example.com",
  token: "private-fixture-token",
  userId: "42",
}
const extensionAccount = {
  site_name: "Fixture",
  site_type: "new-api",
  site_url: credential.baseUrl,
  account_info: { access_token: credential.token, id: 42 },
}

async function harness(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "aah-security-"))
  const env = {
    ADMIN_PASSWORD: "a-very-long-test-password",
    ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    DATA_DIR: directory,
    PUBLIC_ORIGIN: "https://hub.example.com",
    BASE_PATH: "/hub/",
  }
  const app = await createApp({ env, ...options })
  const admitted = []
  const server = createServer((req, res) => {
    void app.handler(req, res)
    admitted.push(req.url)
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  })
  const address = `http://127.0.0.1:${server.address().port}/hub/`
  let session
  const call = async (
    route,
    { method = "GET", body, headers = {}, auth = session } = {},
  ) => {
    const response = await fetch(address + route, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        origin: env.PUBLIC_ORIGIN,
        ...(auth ? { cookie: auth.cookie, "x-csrf-token": auth.csrf } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return {
      status: response.status,
      body: await response.json(),
      headers: response.headers,
    }
  }
  const login = async () => {
    const result = await call("api/login", {
      method: "POST",
      body: { password: env.ADMIN_PASSWORD },
      auth: null,
    })
    assert.equal(result.status, 200)
    return {
      cookie: result.headers.get("set-cookie").split(";")[0],
      csrf: result.body.csrfToken,
    }
  }
  session = await login()
  return { app, env, directory, call, login, session, address, admitted }
}

test("address policy denies private, encoded IPv4, mapped IPv4 and non-global IPv6", () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "fec0::1",
    "64:ff9b:1::a00:1",
  ]) {
    assert.equal(network.isPublicAddress(address), false, address)
  }
  for (const address of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"])
    assert.equal(network.isPublicAddress(address), true, address)
  for (const url of [
    "http://api.example.com",
    "https://a:b@api.example.com",
    "https://localhost",
    "https://thing.localhost",
    "https://api.example.com/#x",
  ]) {
    assert.throws(() => network.validateUrl(url))
  }
  assert.equal(
    network.isPublicAddress(network.validateUrl("https://2130706433").hostname),
    false,
  )
})

test("network resolves once, pins checked address, rejects redirects and mixed DNS results offline", async () => {
  assert.equal(
    typeof network.createSafeFetch,
    "function",
    "Network needs injectable transport for offline socket-policy verification",
  )
  let dnsCalls = 0,
    closed = 0,
    requests = 0,
    chosen,
    response = Response.json({ ok: true })
  let answers = [
    { address: "1.1.1.1", family: 4 },
    { address: "8.8.8.8", family: 4 },
  ]
  class Agent {
    constructor(options) {
      this.options = options
    }
    async close() {
      closed++
    }
  }
  const safeFetch = network.createSafeFetch({
    lookupImpl: async () => {
      dnsCalls++
      return answers
    },
    AgentImpl: Agent,
    fetchImpl: async (_url, init) => {
      requests++
      assert.equal(init.redirect, "manual")
      init.dispatcher.options.connect.lookup(
        "attacker.example.com",
        { all: true },
        (error, values) => {
          assert.equal(error, null)
          chosen = values
        },
      )
      return response
    },
  })
  assert.equal((await safeFetch("https://api.example.com")).status, 200)
  assert.equal(dnsCalls, 1)
  assert.deepEqual(chosen, [{ address: "1.1.1.1", family: 4 }])
  assert.equal(closed, 1)
  response = new Response(null, {
    status: 302,
    headers: { location: "http://169.254.169.254/latest/meta-data/" },
  })
  await assert.rejects(safeFetch("https://api.example.com"), /重定向/)
  assert.equal(requests, 2)
  assert.equal(closed, 2)
  answers = [
    { address: "1.1.1.1", family: 4 },
    { address: "127.0.0.1", family: 4 },
  ]
  await assert.rejects(safeFetch("https://api.example.com"), /内网|保留/)
  assert.equal(requests, 2)
})

test("cancellation bounds DNS lookup before opening a socket", async () => {
  const controller = new AbortController()
  let lookedUp = false,
    connected = false
  let markStarted
  const started = new Promise((resolve) => {
    markStarted = resolve
  })
  const fetchImpl = network.createSafeFetch({
    lookupImpl: async () => {
      lookedUp = true
      markStarted()
      return new Promise(() => {})
    },
    AgentImpl: class {
      constructor() {
        connected = true
      }
    },
    fetchImpl: async () => {
      throw new Error("must not request")
    },
  })
  const pending = fetchImpl("https://api.example.com", {
    signal: controller.signal,
  })
  await started
  assert.equal(lookedUp, true)
  controller.abort()
  let timer
  try {
    const outcome = await Promise.race([
      pending.then(
        () => "resolved",
        () => "rejected",
      ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve("stuck"), 500)
      }),
    ])
    assert.equal(outcome, "rejected")
    assert.equal(connected, false)
  } finally {
    clearTimeout(timer)
  }
})

test("unknown extension backup versions are rejected before interpreting their fields", () => {
  for (const version of ["99.0", 4, null, { major: 4 }]) {
    assert.throws(
      () =>
        parseImport({ version, accounts: { accounts: [extensionAccount] } }),
      undefined,
      JSON.stringify(version),
    )
  }
  assert.equal(
    parseImport({ version: "4.0", accounts: { accounts: [extensionAccount] } })
      .accounts.length,
    1,
  )
})

test("invalid balance values never overwrite a valid cached balance with zero", async () => {
  const account = validateAccount(credential)
  for (const quota of [null, false, true, "", "   ", [], {}]) {
    await assert.rejects(
      refreshAccount(account, async () =>
        Response.json({ success: true, data: { quota } }),
      ),
      undefined,
      JSON.stringify(quota),
    )
  }
  assert.equal(
    (
      await refreshAccount(account, async () =>
        Response.json({ success: true, data: { quota: 0 } }),
      )
    ).balance,
    0,
  )
  assert.equal(
    (
      await refreshAccount(account, async () =>
        Response.json({ success: true, data: { quota: "500000" } }),
      )
    ).balance,
    1,
  )
})

test("masked key listings never reveal a short secret in full", async () => {
  const account = validateAccount(credential)
  for (const key of ["abc", "12345678"]) {
    const keys = await listKeys(account, async () =>
      Response.json({
        success: true,
        data: { items: [{ id: 1, name: "Fixture", key }] },
      }),
    )
    assert.ok(!JSON.stringify(keys).includes(key), key)
    const visibleCharacters = String(keys[0].key).replace(/[^a-z0-9]/g, "")
    assert.notEqual(visibleCharacters, key + key, key)
  }
})

test("shared sessions require matching CSRF and origin for every account mutation", async (t) => {
  const h = await harness(t)
  const second = await h.login()
  assert.equal(
    (
      await h.call("api/accounts", {
        method: "POST",
        body: credential,
        headers: { "x-csrf-token": "" },
      })
    ).status,
    403,
  )
  assert.equal(
    (
      await h.call("api/accounts", {
        method: "POST",
        body: credential,
        headers: { "x-csrf-token": second.csrf },
      })
    ).status,
    403,
  )
  assert.equal(
    (
      await h.call("api/accounts", {
        method: "POST",
        body: credential,
        headers: { origin: "https://attacker.example.com" },
      })
    ).status,
    403,
  )
  assert.equal(
    (
      await h.call("api/accounts", {
        method: "POST",
        body: credential,
        headers: { "sec-fetch-site": "cross-site" },
      })
    ).status,
    403,
  )
  assert.equal(
    (await h.call("api/accounts", { method: "POST", body: credential })).status,
    201,
  )
  const listed = await h.call("api/accounts")
  assert.equal(listed.body.accounts.length, 1)
  assert.ok(!JSON.stringify(listed.body).includes(credential.token))
  assert.equal(
    (await h.call("api/logout", { method: "POST", body: {} })).status,
    200,
  )
  assert.equal((await h.call("api/accounts")).status, 401)
})

test("detect concurrency is reserved before deferred request bodies are read", async (t) => {
  let calls = 0,
    maximum = 0,
    inFlight = 0,
    release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const h = await harness(t, {
    detect: async () => {
      calls++
      maximum = Math.max(maximum, ++inFlight)
      await gate
      inFlight--
      return { analysis: null }
    },
  })
  const pending = []
  const start = () => {
    const body = JSON.stringify({
      baseUrl: "https://api.example.com",
      apiKey: "fixture",
      model: "fixture",
    })
    let finish
    const result = new Promise((resolve, reject) => {
      const req = request(
        h.address + "api/detect",
        {
          method: "POST",
          headers: {
            cookie: h.session.cookie,
            origin: h.env.PUBLIC_ORIGIN,
            "x-csrf-token": h.session.csrf,
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          },
        },
        (res) => {
          res.resume()
          res.on("end", () => resolve(res.statusCode))
        },
      )
      req.on("error", reject)
      req.write(body.slice(0, 1))
      finish = () => req.end(body.slice(1))
    })
    pending.push(result)
    return finish
  }
  const finishA = start(),
    finishB = start()
  for (
    let turn = 0;
    turn < 100 &&
    h.admitted.filter((url) => url.endsWith("/api/detect")).length < 2;
    turn++
  )
    await new Promise((resolve) => setImmediate(resolve))
  assert.equal(
    h.admitted.filter((url) => url.endsWith("/api/detect")).length,
    2,
  )
  finishA()
  finishB()
  for (let turn = 0; turn < 100; turn++)
    await new Promise((resolve) => setImmediate(resolve))
  release()
  assert.deepEqual((await Promise.all(pending)).sort(), [200, 409])
  assert.equal(calls, 1)
  assert.equal(maximum, 1)
})

test("scheduler uses Shanghai day for manual check-in deduplication", async (t) => {
  for (const scenario of [
    { now: "2026-11-10T16:30:00Z", previous: "2026-11-10T15:30:00Z", calls: 1 },
    { now: "2026-11-11T01:30:00Z", previous: "2026-11-10T17:30:00Z", calls: 0 },
  ]) {
    await t.test(scenario.now, async (sub) => {
      sub.mock.timers.enable({ apis: ["Date"], now: new Date(scenario.now) })
      let requests = 0
      const h = await harness(sub, {
        fetchImpl: async () => {
          requests++
          return Response.json({ success: true, data: {} })
        },
      })
      const account = validateAccount({ ...credential, autoCheckin: true })
      account.lastCheckin = scenario.previous
      await h.app.store.mutate((state) => {
        state.accounts.push(account)
      })
      await h.app.tick()
      assert.equal(requests, scenario.calls)
    })
  }
})

test("encrypted store serializes concurrent writes, recovers after rejected mutations and rejects a wrong key", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "aah-store-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const key = randomBytes(32).toString("hex")
  const store = new Store(directory, key)
  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      store.mutate((state) => {
        state.accounts.push({ id: index, token: credential.token })
      }),
    ),
  )
  assert.equal((await store.read()).accounts.length, 20)
  await assert.rejects(
    store.mutate((state) => {
      state.accounts = []
      throw new Error("cancelled mutation")
    }),
  )
  await store.mutate((state) => {
    state.settings.afterFailure = true
  })
  assert.equal((await store.read()).accounts.length, 20)
  assert.equal((await store.read()).settings.afterFailure, true)
  assert.ok(
    !(await readFile(store.file)).includes(Buffer.from(credential.token)),
  )
  await assert.rejects(
    new Store(directory, randomBytes(32).toString("hex")).read(),
  )
})
