const $ = (selector, root = document) => root.querySelector(selector)
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)]
const apiBase = new URL("api/", window.location.href)
const pages = {
  overview: "总览",
  accounts: "账户管理",
  detector: "模型指纹检测",
  data: "导入与备份",
  system: "部署与更新",
}
const siteNames = {
  "new-api": "New API",
  sub2api: "Sub2API",
  credential: "API 凭据",
}
let csrfToken = ""
let authenticated = false
let accounts = []
let history = []
let presets = []
let status = null
let toastTimer
let authGeneration = 0
const requests = new Set()

function element(tag, text, className) {
  const node = document.createElement(tag)
  if (text !== undefined && text !== null) node.textContent = String(text)
  if (className) node.className = className
  return node
}

function message(text, error = false) {
  const toast = $("#toast")
  clearTimeout(toastTimer)
  toast.textContent = text
  toast.classList.toggle("error", error)
  toast.hidden = false
  toastTimer = setTimeout(() => {
    toast.hidden = true
  }, 6500)
}

async function request(path, options = {}) {
  const controller = new AbortController()
  requests.add(controller)
  const timer = setTimeout(
    () => controller.abort(),
    path === "detect" ? 420000 : 90000,
  )
  const headers = { Accept: "application/json", ...options.headers }
  if (options.body !== undefined) headers["Content-Type"] = "application/json"
  if (options.method && options.method !== "GET")
    headers["X-CSRF-Token"] = csrfToken
  try {
    const response = await fetch(new URL(path, apiBase), {
      credentials: "same-origin",
      ...options,
      headers,
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      if (response.status === 401 && path !== "login") showLogin()
      throw new Error(
        typeof data.error === "string"
          ? data.error
          : data.error?.message ||
              data.message ||
              `请求失败（HTTP ${response.status}）`,
      )
    }
    return data
  } catch (error) {
    if (error.name === "AbortError")
      throw new Error("请求已中止或超时，请稍后重试。", { cause: error })
    throw error
  } finally {
    clearTimeout(timer)
    requests.delete(controller)
  }
}

async function busy(button, action, pendingText = "处理中…") {
  if (button.disabled) return
  const previous = button.textContent
  button.disabled = true
  button.textContent = pendingText
  try {
    return await action()
  } finally {
    button.disabled = false
    button.textContent = previous
  }
}

function showLogin() {
  authenticated = false
  authGeneration += 1
  csrfToken = ""
  accounts = []
  history = []
  status = null
  for (const controller of requests) controller.abort()
  $("#boot").hidden = true
  $("#workspace").hidden = true
  $("#login-view").hidden = false
  $("#password").value = ""
  $("#detect-key").value = ""
  $("#detect-form").reset()
  $("#detect-key").required = true
  $("#account-token").value = ""
  $("#account-key").value = ""
  $("#detail-body").replaceChildren()
  $("#import-file").value = ""
  $$("dialog[open]").forEach((dialog) => dialog.close())
}

async function showWorkspace(token) {
  const statusResponse = await request("status")
  if (statusResponse.nativeWorkspace) {
    window.location.replace(new URL("options.html", window.location.href))
    return
  }
  csrfToken = token || ""
  authenticated = true
  $("#boot").hidden = true
  $("#login-view").hidden = true
  $("#workspace").hidden = false
  $("#password").value = ""
  route()
  await loadWorkspace()
}

function route() {
  const id = window.location.hash.slice(1) || "overview"
  const selected = Object.hasOwn(pages, id) ? id : "overview"
  $$("[data-page]").forEach((node) => {
    node.hidden = node.dataset.page !== selected
  })
  $$("[data-view]").forEach((node) => {
    const active = node.dataset.view === selected
    node.classList.toggle("active", active)
    if (active) node.setAttribute("aria-current", "page")
    else node.removeAttribute("aria-current")
  })
  $("#breadcrumb").textContent = pages[selected]
  document.title = `${pages[selected]} · All API Hub`
}

async function loadWorkspace() {
  const generation = authGeneration
  const results = await Promise.allSettled([
    request("state"),
    request("status"),
    request("detection/presets"),
  ])
  if (!authenticated || generation !== authGeneration) return
  if (results[0].status === "fulfilled") {
    accounts = results[0].value.accounts || []
    history = results[0].value.history || []
    renderAccounts()
    renderHistory()
  } else message(`加载账户失败：${results[0].reason.message}`, true)
  if (results[1].status === "fulfilled") {
    status = results[1].value
    renderStatus()
  } else
    $("#system-status").replaceChildren(
      element("dt", "加载失败"),
      element("dd", results[1].reason.message),
    )
  if (results[2].status === "fulfilled") {
    const raw = results[2].value.presets || results[2].value
    presets = Array.isArray(raw)
      ? raw
      : Object.entries(raw).map(([id, value]) => ({ id, ...value }))
    applyPreset(false)
  }
}

async function reloadAccounts() {
  const generation = authGeneration
  const data = await request("state")
  if (!authenticated || generation !== authGeneration) return
  accounts = data.accounts || []
  history = data.history || []
  renderAccounts()
  renderHistory()
}

function dateText(value) {
  if (!value) return "尚未更新"
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(date)
}

function balanceText(value) {
  if (value === null || value === undefined || value === "") return "—"
  const number = Number(value)
  return Number.isFinite(number)
    ? new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 4 }).format(
        number,
      )
    : "—"
}

function shortUrl(value) {
  try {
    return new URL(value).host
  } catch {
    return value || "未设置地址"
  }
}

function emptyState(title, description, action) {
  const node = element("div", null, "empty-state")
  node.append(
    element("span", "▤", "empty-symbol"),
    element("h3", title),
    element("p", description),
  )
  if (action) {
    const button = element("button", "＋ 添加第一个账户", "secondary")
    button.type = "button"
    button.addEventListener("click", () => openAccount())
    node.append(button)
  }
  return node
}

function renderAccounts() {
  $("#nav-account-count").textContent = accounts.length
  $("#metric-accounts").textContent = accounts.length
  $("#metric-refreshed").textContent = accounts.filter(
    (account) => account.balance != null,
  ).length
  $("#metric-checkin").textContent = accounts.filter(
    (account) => account.autoCheckin,
  ).length
  const overview = $("#overview-accounts")
  overview.replaceChildren()
  if (!accounts.length)
    overview.append(
      emptyState(
        "连接你的第一个账户",
        "添加一个 API 站点，开始汇总你的模型资产。",
        true,
      ),
    )
  for (const account of accounts.slice(0, 4)) {
    const row = element("div", null, "account-row")
    const info = element("div")
    info.append(
      element("div", account.name, "account-row-name"),
      element("div", shortUrl(account.baseUrl), "account-row-url"),
    )
    const value = element(
      "div",
      balanceText(account.balance),
      "account-row-stat",
    )
    value.append(
      element("small", account.balance == null ? "待刷新" : "余额 · USD"),
    )
    row.append(
      element("span", (account.name || "A").slice(0, 1), "account-initial"),
      info,
      value,
    )
    overview.append(row)
  }
  const search = $("#account-search").value.toLowerCase().trim()
  const visible = accounts.filter((account) =>
    `${account.name} ${account.baseUrl}`.toLowerCase().includes(search),
  )
  const list = $("#accounts-list")
  list.replaceChildren()
  if (!visible.length)
    list.append(
      emptyState(
        accounts.length ? "没有匹配的账户" : "还没有添加账户",
        accounts.length
          ? "试试其他名称或地址。"
          : "使用账户访问令牌连接你的服务。",
        !accounts.length,
      ),
    )
  for (const account of visible) list.append(accountCard(account))
  const selector = $("#detect-account")
  if (selector) {
    const selected = selector.value
    selector.replaceChildren(element("option", "手动输入连接信息"))
    selector.firstChild.value = ""
    for (const account of accounts.filter((item) => item.hasApiKey)) {
      const option = element("option", account.name)
      option.value = account.id
      selector.append(option)
    }
    selector.value = accounts.some(
      (account) => account.id === selected && account.hasApiKey,
    )
      ? selected
      : ""
    $("#detect-key").required = !selector.value
  }
}

function accountCard(account) {
  const card = element("article", null, "card account-card")
  const top = element("div", null, "account-card-top")
  const identity = element("div")
  identity.append(
    element("h2", account.name),
    element("p", shortUrl(account.baseUrl)),
  )
  top.append(
    element("span", (account.name || "A").slice(0, 1), "account-initial"),
    identity,
    element("span", siteNames[account.siteType] || account.siteType, "pill"),
  )
  const stats = element("div", null, "account-card-stats")
  for (const [label, value] of [
    ["账户余额", account.balance],
    ["累计用量", account.usedQuota],
  ]) {
    const stat = element("div")
    stat.append(
      element("span", label),
      element("strong", balanceText(value)),
      element("small", value == null ? "等待查询" : "USD"),
    )
    stats.append(stat)
  }
  const meta = element("div", null, "account-card-meta")
  meta.append(
    element("span", `更新 ${dateText(account.lastRefresh)}`),
    element("span", account.autoCheckin ? "自动签到已开启" : "手动签到"),
  )
  card.append(top, stats, meta)
  if (account.lastError)
    card.append(element("div", account.lastError, "account-failure"))
  const actions = element("div", null, "account-card-actions")
  const buttons = [
    ["refresh", "↻ 刷新"],
    ["checkin", "签到"],
    ["models", "模型"],
    ["keys", "密钥"],
    ["edit", "编辑"],
    ["delete", "删除"],
  ]
  for (const [action, label] of buttons) {
    if (
      account.siteType === "credential" &&
      ["checkin", "keys"].includes(action)
    )
      continue
    if (account.siteType === "sub2api" && action === "checkin") continue
    const button = element(
      "button",
      label,
      action === "delete" ? "quiet danger" : "secondary",
    )
    button.type = "button"
    button.addEventListener("click", () =>
      accountAction(account, action, button),
    )
    actions.append(button)
  }
  card.append(actions)
  return card
}

function renderHistory() {
  const target = $("#activity-list")
  target.replaceChildren()
  if (!history.length) {
    target.append(
      emptyState("还没有活动记录", "账户刷新与签到的记录将显示在这里。"),
    )
    return
  }
  for (const event of history.slice(0, 8)) {
    const row = element("div", null, "activity-row")
    const labels = {
      refresh: "账户刷新",
      checkin: "账户签到",
      detect: "模型检测",
      import: "导入备份",
      detection: "模型检测",
    }
    const action = event.action || event.type
    const accountName =
      event.accountName ||
      accounts.find((account) => account.id === event.accountId)?.name
    row.append(
      element("span", null, "event-dot"),
      element(
        "span",
        event.message ||
          `${labels[action] || action || "工作空间操作"}${accountName ? ` · ${accountName}` : ""}`,
      ),
      element("time", dateText(event.at || event.createdAt || event.timestamp)),
    )
    target.append(row)
  }
}

function openAccount(account) {
  $("#account-form").reset()
  $("#account-error").textContent = ""
  $("#account-id").value = account?.id || ""
  $("#account-dialog-title").textContent = account ? "编辑账户" : "添加账户"
  $("#credential-hint").textContent = account
    ? "留空会保留现有令牌和 API 密钥。填写新值后才会替换。"
    : "使用站点的账户访问令牌；它通常不同于用于模型调用的 API 密钥。"
  if (account) {
    $("#account-name").value = account.name || ""
    $("#account-url").value = account.baseUrl || ""
    $("#account-type").value = account.siteType || "new-api"
    $("#account-user-id").value = account.userId || ""
    $("#account-auto").checked = Boolean(account.autoCheckin)
  }
  updateAccountType()
  $("#account-dialog").showModal()
}

function updateAccountType() {
  const type = $("#account-type").value
  $("#account-user-id").disabled = type !== "new-api"
  $("#account-token").disabled = type === "credential"
  $("#account-auto").disabled = type !== "new-api"
  if (type !== "new-api") $("#account-auto").checked = false
  $("#account-token").required =
    !$("#account-id").value && type !== "credential"
  $("#account-key").required = !$("#account-id").value && type === "credential"
}

async function accountAction(account, action, button) {
  if (action === "edit") {
    openAccount(account)
    return
  }
  if (
    action === "delete" &&
    !window.confirm(`删除“${account.name}”？这只删除当前工作空间中的账户配置。`)
  )
    return
  const generation = authGeneration
  try {
    await busy(button, async () => {
      const path = `accounts/${encodeURIComponent(account.id)}`
      if (action === "delete") {
        await request(path, { method: "DELETE" })
        await reloadAccounts()
        message("账户已删除")
      } else if (action === "models" || action === "keys") {
        const result = await request(`${path}/${action}`)
        if (!authenticated || authGeneration !== generation) return
        showDetails(account, action, result)
      } else {
        await request(`${path}/${action}`, { method: "POST", body: {} })
        await reloadAccounts()
        message(action === "checkin" ? "签到请求已完成" : "账户信息已刷新")
      }
    })
  } catch (error) {
    message(error.message, true)
    if (authenticated) await reloadAccounts().catch(() => {})
  }
}

function showDetails(account, action, result) {
  $("#detail-title").textContent =
    `${account.name} · ${action === "models" ? "可用模型" : "API 密钥"}`
  const body = $("#detail-body")
  body.replaceChildren()
  const values = result[action] || result.data || []
  if (action === "keys")
    body.append(
      element(
        "p",
        "密钥以脱敏形式显示。最多展示 100 条；完整密钥与管理操作请前往站点控制台。",
        "caption",
      ),
    )
  if (!values.length)
    body.append(
      emptyState(
        action === "models" ? "暂无模型" : "暂无密钥",
        "接口没有返回可展示的数据。",
      ),
    )
  const list = element("div", null, "detail-list")
  for (const item of values) {
    const row = element("div", null, "detail-item")
    if (typeof item === "string") row.textContent = item
    else {
      row.append(element("h3", item.name || item.id || item.model || "未命名"))
      if (item.key || item.token || item.maskedKey)
        row.append(element("code", item.maskedKey || item.key || item.token))
      if (item.status != null)
        row.append(element("small", `状态：${item.status}`))
    }
    list.append(row)
  }
  body.append(list)
  $("#detail-dialog").showModal()
}

function applyPreset(reset = true) {
  const id = $("#detect-preset").value
  const preset = presets.find((item) => item.id === id)
  const fallback = {
    standard: { api: "chat_completions", userAgent: "", headers: {} },
    "claude-code": {
      api: "messages",
      userAgent: "claude-cli/2.1.0 (external, cli)",
      headers: {},
    },
    "codex-cli": {
      api: "responses",
      userAgent: "codex_cli_rs/0.100.0",
      headers: {},
    },
  }[id]
  if (reset) {
    $("#detect-api").value = preset?.api || fallback.api
    $("#detect-ua").value = preset?.userAgent || fallback.userAgent
    $("#detect-headers").value = JSON.stringify(
      preset?.headers || fallback.headers,
      null,
      2,
    )
  }
}

function detectionPending() {
  $("#detection-badge").textContent = "检测中"
  $("#detection-subtitle").textContent = "正在请求样本并与参考库比对"
  const output = $("#detection-result")
  output.className = "result-empty running"
  output.replaceChildren(
    element("span", "◎", "empty-symbol"),
    element("h3", "正在采集模型指纹"),
    element("p", "通常需要数十秒至几分钟，请保持页面打开。"),
  )
}

function detectionResult(result) {
  const analysis = result.analysis
  $("#detection-badge").textContent = analysis ? "已完成" : "未完成"
  $("#detection-subtitle").textContent = analysis
    ? "数字行为指纹 · 参考库内候选排名"
    : "本次检测未能生成有效排名"
  const output = $("#detection-result")
  output.className = analysis ? "result-success" : "result-empty"
  output.replaceChildren()
  if (!analysis) {
    output.append(
      element("span", "!", "empty-symbol"),
      element("h3", "检测未完成"),
      element(
        "p",
        result.error || "样本不足或接口未返回有效结果，请检查配置后重试。",
      ),
    )
    const failures = (result.samples || []).filter((sample) => sample.error)
    if (failures.length) {
      const details = element("div", null, "sample-errors")
      for (const [index, sample] of failures.entries())
        details.append(element("p", `样本 ${index + 1}：${sample.error}`))
      output.append(details)
    }
    return
  }
  output.append(
    element("div", "最接近的参考模型", "prediction-label"),
    element(
      "h3",
      analysis.prediction_name || analysis.prediction || "未确定",
      "prediction-name",
    ),
  )
  output.append(
    element(
      "p",
      result.disclaimer ||
        "候选排名仅反映与参考库的相似度。未收录的模型也可能得到最接近的候选。",
      "caption",
    ),
  )
  const rows = Array.isArray(analysis.results) ? analysis.results : []
  for (const [index, entry] of rows.slice(0, 8).entries()) {
    const row = element("div", null, "ranking-row")
    row.append(
      element(
        "strong",
        `${index + 1}. ${entry.display_name || entry.model || entry.family_name || "候选模型"}`,
      ),
    )
    const probability = Number(entry.probability)
    const score = Number(entry.score)
    const value =
      entry.probability != null && Number.isFinite(probability)
        ? `${(probability * 100).toFixed(1)}%`
        : Number.isFinite(score)
          ? `分数 ${score.toFixed(3)}`
          : "—"
    row.append(element("span", value))
    output.append(row)
  }
  if (result.error) output.append(element("p", result.error, "error-text"))
  if (result.referenceBuiltAt)
    output.append(
      element(
        "p",
        `参考库构建时间：${dateText(result.referenceBuiltAt)}`,
        "caption",
      ),
    )
  const details = element("details")
  details.append(
    element("summary", "查看本次检测详情"),
    element("pre", JSON.stringify(result, null, 2)),
  )
  output.append(details)
}

function renderStatus() {
  const target = $("#system-status")
  const info = [
    ["服务版本", status?.version || "Web 服务"],
    [
      "上游版本",
      typeof status?.upstream === "object"
        ? status.upstream.version ||
          status.upstream.revision ||
          JSON.stringify(status.upstream)
        : status?.upstream || "见部署目录中的 Git 版本",
    ],
    ["运行模式", "已登录 · 单一共享管理空间"],
    ["更新方式", status?.updateCommand || "bash deploy/update.sh"],
  ]
  target.replaceChildren()
  for (const [label, value] of info)
    target.append(element("dt", label), element("dd", value))
  try {
    const source = new URL(status?.sourceUrl)
    if (["https:", "http:"].includes(source.protocol)) {
      $("#source-link").href = source.href
      $("#source-link").hidden = false
    }
  } catch {
    $("#source-link").hidden = true
  }
}

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault()
  $("#login-error").textContent = ""
  try {
    await busy(
      $("#login-form button"),
      async () => {
        const result = await request("login", {
          method: "POST",
          body: { password: $("#password").value },
        })
        await showWorkspace(result.csrfToken)
      },
      "正在登录…",
    )
  } catch (error) {
    $("#login-error").textContent = error.message
  }
})

async function logout() {
  try {
    await request("logout", { method: "POST", body: {} })
    showLogin()
  } catch (error) {
    message(error.message, true)
  }
}
$("#logout").addEventListener("click", logout)
$("#logout-mobile").addEventListener("click", logout)

window.addEventListener("hashchange", route)
$$("[data-add-account]").forEach((button) =>
  button.addEventListener("click", () => openAccount()),
)
$$("[data-close-dialog]").forEach((button) =>
  button.addEventListener("click", () => button.closest("dialog").close()),
)
$("#account-search").addEventListener("input", renderAccounts)
$("#account-type").addEventListener("change", updateAccountType)
$("#account-dialog").addEventListener("close", () => {
  $("#account-token").value = ""
  $("#account-key").value = ""
})
$("#detail-dialog").addEventListener("close", () =>
  $("#detail-body").replaceChildren(),
)

$("#account-form").addEventListener("submit", async (event) => {
  event.preventDefault()
  $("#account-error").textContent = ""
  const id = $("#account-id").value
  const payload = {
    name: $("#account-name").value.trim(),
    baseUrl: $("#account-url").value.trim(),
    siteType: $("#account-type").value,
    userId: $("#account-user-id").value.trim(),
    autoCheckin: $("#account-auto").checked,
  }
  const token = $("#account-token").value.trim()
  const apiKey = $("#account-key").value.trim()
  if (token) payload.token = token
  if (apiKey) payload.apiKey = apiKey
  try {
    await busy(
      $("#account-form button[type=submit]"),
      async () => {
        await request(id ? `accounts/${encodeURIComponent(id)}` : "accounts", {
          method: id ? "PATCH" : "POST",
          body: payload,
        })
        $("#account-dialog").close()
        await reloadAccounts()
        message(id ? "账户配置已更新" : "账户已添加，可刷新查询余额")
      },
      "正在保存…",
    )
  } catch (error) {
    $("#account-error").textContent = error.message
  }
})

$("#refresh-all").addEventListener("click", async () => {
  await busy(
    $("#refresh-all"),
    async () => {
      let succeeded = 0
      let failed = 0
      for (const account of accounts.filter(
        (item) => item.siteType !== "credential",
      )) {
        if (!authenticated) break
        try {
          await request(`accounts/${encodeURIComponent(account.id)}/refresh`, {
            method: "POST",
            body: {},
          })
          succeeded += 1
        } catch {
          failed += 1
        }
      }
      if (authenticated) {
        await reloadAccounts().catch((error) => message(error.message, true))
        message(
          `刷新完成：${succeeded} 个成功${failed ? `，${failed} 个失败，请查看账户错误信息` : ""}`,
          failed > 0,
        )
      }
    },
    "刷新中…",
  )
})

$("#detect-preset").addEventListener("change", () => applyPreset())
$("#detect-account")?.addEventListener("change", () => {
  const account = accounts.find(
    (item) => item.id === $("#detect-account").value,
  )
  $("#detect-key").required = !account
  $("#detect-key").placeholder = account
    ? "留空使用账户已保存的 API 密钥"
    : "sk-…"
  if (account) $("#detect-url").value = account.baseUrl
})

$("#detect-form").addEventListener("submit", async (event) => {
  event.preventDefault()
  $("#detect-error").textContent = ""
  let headers
  try {
    headers = JSON.parse($("#detect-headers").value || "{}")
    if (
      !headers ||
      Array.isArray(headers) ||
      typeof headers !== "object" ||
      Object.values(headers).some((value) => typeof value !== "string")
    )
      throw new Error()
  } catch {
    $("#detect-error").textContent =
      "请求头必须是 JSON 对象，且每个值都必须是字符串。"
    return
  }
  const payload = {
    baseUrl: $("#detect-url").value.trim(),
    apiKey: $("#detect-key").value.trim(),
    model: $("#detect-model").value.trim(),
    preset: $("#detect-preset").value,
    api: $("#detect-api").value,
    userAgent: $("#detect-ua").value.trim(),
    headers,
  }
  const accountId = $("#detect-account")?.value
  if (accountId && !payload.apiKey) {
    payload.accountId = accountId
    delete payload.apiKey
  }
  const generation = authGeneration
  try {
    await busy(
      $("#detect-submit"),
      async () => {
        detectionPending()
        const result = await request("detect", {
          method: "POST",
          body: payload,
        })
        if (!authenticated || authGeneration !== generation) return
        detectionResult(result)
        await reloadAccounts().catch(() => {})
      },
      "正在检测，请稍候…",
    )
  } catch (error) {
    if (!authenticated) return
    $("#detect-error").textContent = error.message
    detectionResult({ error: error.message })
  }
})

$("#export-data").addEventListener("click", async () => {
  if (!window.confirm("备份文件包含账户令牌和 API 密钥。确定下载到当前设备？"))
    return
  try {
    await busy($("#export-data"), async () => {
      const data = await request("export")
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
      )
      const link = element("a")
      link.href = url
      link.download = `all-api-hub-backup-${new Date().toISOString().slice(0, 10)}.json`
      document.body.append(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      message("备份已下载，请妥善保存")
    })
  } catch (error) {
    message(error.message, true)
  }
})

$("#import-form").addEventListener("submit", async (event) => {
  event.preventDefault()
  const file = $("#import-file").files[0]
  if (!file) return
  if (file.size > 1024 * 1024) {
    message("备份文件不能大于 1 MB", true)
    return
  }
  $("#import-result").textContent = ""
  try {
    let data
    try {
      data = JSON.parse(await file.text())
    } catch {
      throw new Error("文件不是有效的 JSON 备份。")
    }
    if (
      !window.confirm(
        "确认导入此备份？导入内容可能影响已有账户配置，建议先导出当前备份。",
      )
    )
      return
    await busy(
      $("#import-form button"),
      async () => {
        const result = await request("import", { method: "POST", body: data })
        const skipped = Array.isArray(result.skipped)
          ? result.skipped.map((item) =>
              typeof item === "string"
                ? item
                : item.name || item.reason || JSON.stringify(item),
            )
          : []
        const summary = `已导入 ${result.imported ?? result.count ?? 0} 个账户。${skipped.length ? `已跳过 ${skipped.length} 项：${skipped.join("、")}` : ""}`
        $("#import-result").textContent = summary
        $("#import-result").className = skipped.length
          ? "error-text"
          : "caption"
        $("#import-file").value = ""
        await reloadAccounts()
        message(
          skipped.length ? "导入完成，部分账户未导入，请查看结果" : "导入完成",
        )
      },
      "正在导入…",
    )
  } catch (error) {
    $("#import-result").textContent = error.message
    $("#import-result").className = "error-text"
  }
})

$("#copy-update").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(
      status?.updateCommand || "bash deploy/update.sh",
    )
    message("更新命令已复制，在 VPS 项目目录中执行即可")
  } catch {
    message("浏览器无法自动复制，请选中命令手动复制", true)
  }
})

try {
  const session = await request("session")
  if (session.authenticated) await showWorkspace(session.csrfToken)
  else showLogin()
} catch (error) {
  showLogin()
  $("#login-error").textContent = `无法连接服务器：${error.message}`
}
