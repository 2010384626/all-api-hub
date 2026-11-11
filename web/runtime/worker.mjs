import { readFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { parentPort, workerData } from "node:worker_threads"

import { createBrowserRuntime } from "./browser.mjs"

const pending = new Map()
let sequence = 0
let background
function parentCall(type, input) {
  const id = `worker:${++sequence}`
  let resolve, reject
  const result = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  pending.set(id, { resolve, reject })
  parentPort.postMessage({ type, id, ...input })
  return { id, result }
}
const runtime = createBrowserRuntime({
  initialState: workerData.initialState,
  manifest: workerData.manifest,
  persist: (state) => parentCall("persist", { state }).result,
  emit: (event, args) => parentPort.postMessage({ type: "event", event, args }),
})
globalThis.browser = runtime.browser
globalThis.chrome = runtime.browser
globalThis.__AAH_WEB__ = true
Object.defineProperty(globalThis.navigator, "locks", {
  configurable: true,
  value: runtime.locks,
})
globalThis.self = globalThis
globalThis.location = new URL("aah-extension:///background.js")
globalThis.fetch = async function (input, init) {
  const request = new Request(input, init)
  if (request.url.startsWith("aah-extension:")) {
    const relative = decodeURIComponent(new URL(request.url).pathname).replace(
      /^\/+/,
      "",
    )
    const filename = path.resolve(workerData.extensionPath, relative)
    if (!filename.startsWith(path.resolve(workerData.extensionPath) + path.sep))
      throw new Error("Invalid extension resource")
    return new Response(await readFile(filename), {
      headers: {
        "content-type": relative.endsWith(".json")
          ? "application/json"
          : "application/octet-stream",
      },
    })
  }
  request.signal.throwIfAborted()
  const { id, result } = parentCall("fetch", {
    input: {
      url: request.url,
      method: request.method,
      headers: [...request.headers],
      body: ["GET", "HEAD"].includes(request.method)
        ? null
        : new Uint8Array(await request.arrayBuffer()),
    },
  })
  const aborted = () => parentPort.postMessage({ type: "abort", id })
  request.signal.addEventListener("abort", aborted, { once: true })
  try {
    const response = await result
    request.signal.throwIfAborted()
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  } finally {
    request.signal.removeEventListener("abort", aborted)
  }
}
parentPort.on("message", async (message) => {
  if (message.type === "reply") {
    const operation = pending.get(message.id)
    pending.delete(message.id)
    if (operation) {
      if (message.error) operation.reject(new Error(message.error))
      else operation.resolve(message.value)
    }
    return
  }
  if (message.type === "touch") {
    runtime.locks.touch(message.clientId)
    return
  }
  try {
    let value
    if (message.type === "call")
      value = await runtime.call(message.method, message.args)
    else if (message.type === "acquire")
      value = await runtime.locks.acquire(message.name, message.clientId)
    else if (message.type === "release")
      value = runtime.locks.release(message.lockId, message.clientId)
    else if (message.type === "releaseClient")
      value = runtime.locks.releaseClient(message.sessionId)
    else if (message.type === "importBackup")
      value = await background.importBackup(message.payload)
    else if (message.type === "resolveDetectionCredential")
      value = await background.resolveDetectionCredential(
        message.sourceId,
        message.keyId,
      )
    else if (message.type === "close") {
      clearInterval(leases)
      await runtime.close()
      value = true
    } else throw new Error("Unknown worker command")
    parentPort.postMessage({ id: message.id, value })
  } catch (error) {
    parentPort.postMessage({
      id: message.id,
      error: error.message,
      status: error.status,
    })
  }
})
const leases = setInterval(() => runtime.locks.expire(), 10_000)
leases.unref()
try {
  background = await import(pathToFileURL(workerData.bundlePath).href)
  await background.initialize()
  runtime.startAlarms()
  parentPort.postMessage({ id: "ready", value: true })
} catch (error) {
  parentPort.postMessage({
    id: "ready",
    error: `后台初始化失败：${error.message}`,
  })
}
