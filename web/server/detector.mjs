import { buildRequest, generateChallenges, parseNumbers } from "lmfpd-sdk"

import { loadReferenceDetector } from "./detector-data.mjs"

export const DETECTION_DISCLAIMER =
  "结果是参考库内的相似度排序，不能证明模型身份。客户端预设仅设置 HTTP 协议、UA 和请求头，不模拟 CLI 会话、TLS/JA3 或 HTTP/2 指纹。"

// Versions are editable illustrative profiles, not assertions about installed clients.
export const CLIENT_PRESETS = Object.freeze([
  {
    id: "standard",
    label: "标准 API",
    api: "chat_completions",
    userAgent: "All-API-Hub-Web/1.0",
    headers: {},
  },
  {
    id: "claude-code",
    label: "Claude Code 请求头预设",
    api: "messages",
    userAgent: "claude-cli/2.1.0 (external, cli)",
    headers: { "anthropic-version": "2023-06-01", "x-app": "cli" },
  },
  {
    id: "codex-cli",
    label: "Codex CLI 请求头预设",
    api: "responses",
    userAgent: "codex_cli_rs/0.100.0",
    headers: { originator: "codex_cli_rs" },
  },
])

const APIS = new Set(["chat_completions", "responses", "messages"])
const MAX_RESPONSE_BYTES = 1_048_576
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9a-z-]+$/
const FORBIDDEN_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "cookie",
  "cookie2",
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "expect",
  "content-type",
  "content-encoding",
  "accept-encoding",
  "accept",
  "forwarded",
])

export class DetectionInputError extends Error {
  constructor(message) {
    super(message)
    this.name = "DetectionInputError"
    this.status = 400
    this.statusCode = 400
  }
}

function requireText(value, label, maxLength, optional = false) {
  if (optional && value === undefined) return ""
  if (
    typeof value !== "string" ||
    (!optional && !value.trim()) ||
    value.length > maxLength ||
    [...value].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  ) {
    throw new DetectionInputError(`${label} 格式无效。`)
  }
  return value.trim()
}

/** Validate custom HTTP fingerprint fields without allowing framing or credential overrides. */
export function validateFingerprintHeaders(input = {}) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).length > 32
  ) {
    throw new DetectionInputError("自定义请求头必须是最多 32 项的 JSON 对象。")
  }
  const headers = Object.create(null)
  let size = 0
  for (const [name, rawValue] of Object.entries(input)) {
    const key = name.toLowerCase()
    if (
      !HEADER_NAME.test(key) ||
      key.length > 128 ||
      FORBIDDEN_HEADERS.has(key) ||
      key.startsWith("proxy-") ||
      key.startsWith("x-forwarded-") ||
      key.startsWith("sec-")
    ) {
      throw new DetectionInputError(`不允许自定义请求头：${name.slice(0, 128)}`)
    }
    if (Object.hasOwn(headers, key))
      throw new DetectionInputError(`请求头名称重复：${key}`)
    const value = requireText(rawValue, `请求头 ${name}`, 2048, true)
    // Headers must be byte strings in fetch, so reject non-HTTP characters early.
    if (/[^\x20-\x7e\x80-\xff]/.test(value))
      throw new DetectionInputError(`请求头 ${name} 包含不支持的字符。`)
    size += key.length + value.length
    if (size > 16_384)
      throw new DetectionInputError("自定义请求头总长度不能超过 16 KB。")
    headers[key] = value
  }
  return headers
}

/** DNS/IP safety is enforced by the server's injected fetchImpl at connection time. */
export function normalizeDetectionInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new DetectionInputError("检测参数无效。")
  const baseUrl = requireText(input.baseUrl, "Base URL", 2048)
  let url
  try {
    url = new URL(baseUrl)
  } catch {
    throw new DetectionInputError("Base URL 必须是有效的 HTTP(S) 地址。")
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new DetectionInputError(
      "Base URL 必须使用 HTTP(S)，且不能包含账号密码、查询参数或片段。",
    )
  }
  const preset = CLIENT_PRESETS.find(
    (item) => item.id === (input.preset ?? "standard"),
  )
  if (!preset) throw new DetectionInputError("客户端预设无效。")
  const api = input.api || preset.api
  if (!APIS.has(api)) throw new DetectionInputError("API 协议无效。")
  const count = input.count ?? 3
  const timeoutSeconds = input.timeoutSeconds ?? 60
  if (!Number.isSafeInteger(count) || count < 1 || count > 3)
    throw new DetectionInputError("检测样本数必须为 1 到 3。")
  if (
    !Number.isFinite(timeoutSeconds) ||
    timeoutSeconds < 5 ||
    timeoutSeconds > 120
  )
    throw new DetectionInputError("超时必须在 5 到 120 秒之间。")
  if (input.stream !== undefined && typeof input.stream !== "boolean")
    throw new DetectionInputError("stream 必须是布尔值。")
  for (const field of ["parallel", "looseMode", "autoVerify"]) {
    if (input[field] !== undefined && typeof input[field] !== "boolean")
      throw new DetectionInputError(`${field} 必须是布尔值。`)
  }
  if (
    input.serviceTier !== undefined &&
    !["default", "flex", "fast", "ultrafast"].includes(input.serviceTier)
  )
    throw new DetectionInputError("服务等级无效。")
  const customHeaders = validateFingerprintHeaders(input.headers)
  const userAgent = requireText(
    input.userAgent || customHeaders["user-agent"] || preset.userAgent,
    "User-Agent",
    1024,
  )
  if (/[^\x20-\x7e\x80-\xff]/.test(userAgent))
    throw new DetectionInputError("User-Agent 包含不支持的字符。")
  const result = {
    baseUrl: url.href.replace(/\/+$/, ""),
    apiKey: requireText(input.apiKey, "API Key", 8192),
    model: requireText(input.model, "模型名称", 256),
    preset: preset.id,
    api,
    count,
    timeoutSeconds,
    stream: input.stream ?? false,
    parallel: input.parallel ?? true,
    looseMode: input.looseMode ?? true,
    autoVerify: input.autoVerify ?? true,
    serviceTier: input.serviceTier ?? "default",
    effort: requireText(input.effort, "推理强度", 32, true),
    headers: { ...preset.headers, ...customHeaders, "user-agent": userAgent },
  }
  const request = buildRequest(
    { ...result, parallel: result.parallel ? 3 : 1 },
    "validate",
  )
  if ("error" in request) throw new DetectionInputError(request.error)
  return result
}

function safeError(error, apiKey, headers = {}) {
  let message = String(error instanceof Error ? error.message : error)
  const secrets = [
    apiKey,
    ...Object.entries(headers)
      .filter(([name]) => /key|token|secret|auth|cookie/i.test(name))
      .map(([, value]) => value),
  ]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
  for (const secret of secrets)
    message = message.replaceAll(secret, "[REDACTED]")
  return [...message]
    .map((character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
        ? " "
        : character,
    )
    .join("")
    .slice(0, 500)
}

async function readBoundedResponse(response, signal) {
  const declaredLength = Number(response.headers.get("content-length"))
  if (declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel()
    throw new Error("检测响应超过 1 MB 限制。")
  }
  if (!response.body) throw new Error("检测接口返回空响应。")
  const reader = response.body.getReader()
  const chunks = []
  let length = 0
  const abort = () => {
    void reader.cancel().catch(() => {})
  }
  signal.addEventListener("abort", abort, { once: true })
  try {
    while (true) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) break
      length += value.byteLength
      if (length > MAX_RESPONSE_BYTES)
        throw new Error("检测响应超过 1 MB 限制。")
      chunks.push(value)
    }
    return new TextDecoder().decode(Buffer.concat(chunks))
  } finally {
    signal.removeEventListener("abort", abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function responseOutput(data) {
  return (Array.isArray(data.output) ? data.output : [])
    .filter((item) => item.type === "message")
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .filter(
      (part) => part.type === "output_text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("")
}

function upstreamError(data) {
  if (data?.error || data?.type === "error") {
    throw new Error(
      `上游错误：${typeof data.error?.message === "string" ? data.error.message : "检测请求失败"}`,
    )
  }
}

function parseJsonReply(data, api) {
  upstreamError(data)
  if (!data || typeof data !== "object")
    throw new Error("检测响应必须是 JSON 对象。")
  let text, finish
  if (api === "chat_completions") {
    const choice = data.choices?.[0]
    if (choice?.message?.refusal) throw new Error("模型拒绝了检测请求。")
    text = choice?.message?.content
    finish = choice?.finish_reason
  } else if (api === "messages") {
    text = (Array.isArray(data.content) ? data.content : [])
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("")
    finish = data.stop_reason
  } else {
    text = responseOutput(data)
    finish = data.status
  }
  if (
    typeof text !== "string" ||
    !["stop", "end_turn", "completed"].includes(finish)
  )
    throw new Error("检测响应未正常完成，不能评分。")
  return {
    text,
    responseModel: typeof data.model === "string" ? data.model : null,
  }
}

function createSseParser(api) {
  let text = "",
    finish = "",
    terminal = false,
    responseModel = null
  const metadata = (data) => {
    if (typeof data?.model === "string") responseModel = data.model
  }
  const accept = (frame) => {
    const payload = frame
      .split(/\r\n|\r|\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
    if (!payload) return
    if (payload.trim() === "[DONE]") {
      terminal = true
      return
    }
    let data
    try {
      data = JSON.parse(payload)
    } catch {
      throw new Error("SSE 检测响应含无效 JSON。")
    }
    upstreamError(data)
    if (!data || typeof data !== "object")
      throw new Error("SSE 数据必须是 JSON 对象。")
    metadata(data)
    if (api === "chat_completions") {
      const choices = Array.isArray(data.choices) ? data.choices : []
      const choice = choices.find((item) => item.index === 0) ?? choices[0]
      if (choice?.delta?.refusal) throw new Error("模型拒绝了检测请求。")
      if (typeof choice?.delta?.content === "string")
        text += choice.delta.content
      if (choice?.finish_reason) {
        finish = choice.finish_reason
        terminal = true
      }
    } else if (api === "messages") {
      if (data.type === "message_start") metadata(data.message)
      if (
        data.type === "content_block_start" &&
        data.content_block?.type === "text"
      )
        text += data.content_block.text ?? ""
      if (
        data.type === "content_block_delta" &&
        data.delta?.type === "text_delta"
      )
        text += data.delta.text ?? ""
      if (data.type === "message_delta")
        finish = data.delta?.stop_reason || finish
      if (data.type === "message_stop") terminal = true
    } else {
      if (data.response) metadata(data.response)
      if (
        data.type === "response.output_text.delta" &&
        typeof data.delta === "string"
      )
        text += data.delta
      if (
        data.type === "response.output_text.done" &&
        !text &&
        typeof data.text === "string"
      )
        text = data.text
      if (data.type === "response.completed") {
        finish = data.response?.status || "completed"
        terminal = true
        const full = responseOutput(data.response ?? {})
        if (full) text = full
      }
      if (
        [
          "response.failed",
          "response.incomplete",
          "response.refusal.delta",
        ].includes(data.type)
      )
        throw new Error("检测响应未正常完成，不能评分。")
    }
  }
  return { accept, snapshot: () => ({ text, responseModel, terminal, finish }) }
}

async function readStreamingReply(response, signal, config, challenge, update) {
  if (!response.body) throw new Error("检测接口返回空响应。")
  const reader = response.body.getReader(),
    decoder = new TextDecoder(),
    parser = createSseParser(config.api)
  let pending = "",
    bytes = 0,
    truncated = false
  const abort = () => {
    void reader.cancel().catch(() => {})
  }
  signal.addEventListener("abort", abort, { once: true })
  const report = (final) => {
    const state = parser.snapshot()
    const numbers = parseNumbers(
      final ? state.text : state.text.replace(/\d+$/, ""),
    )
    const used = config.looseMode
      ? numbers.slice(0, challenge.expected_count)
      : numbers
    update(used.join(", "), used.length, state.responseModel)
    if (
      !final &&
      config.looseMode &&
      numbers.length >= challenge.expected_count
    )
      truncated = true
  }
  try {
    while (!truncated) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) {
        pending += decoder.decode()
        break
      }
      bytes += value.byteLength
      if (bytes > MAX_RESPONSE_BYTES)
        throw new Error("检测响应超过 1 MB 限制。")
      pending += decoder.decode(value, { stream: true })
      const frames = pending.split(/\r\n\r\n|\n\n|\r\r/)
      pending = frames.pop()
      for (const frame of frames) {
        parser.accept(frame)
        report(false)
        if (truncated) break
      }
    }
    if (!truncated && pending.trim()) parser.accept(pending)
    const state = parser.snapshot()
    if (
      !truncated &&
      (!state.terminal ||
        !["stop", "end_turn", "completed"].includes(state.finish))
    )
      throw new Error("SSE 检测响应未正常完成，不能评分。")
    report(true)
    return { ...state, truncated }
  } finally {
    signal.removeEventListener("abort", abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

async function sampleChallenge(
  config,
  challenge,
  fetchImpl,
  outerSignal,
  update = () => {},
) {
  const timeout = AbortSignal.timeout(config.timeoutSeconds * 1000)
  const signal = outerSignal ? AbortSignal.any([timeout, outerSignal]) : timeout
  const sample = {
    state: "failed",
    count: 0,
    expected_count: challenge.expected_count,
    response_model: null,
    error: null,
    text: "",
  }
  const report = () => update({ ...sample })
  try {
    signal.throwIfAborted()
    sample.state = "waiting"
    report()
    const request = buildRequest(
      { ...config, parallel: config.parallel ? 3 : 1 },
      challenge.prompt,
    )
    if ("error" in request) throw new Error(request.error)
    const headers = new Headers(request.headers)
    for (const [key, value] of Object.entries(config.headers))
      headers.set(key, value)
    const response = await fetchImpl(request.url, {
      method: "POST",
      headers,
      body: JSON.stringify(request.body),
      redirect: "error",
      signal,
    })
    if (!response.ok)
      throw new Error(
        `HTTP ${response.status}: ${await readBoundedResponse(response, signal)}`,
      )
    const parsed = response.headers
      .get("content-type")
      ?.toLowerCase()
      .includes("text/event-stream")
      ? await readStreamingReply(
          response,
          signal,
          config,
          challenge,
          (text, count, responseModel) => {
            Object.assign(sample, {
              state: "streaming",
              text,
              count,
              response_model: responseModel
                ? safeError(responseModel, config.apiKey, config.headers)
                : null,
            })
            report()
          },
        )
      : parseJsonReply(
          JSON.parse(await readBoundedResponse(response, signal)),
          config.api,
        )
    const numbers = parseNumbers(parsed.text)
    const minimum = Math.max(80, Math.ceil(challenge.expected_count * 0.55))
    sample.count = config.looseMode
      ? Math.min(numbers.length, challenge.expected_count)
      : numbers.length
    sample.text = (
      config.looseMode ? numbers.slice(0, challenge.expected_count) : numbers
    ).join(", ")
    sample.response_model = parsed.responseModel
      ? safeError(parsed.responseModel, config.apiKey, config.headers)
      : null
    if (numbers.length < minimum)
      throw new Error(
        `有效整数不足：收到 ${numbers.length} 个，至少需要 ${minimum} 个。`,
      )
    sample.state =
      parsed.truncated ||
      (config.looseMode && numbers.length > challenge.expected_count)
        ? "truncated"
        : "complete"
    report()
    return {
      sample,
      output: {
        text: sample.text,
        expected_count: challenge.expected_count,
      },
    }
  } catch (error) {
    sample.state = outerSignal?.aborted ? "cancelled" : "failed"
    sample.error = outerSignal?.aborted
      ? "检测已取消。"
      : timeout.aborted
        ? `检测请求超过 ${config.timeoutSeconds} 秒。`
        : safeError(error, config.apiKey, config.headers)
    report()
    return {
      sample,
      output: { text: "", expected_count: challenge.expected_count },
    }
  }
}

/** Run real lmfpd challenge generation/scoring through the service's SSRF-safe transport. */
export async function runDetection(
  input,
  { fetchImpl, signal, detector, onProgress } = {},
) {
  const config = normalizeDetectionInput(input)
  if (typeof fetchImpl !== "function")
    throw new Error("runDetection requires the server safe fetchImpl.")
  const reference = detector ?? (await loadReferenceDetector())
  const challenges = generateChallenges(config.count)
  const update = (index) => (sample) =>
    onProgress?.({ type: "sample", index, sample })
  for (const [index, challenge] of challenges.entries())
    update(index)({
      state: "queued",
      count: 0,
      expected_count: challenge.expected_count,
      text: "",
      response_model: null,
      error: null,
    })
  let results
  if (config.parallel)
    results = await Promise.all(
      challenges.map((challenge, index) =>
        sampleChallenge(config, challenge, fetchImpl, signal, update(index)),
      ),
    )
  else {
    results = []
    for (const [index, challenge] of challenges.entries())
      results.push(
        await sampleChallenge(
          config,
          challenge,
          fetchImpl,
          signal,
          update(index),
        ),
      )
  }
  const samples = results.map((result) => result.sample)
  let analysis = null
  let error = null
  if (
    samples.some((sample) => ["complete", "truncated"].includes(sample.state))
  ) {
    try {
      if (config.autoVerify)
        analysis = reference.analyze(
          results.map((result) => result.output),
          { strict: !config.looseMode },
        )
    } catch (failure) {
      error = safeError(failure, config.apiKey, config.headers)
    }
  } else error = "本轮没有有效样本，请查看各请求的错误信息。"
  return {
    preset: config.preset,
    api: config.api,
    referenceBuiltAt: reference.builtAt,
    samples,
    outputs: results.map((result) => result.output),
    verificationPending: !config.autoVerify && !error,
    looseMode: config.looseMode,
    analysis,
    error,
    disclaimer: DETECTION_DISCLAIMER,
  }
}

/** Score a retained collection without making another model API request. */
export async function analyzeDetectionOutputs(
  outputs,
  { detector, looseMode = true } = {},
) {
  const reference = detector ?? (await loadReferenceDetector())
  return {
    analysis: reference.analyze(outputs, { strict: !looseMode }),
    referenceBuiltAt: reference.builtAt,
  }
}
