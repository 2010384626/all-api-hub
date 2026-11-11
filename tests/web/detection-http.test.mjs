import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import { createApp } from "../../web/server/app.mjs"

const input = {
  sourceId: "manual",
  baseUrl: "https://detector.example",
  apiKey: "fixture-upstream-private-key",
  model: "fixture-model",
  preset: "standard",
  api: "chat_completions",
}
const numberText = Array.from(
  { length: 300 },
  (_, index) => ((index * 79) % 355) + 1,
).join(", ")
const sampled = () => ({
  analysis: null,
  error: null,
  samples: [1, 2, 3].map(() => ({
    state: "complete",
    count: 300,
    text: numberText,
    expected_count: 300,
  })),
  outputs: [1, 2, 3].map(() => ({ text: numberText, expected_count: 300 })),
  verificationPending: true,
  looseMode: true,
})

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "aah-detection-http-"))
  const env = {
    ADMIN_PASSWORD: "fixture-admin-password",
    ENCRYPTION_KEY: "64".repeat(32),
    DATA_DIR: directory,
    PUBLIC_ORIGIN: "https://hub.example.com",
    BASE_PATH: "/hub/",
  }
  const app = await createApp({
    env,
    detect: async () => sampled(),
    ...options,
  })
  const server = createServer(app.handler)
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${server.address().port}/hub/api/`
  let session
  const request = async (
    route,
    { method = "GET", body, headers = {}, auth = session } = {},
  ) =>
    fetch(base + route, {
      method,
      headers: {
        origin: env.PUBLIC_ORIGIN,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(auth ? { cookie: auth.cookie, "x-csrf-token": auth.csrf } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  const login = await request("login", {
    method: "POST",
    body: { password: env.ADMIN_PASSWORD },
  })
  assert.equal(login.status, 200)
  session = {
    cookie: login.headers.get("set-cookie").split(";")[0],
    csrf: (await login.json()).csrfToken,
  }
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await app.close()
    await rm(directory, { recursive: true, force: true })
  })
  return { app, env, directory, request, session }
}

test("detector configuration persists explicit custom headers and controls behind login and CSRF", async (t) => {
  const f = await fixture(t)
  assert.equal(
    (await f.request("detection/config", { auth: null })).status,
    401,
  )
  const config = {
    userAgent: "fixture-client/2",
    headers: { "x-custom-secret": "custom-header-value" },
    stream: true,
    parallel: false,
    autoVerify: false,
    looseMode: false,
    effort: "xhigh",
    serviceTier: "ultrafast",
  }
  assert.equal(
    (
      await f.request("detection/config", {
        method: "PATCH",
        body: config,
        headers: { "x-csrf-token": "" },
      })
    ).status,
    403,
  )
  assert.equal(
    (
      await f.request("detection/config", {
        method: "PATCH",
        body: config,
        headers: { origin: "https://attacker.example" },
      })
    ).status,
    403,
  )
  const saved = await f.request("detection/config", {
    method: "PATCH",
    body: { ...config, apiKey: "must-not-save" },
  })
  assert.equal(saved.status, 200)
  const persisted = (await (await f.request("detection/config")).json()).config
  for (const [field, value] of Object.entries(config))
    assert.deepEqual(persisted[field], value)
  assert.equal(persisted.apiKey, undefined)
  const disk = await readFile(path.join(f.directory, "state.enc"))
  assert.equal(disk.includes(Buffer.from("custom-header-value")), false)
  assert.equal(
    (await f.app.store.read()).detectionConfig.headers["x-custom-secret"],
    "custom-header-value",
  )
})

test("scheduled detection resolves current source credentials, records results and supports CSRF-safe edit/delete", async (t) => {
  const resolved = [],
    detected = []
  const f = await fixture(t, {
    runtimeFactory: async () => ({
      close: async () => {},
      resolveDetectionCredential: async (target) => {
        resolved.push(target)
        return {
          baseUrl: "https://saved.example",
          apiKey: "current-source-secret",
          requestHeaders: { "x-source": "saved-source-header" },
        }
      },
    }),
    detect: async (config) => {
      detected.push(config)
      return {
        ...sampled(),
        verificationPending: false,
        analysis: {
          decision: "scored",
          probability: 0.998,
          results: [{ model: "candidate", probability: 0.998 }],
        },
      }
    },
  })
  const body = {
    name: "My scheduled model",
    enabled: true,
    target: {
      sourceId: "profile:existing",
      model: "fixture-model",
      headers: { "x-client": "custom-client-header" },
    },
    timing: { type: "daily", at: "09:30", timeZone: "Asia/Shanghai" },
  }
  assert.equal(
    (
      await f.request("detection/schedules", {
        method: "POST",
        body,
        auth: null,
      })
    ).status,
    401,
  )
  assert.equal(
    (
      await f.request("detection/schedules", {
        method: "POST",
        body,
        headers: { "x-csrf-token": "" },
      })
    ).status,
    403,
  )
  const created = await f.request("detection/schedules", {
    method: "POST",
    body,
  })
  assert.equal(created.status, 201)
  const schedule = (await created.json()).schedule
  assert.ok(schedule.nextRunAt > Date.now())
  assert.ok(!JSON.stringify(schedule).includes("custom-client-header"))
  await f.app.store.mutate((state) => {
    state.detectionSchedules[0].nextRunAt = Date.now() - 1000
  })
  await f.app.tick()
  assert.equal(resolved.length, 1)
  assert.equal(resolved[0].sourceId, "profile:existing")
  assert.equal(detected[0].apiKey, "current-source-secret")
  assert.equal(detected[0].headers["x-source"], "saved-source-header")
  assert.equal(detected[0].headers["x-client"], "custom-client-header")
  const history = await (await f.request("detection/history")).json()
  assert.equal(history.items[0].trigger, "schedule")
  assert.equal(history.items[0].scheduleId, schedule.id)
  assert.ok(!JSON.stringify(history).includes("current-source-secret"))
  const disabled = await f.request(`detection/schedules/${schedule.id}`, {
    method: "PATCH",
    body: { enabled: false },
  })
  assert.equal((await disabled.json()).schedule.enabled, false)
  assert.equal(
    (
      await f.request(`detection/schedules/${schedule.id}`, {
        method: "DELETE",
        headers: { "x-csrf-token": "" },
      })
    ).status,
    403,
  )
  assert.equal(
    (
      await f.request(`detection/schedules/${schedule.id}`, {
        method: "DELETE",
      })
    ).status,
    200,
  )
  assert.deepEqual(
    (await (await f.request("detection/schedules")).json()).schedules,
    [],
  )
})

test("manual detector errors are retained and scrubbed in authenticated history", async (t) => {
  const f = await fixture(t, {
    detect: async () => {
      throw new Error(`failed with ${input.apiKey}`)
    },
  })
  assert.equal(
    (await f.request("detect", { method: "POST", body: input })).status,
    502,
  )
  const history = await (
    await f.request("detection/history?limit=1&offset=0")
  ).json()
  assert.equal(history.total, 1)
  assert.equal(history.items[0].status, "failed")
  assert.equal(history.items[0].model, "fixture-model")
  assert.ok(history.items[0].finishedAt >= history.items[0].startedAt)
  assert.ok(!JSON.stringify(history).includes(input.apiKey))
  assert.equal(
    (await f.request("detection/history", { auth: null })).status,
    401,
  )
})

test("SSE exposes samples before final completion and sample-only history can be verified without new requests", async (t) => {
  let release,
    calls = 0
  const gate = new Promise((resolve) => {
    release = resolve
  })
  t.after(() => release())
  const f = await fixture(t, {
    detect: async (_config, { onProgress }) => {
      calls++
      onProgress({
        type: "sample",
        index: 0,
        sample: {
          state: "streaming",
          count: 2,
          expected_count: 300,
          text: "10, 20",
        },
      })
      await gate
      return sampled()
    },
  })
  const response = await f.request("detect", {
    method: "POST",
    body: { ...input, stream: true, autoVerify: false },
    headers: { accept: "text/event-stream" },
  })
  assert.equal(response.status, 200)
  assert.match(response.headers.get("content-type"), /text\/event-stream/)
  const reader = response.body.getReader()
  const first = new TextDecoder().decode((await reader.read()).value)
  assert.match(first, /event: progress/)
  assert.match(first, /10, 20/)
  assert.ok(!first.includes("event: result"))
  release()
  let rest = ""
  while (true) {
    const next = await reader.read()
    if (next.done) break
    rest += new TextDecoder().decode(next.value)
  }
  reader.releaseLock()
  assert.match(rest, /event: result/)
  const history = await (await f.request("detection/history")).json()
  assert.equal(history.items[0].status, "sampled")
  const id = history.items[0].id
  assert.equal(
    (
      await f.request(`detection/history/${id}/verify`, {
        method: "POST",
        headers: { "x-csrf-token": "" },
      })
    ).status,
    403,
  )
  const verification = await f.request(`detection/history/${id}/verify`, {
    method: "POST",
  })
  assert.equal(verification.status, 200)
  const verified = await verification.json()
  assert.equal(verified.historyId, id)
  assert.equal(verified.verificationPending, false)
  assert.ok(verified.analysis)
  assert.equal(calls, 1)
  assert.equal((await (await f.request("detection/history")).json()).total, 1)
})
