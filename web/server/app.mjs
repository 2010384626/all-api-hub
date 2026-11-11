import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  checkinAccount,
  listKeys,
  listModels,
  parseImport,
  publicAccount,
  refreshAccount,
  validateAccount,
} from "./accounts.mjs"
import { CLIENT_PRESETS, runDetection } from "./detector.mjs"
import { AppError, requireValue } from "./errors.mjs"
import { legacyAccountsToBackup } from "./legacy-migration.mjs"
import { safeFetch } from "./network.mjs"
import { Store } from "./store.mjs"

const publicDirectory = fileURLToPath(new URL("../public/", import.meta.url))
const cookieName = "aah_session"
const dayKey = (date = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(date)
const digest = (value) => createHash("sha256").update(value).digest()
const equal = (a, b) =>
  timingSafeEqual(digest(String(a || "")), digest(String(b || "")))
export async function readJson(req, limit = 1024 * 1024) {
  requireValue(
    req.headers["content-type"]?.split(";")[0] === "application/json",
    "请求需要 application/json",
    415,
  )
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    requireValue(size <= limit, "请求体超过大小限制", 413)
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString())
  } catch {
    throw new AppError(400, "JSON 格式错误")
  }
}

export async function createApp({
  env = process.env,
  fetchImpl = safeFetch,
  detect = runDetection,
  runtimeFactory,
  nativeDirectory = fileURLToPath(new URL("../dist/", import.meta.url)),
} = {}) {
  requireValue(
    typeof env.ADMIN_PASSWORD === "string" && env.ADMIN_PASSWORD.length >= 16,
    "ADMIN_PASSWORD must have at least 16 characters",
    500,
  )
  const base = env.BASE_PATH || "/"
  requireValue(
    /^\/(?:[A-Za-z0-9_-]+\/)*$/.test(base),
    "BASE_PATH must start and end with /",
    500,
  )
  const originUrl = new URL(env.PUBLIC_ORIGIN || "http://localhost:3000")
  requireValue(
    ["http:", "https:"].includes(originUrl.protocol) &&
      originUrl.pathname === "/" &&
      !originUrl.search &&
      !originUrl.hash &&
      !originUrl.username &&
      !originUrl.password,
    "PUBLIC_ORIGIN must be an HTTP(S) origin without path",
    500,
  )
  const origin = originUrl.origin
  const store = new Store(
    env.DATA_DIR || fileURLToPath(new URL("../data", import.meta.url)),
    env.ENCRYPTION_KEY,
  )
  await store.read() // Fail startup on corruption or a wrong encryption key.
  const nativeRuntime = runtimeFactory
    ? await runtimeFactory({ store, fetchImpl })
    : null
  const salt = randomBytes(16)
  const passwordHash = scryptSync(env.ADMIN_PASSWORD, salt, 32)
  const sessions = new Map(),
    attempts = new Map(),
    busyAccounts = new Set()
  let detectionBusy = false,
    schedulerBusy = false
  const json = (res, status, data) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" })
    res.end(JSON.stringify(data))
  }
  const cookie = (value) =>
    `${cookieName}=${value}; Path=${base}; HttpOnly; SameSite=Strict; Max-Age=${value ? 43200 : 0}${originUrl.protocol === "https:" ? "; Secure" : ""}`
  function getSession(req) {
    const value = req.headers.cookie
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith(cookieName + "="))
      ?.slice(cookieName.length + 1)
    const session = value && sessions.get(value)
    if (session && session.expires > Date.now())
      return { ...session, id: value }
    if (value) sessions.delete(value)
    return null
  }
  async function accountAction(id, action, automatic = false) {
    requireValue(!busyAccounts.has(id), "此账号有操作正在执行", 409)
    busyAccounts.add(id)
    try {
      const account = (await store.read()).accounts.find((x) => x.id === id)
      requireValue(account, "账号不存在", 404)
      if (automatic) {
        if (
          !account.autoCheckin ||
          account.lastAutoAttempt === dayKey() ||
          (account.lastCheckin &&
            dayKey(new Date(account.lastCheckin)) === dayKey())
        )
          return publicAccount(account)
        await store.mutate((state) => {
          const saved = state.accounts.find((x) => x.id === id)
          if (saved) saved.lastAutoAttempt = dayKey()
        })
      }
      let patch
      try {
        patch = await (action === "checkin"
          ? checkinAccount(account, fetchImpl)
          : refreshAccount(account, fetchImpl))
      } catch (error) {
        await store.mutate((state) => {
          const saved = state.accounts.find((x) => x.id === id)
          if (saved && saved.revision === account.revision)
            saved.lastError =
              error instanceof AppError ? error.message : "上游操作失败"
        })
        throw error
      }
      return await store.mutate((state) => {
        const saved = state.accounts.find((x) => x.id === id)
        requireValue(
          saved && saved.revision === account.revision,
          "账号配置已改变，请重新操作",
          409,
        )
        Object.assign(saved, patch)
        state.history.unshift({
          accountId: id,
          action,
          at: new Date().toISOString(),
          balance: saved.balance ?? null,
        })
        state.history = state.history.slice(0, 2000)
        return publicAccount(saved)
      })
    } finally {
      busyAccounts.delete(id)
    }
  }
  async function tick() {
    if (schedulerBusy) return
    schedulerBusy = true
    try {
      const state = await store.read()
      for (const account of state.accounts.filter((a) => a.autoCheckin)) {
        try {
          await accountAction(account.id, "checkin", true)
        } catch {
          /* Persisted account error is visible in the dashboard. */
        }
      }
    } finally {
      schedulerBusy = false
    }
  }
  const handler = async (req, res) => {
    res.setHeader("cache-control", "no-store")
    res.setHeader("x-content-type-options", "nosniff")
    res.setHeader("referrer-policy", "no-referrer")
    res.setHeader(
      "content-security-policy",
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'",
    )
    try {
      const pathname = new URL(req.url, origin).pathname
      if (base !== "/" && pathname === base.slice(0, -1)) {
        res.writeHead(308, { location: base })
        res.end()
        return
      }
      requireValue(pathname.startsWith(base), "页面不存在", 404)
      const route = pathname.slice(base.length)
      const method = req.method
      if (route === "api/health" && method === "GET") {
        json(res, nativeRuntime?.failed ? 503 : 200, {
          ok: !nativeRuntime?.failed,
        })
        return
      }
      if (!route.startsWith("api/")) {
        requireValue(
          method === "GET" || method === "HEAD",
          "不支持的请求方法",
          405,
        )
        const files = {
          "": ["index.html", "text/html"],
          "index.html": ["index.html", "text/html"],
          "app.js": ["app.js", "text/javascript"],
          "style.css": ["style.css", "text/css"],
        }
        const file = Object.hasOwn(files, route) ? files[route] : null
        if (!file && nativeRuntime) {
          requireValue(getSession(req), "请先登录", 401)
          let decoded
          try {
            decoded = decodeURIComponent(route)
          } catch {
            throw new AppError(400, "无效路径")
          }
          const asset = path.resolve(nativeDirectory, decoded)
          requireValue(
            asset.startsWith(path.resolve(nativeDirectory) + path.sep) &&
              !decoded.split(/[\\/]/).some((part) => part.startsWith(".")) &&
              !/sponsor-catalog|partners\//i.test(decoded),
            "页面不存在",
            404,
          )
          const types = {
            ".html": "text/html",
            ".js": "text/javascript",
            ".mjs": "text/javascript",
            ".css": "text/css",
            ".json": "application/json",
            ".png": "image/png",
            ".svg": "image/svg+xml",
            ".webp": "image/webp",
            ".woff2": "font/woff2",
            ".wasm": "application/wasm",
            ".ico": "image/x-icon",
            ".jpg": "image/jpeg",
          }
          const mime = types[path.extname(asset)]
          requireValue(mime, "页面不存在", 404)
          try {
            requireValue((await stat(asset)).isFile(), "页面不存在", 404)
            const bytes = await readFile(asset)
            res.writeHead(200, { "content-type": mime })
            res.end(method === "HEAD" ? undefined : bytes)
            return
          } catch (error) {
            if (error.code === "ENOENT") throw new AppError(404, "页面不存在")
            throw error
          }
        }
        requireValue(file, "页面不存在", 404)
        const content = await readFile(path.join(publicDirectory, file[0]))
        res.writeHead(200, { "content-type": `${file[1]}; charset=utf-8` })
        res.end(method === "HEAD" ? undefined : content)
        return
      }
      if (!["GET", "HEAD"].includes(method)) {
        requireValue(
          !req.headers.origin || req.headers.origin === origin,
          "来源校验失败",
          403,
        )
        requireValue(
          req.headers["sec-fetch-site"] !== "cross-site",
          "不允许跨站请求",
          403,
        )
      }
      if (route === "api/login" && method === "POST") {
        const now = Date.now()
        for (const [key, value] of attempts)
          if (value.until <= now) attempts.delete(key)
        const ip = req.socket.remoteAddress
        const record = attempts.get(ip) || {
          count: 0,
          until: now + 15 * 60_000,
        }
        requireValue(
          record.count < 10 && attempts.size < 5000,
          "登录尝试过多，请 15 分钟后再试",
          429,
        )
        record.count++
        attempts.set(ip, record)
        const input = await readJson(req)
        requireValue(
          typeof input?.password === "string" && input.password.length <= 1024,
          "密码错误",
          401,
        )
        const supplied = scryptSync(input.password, salt, 32)
        requireValue(timingSafeEqual(supplied, passwordHash), "密码错误", 401)
        attempts.delete(ip)
        for (const [key, value] of sessions)
          if (value.expires < now) sessions.delete(key)
        if (sessions.size >= 64) sessions.delete(sessions.keys().next().value)
        const id = randomBytes(32).toString("hex"),
          csrfToken = randomBytes(32).toString("hex")
        sessions.set(id, { csrfToken, expires: now + 12 * 3600_000 })
        res.setHeader("set-cookie", cookie(id))
        json(res, 200, { authenticated: true, csrfToken })
        return
      }
      const session = getSession(req)
      if (route === "api/session" && method === "GET") {
        json(res, 200, {
          authenticated: Boolean(session),
          csrfToken: session?.csrfToken,
        })
        return
      }
      requireValue(session, "请先登录", 401)
      if (!["GET", "HEAD"].includes(method))
        requireValue(
          equal(req.headers["x-csrf-token"], session.csrfToken),
          "页面会话已过期，请刷新后重试",
          403,
        )
      if (route === "api/logout" && method === "POST") {
        await nativeRuntime?.releaseClient?.(session.id)
        sessions.delete(session.id)
        res.setHeader("set-cookie", cookie(""))
        json(res, 200, { ok: true })
        return
      }
      if (route.startsWith("api/extension/")) {
        requireValue(nativeRuntime, "原版工作空间未构建", 503)
        const rawClient = req.headers["x-aah-client"]
        requireValue(
          typeof rawClient === "string" && /^[\w-]{1,100}$/.test(rawClient),
          "客户端标识无效",
        )
        const clientId = `${session.id}:${rawClient}`
        if (route === "api/extension/bootstrap" && method === "GET") {
          json(res, 200, await nativeRuntime.bootstrap())
          return
        }
        if (route === "api/extension/events" && method === "GET") {
          const cursor = Number(
            new URL(req.url, origin).searchParams.get("after") || 0,
          )
          requireValue(
            Number.isSafeInteger(cursor) && cursor >= 0,
            "事件游标无效",
          )
          json(res, 200, await nativeRuntime.events(cursor, clientId))
          return
        }
        if (route === "api/extension/call" && method === "POST") {
          const input = await readJson(req, 16 * 1024 * 1024)
          json(res, 200, {
            value: await nativeRuntime.call(input.path, input.args, clientId),
          })
          return
        }
        if (route === "api/extension/lock/acquire" && method === "POST") {
          const input = await readJson(req)
          json(res, 200, await nativeRuntime.acquireLock(input.name, clientId))
          return
        }
        if (route === "api/extension/lock/release" && method === "POST") {
          const input = await readJson(req)
          await nativeRuntime.releaseLock(input.id, clientId)
          json(res, 200, { ok: true })
          return
        }
        if (route === "api/extension/fetch" && method === "POST") {
          const input = await readJson(req)
          requireValue(
            input &&
              typeof input.url === "string" &&
              [
                "GET",
                "POST",
                "PUT",
                "PATCH",
                "DELETE",
                "HEAD",
                "OPTIONS",
                "PROPFIND",
                "MKCOL",
              ].includes(input.method || "GET"),
            "请求参数无效",
          )
          const headers = new Headers(input.headers)
          for (const name of [
            "host",
            "connection",
            "transfer-encoding",
            "content-length",
            "proxy-authorization",
            "proxy-connection",
            "upgrade",
          ])
            headers.delete(name)
          const controller = new AbortController()
          res.on("close", () => {
            if (!res.writableEnded) controller.abort()
          })
          const response = await fetchImpl(input.url, {
            method: input.method || "GET",
            headers,
            body: input.bodyBase64
              ? Buffer.from(input.bodyBase64, "base64")
              : undefined,
            signal: controller.signal,
          })
          json(res, 200, {
            status: response.status,
            statusText: response.statusText,
            headers: Object.fromEntries(response.headers),
            bodyBase64: Buffer.from(await response.arrayBuffer()).toString(
              "base64",
            ),
          })
          return
        }
        throw new AppError(404, "接口不存在")
      }
      if (route === "api/status" && method === "GET") {
        let upstream = { revision: "unknown" }
        try {
          upstream = JSON.parse(
            await readFile(
              new URL("../../deploy/upstream.json", import.meta.url),
              "utf8",
            ),
          )
        } catch {
          /* Version metadata is optional in development fixtures. */
        }
        json(res, 200, {
          version: "0.2.0",
          nativeWorkspace: Boolean(nativeRuntime),
          upstream,
          updateCommand: "bash deploy/update.sh",
          capabilities: nativeRuntime
            ? [
                "原版总览与账户管理",
                "API 凭据库、模型与密钥管理",
                "批量签到与服务器定时任务",
                "公告、余额历史与用量分析",
                "渠道管理与模型同步",
                "设置、导入导出与关于",
                "账户与凭据联动模型指纹检测",
              ]
            : [
                "New API / Sub2API 账号与余额",
                "API 凭据、模型和密钥列表",
                "New API 签到",
                "模型指纹检测",
                "加密持久化",
                "备份迁移",
              ],
          limitations: [
            "纯服务端无法读取用户本机浏览器登录态；网页交互验证码需在站点完成",
          ],
          sourceUrl:
            env.SOURCE_URL || "https://github.com/2010384626/all-api-hub",
        })
        return
      }
      if (route === "api/state" && method === "GET") {
        const state = await store.read()
        json(res, 200, {
          version: state.version,
          history: state.history,
          settings: state.settings,
          accounts: state.accounts.map(publicAccount),
        })
        return
      }
      if (route === "api/accounts" && method === "GET") {
        json(res, 200, {
          accounts: (await store.read()).accounts.map(publicAccount),
        })
        return
      }
      if (route === "api/accounts" && method === "POST") {
        const account = validateAccount(await readJson(req))
        await store.mutate((state) => {
          requireValue(state.accounts.length < 1000, "账号数量超过限制")
          state.accounts.push(account)
        })
        json(res, 201, { account: publicAccount(account) })
        return
      }
      const match = route.match(
        /^api\/accounts\/([\w-]+)(?:\/(refresh|checkin|models|keys))?$/,
      )
      if (match) {
        const [, id, action] = match
        if (!action && method === "PATCH") {
          const input = await readJson(req)
          const account = await store.mutate((state) => {
            const index = state.accounts.findIndex((a) => a.id === id)
            requireValue(index >= 0, "账号不存在", 404)
            state.accounts[index] = validateAccount(
              input,
              state.accounts[index],
            )
            return publicAccount(state.accounts[index])
          })
          json(res, 200, { account })
          return
        }
        if (!action && method === "DELETE") {
          await store.mutate((state) => {
            requireValue(
              state.accounts.some((a) => a.id === id),
              "账号不存在",
              404,
            )
            state.accounts = state.accounts.filter((a) => a.id !== id)
          })
          json(res, 200, { ok: true })
          return
        }
        if (["refresh", "checkin"].includes(action) && method === "POST") {
          json(res, 200, { account: await accountAction(id, action) })
          return
        }
        if (["models", "keys"].includes(action) && method === "GET") {
          const account = (await store.read()).accounts.find((a) => a.id === id)
          requireValue(account, "账号不存在", 404)
          json(
            res,
            200,
            action === "models"
              ? { models: await listModels(account, fetchImpl) }
              : { keys: await listKeys(account, fetchImpl), limit: 100 },
          )
          return
        }
      }
      if (route === "api/export" && method === "GET") {
        // This explicit download is the only API returning saved credential secrets.
        res.setHeader(
          "content-disposition",
          'attachment; filename="all-api-hub-web-backup.json"',
        )
        json(res, 200, {
          accounts: (await store.read()).accounts,
          version: 1,
          format: "all-api-hub-web",
          scope: "accounts",
        })
        return
      }
      if (route === "api/import" && method === "POST") {
        const input = await readJson(req, 16 * 1024 * 1024)
        if (nativeRuntime && input.format !== "all-api-hub-web") {
          json(res, 200, await nativeRuntime.importBackup(input))
          return
        }
        const imported = parseImport(input)
        if (nativeRuntime) {
          json(
            res,
            200,
            await nativeRuntime.importBackup(
              legacyAccountsToBackup(imported.accounts),
            ),
          )
          return
        }
        const count = await store.mutate((state) => {
          let count = 0
          for (const account of imported.accounts) {
            if (
              state.accounts.some(
                (a) =>
                  a.baseUrl === account.baseUrl &&
                  a.userId === account.userId &&
                  a.token === account.token &&
                  a.apiKey === account.apiKey,
              )
            )
              continue
            requireValue(state.accounts.length < 1000, "账号数量超过限制")
            state.accounts.push(account)
            count++
          }
          return count
        })
        json(res, 200, { imported: count, skipped: imported.skipped })
        return
      }
      if (route === "api/detection/presets" && method === "GET") {
        json(res, 200, { presets: CLIENT_PRESETS })
        return
      }
      if (route === "api/detect" && method === "POST") {
        requireValue(!detectionBusy, "已有检测正在执行，请等待完成", 409)
        detectionBusy = true
        try {
          const input = await readJson(req)
          if (input.accountId) {
            const account = (await store.read()).accounts.find(
              (a) => a.id === input.accountId,
            )
            requireValue(account, "账号不存在", 404)
            input.apiKey = input.apiKey || account.apiKey
            input.baseUrl = input.baseUrl || account.baseUrl
          }
          const controller = new AbortController()
          res.on("close", () => {
            if (!res.writableEnded) controller.abort()
          })
          json(
            res,
            200,
            await detect(input, {
              fetchImpl,
              signal: AbortSignal.any([
                controller.signal,
                AbortSignal.timeout(180_000),
              ]),
            }),
          )
        } finally {
          detectionBusy = false
        }
        return
      }
      throw new AppError(404, "接口不存在")
    } catch (error) {
      if (res.destroyed) return
      const status =
        error instanceof AppError
          ? error.status
          : error.name === "DetectionInputError"
            ? 400
            : 500
      json(res, status, {
        error:
          error instanceof AppError || error.name === "DetectionInputError"
            ? error.message
            : "操作失败，请检查配置或稍后重试",
      })
    }
  }
  return {
    handler,
    store,
    tick: nativeRuntime ? async () => {} : tick,
    base,
    origin,
    runtime: nativeRuntime,
    close: async () => {
      await nativeRuntime?.close()
    },
  }
}
