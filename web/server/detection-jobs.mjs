import { randomUUID } from "node:crypto"

import {
  analyzeDetectionOutputs,
  normalizeDetectionInput,
  validateFingerprintHeaders,
} from "./detector.mjs"
import { AppError, requireValue } from "./errors.mjs"

const clone = (value) => structuredClone(value)
const targetFields = [
  "sourceId",
  "keyId",
  "sourceLabel",
  "baseUrl",
  "apiKey",
  "model",
  "preset",
  "api",
  "userAgent",
  "headers",
  "effort",
  "count",
  "timeoutSeconds",
  "stream",
  "parallel",
  "looseMode",
  "autoVerify",
  "serviceTier",
]
const configFields = [
  "preset",
  "api",
  "userAgent",
  "headers",
  "effort",
  "count",
  "timeoutSeconds",
  "stream",
  "parallel",
  "looseMode",
  "autoVerify",
  "serviceTier",
]

function normalizedConfig(input) {
  const normalized = normalizeDetectionInput({
    ...input,
    baseUrl: "https://configuration.invalid",
    apiKey: "configuration-placeholder",
    model: "configuration-placeholder",
  })
  return Object.fromEntries(
    configFields.map((field) => [
      field,
      field === "userAgent"
        ? normalized.headers["user-agent"]
        : field === "headers"
          ? { ...validateFingerprintHeaders(input.headers || {}) }
          : normalized[field],
    ]),
  )
}

function text(value, label, maximum = 200, optional = false) {
  requireValue(
    typeof value === "string" &&
      (optional || value.trim()) &&
      value.length <= maximum &&
      [...value].every((character) => character.charCodeAt(0) >= 32),
    `${label} 格式无效`,
  )
  return value.trim()
}

function normalizeTarget(input, previous) {
  requireValue(
    input && typeof input === "object" && !Array.isArray(input),
    "检测目标格式无效",
  )
  const target = { ...(previous || {}) }
  for (const field of targetFields)
    if (input[field] !== undefined) target[field] = clone(input[field])
  target.sourceId = target.sourceId || "manual"
  requireValue(
    target.sourceId === "manual" ||
      /^(account|profile):[^\s:]{1,200}$/.test(target.sourceId),
    "请选择有效的账户或 API 凭据",
  )
  target.keyId =
    target.keyId === undefined
      ? undefined
      : text(target.keyId, "密钥标识", 200, true)
  target.sourceLabel = target.sourceLabel
    ? text(target.sourceLabel, "来源名称")
    : ""
  target.model = text(target.model, "模型名称", 256)
  if (previous && target.sourceId !== previous.sourceId) {
    for (const field of ["apiKey", "baseUrl", "headers"])
      if (input[field] === undefined) delete target[field]
  }
  if (input.apiKey === "" && previous?.sourceId === target.sourceId)
    target.apiKey = previous.apiKey
  const config = normalizeDetectionInput({
    ...target,
    baseUrl:
      target.sourceId === "manual"
        ? target.baseUrl
        : "https://credential.invalid",
    apiKey:
      target.sourceId === "manual" ? target.apiKey : "resolved-at-runtime",
  })
  if (target.sourceId !== "manual") {
    delete target.apiKey
    delete target.baseUrl
  }
  return {
    ...target,
    preset: config.preset,
    api: config.api,
    userAgent: config.headers["user-agent"],
    count: config.count,
    timeoutSeconds: config.timeoutSeconds,
    stream: config.stream,
    parallel: config.parallel,
    looseMode: config.looseMode,
    autoVerify: config.autoVerify,
    serviceTier: config.serviceTier,
  }
}

export function normalizeDetectionTiming(input) {
  requireValue(input && typeof input === "object", "请设置执行时间")
  if (input.type === "interval") {
    requireValue(
      Number.isInteger(input.everyMinutes) &&
        input.everyMinutes >= 5 &&
        input.everyMinutes <= 525600,
      "间隔需为 5–525600 分钟",
    )
    return { type: "interval", everyMinutes: input.everyMinutes }
  }
  requireValue(
    input.type === "daily" &&
      typeof input.at === "string" &&
      /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.at),
    "每日时间需为 HH:mm",
  )
  requireValue(
    !input.timeZone || input.timeZone === "Asia/Shanghai",
    "每日任务使用 Asia/Shanghai 时区",
  )
  return { type: "daily", at: input.at, timeZone: "Asia/Shanghai" }
}

export function nextDetectionRun(timing, now) {
  if (timing.type === "interval") return now + timing.everyMinutes * 60_000
  const localDate = new Date(now + 8 * 3600_000).toISOString().slice(0, 10)
  let candidate = Date.parse(`${localDate}T${timing.at}:00+08:00`)
  if (candidate <= now) candidate += 24 * 3600_000
  return candidate
}

function publicSchedule(schedule) {
  const { apiKey, headers, ...target } = schedule.target
  return {
    ...clone(schedule),
    target: {
      ...target,
      hasApiKey: Boolean(apiKey),
      headerNames: Object.keys(headers || {}),
    },
  }
}

function secretValues(input) {
  return [
    input?.apiKey,
    ...Object.values(input?.headers || {}),
    ...Object.values(input?.requestHeaders || {}),
  ]
    .filter((value) => typeof value === "string" && value.length > 0)
    .sort((a, b) => b.length - a.length)
}

function scrub(value, secrets) {
  if (typeof value === "string") {
    for (const secret of secrets) value = value.replaceAll(secret, "[REDACTED]")
    return value
  }
  if (Array.isArray(value)) return value.map((item) => scrub(item, secrets))
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            ![
              "apiKey",
              "headers",
              "requestHeaders",
              "raw_text",
              "prompt",
            ].includes(key),
        )
        .map(([key, item]) => [
          key,
          // These texts are reconstructed only from accepted integer samples.
          // Redacting a numeric custom header (for example retry-count: 0)
          // would corrupt the saved sample and change later verification.
          key === "text" && typeof item === "string" && /^[\d,\s]*$/.test(item)
            ? item
            : scrub(item, secrets),
        ]),
    )
  return value
}

function safeFailure(error, secrets) {
  return scrub(
    error instanceof AppError || error?.name === "DetectionInputError"
      ? error.message
      : "检测执行失败，请检查账户凭据和接口配置",
    secrets,
  )
}

async function abortable(operation, signal) {
  signal.throwIfAborted()
  let aborted
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => {
        aborted = () => reject(signal.reason)
        signal.addEventListener("abort", aborted, { once: true })
        if (signal.aborted) aborted()
      }),
    ])
  } finally {
    if (aborted) signal.removeEventListener("abort", aborted)
  }
}

/** Own persisted detector runs and scheduling in the same encrypted store. */
export async function createDetectionJobs({
  store,
  detect,
  resolveCredential,
  now = Date.now,
  maximumRunMs = 600_000,
  analyze = analyzeDetectionOutputs,
}) {
  requireValue(store && typeof detect === "function", "检测服务配置错误", 500)
  let active = null,
    ticking = false,
    closed = false
  await store.mutate((state) => {
    state.detectionHistory ??= []
    state.detectionSchedules ??= []
    for (const item of state.detectionHistory)
      if (item.status === "running") {
        item.status = "interrupted"
        item.finishedAt = now()
        item.result = { error: "服务重启中断了本次检测" }
      }
  })

  async function execute(input, options, controller) {
    const startedAt = now(),
      id = randomUUID()
    const target = {
      sourceId: input.sourceId || "manual",
      keyId: input.keyId,
      sourceLabel: input.sourceLabel || "",
      model: input.model || "",
      preset: input.preset || "standard",
      api: input.api,
    }
    let secrets = secretValues(input),
      config,
      result,
      status = "failed",
      thrown
    const entry = {
      id,
      createdAt: startedAt,
      startedAt,
      finishedAt: null,
      source: options.source || "manual",
      trigger: options.source || "manual",
      scheduleId: options.scheduleId || null,
      sourceId: target.sourceId,
      sourceLabel: target.sourceLabel,
      model: target.model,
      target: scrub(target, secrets),
      status: "running",
      result: null,
    }
    await store.mutate((state) => {
      state.detectionHistory.push(entry)
    })
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(maximumRunMs),
      ...(options.signal ? [options.signal] : []),
    ])
    try {
      signal.throwIfAborted()
      config = { ...input }
      if (input.sourceId && input.sourceId !== "manual") {
        requireValue(
          typeof resolveCredential === "function",
          "账户凭据服务不可用",
          503,
        )
        const credential = await abortable(
          () =>
            resolveCredential({
              sourceId: input.sourceId,
              keyId: input.keyId,
              signal,
            }),
          signal,
        )
        requireValue(
          credential?.baseUrl && credential?.apiKey,
          "所选账户没有可用的模型调用密钥",
        )
        config = {
          ...input,
          baseUrl: credential.baseUrl,
          apiKey: credential.apiKey,
          headers: {
            ...(credential.requestHeaders || credential.headers || {}),
            ...(input.headers || {}),
          },
        }
        secrets = [...new Set([...secrets, ...secretValues(config)])]
      }
      signal.throwIfAborted()
      result = await abortable(
        () => detect(config, { signal, onProgress: options.onProgress }),
        signal,
      )
      if (
        signal.aborted ||
        (result.samples?.length > 0 &&
          result.samples.every((sample) => sample.state === "cancelled"))
      )
        status = "cancelled"
      else if (result.verificationPending) status = "sampled"
      else if (
        !result.analysis ||
        result.error ||
        ["unscorable", "not_model"].includes(result.analysis.decision)
      )
        status = "failed"
      else if (
        result.analysis.decision === "partial" ||
        result.samples?.some((sample) =>
          ["failed", "cancelled"].includes(sample.state),
        )
      )
        status = "partial"
      else status = "success"
    } catch (error) {
      status = signal.aborted ? "cancelled" : "failed"
      result = {
        error: signal.aborted
          ? "检测已取消或超时"
          : safeFailure(error, secrets),
        samples: [],
        analysis: null,
      }
      thrown = new AppError(
        signal.aborted ? 499 : error.status || 502,
        result.error,
      )
    }
    const finishedAt = now(),
      safeResult = scrub(result, secrets)
    await store.mutate((state) => {
      const record = state.detectionHistory.find((item) => item.id === id)
      if (record)
        Object.assign(record, {
          status,
          finishedAt,
          result: safeResult,
          target: scrub(target, secrets),
          sourceLabel: scrub(entry.sourceLabel, secrets),
          model: scrub(entry.model, secrets),
        })
      const schedule = state.detectionSchedules.find(
        (item) => item.id === options.scheduleId,
      )
      if (schedule)
        Object.assign(schedule, {
          lastRunAt: startedAt,
          lastStatus: status,
          lastHistoryId: id,
          lastError: safeResult.error || null,
        })
    })
    if (thrown) {
      thrown.historyId = id
      throw thrown
    }
    return { ...safeResult, historyId: id }
  }

  function run(input, options = {}) {
    requireValue(!closed, "检测服务已停止", 503)
    requireValue(
      !active && (!ticking || options.source === "schedule"),
      "已有检测正在执行，请等待完成",
      409,
    )
    requireValue(
      input && typeof input === "object" && !Array.isArray(input),
      "检测参数无效",
    )
    const controller = new AbortController()
    const task = { controller, scheduleId: options.scheduleId }
    active = task
    task.promise = execute(input, options, controller).finally(() => {
      if (active === task) active = null
    })
    return task.promise
  }

  async function saveSchedule(input, id) {
    requireValue(
      input && typeof input === "object" && !Array.isArray(input),
      "任务配置无效",
    )
    const saved = await store.mutate((state) => {
      const previous = id
        ? state.detectionSchedules.find((item) => item.id === id)
        : undefined
      requireValue(!id || previous, "定时任务不存在", 404)
      const target =
        input.target === undefined && previous
          ? previous.target
          : normalizeTarget(input.target, previous?.target)
      const timing =
        input.timing === undefined && previous
          ? previous.timing
          : normalizeDetectionTiming(input.timing)
      const enabled =
        input.enabled === undefined
          ? (previous?.enabled ?? false)
          : input.enabled
      requireValue(typeof enabled === "boolean", "任务启用配置无效")
      const name =
        input.name === undefined && previous
          ? previous.name
          : text(input.name, "任务名称", 100)
      const timestamp = now()
      const changedTiming =
        JSON.stringify(timing) !== JSON.stringify(previous?.timing)
      const schedule = {
        ...previous,
        id: previous?.id || randomUUID(),
        name,
        target: clone(target),
        timing,
        enabled,
        createdAt: previous?.createdAt ?? timestamp,
        updatedAt: timestamp,
        nextRunAt: !enabled
          ? null
          : !previous?.enabled || changedTiming
            ? nextDetectionRun(timing, timestamp)
            : previous.nextRunAt,
      }
      if (previous)
        state.detectionSchedules[state.detectionSchedules.indexOf(previous)] =
          schedule
      else {
        requireValue(
          state.detectionSchedules.length < 500,
          "定时任务数量超过 500 个",
        )
        state.detectionSchedules.push(schedule)
      }
      return publicSchedule(schedule)
    })
    if (!saved.enabled && active?.scheduleId === saved.id)
      active.controller.abort()
    return saved
  }

  async function tick() {
    if (closed || ticking || active) return
    ticking = true
    try {
      const due = (await store.read()).detectionSchedules
        .filter((schedule) => schedule.enabled && schedule.nextRunAt <= now())
        .map((schedule) => schedule.id)
      for (const id of due) {
        if (closed || active) break
        const schedule = await store.mutate((state) => {
          const candidate = state.detectionSchedules.find(
            (item) => item.id === id,
          )
          if (!candidate?.enabled || candidate.nextRunAt > now()) return null
          // Reserve before the network request; restart never replays missed intervals in a burst.
          candidate.nextRunAt = nextDetectionRun(candidate.timing, now())
          return clone(candidate)
        })
        if (schedule)
          try {
            await run(schedule.target, {
              source: "schedule",
              scheduleId: schedule.id,
            })
          } catch (error) {
            if (!(error instanceof AppError)) throw error
          }
      }
    } finally {
      ticking = false
    }
  }

  return {
    run,
    tick,
    saveSchedule,
    async getConfig() {
      return normalizedConfig((await store.read()).detectionConfig || {})
    },
    async saveConfig(input) {
      requireValue(
        input && typeof input === "object" && !Array.isArray(input),
        "检测设置格式无效",
      )
      return store.mutate((state) => {
        const updated = { ...(state.detectionConfig || {}) }
        for (const field of configFields)
          if (input[field] !== undefined) updated[field] = clone(input[field])
        state.detectionConfig = normalizedConfig(updated)
        return clone(state.detectionConfig)
      })
    },
    async verifyHistory(id) {
      const record = (await store.read()).detectionHistory.find(
        (item) => item.id === id,
      )
      requireValue(record, "检测记录不存在", 404)
      requireValue(
        Array.isArray(record.result?.outputs) &&
          record.result.outputs.some((output) => output.text),
        "记录中没有可验证的有效样本",
      )
      const scored = await analyze(record.result.outputs, {
        looseMode: record.result.looseMode !== false,
      })
      const result = { ...record.result, ...scored, verificationPending: false }
      const status =
        !result.analysis ||
        ["unscorable", "not_model"].includes(result.analysis.decision)
          ? "failed"
          : result.analysis.decision === "partial"
            ? "partial"
            : "success"
      await store.mutate((state) => {
        const current = state.detectionHistory.find((item) => item.id === id)
        requireValue(current, "检测记录不存在", 404)
        Object.assign(current, { result, status, verifiedAt: now() })
      })
      return { ...result, historyId: id }
    },
    listSchedules: async () =>
      (await store.read()).detectionSchedules.map(publicSchedule),
    async deleteSchedule(id) {
      await store.mutate((state) => {
        requireValue(
          state.detectionSchedules.some((item) => item.id === id),
          "定时任务不存在",
          404,
        )
        state.detectionSchedules = state.detectionSchedules.filter(
          (item) => item.id !== id,
        )
      })
      if (active?.scheduleId === id) active.controller.abort()
    },
    async history({ offset = 0, limit = 20, sourceId, model } = {}) {
      offset = Number(offset)
      limit = Number(limit)
      requireValue(
        Number.isSafeInteger(offset) &&
          offset >= 0 &&
          Number.isSafeInteger(limit) &&
          limit > 0 &&
          limit <= 100,
        "历史分页参数无效",
      )
      const items = (await store.read()).detectionHistory
        .filter(
          (item) =>
            (!sourceId || item.sourceId === sourceId) &&
            (!model || item.model === model),
        )
        .reverse()
      return {
        items: items.slice(offset, offset + limit),
        total: items.length,
        offset,
        limit,
      }
    },
    async close() {
      closed = true
      const task = active
      task?.controller.abort()
      await task?.promise.catch(() => {})
    },
  }
}
