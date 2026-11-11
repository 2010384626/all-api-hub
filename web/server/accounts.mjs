import { randomUUID } from "node:crypto"

import { AppError, requireValue } from "./errors.mjs"
import { safeFetch, validateUrl } from "./network.mjs"

const TYPES = ["new-api", "sub2api", "credential"]
const clean = (v, max = 4096) =>
  typeof v === "string" &&
  v.length <= max &&
  ![...v].some((character) => [0, 10, 13].includes(character.charCodeAt(0)))
const numeric = (value) =>
  (typeof value === "number" ||
    (typeof value === "string" && value.trim() !== "")) &&
  Number.isFinite(Number(value))
export function validateAccount(input, old = {}) {
  requireValue(
    input && typeof input === "object" && !Array.isArray(input),
    "账号数据格式错误",
  )
  const account = { ...old }
  for (const field of [
    "name",
    "baseUrl",
    "token",
    "apiKey",
    "userId",
    "siteType",
  ]) {
    if (input[field] !== undefined) {
      requireValue(clean(input[field]), `${field} 格式错误`)
      account[field] = input[field].trim()
    }
  }
  requireValue(
    account.name && account.name.length <= 100,
    "账号名称为必填，最多 100 字",
  )
  requireValue(
    TYPES.includes(account.siteType),
    "仅支持 New API、Sub2API 或独立 API 凭据",
  )
  account.baseUrl = validateUrl(account.baseUrl).href.replace(/\/$/, "")
  requireValue(
    account.siteType === "credential" ? account.apiKey : account.token,
    "请填写管理访问令牌（独立 API 凭据填写 API Key）",
  )
  if (input.autoCheckin !== undefined)
    requireValue(typeof input.autoCheckin === "boolean", "自动签到配置错误")
  account.autoCheckin =
    account.siteType === "new-api" &&
    (input.autoCheckin ?? old.autoCheckin ?? false)
  if (
    old.id &&
    ["baseUrl", "siteType", "token", "userId", "apiKey"].some(
      (key) => account[key] !== old[key],
    )
  ) {
    for (const key of [
      "balance",
      "usedQuota",
      "requests",
      "lastRefresh",
      "lastCheckin",
      "lastAutoAttempt",
      "lastError",
      "modelCount",
    ])
      delete account[key]
  }
  account.id = old.id || randomUUID()
  account.revision = (old.revision || 0) + 1
  account.createdAt = old.createdAt || new Date().toISOString()
  return account
}

export function publicAccount(account) {
  const { token, apiKey, ...visible } = account
  return { ...visible, hasToken: Boolean(token), hasApiKey: Boolean(apiKey) }
}

export async function providerRequest(
  account,
  route,
  { method = "GET", body, inference = false, fetchImpl = safeFetch } = {},
) {
  const headers = {
    accept: "application/json",
    "user-agent": "AllAPIHub-Web/0.1",
  }
  const token = inference ? account.apiKey : account.token
  requireValue(
    token,
    inference ? "请先为此账号配置 API Key" : "请配置管理访问令牌",
  )
  headers.authorization = `Bearer ${token}`
  if (!inference && account.siteType === "new-api" && account.userId)
    headers["new-api-user"] = account.userId
  if (body) headers["content-type"] = "application/json"
  const response = await fetchImpl(`${account.baseUrl}${route}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!response.ok)
    throw new AppError(
      502,
      `上游返回 HTTP ${response.status}，请检查凭据、接口和站点防护`,
    )
  let result
  try {
    result = await response.json()
  } catch {
    throw new AppError(502, "上游没有返回 JSON，可能需要浏览器登录或验证")
  }
  if (
    !result ||
    typeof result !== "object" ||
    result.success === false ||
    (typeof result.code === "number" && result.code !== 0)
  ) {
    throw new AppError(
      502,
      "上游未接受请求，请检查令牌有效期、用户 ID 或是否已签到",
    )
  }
  return result.data ?? result
}

export async function refreshAccount(account, fetchImpl) {
  if (account.siteType === "credential") {
    const models = await listModels(account, fetchImpl)
    return {
      lastRefresh: new Date().toISOString(),
      modelCount: models.length,
      lastError: null,
    }
  }
  const data = await providerRequest(
    account,
    account.siteType === "sub2api" ? "/api/v1/auth/me" : "/api/user/self",
    { fetchImpl },
  )
  const rawBalance = account.siteType === "sub2api" ? data.balance : data.quota
  requireValue(numeric(rawBalance), "上游余额字段缺失或格式错误", 502)
  const balance = Number(rawBalance)
  return {
    balance: account.siteType === "sub2api" ? balance : balance / 500_000,
    usedQuota:
      account.siteType === "new-api" && numeric(data.used_quota)
        ? Number(data.used_quota) / 500_000
        : null,
    requests: numeric(data.request_count) ? Number(data.request_count) : null,
    lastRefresh: new Date().toISOString(),
    lastError: null,
  }
}

export async function listModels(account, fetchImpl) {
  const suffix = /\/v1$/.test(account.baseUrl) ? "/models" : "/v1/models"
  const data = await providerRequest(account, suffix, {
    inference: true,
    fetchImpl,
  })
  requireValue(Array.isArray(data), "上游模型列表格式错误", 502)
  return data
    .map((item) => (typeof item === "string" ? item : item?.id))
    .filter((x) => typeof x === "string")
    .slice(0, 5000)
}

export async function listKeys(account, fetchImpl) {
  requireValue(
    account.siteType !== "credential",
    "独立 API 凭据不提供站点密钥管理",
  )
  const data = await providerRequest(
    account,
    account.siteType === "sub2api"
      ? "/api/v1/keys?page=1&page_size=100"
      : "/api/token/?p=0&page_size=100",
    { fetchImpl },
  )
  const items = Array.isArray(data) ? data : data.items
  requireValue(Array.isArray(items), "上游密钥列表格式错误", 502)
  // Secret values are deliberately absent from the list response.
  return items.slice(0, 100).map((k) => ({
    id: k.id,
    name: k.name,
    status: k.status,
    quota: k.quota ?? k.remain_quota,
    usedQuota: k.quota_used ?? k.used_quota,
    key: k.key
      ? String(k.key).length <= 12
        ? "••••"
        : `${String(k.key).slice(0, 4)}…${String(k.key).slice(-4)}`
      : undefined,
  }))
}

export async function checkinAccount(account, fetchImpl) {
  requireValue(account.siteType === "new-api", "此站点类型不支持服务端签到")
  await providerRequest(account, "/api/user/checkin", {
    method: "POST",
    body: {},
    fetchImpl,
  })
  return { lastCheckin: new Date().toISOString(), lastError: null }
}

/** Import supported accounts, rejecting unknown types rather than changing their meaning. */
export function parseImport(payload) {
  requireValue(payload && typeof payload === "object", "备份格式错误")
  const isWeb = payload.format === "all-api-hub-web" && payload.version === 1
  requireValue(!payload.format || isWeb, "不支持此 Web 备份版本")
  requireValue(
    isWeb ||
      payload.version === undefined ||
      ["1.0", "2.0", "3.0", "4.0"].includes(payload.version),
    "不支持此扩展备份版本",
  )
  const accounts = isWeb ? payload.accounts : payload.accounts?.accounts
  requireValue(
    Array.isArray(accounts) && accounts.length <= 1000,
    "备份需包含最多 1000 个账号（Web 或扩展账号导出格式）",
  )
  const skipped = []
  const parsed = []
  for (const raw of accounts) {
    requireValue(
      raw && typeof raw === "object" && !Array.isArray(raw),
      "备份中的账号格式错误",
    )
    if (isWeb) {
      parsed.push(validateAccount(raw))
      continue
    }
    const type =
      raw.site_type === "new-api"
        ? "new-api"
        : raw.site_type === "sub2api"
          ? "sub2api"
          : null
    if (!type || !raw.account_info?.access_token || raw.disabled) {
      skipped.push(String(raw.site_name || raw.id || "未知账号"))
      continue
    }
    parsed.push(
      validateAccount({
        name: raw.site_name,
        baseUrl: raw.site_url,
        siteType: type,
        token: raw.account_info.access_token,
        userId: String(raw.account_info.id ?? ""),
        autoCheckin: false,
      }),
    )
  }
  return { accounts: parsed, skipped }
}
