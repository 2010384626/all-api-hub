import assert from "node:assert/strict"
import { test } from "node:test"

import { loadReferenceDetector } from "../../web/server/detector-data.mjs"
import {
  analyzeDetectionOutputs,
  CLIENT_PRESETS,
  normalizeDetectionInput,
  runDetection,
} from "../../web/server/detector.mjs"

const input = {
  baseUrl: "https://example.com/v1",
  apiKey: "sk-private-fixture",
  model: "test-model",
}
const reply = Array.from({ length: 340 }, (_, i) => ((i * 79) % 355) + 1).join(
  ", ",
)
const detector = {
  builtAt: "fixture",
  analyze(outputs) {
    assert.equal(outputs.length, 3)
    assert.ok(outputs.every((output) => output.text.length > 0))
    return {
      decision: "scored",
      results: [{ model: "fixture", score: 0.5 }],
      probability: 0.4,
    }
  },
}

test("presets choose protocol and custom fingerprint headers override defaults", () => {
  assert.deepEqual(
    CLIENT_PRESETS.map((preset) => preset.id),
    ["standard", "claude-code", "codex-cli"],
  )
  const config = normalizeDetectionInput({
    ...input,
    preset: "claude-code",
    userAgent: "my-cli/4",
    headers: { "X-App": "testing", "Anthropic-Beta": "custom-beta" },
  })
  assert.equal(config.api, "messages")
  assert.equal(config.headers["user-agent"], "my-cli/4")
  assert.equal(config.headers["x-app"], "testing")
  assert.equal(config.headers["anthropic-beta"], "custom-beta")
  assert.equal(
    normalizeDetectionInput({ ...input, preset: "codex-cli" }).api,
    "responses",
  )
})

test("rejects unsafe URL shapes, invalid config, credentials and framing headers", () => {
  for (const baseUrl of [
    "file:///etc/passwd",
    "https://user:pass@example.com",
    "https://example.com?a=1",
    "https://example.com/#x",
  ]) {
    assert.throws(() => normalizeDetectionInput({ ...input, baseUrl }))
  }
  for (const name of [
    "Host",
    "Content-Length",
    "Connection",
    "Proxy-Authorization",
    "Authorization",
    "Cookie",
    "x-api-key",
    "Transfer-Encoding",
    "x-forwarded-for",
  ]) {
    assert.throws(() =>
      normalizeDetectionInput({ ...input, headers: { [name]: "x" } }),
    )
  }
  assert.throws(() =>
    normalizeDetectionInput({ ...input, userAgent: "agent\r\nX-Evil: yes" }),
  )
  assert.throws(() =>
    normalizeDetectionInput({ ...input, headers: { "X-Foo": "a\nb" } }),
  )
  assert.throws(() => normalizeDetectionInput({ ...input, count: 4 }))
  assert.throws(() => normalizeDetectionInput({ ...input, timeoutSeconds: 0 }))
  assert.throws(() => normalizeDetectionInput({ ...input, api: "nonsense" }))
  assert.throws(() => normalizeDetectionInput({ ...input, preset: "nonsense" }))
})

for (const api of ["chat_completions", "responses", "messages"]) {
  test(`JSON ${api} uses SDK challenges, injected fetch and never returns credentials`, async () => {
    let calls = 0
    const result = await runDetection(
      {
        ...input,
        api,
        userAgent: "custom/1",
        headers: { "X-Client-Fingerprint": "fixture" },
      },
      {
        detector,
        async fetchImpl(url, init) {
          calls++
          assert.equal(init.redirect, "error")
          assert.equal(init.headers.get("user-agent"), "custom/1")
          assert.equal(init.headers.get("x-client-fingerprint"), "fixture")
          assert.equal(
            init.headers.get(
              api === "messages" ? "x-api-key" : "authorization",
            ),
            api === "messages" ? input.apiKey : `Bearer ${input.apiKey}`,
          )
          const body = JSON.parse(init.body)
          assert.equal(body.model, input.model)
          const suffix = {
            chat_completions: "/chat/completions",
            responses: "/responses",
            messages: "/messages",
          }[api]
          assert.equal(url, input.baseUrl + suffix)
          const payload =
            api === "chat_completions"
              ? {
                  model: "returned",
                  choices: [
                    { message: { content: reply }, finish_reason: "stop" },
                  ],
                }
              : api === "messages"
                ? {
                    model: "returned",
                    content: [{ type: "text", text: reply }],
                    stop_reason: "end_turn",
                  }
                : {
                    model: "returned",
                    status: "completed",
                    output: [
                      {
                        type: "message",
                        content: [{ type: "output_text", text: reply }],
                      },
                    ],
                  }
          return Response.json(payload)
        },
      },
    )
    assert.equal(calls, 3)
    assert.equal(result.analysis.decision, "scored")
    assert.ok(
      result.samples.every(
        (sample) =>
          sample.count === sample.expected_count &&
          sample.state === "truncated",
      ),
    )
    assert.equal(result.referenceBuiltAt, "fixture")
    assert.ok(!JSON.stringify(result).includes(input.apiKey))
    assert.ok(!JSON.stringify(result).includes("raw_text"))
  })
}

for (const api of ["chat_completions", "responses", "messages"]) {
  test(`SSE ${api} accepts split frames and requires completion`, async () => {
    const events =
      api === "chat_completions"
        ? [
            { choices: [{ index: 0, delta: { content: reply } }] },
            { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          ]
        : api === "messages"
          ? [
              {
                type: "content_block_delta",
                delta: { type: "text_delta", text: reply },
              },
              { type: "message_delta", delta: { stop_reason: "end_turn" } },
              { type: "message_stop" },
            ]
          : [
              { type: "response.output_text.delta", delta: reply },
              { type: "response.completed", response: { status: "completed" } },
            ]
    const text = events
      .map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`)
      .join("")
    const result = await runDetection(
      { ...input, api, stream: true },
      {
        detector,
        fetchImpl: async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                for (let i = 0; i < text.length; i += 17)
                  controller.enqueue(
                    new TextEncoder().encode(text.slice(i, i + 17)),
                  )
                controller.close()
              },
            }),
            { headers: { "Content-Type": "text/event-stream" } },
          ),
      },
    )
    assert.equal(result.analysis.decision, "scored")
  })
}

test("failures redact keys, do not score short replies, and preserve per-sample diagnostics", async () => {
  const result = await runDetection(input, {
    detector,
    fetchImpl: async () =>
      new Response(`upstream echoed ${input.apiKey}`, { status: 401 }),
  })
  assert.equal(result.analysis, null)
  assert.ok(
    result.samples.every(
      (sample) => sample.state === "failed" && sample.error.includes("401"),
    ),
  )
  assert.ok(!JSON.stringify(result).includes(input.apiKey))
  const short = await runDetection(input, {
    detector,
    fetchImpl: async () =>
      Response.json({
        choices: [{ message: { content: "1 2 3" }, finish_reason: "stop" }],
      }),
  })
  assert.equal(short.analysis, null)
  assert.match(short.samples[0].error, /有效整数/)
})

test("redacts custom credential headers and API keys before error truncation", async () => {
  const value = "custom-fingerprint-secret"
  const result = await runDetection(
    { ...input, headers: { "X-Client-Token": value } },
    {
      detector,
      fetchImpl: async () =>
        new Response(`upstream echoed ${value} ${input.apiKey}`, {
          status: 403,
        }),
    },
  )
  assert.ok(!JSON.stringify(result).includes(value))
  assert.ok(!JSON.stringify(result).includes(input.apiKey))
  assert.ok(result.samples[0].error.includes("[REDACTED]"))
})

test("refuses oversized responses and invalid SSE rather than scoring them", async () => {
  for (const response of [
    () => new Response("x".repeat(1_048_577)),
    () =>
      new Response("data: {broken}\n\n", {
        headers: { "content-type": "text/event-stream" },
      }),
    () =>
      Response.json({
        choices: [{ message: { content: reply }, finish_reason: "length" }],
      }),
  ]) {
    const result = await runDetection(input, {
      detector,
      fetchImpl: async () => response(),
    })
    assert.equal(result.analysis, null)
    assert.ok(result.samples.every((sample) => sample.state === "failed"))
  }
})

test("requires safe fetch injection and honors pre-aborted detection", async () => {
  await assert.rejects(runDetection(input), /fetchImpl/)
  const controller = new AbortController()
  controller.abort()
  let calls = 0
  const result = await runDetection(input, {
    detector,
    signal: controller.signal,
    fetchImpl: async () => {
      calls++
      throw new Error("must not call")
    },
  })
  assert.equal(calls, 0)
  assert.equal(result.analysis, null)
  assert.ok(result.samples.every((sample) => sample.state === "cancelled"))
})

test("pinned reference package loads and scores through the real lmfpd SDK offline", async () => {
  const actual = await loadReferenceDetector()
  assert.ok(actual.builtAt)
  const result = actual.analyze([{ text: reply, expected_count: 300 }])
  assert.ok(
    ["partial", "scored", "not_model", "unscorable"].includes(result.decision),
  )
  assert.ok(Array.isArray(result.results))
  assert.ok(result.model_version.base_sha256)
})

test("request controls preserve effort and tier and serialize sampling when parallel is off", async () => {
  let inFlight = 0,
    maximum = 0
  const result = await runDetection(
    {
      ...input,
      effort: "xhigh",
      serviceTier: "ultrafast",
      parallel: false,
      looseMode: false,
    },
    {
      detector: {
        ...detector,
        analyze(outputs, options) {
          assert.equal(options.strict, true)
          return detector.analyze(outputs)
        },
      },
      fetchImpl: async (_url, init) => {
        maximum = Math.max(maximum, ++inFlight)
        const body = JSON.parse(init.body)
        assert.equal(body.reasoning_effort, "xhigh")
        assert.equal(body.service_tier, "ultrafast")
        await new Promise((resolve) => setImmediate(resolve))
        inFlight--
        return Response.json({
          choices: [{ message: { content: reply }, finish_reason: "stop" }],
        })
      },
    },
  )
  assert.equal(maximum, 1)
  assert.ok(
    result.samples.every(
      (sample) => sample.state === "complete" && sample.count === 340,
    ),
  )
  assert.ok(
    result.outputs.every((output) => output.text.split(", ").length === 340),
  )
})

test("streaming progress arrives before completion and loose mode cancels after target without finish marker", async () => {
  const events = []
  let cancelled = 0
  const result = await runDetection(
    { ...input, stream: true, count: 1 },
    {
      detector: {
        builtAt: "fixture",
        analyze: () => ({ decision: "partial", probability: null }),
      },
      onProgress: (event) => events.push(event),
      fetchImpl: async (_url, init) => {
        assert.equal(JSON.parse(init.body).stream, true)
        let sent = false
        return new Response(
          new ReadableStream({
            pull(controller) {
              if (!sent) {
                sent = true
                controller.enqueue(
                  new TextEncoder().encode(
                    `data: ${JSON.stringify({ choices: [{ delta: { content: reply + ", " } }] })}\n\n`,
                  ),
                )
              } else return new Promise(() => {})
            },
            cancel() {
              cancelled++
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    },
  )
  assert.equal(cancelled, 1)
  assert.equal(result.samples[0].state, "truncated")
  assert.ok(
    events.some(
      (event) => event.sample.state === "streaming" && event.sample.count > 0,
    ),
  )
  assert.equal(events.at(-1).sample.state, "truncated")
  assert.ok(!JSON.stringify(events).includes(input.apiKey))
})

test("strict streaming rejects missing natural completion and disabled auto verification preserves samples", async () => {
  let analyzed = 0
  const reference = {
    builtAt: "fixture",
    analyze() {
      analyzed++
      return { decision: "partial", probability: null }
    },
  }
  const missingEnd = await runDetection(
    { ...input, stream: true, looseMode: false, count: 1 },
    {
      detector: reference,
      fetchImpl: async () =>
        new Response(
          `data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
    },
  )
  assert.equal(missingEnd.analysis, null)
  assert.equal(missingEnd.samples[0].state, "failed")
  const sampled = await runDetection(
    { ...input, autoVerify: false, count: 1 },
    {
      detector: reference,
      fetchImpl: async () =>
        Response.json({
          choices: [{ message: { content: reply }, finish_reason: "stop" }],
        }),
    },
  )
  assert.equal(analyzed, 0)
  assert.equal(sampled.verificationPending, true)
  assert.ok(sampled.outputs[0].text)
  const verified = await analyzeDetectionOutputs(sampled.outputs, {
    detector: reference,
  })
  assert.equal(analyzed, 1)
  assert.equal(verified.analysis.decision, "partial")
})
