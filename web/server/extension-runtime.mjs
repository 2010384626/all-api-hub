import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Worker } from "node:worker_threads"

import { AppError, requireValue } from "./errors.mjs"
import { safeFetch } from "./network.mjs"

export class ExtensionEventBuffer {
  constructor(limit = 300) {
    this.limit = limit
    this.sequence = 0
    this.entries = []
  }
  push(event, args) {
    this.entries.push({ id: ++this.sequence, event, args })
    if (this.entries.length > this.limit) this.entries.shift()
  }
  since(after = 0) {
    const cursor = Number(after)
    requireValue(Number.isSafeInteger(cursor) && cursor >= 0, "事件游标无效")
    return {
      events: this.entries.filter((entry) => entry.id > cursor),
      cursor: this.sequence,
      reset: this.entries.length > 0 && cursor < this.entries[0].id - 1,
    }
  }
}

/** Isolate upstream globals and background timers from the HTTP server. */
export async function createExtensionRuntime({
  store,
  extensionPath = fileURLToPath(new URL("../dist", import.meta.url)),
  bundlePath = fileURLToPath(
    new URL("./generated/background.mjs", import.meta.url),
  ),
  fetchImpl = safeFetch,
  workerFactory = (url, options) => new Worker(url, options),
}) {
  requireValue(store, "Encrypted store is required", 500)
  const initialState = (await store.read()).extensionState || {}
  let manifest
  try {
    manifest = JSON.parse(
      await readFile(path.join(extensionPath, "manifest.json"), "utf8"),
    )
  } catch {
    manifest = {
      name: "All API Hub Web",
      version: "0.2.0",
      permissions: ["storage", "alarms"],
      host_permissions: ["https://*/*"],
    }
  }
  const events = new ExtensionEventBuffer(),
    pending = new Map(),
    network = new Map()
  let sequence = 0,
    stopped = false,
    storageFailed = false
  const worker = workerFactory(
    new URL("../runtime/worker.mjs", import.meta.url),
    {
      workerData: { initialState, manifest, extensionPath, bundlePath },
      execArgv: [],
    },
  )
  const ready = new Promise((resolve, reject) =>
    pending.set("ready", { resolve, reject }),
  )
  function rejectPending(error) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    pending.clear()
  }
  worker.on("error", (error) => rejectPending(error))
  worker.on("exit", (code) => {
    stopped = true
    rejectPending(new Error(`Extension runtime exited (${code})`))
  })
  worker.on("message", async (message) => {
    if (message.type === "event") {
      events.push(message.event, message.args)
      return
    }
    if (message.type === "abort") {
      network.get(message.id)?.abort()
      return
    }
    if (message.type === "persist") {
      try {
        await store.mutate((state) => {
          state.extensionState = message.state
        })
        storageFailed = false
        worker.postMessage({ type: "reply", id: message.id, value: true })
      } catch {
        storageFailed = true
        worker.postMessage({
          type: "reply",
          id: message.id,
          error: "加密存储写入失败，请检查磁盘空间和权限",
        })
      }
      return
    }
    if (message.type === "fetch") {
      const controller = new AbortController()
      network.set(message.id, controller)
      try {
        const { url, method, headers, body } = message.input
        const response = await fetchImpl(url, {
          method,
          headers,
          body: body == null ? undefined : Buffer.from(body),
          signal: controller.signal,
        })
        worker.postMessage({
          type: "reply",
          id: message.id,
          value: {
            status: response.status,
            statusText: response.statusText,
            headers: [...response.headers],
            body: [204, 205, 304].includes(response.status)
              ? null
              : new Uint8Array(await response.arrayBuffer()),
          },
        })
      } catch (error) {
        worker.postMessage({
          type: "reply",
          id: message.id,
          error: error instanceof AppError ? error.message : "上游请求失败",
        })
      } finally {
        network.delete(message.id)
      }
      return
    }
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error)
      entry.reject(new AppError(message.status || 500, message.error))
    else entry.resolve(message.value)
  })
  function command(type, value) {
    if (stopped)
      return Promise.reject(new AppError(503, "后台服务已停止，请重启服务"))
    const id = ++sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new AppError(504, "后台操作超时"))
      }, 180_000)
      timer.unref()
      pending.set(id, { resolve, reject, timer })
      worker.postMessage({ type, id, ...value })
    })
  }
  const readyTimer = setTimeout(
    () =>
      pending
        .get("ready")
        ?.reject(new Error("Background startup exceeded 120 seconds")),
    120_000,
  )
  try {
    await ready
  } catch (error) {
    await worker.terminate()
    throw error
  } finally {
    clearTimeout(readyTimer)
  }
  return {
    id: "all-api-hub-web",
    manifest,
    get failed() {
      return stopped || storageFailed
    },
    bootstrap: () => ({
      id: "all-api-hub-web",
      manifest,
      eventCursor: events.sequence,
    }),
    call: (method, args) => command("call", { method, args }),
    events: (after, clientId) => {
      worker.postMessage({ type: "touch", clientId })
      return events.since(after)
    },
    acquireLock: (name, clientId) => command("acquire", { name, clientId }),
    releaseLock: (id, clientId) => command("release", { lockId: id, clientId }),
    releaseClient: (sessionId) => command("releaseClient", { sessionId }),
    importBackup: (payload) => command("importBackup", { payload }),
    async close() {
      for (const controller of network.values()) controller.abort()
      try {
        await command("close", {})
      } finally {
        await worker.terminate()
      }
    },
  }
}
