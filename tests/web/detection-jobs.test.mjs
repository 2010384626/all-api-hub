import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import {
  createDetectionJobs,
  nextDetectionRun,
  normalizeDetectionTiming,
} from "../../web/server/detection-jobs.mjs"
import { Store } from "../../web/server/store.mjs"

const manual = {
  sourceId: "manual",
  baseUrl: "https://api.example.com",
  apiKey: "fixture-private-key",
  model: "test-model",
  headers: { "x-client-secret": "fixture-header-secret" },
}
const validResult = () => ({
  analysis: {
    decision: "scored",
    prediction: "reference-model",
    probability: 0.998,
    probability_status: "reference_calibrated",
    results: [{ model: "reference-model", probability: 0.998, score: 3.681 }],
  },
  samples: [1, 2, 3].map(() => ({ state: "complete", count: 300 })),
})

async function harness(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "aah-detection-jobs-"))
  const store = new Store(directory, "5a".repeat(32))
  let time = Date.parse("2026-11-11T00:00:00Z")
  const jobs = await createDetectionJobs({
    store,
    detect: async () => validResult(),
    now: () => time,
    ...options,
  })
  t.after(async () => {
    await jobs.close()
    await rm(directory, { recursive: true, force: true })
  })
  return {
    jobs,
    store,
    directory,
    advance: (minutes) => {
      time += minutes * 60_000
    },
    now: () => time,
  }
}

test("the default run deadline allows all three serial samples their own request timeout", async (t) => {
  const deadlines = []
  t.mock.method(AbortSignal, "timeout", (milliseconds) => {
    deadlines.push(milliseconds)
    return new AbortController().signal
  })
  const h = await harness(t)
  await h.jobs.run({ ...manual, parallel: false, timeoutSeconds: 120 })
  assert.equal(deadlines.length, 1)
  assert.ok(deadlines[0] > 3 * 120_000)
})

test("manual outcomes persist across service restart with exact probabilities and without credential data", async (t) => {
  const h = await harness(t, {
    detect: async () => ({
      ...validResult(),
      error: "fixture-private-key fixture-header-secret",
      headers: { secret: "fixture-header-secret" },
    }),
  })
  const result = await h.jobs.run(manual)
  assert.ok(result.historyId)
  assert.ok(!JSON.stringify(result).includes("fixture-private-key"))
  assert.ok(!JSON.stringify(result).includes("fixture-header-secret"))
  const persisted = await h.jobs.history({})
  assert.equal(persisted.items[0].result.analysis.results[0].probability, 0.998)
  assert.equal(persisted.items[0].result.analysis.results[0].score, 3.681)
  assert.equal(persisted.items[0].source, "manual")
  const reopened = await createDetectionJobs({
    store: new Store(h.directory, "5a".repeat(32)),
    detect: async () => validResult(),
    now: h.now,
  })
  assert.equal((await reopened.history({})).items[0].id, result.historyId)
  await reopened.close()
  const disk = await readFile(h.store.file)
  assert.equal(disk.includes(Buffer.from("reference-model")), false)
})

test("partial sample probabilities stay unavailable; failed and cancelled detections are retained", async (t) => {
  let mode = "partial"
  const h = await harness(t, {
    detect: async () => {
      if (mode === "throw")
        throw new Error("secret failure fixture-private-key")
      return {
        analysis: {
          decision: "partial",
          probability: null,
          probability_status: "unavailable",
          results: [
            { model: "reference-model", score: 3.681, probability: null },
          ],
        },
        samples: [
          { state: "complete", count: 300 },
          { state: "failed", count: 84 },
        ],
      }
    },
  })
  const partial = await h.jobs.run(manual)
  assert.equal(partial.analysis.probability, null)
  assert.equal((await h.jobs.history({})).items[0].status, "partial")
  mode = "throw"
  await assert.rejects(
    h.jobs.run(manual),
    (error) => error.status === 502 && Boolean(error.historyId),
  )
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    h.jobs.run(manual, { signal: controller.signal }),
    (error) => error.status === 499,
  )
  const { items } = await h.jobs.history({})
  assert.deepEqual(
    items.map((item) => item.status),
    ["cancelled", "failed", "partial"],
  )
  assert.ok(!JSON.stringify(items).includes("fixture-private-key"))
})

test("schedules are disabled by default and resolve current saved credentials at each due execution", async (t) => {
  const requests = [],
    resolutions = []
  let key = "first-current-secret"
  const h = await harness(t, {
    resolveCredential: async (target) => {
      resolutions.push(target)
      return {
        baseUrl: "https://saved.example",
        apiKey: key,
        requestHeaders: { "x-account-secret": "saved-header-secret" },
      }
    },
    detect: async (input) => {
      requests.push(input)
      return validResult()
    },
  })
  const saved = await h.jobs.saveSchedule({
    name: "Watch model",
    target: { sourceId: "profile:p1", model: "test-model" },
    timing: { type: "interval", everyMinutes: 5 },
  })
  assert.equal(saved.enabled, false)
  assert.equal(saved.nextRunAt, null)
  h.advance(20)
  await h.jobs.tick()
  assert.equal(requests.length, 0)
  const enabled = await h.jobs.saveSchedule({ enabled: true }, saved.id)
  assert.equal(enabled.nextRunAt, h.now() + 5 * 60_000)
  h.advance(5)
  await h.jobs.tick()
  assert.equal(requests[0].apiKey, key)
  assert.equal(requests[0].headers["x-account-secret"], "saved-header-secret")
  key = "updated-current-secret"
  h.advance(5)
  await h.jobs.tick()
  assert.equal(requests[1].apiKey, key)
  assert.equal(resolutions.length, 2)
  const schedules = await h.jobs.listSchedules()
  assert.equal(schedules[0].lastStatus, "success")
  assert.equal(
    schedules[0].lastHistoryId,
    (await h.jobs.history({})).items[0].id,
  )
  assert.equal((await h.jobs.history({})).total, 2)
})

test("daily Shanghai scheduling and missed interval restarts never catch up with a burst", async (t) => {
  const timing = normalizeDetectionTiming({ type: "daily", at: "09:30" })
  assert.equal(
    nextDetectionRun(timing, Date.parse("2026-11-11T00:00:00Z")),
    Date.parse("2026-11-11T01:30:00Z"),
  )
  assert.equal(
    nextDetectionRun(timing, Date.parse("2026-11-11T01:30:00Z")),
    Date.parse("2026-11-12T01:30:00Z"),
  )
  let calls = 0
  const h = await harness(t, {
    detect: async () => {
      calls++
      return validResult()
    },
  })
  const schedule = await h.jobs.saveSchedule({
    name: "Periodic",
    target: manual,
    enabled: true,
    timing: { type: "interval", everyMinutes: 5 },
  })
  h.advance(1440)
  await h.jobs.tick()
  await h.jobs.tick()
  assert.equal(calls, 1)
  assert.equal(
    (await h.jobs.listSchedules())[0].nextRunAt,
    h.now() + 5 * 60_000,
  )
  await h.jobs.saveSchedule({ name: "Daily", timing }, schedule.id)
  assert.equal(
    (await h.jobs.listSchedules())[0].nextRunAt,
    Date.parse("2026-11-12T01:30:00Z"),
  )
})

test("schedule responses omit API keys and header values while editing timing preserves them", async (t) => {
  const h = await harness(t)
  const saved = await h.jobs.saveSchedule({
    name: "Manual",
    target: manual,
    timing: { type: "interval", everyMinutes: 15 },
  })
  assert.equal(saved.target.hasApiKey, true)
  assert.deepEqual(saved.target.headerNames, ["x-client-secret"])
  assert.ok(!JSON.stringify(saved).includes(manual.apiKey))
  assert.ok(!JSON.stringify(saved).includes("fixture-header-secret"))
  await h.jobs.saveSchedule(
    { timing: { type: "interval", everyMinutes: 20 }, enabled: true },
    saved.id,
  )
  assert.equal(
    (await h.store.read()).detectionSchedules[0].target.apiKey,
    manual.apiKey,
  )
  assert.equal(
    (await h.store.read()).detectionSchedules[0].target.headers[
      "x-client-secret"
    ],
    "fixture-header-secret",
  )
  await h.jobs.deleteSchedule(saved.id)
  assert.deepEqual(await h.jobs.listSchedules(), [])
  await assert.rejects(
    h.jobs.saveSchedule({ enabled: true }, saved.id),
    (error) => error.status === 404,
  )
})

test("concurrent runs and ticks cannot overlap and disable cancels an active schedule", async (t) => {
  let started,
    release,
    calls = 0
  const began = new Promise((resolve) => {
    started = resolve
  })
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const h = await harness(t, {
    detect: async (_input, { signal }) => {
      calls++
      started()
      await gate
      signal.throwIfAborted()
      return validResult()
    },
  })
  const saved = await h.jobs.saveSchedule({
    name: "Serial",
    enabled: true,
    target: manual,
    timing: { type: "interval", everyMinutes: 5 },
  })
  h.advance(5)
  const tick = h.jobs.tick()
  await began
  assert.throws(
    () => h.jobs.run(manual),
    (error) => error.status === 409,
  )
  await h.jobs.tick()
  await h.jobs.saveSchedule({ enabled: false }, saved.id)
  release()
  await tick
  assert.equal(calls, 1)
  assert.equal((await h.jobs.history({})).items[0].status, "cancelled")
})

test("history is paginated and never silently removes older runs; restart marks unfinished work", async (t) => {
  const h = await harness(t)
  for (let i = 0; i < 6; i++) {
    h.advance(1)
    await h.jobs.run({ ...manual, model: i % 2 ? "second" : "first" })
  }
  const page = await h.jobs.history({ offset: 2, limit: 2 })
  assert.equal(page.total, 6)
  assert.equal(page.items.length, 2)
  assert.ok(page.items[0].startedAt > page.items[1].startedAt)
  assert.equal((await h.jobs.history({ model: "first" })).total, 3)
  await h.store.mutate((state) =>
    state.detectionHistory.push({ id: "unfinished", status: "running" }),
  )
  const restarted = await createDetectionJobs({
    store: h.store,
    detect: async () => validResult(),
    now: h.now,
  })
  assert.equal((await restarted.history({})).items[0].status, "interrupted")
  await restarted.close()
})

test("invalid timing, targets and paging fail before network use", async (t) => {
  const h = await harness(t)
  for (const timing of [
    { type: "interval", everyMinutes: 4 },
    { type: "daily", at: "25:00" },
    { type: "daily", at: "09:00", timeZone: "UTC" },
  ]) {
    await assert.rejects(
      h.jobs.saveSchedule({ name: "Invalid", target: manual, timing }),
      (error) => error.status === 400,
    )
  }
  await assert.rejects(
    h.jobs.saveSchedule({
      name: "Invalid",
      target: { sourceId: "manual", model: "m" },
      timing: { type: "interval", everyMinutes: 5 },
    }),
  )
  await assert.rejects(h.jobs.history({ offset: -1 }))
  assert.equal((await h.jobs.history({})).total, 0)
})

test("cancellation bounds credential lookup and persists the cancelled attempt", async (t) => {
  let entered
  const started = new Promise((resolve) => {
    entered = resolve
  })
  const h = await harness(t, {
    resolveCredential: async () => {
      entered()
      return new Promise(() => {})
    },
  })
  const controller = new AbortController()
  const pending = h.jobs.run(
    { sourceId: "profile:p1", model: "m" },
    { signal: controller.signal },
  )
  await started
  controller.abort()
  await assert.rejects(pending, (error) => error.status === 499)
  assert.equal((await h.jobs.history({})).items[0].status, "cancelled")
})

test("configuration persists UA/custom headers and controls without saving a supplied API key", async (t) => {
  const h = await harness(t)
  const config = await h.jobs.saveConfig({
    userAgent: "custom-client/4",
    headers: { "x-client-token": "saved-custom-token" },
    stream: true,
    parallel: false,
    looseMode: false,
    autoVerify: false,
    effort: "high",
    serviceTier: "flex",
    apiKey: "must-not-save",
  })
  assert.equal(config.userAgent, "custom-client/4")
  assert.equal(config.headers["x-client-token"], "saved-custom-token")
  const reopened = await createDetectionJobs({
    store: h.store,
    detect: async () => validResult(),
  })
  assert.deepEqual(await reopened.getConfig(), config)
  assert.ok(
    !JSON.stringify((await h.store.read()).detectionConfig).includes(
      "must-not-save",
    ),
  )
  const patched = await reopened.saveConfig({ effort: "xhigh" })
  assert.equal(patched.headers["x-client-token"], "saved-custom-token")
  await reopened.close()
})

test("sample-only history verifies retained integer outputs without another upstream request", async (t) => {
  let requests = 0,
    verifications = 0
  const output = { text: "1, 2, 3", expected_count: 300 }
  const h = await harness(t, {
    detect: async () => {
      requests++
      return {
        analysis: null,
        verificationPending: true,
        outputs: [output],
        looseMode: true,
        samples: [{ state: "complete", text: output.text, count: 300 }],
      }
    },
    analyze: async (outputs, options) => {
      verifications++
      assert.deepEqual(outputs, [output])
      assert.equal(options.looseMode, true)
      return { analysis: validResult().analysis }
    },
  })
  const sampled = await h.jobs.run(manual)
  assert.equal((await h.jobs.history({})).items[0].status, "sampled")
  assert.deepEqual((await h.jobs.history({})).items[0].result.outputs, [output])
  const verified = await h.jobs.verifyHistory(sampled.historyId)
  assert.equal(verified.verificationPending, false)
  assert.equal(verified.analysis.probability, 0.998)
  assert.equal(requests, 1)
  assert.equal(verifications, 1)
  assert.equal((await h.jobs.history({})).total, 1)
  assert.equal((await h.jobs.history({})).items[0].status, "success")
})

test("numeric request headers do not corrupt stored integer samples", async (t) => {
  const h = await harness(t, {
    detect: async () => ({
      verificationPending: true,
      analysis: null,
      samples: [{ state: "complete", count: 3, text: "10, 20, 30" }],
      outputs: [{ text: "10, 20, 30", expected_count: 300 }],
    }),
  })
  const result = await h.jobs.run({
    ...manual,
    headers: { "x-retry-count": "0" },
  })
  assert.equal(result.outputs[0].text, "10, 20, 30")
  assert.equal(
    (await h.jobs.history({})).items[0].result.samples[0].text,
    "10, 20, 30",
  )
})
