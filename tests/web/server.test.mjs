import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import { parseImport } from "../../web/server/accounts.mjs"
import { createApp } from "../../web/server/app.mjs"
import { isPublicAddress, validateUrl } from "../../web/server/network.mjs"
import { Store } from "../../web/server/store.mjs"

const password = "test-admin-password-1234",
  encryptionKey = "ab".repeat(32)
async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "aah-web-test-"))
  const calls = []
  const app = await createApp({
    env: {
      ADMIN_PASSWORD: password,
      ENCRYPTION_KEY: encryptionKey,
      DATA_DIR: directory,
      BASE_PATH: "/hub/",
      PUBLIC_ORIGIN: "https://hub.example.com",
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      let data = { quota: 750000, used_quota: 250000, request_count: 4 }
      if (url.endsWith("/api/v1/auth/me")) data = { balance: "9.25" }
      if (url.includes("/models")) data = [{ id: "gpt-test" }]
      if (url.includes("/api/token/"))
        data = {
          items: [{ id: 1, name: "Primary", key: "sk-very-secret-test-key" }],
        }
      return Response.json({ success: true, data })
    },
    ...options,
  })
  const server = createServer(app.handler)
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  let cookie = "",
    csrf = ""
  async function request(
    route,
    { method = "GET", body, noCsrf = false, headers = {} } = {},
  ) {
    return fetch(`${origin}/hub/${route}`, {
      method,
      headers: {
        cookie,
        ...(noCsrf ? {} : { "x-csrf-token": csrf }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    })
  }
  async function login() {
    const response = await request("api/login", {
      method: "POST",
      body: { password },
      headers: { origin: "https://hub.example.com" },
    })
    assert.equal(response.status, 200)
    assert.match(
      response.headers.get("set-cookie"),
      /HttpOnly; SameSite=Strict.*Secure/,
    )
    cookie = response.headers.get("set-cookie").split(";")[0]
    csrf = (await response.json()).csrfToken
  }
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  })
  return { ...app, request, login, directory, calls, origin }
}

test("auth, CSRF, mount prefix, static allowlist and login limits", async (t) => {
  const f = await fixture(t)
  assert.equal((await f.request("api/health")).status, 200)
  assert.equal((await f.request("api/accounts")).status, 401)
  assert.equal(
    (
      await f.request("api/login", {
        method: "POST",
        body: { password },
        headers: { origin: "https://attacker.example" },
      })
    ).status,
    403,
  )
  await f.login()
  assert.equal(
    (
      await f.request("api/accounts", {
        method: "POST",
        body: {},
        noCsrf: true,
      })
    ).status,
    403,
  )
  assert.equal(
    (
      await f.request("api/accounts", {
        method: "POST",
        body: {},
        headers: { origin: "https://attacker.example" },
      })
    ).status,
    403,
  )
  assert.equal((await f.request("api/session")).status, 200)
  assert.equal((await f.request("sponsor-catalog.v5.json")).status, 404)
  assert.equal((await f.request("server/index.mjs")).status, 404)
  assert.equal((await fetch(f.origin + "/api/health")).status, 404)
  assert.equal((await f.request("api/logout", { method: "POST" })).status, 200)
  assert.equal((await f.request("api/accounts")).status, 401)
  for (let i = 0; i < 10; i++)
    assert.equal(
      (
        await f.request("api/login", {
          method: "POST",
          body: { password: "wrong" },
        })
      ).status,
      401,
    )
  assert.equal(
    (await f.request("api/login", { method: "POST", body: { password } }))
      .status,
    429,
  )
})

test("account CRUD, quota meaning, models/keys, persisted shared state and backup roundtrip", async (t) => {
  const f = await fixture(t)
  await f.login()
  const add = await f.request("api/accounts", {
    method: "POST",
    body: {
      name: "My relay",
      baseUrl: "https://api.example.com",
      siteType: "new-api",
      token: "management-secret",
      apiKey: "sk-inference-secret",
      userId: "42",
      autoCheckin: true,
    },
  })
  assert.equal(add.status, 201)
  const account = (await add.json()).account
  assert.equal(account.token, undefined)
  assert.equal(account.apiKey, undefined)
  assert.equal(
    (await f.request(`api/accounts/${account.id}/refresh`, { method: "POST" }))
      .status,
    200,
  )
  const saved = (await (await f.request("api/accounts")).json()).accounts[0]
  assert.equal(saved.balance, 1.5)
  assert.equal(saved.usedQuota, 0.5)
  assert.equal(f.calls[0].init.headers["new-api-user"], "42")
  assert.equal(
    f.calls[0].init.headers.authorization,
    "Bearer management-secret",
  )
  const models = await (
    await f.request(`api/accounts/${account.id}/models`)
  ).json()
  assert.deepEqual(models.models, ["gpt-test"])
  const keys = await (await f.request(`api/accounts/${account.id}/keys`)).json()
  assert.equal(JSON.stringify(keys).includes("sk-very-secret-test-key"), false)
  await f.tick()
  await f.tick()
  assert.equal(f.calls.filter((c) => c.url.endsWith("/checkin")).length, 1)
  const dataOnDisk = await readFile(path.join(f.directory, "state.enc"))
  assert.equal(dataOnDisk.includes("management-secret"), false)
  assert.equal(
    (await new Store(f.directory, encryptionKey).read()).accounts[0].token,
    "management-secret",
  )
  const exported = await (await f.request("api/export")).json()
  assert.equal(exported.accounts[0].apiKey, "sk-inference-secret")
  assert.equal(
    (
      await f.request(`api/accounts/${account.id}`, {
        method: "PATCH",
        body: { name: "Updated" },
      })
    ).status,
    200,
  )
  assert.equal((await f.store.read()).accounts[0].token, "management-secret")
  await f.request(`api/accounts/${account.id}`, { method: "DELETE" })
  const imported = await (
    await f.request("api/import", { method: "POST", body: exported })
  ).json()
  assert.equal(imported.imported, 1)
  const duplicate = await (
    await f.request("api/import", { method: "POST", body: exported })
  ).json()
  assert.equal(duplicate.imported, 0)
})

test("Sub2API keeps native balance, unsupported checkin is explicit; credentials use inference key", async (t) => {
  const f = await fixture(t)
  await f.login()
  const add = async (body) =>
    (await (await f.request("api/accounts", { method: "POST", body })).json())
      .account
  const sub = await add({
    name: "Sub",
    baseUrl: "https://sub.example.com",
    siteType: "sub2api",
    token: "jwt-token",
  })
  const refreshed = await (
    await f.request(`api/accounts/${sub.id}/refresh`, { method: "POST" })
  ).json()
  assert.equal(refreshed.account.balance, 9.25)
  assert.equal(
    (await f.request(`api/accounts/${sub.id}/checkin`, { method: "POST" }))
      .status,
    400,
  )
  const credential = await add({
    name: "API",
    baseUrl: "https://api.example.com/v1",
    siteType: "credential",
    apiKey: "inference-key",
  })
  assert.equal(
    (
      await f.request(`api/accounts/${credential.id}/refresh`, {
        method: "POST",
      })
    ).status,
    200,
  )
  assert.equal(f.calls.at(-1).url, "https://api.example.com/v1/models")
})

test("encryption rejects wrong keys, corruption, and serializes concurrent writes", async (t) => {
  const f = await fixture(t)
  await Promise.all(
    Array.from({ length: 20 }, () =>
      f.store.mutate((state) => {
        state.settings.counter = (state.settings.counter || 0) + 1
      }),
    ),
  )
  assert.equal((await f.store.read()).settings.counter, 20)
  await assert.rejects(new Store(f.directory, "cd".repeat(32)).read())
  await writeFile(path.join(f.directory, "state.enc"), "corrupt")
  await assert.rejects(
    f.store.mutate((state) => {
      state.accounts = []
    }),
  )
  assert.equal(
    await readFile(path.join(f.directory, "state.enc"), "utf8"),
    "corrupt",
  )
})

test("SSRF blocks private/reserved IPv4, IPv6, mapped forms; public URL validation", () => {
  for (const ip of [
    "127.0.0.1",
    "10.1.1.1",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "0.0.0.0",
    "100.64.1.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "224.0.0.1",
  ])
    assert.equal(isPublicAddress(ip), false, ip)
  assert.equal(isPublicAddress("8.8.8.8"), true)
  for (const url of [
    "http://example.com",
    "https://a:b@example.com",
    "https://example.com/#x",
    "https://localhost",
    "file:///tmp/file",
  ])
    assert.throws(() => validateUrl(url))
})

test("extension import maps known token accounts and reports unsupported records", () => {
  const imported = parseImport({
    version: "4.0",
    accounts: {
      accounts: [
        {
          site_name: "Relay",
          site_url: "https://api.example.com",
          site_type: "new-api",
          account_info: { access_token: "token", id: "17" },
        },
        { site_name: "Other", site_type: "unknown" },
      ],
    },
  })
  assert.equal(imported.accounts[0].userId, "17")
  assert.deepEqual(imported.skipped, ["Other"])
  assert.throws(() =>
    parseImport({
      format: "all-api-hub-web",
      version: 1,
      accounts: [{ name: "invalid" }],
    }),
  )
})

test("detection uses stored secret without returning it and disconnect path is bounded", async (t) => {
  let seen
  const f = await fixture(t, {
    detect: async (input, options) => {
      seen = input
      assert.ok(options.signal)
      return { analysis: { prediction: "reference-model" } }
    },
  })
  await f.login()
  const account = (
    await (
      await f.request("api/accounts", {
        method: "POST",
        body: {
          name: "API",
          baseUrl: "https://api.example.com",
          siteType: "credential",
          apiKey: "stored-secret",
        },
      })
    ).json()
  ).account
  const result = await (
    await f.request("api/detect", {
      method: "POST",
      body: { accountId: account.id, model: "gpt-test" },
    })
  ).json()
  assert.equal(seen.apiKey, "stored-secret")
  assert.equal(result.analysis.prediction, "reference-model")
  assert.equal(JSON.stringify(result).includes("stored-secret"), false)
})
