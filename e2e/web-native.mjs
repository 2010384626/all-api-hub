// Native options UI + real Node background; upstream requests use local fixtures.
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { chromium, expect } from "@playwright/test"

import { createApp } from "../web/server/app.mjs"
import { createExtensionRuntime } from "../web/server/extension-runtime.mjs"

const directory = await mkdtemp(path.join(tmpdir(), "aah-native-web-"))
const artifacts = path.resolve(".scratch/vps-web/artifacts/native-ui")
await mkdir(artifacts, { recursive: true })
const port = 4419
const password = "native-browser-fixture-password"
const origin = `http://127.0.0.1:${port}`
let detectionInput
let detectionCalls = 0
const upstreamCalls = { models: 0, keys: 0 }
const fetchImpl = async (raw) => {
  const url = String(raw)
  if (url.includes("/models")) {
    if (new URL(url).hostname === "models.example") upstreamCalls.models++
    return Response.json({
      data: [{ id: "fixture-model" }, { id: "fixture-second" }],
    })
  }
  if (url.includes("/api/user/self"))
    return Response.json({
      success: true,
      data: {
        id: 42,
        username: "fixture",
        quota: 1000000,
        used_quota: 50000,
        request_count: 3,
      },
    })
  if (url.includes("/api/token/")) {
    upstreamCalls.keys++
    return Response.json({
      success: true,
      data: {
        page: 1,
        page_size: 100,
        total: 1,
        items: [
          {
            id: 1,
            name: "fixture key",
            key: "fixture-key",
            status: 1,
            user_id: 42,
            created_time: 1,
            accessed_time: 1,
            expired_time: -1,
            remain_quota: 0,
            unlimited_quota: true,
            model_limits_enabled: false,
            model_limits: "",
            allow_ips: "",
            used_quota: 0,
            group: "default",
          },
        ],
      },
    })
  }
  if (url.includes("/api/status"))
    return Response.json({ success: true, data: { checkin_enabled: true } })
  if (url.includes("/api/log"))
    return Response.json({ success: true, data: { items: [], total: 0 } })
  return Response.json({ success: true, data: [] })
}
const app = await createApp({
  env: {
    ADMIN_PASSWORD: password,
    ENCRYPTION_KEY: "8".repeat(64),
    DATA_DIR: directory,
    PUBLIC_ORIGIN: origin,
    BASE_PATH: "/hub/",
  },
  fetchImpl,
  runtimeFactory: ({ store }) => createExtensionRuntime({ store, fetchImpl }),
  detect: async (input, options) => {
    detectionInput = input
    detectionCalls++
    const samples = Array.from({ length: 3 }, (_, index) => ({
      state: "complete",
      count: 310,
      expected_count: 310,
      text: Array.from({ length: 310 }, (_, i) =>
        String(((i * 97 + index * 37) % 355) + 1),
      ).join(" "),
    }))
    if (input.stream)
      for (const [index, sample] of samples.entries())
        options.onProgress?.({ type: "sample", index, sample })
    return {
      analysis:
        input.autoVerify === false
          ? null
          : {
              prediction: "fixture-model",
              family_prediction_name: "GPT",
              decision: "scored",
              probability_status: "reference_calibrated",
              used_outputs: 3,
              probability: 0.998,
              results: [
                {
                  model: "fixture-model",
                  family_name: "GPT",
                  probability: 0.998,
                },
                {
                  model: "fixture-other",
                  family_name: "Claude",
                  probability: 0.002,
                },
              ],
            },
      samples,
      outputs: samples.map((sample) => ({
        text: sample.text,
        expected_count: sample.expected_count,
      })),
      verificationPending: input.autoVerify === false,
    }
  },
})
const server = createServer(app.handler)
await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve))
let browser
try {
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.AAH_BROWSER_EXECUTABLE ||
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
  })
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: "zh-CN",
    reducedMotion: "reduce",
  })
  const page = await context.newPage()
  const errors = [],
    failedRequests = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("response", (response) => {
    if (response.status() >= 400)
      failedRequests.push(`${response.status()} ${response.url()}`)
  })
  page.on("console", (message) => {
    if (message.type() === "error") console.error("BROWSER", message.text())
  })
  await page.goto(`${origin}/hub/`)
  await page.locator("#password").fill(password)
  await page.locator("#login-form button").click()
  await page.waitForURL("**/options.html")
  await page
    .locator('[data-testid="options-app"]')
    .waitFor({ timeout: 30000 })
    .catch(async (error) => {
      await writeFile(
        path.join(artifacts, "failure-page.txt"),
        await page.locator("body").innerText(),
      )
      console.error("ERRORS", errors, failedRequests)
      throw error
    })
  await page.evaluate(async () =>
    browser.storage.local.set({
      featureGuidance_state_v1: JSON.stringify({
        schemaVersion: 1,
        productTour: {
          expanded: {
            handledVersion: 1,
            handledAt: Date.now(),
            outcome: "completed",
          },
          compact: {
            handledVersion: 1,
            handledAt: Date.now(),
            outcome: "completed",
          },
        },
        gatewayGuidance: {
          dismissedAtBySurface: {
            account: Date.now(),
            apiCredentialProfiles: Date.now(),
          },
        },
      }),
    }),
  )
  const menus = [
    ["总览", "overview"],
    ["账户管理", "account"],
    ["API 凭据库", "apiCredentialProfiles"],
    ["模型列表", "models"],
    ["密钥管理", "keys"],
    ["自动签到", "autoCheckin"],
    ["网站公告", "siteAnnouncements"],
    ["余额历史", "balanceHistory"],
    ["用量分析", "usageAnalytics"],
    ["渠道管理", "managedSiteChannels"],
    ["模型同步", "managedSiteModelSync"],
    ["设置", "basic"],
    ["导入/导出", "importExport"],
    ["关于", "about"],
    ["模型指纹检测", "modelFingerprint"],
  ]
  const headings = []
  for (const [name, id] of menus) {
    await page.getByRole("button", { name, exact: true }).first().click()
    await page.waitForURL(`**#${id}`)
    await page
      .locator('[data-testid="options-content-card"]')
      .getByRole("heading")
      .first()
      .waitFor()
    await page.waitForFunction(
      () => !document.querySelector("[data-options-page-pending]"),
    )
    headings.push({
      id,
      text: await page
        .locator('[data-testid="options-content-card"]')
        .innerText(),
    })
  }
  const now = Date.now()
  const backup = {
    version: "4.0",
    timestamp: now,
    accounts: {
      accounts: ["Anyrouter", "Relayfor"].map((name, index) => ({
        id: `fixture-${index}`,
        site_name: name,
        site_url: `https://${name.toLowerCase()}.example`,
        site_type: name.toLowerCase(),
        authType: "access_token",
        exchange_rate: 7.2,
        tagIds: [],
        notes: "",
        health: { status: "unknown" },
        disabled: index !== 0,
        excludeFromTotalBalance: false,
        excludeFromTodayIncome: false,
        configVersion: 8,
        account_info: {
          id: String(42 + index),
          access_token: "fixture-management-token",
          username: name,
          quota: 1000000,
          today_prompt_tokens: 0,
          today_completion_tokens: 0,
          today_quota_consumption: 0,
          today_requests_count: 0,
          today_income: 0,
        },
        created_at: now,
        updated_at: now,
        user_updated_at: now,
        last_sync_time: now,
        checkIn: {
          automaticExecutionEnabled: false,
          methodKnowledge: { methods: {} },
          selection: { mode: "automatic" },
        },
      })),
      bookmarks: [],
      pinnedAccountIds: [],
      orderedAccountIds: [],
      last_updated: now,
    },
    apiCredentialProfiles: {
      version: 8,
      profiles: [
        {
          id: "fixture-profile",
          name: "Saved API credential",
          apiType: "openai-compatible",
          baseUrl: "https://models.example",
          apiKey: "sk-fixture-inference-secret",
          tagIds: [],
          notes: "",
          createdAt: now,
          updatedAt: now,
        },
      ],
      links: [],
      linkTombstones: [],
      lastUpdated: now,
    },
  }
  await page
    .getByRole("button", { name: "导入/导出", exact: true })
    .first()
    .click()
  await page.locator("#import-backup-file").setInputFiles({
    name: "backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(backup)),
  })
  await page.getByTestId("import-export-import-backup-button").click()
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          JSON.parse(
            (await browser.storage.local.get("site_accounts")).site_accounts ||
              "{}",
          ).accounts?.length,
      ),
    )
    .toBe(2)
  const imported = await page.evaluate(async () =>
    JSON.parse(
      (await browser.storage.local.get("site_accounts")).site_accounts,
    ).accounts.map((a) => a.site_type),
  )
  assert.deepEqual(imported.sort(), ["anyrouter", "relayfor"])
  const downloaded = page.waitForEvent("download")
  await page.getByTestId("import-export-export-full-backup-button").click()
  const download = await downloaded
  assert.ok(download.suggestedFilename().endsWith(".json"))
  const readCatalog = () =>
    page.evaluate(async () => {
      const raw = (await browser.storage.local.get("web_catalog_snapshots_v1"))
        .web_catalog_snapshots_v1
      return typeof raw === "string" ? JSON.parse(raw) : raw
    })
  const verifySchedulePersistence = async (kind) => {
    const panel = page.getByTestId(`catalog-schedule-${kind}`)
    await panel.locator("summary").click()
    await panel.getByRole("checkbox").check()
    await panel.locator(`#catalog-minutes-${kind}`).fill("120")
    await panel.getByRole("button", { name: "保存设置", exact: true }).click()
    await expect
      .poll(async () => (await readCatalog())?.schedules?.[kind])
      .toMatchObject({ enabled: true, everyMinutes: 120 })
    await page.reload()
    await page
      .getByTestId(`catalog-schedule-${kind}`)
      .locator("summary")
      .click()
    await page
      .getByTestId(`catalog-schedule-${kind}`)
      .getByRole("checkbox")
      .waitFor()
    assert.equal(
      await page
        .getByTestId(`catalog-schedule-${kind}`)
        .getByRole("checkbox")
        .isChecked(),
      true,
    )
    assert.equal(
      await page.locator(`#catalog-minutes-${kind}`).inputValue(),
      "120",
    )
    // Keep the deterministic fixture run independent of the server minute alarm.
    await page
      .getByTestId(`catalog-schedule-${kind}`)
      .getByRole("checkbox")
      .uncheck()
    await page
      .getByTestId(`catalog-schedule-${kind}`)
      .getByRole("button", { name: "保存设置", exact: true })
      .click()
    await expect
      .poll(async () => (await readCatalog())?.schedules?.[kind]?.enabled)
      .toBe(false)
  }
  await page
    .getByRole("button", { name: "模型列表", exact: true })
    .first()
    .click()
  await page.getByTestId("model-list-source-selector").click()
  await page.getByRole("option", { name: /Saved API credential/ }).click()
  await page
    .getByTestId("model-list-display")
    .getByText("fixture-model", { exact: true })
    .first()
    .waitFor()
  const modelCount = upstreamCalls.models
  assert.ok(modelCount > 0)
  await page.reload()
  await page
    .getByTestId("model-list-display")
    .getByText("fixture-model", { exact: true })
    .first()
    .waitFor()
  assert.equal(
    upstreamCalls.models,
    modelCount,
    "reload reuses saved model inventory",
  )
  await page.getByRole("button", { name: "刷新数据", exact: true }).click()
  await expect.poll(() => upstreamCalls.models).toBeGreaterThan(modelCount)
  await page.getByRole("button", { name: "刷新数据", exact: true }).waitFor()
  assert.ok(upstreamCalls.models > modelCount, "manual refresh fetches models")
  assert.ok(
    Object.values((await readCatalog()).entries).some(
      (entry) => entry.kind === "models",
    ),
  )
  await verifySchedulePersistence("models")
  await page
    .getByRole("button", { name: "密钥管理", exact: true })
    .first()
    .click()
  await page.getByTestId("key-management-account-scope-select").click()
  await page.getByRole("option", { name: /Anyrouter/ }).click()
  await page.getByText("fixture key", { exact: true }).first().waitFor()
  const keyCount = upstreamCalls.keys
  assert.ok(keyCount > 0)
  await page.reload()
  await page.getByText("fixture key", { exact: true }).first().waitFor()
  assert.equal(
    upstreamCalls.keys,
    keyCount,
    "reload reuses saved Anyrouter keys",
  )
  await page.getByRole("button", { name: "刷新密钥列表", exact: true }).click()
  await expect.poll(() => upstreamCalls.keys).toBeGreaterThan(keyCount)
  await page
    .getByRole("button", { name: "刷新密钥列表", exact: true })
    .waitFor()
  assert.ok(
    upstreamCalls.keys > keyCount,
    "manual refresh fetches Anyrouter keys",
  )
  assert.ok(
    Object.values((await readCatalog()).entries).some(
      (entry) => entry.kind === "keys",
    ),
  )
  await verifySchedulePersistence("keys")
  await page
    .getByRole("button", { name: "模型指纹检测", exact: true })
    .first()
    .click()
  await page.locator("#fingerprint-source").click()
  await page.getByRole("option", { name: /Saved API credential/ }).click()
  await page.waitForFunction(() =>
    document
      .querySelector("#fingerprint-model")
      ?.textContent?.includes("fixture-model"),
  )
  await page.getByRole("button", { name: "开始指纹检测", exact: true }).click()
  await page
    .getByRole("heading", { name: "fixture-model", exact: true })
    .waitFor()
  assert.equal(detectionInput.apiKey, "sk-fixture-inference-secret")
  assert.equal(detectionInput.model, "fixture-model")
  assert.equal(
    await page.getByTestId("fingerprint-top-confidence").innerText(),
    "99.8%",
  )
  await page
    .getByTestId("fingerprint-history")
    .getByRole("button", { name: "查看结果", exact: true })
    .first()
    .waitFor()
  await page
    .getByRole("button", { name: "为当前模型创建任务", exact: true })
    .click()
  await page.locator("#fingerprint-job-name").fill("Fixture daily model check")
  await page.locator("#fingerprint-job-type").click()
  await page.getByRole("option", { name: "每天", exact: true }).click()
  await page.locator("#fingerprint-job-at").fill("09:30")
  await page.getByRole("button", { name: "保存任务", exact: true }).click()
  await page
    .getByText("Fixture daily model check", { exact: false })
    .first()
    .waitFor()
  await page
    .getByTestId("fingerprint-schedules")
    .getByRole("button", { name: "启用", exact: true })
    .click()
  await page
    .getByTestId("fingerprint-schedules")
    .getByRole("button", { name: "暂停", exact: true })
    .click()
  await page.locator("#fingerprint-stream").click()
  await page.locator("#fingerprint-parallel").click()
  await page.locator("#fingerprint-auto-verify").click()
  await page.locator("#fingerprint-effort").fill("xhigh")
  await page.locator("#fingerprint-tier").click()
  await page.getByRole("option", { name: "Ultrafast", exact: true }).click()
  await page.getByText("自定义 User-Agent 和请求头", { exact: true }).click()
  await page.locator("#fingerprint-ua").fill("FixtureClient/3.0")
  const settingsSaved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/detection/config") &&
      response.request().method() === "PATCH" &&
      response.request().postDataJSON()?.headers?.["x-fixture-header"] ===
        "retained",
  )
  await page
    .locator("#fingerprint-headers")
    .fill('{"x-fixture-header":"retained"}')
  const savedResponse = await settingsSaved
  assert.equal(savedResponse.ok(), true)
  const savedSettings = (await savedResponse.json()).config
  assert.equal(savedSettings.stream, true)
  assert.equal(savedSettings.parallel, false)
  assert.equal(savedSettings.autoVerify, false)
  assert.equal(savedSettings.userAgent, "FixtureClient/3.0")
  assert.equal(savedSettings.effort, "xhigh")
  assert.equal(savedSettings.serviceTier, "ultrafast")
  await page.reload()
  await page.locator('#fingerprint-stream[aria-checked="true"]').waitFor()
  assert.equal(
    await page.locator("#fingerprint-parallel").getAttribute("aria-checked"),
    "false",
  )
  assert.equal(
    await page.locator("#fingerprint-auto-verify").getAttribute("aria-checked"),
    "false",
  )
  assert.equal(await page.locator("#fingerprint-effort").inputValue(), "xhigh")
  await page.getByText("自定义 User-Agent 和请求头", { exact: true }).click()
  assert.equal(
    await page.locator("#fingerprint-ua").inputValue(),
    "FixtureClient/3.0",
  )
  assert.equal(
    JSON.parse(await page.locator("#fingerprint-headers").inputValue())[
      "x-fixture-header"
    ],
    "retained",
  )
  await page.getByRole("button", { name: "开始指纹检测", exact: true }).click()
  await page
    .getByRole("button", { name: "验证已保存的样本", exact: true })
    .waitFor()
  assert.equal(detectionInput.stream, true)
  assert.equal(detectionInput.parallel, false)
  assert.equal(detectionInput.effort, "xhigh")
  assert.equal(detectionInput.serviceTier, "ultrafast")
  const callsBeforeVerify = detectionCalls
  await page
    .getByRole("button", { name: "验证已保存的样本", exact: true })
    .click()
  await page
    .getByRole("button", { name: "验证已保存的样本", exact: true })
    .waitFor({ state: "hidden" })
  assert.equal(detectionCalls, callsBeforeVerify)
  assert.equal(
    await page
      .getByTestId("fingerprint-history")
      .getByRole("button", { name: "查看结果", exact: true })
      .count(),
    2,
  )
  await page
    .getByTestId("fingerprint-history")
    .locator("li")
    .filter({ hasText: "99.8%" })
    .getByRole("button", { name: "查看结果", exact: true })
    .click()
  await page
    .getByTestId("fingerprint-result")
    .getByRole("heading", { name: "fixture-model", exact: true })
    .waitFor()
  assert.equal(
    await page.getByTestId("fingerprint-top-confidence").innerText(),
    "99.8%",
  )
  page.once("dialog", (dialog) => dialog.accept())
  await page
    .getByTestId("fingerprint-schedules")
    .getByRole("button", { name: "删除", exact: true })
    .click()
  await page
    .getByText("还没有定时任务，可为当前模型创建。", { exact: true })
    .waitFor()

  await page.evaluate(() => {
    document
      .querySelector('[data-testid="fingerprint-result"]')
      ?.scrollIntoView({ behavior: "instant", block: "start" })
    window.scrollTo({ top: 0, behavior: "instant" })
  })
  await page.screenshot({
    path: path.join(artifacts, "fingerprint-desktop.png"),
    fullPage: true,
    animations: "disabled",
  })
  await page.evaluate(() => document.documentElement.classList.add("dark"))
  await page.screenshot({
    path: path.join(artifacts, "fingerprint-dark.png"),
    fullPage: true,
    animations: "disabled",
  })
  await page.evaluate(() => document.documentElement.classList.remove("dark"))
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByTestId("fingerprint-result").screenshot({
    path: path.join(artifacts, "fingerprint-mobile.png"),
    animations: "disabled",
  })
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  )
  await page.setViewportSize({ width: 1440, height: 1000 })

  await page.getByRole("button", { name: "总览", exact: true }).first().click()
  await page
    .locator('[data-testid="options-content-card"]')
    .getByRole("heading")
    .first()
    .waitFor()
  await page.screenshot({
    path: path.join(artifacts, "overview-desktop.png"),
    fullPage: true,
  })
  const languageTrigger = page
    .getByRole("button", { name: /界面语言选择/ })
    .first()
  {
    await languageTrigger.click()
    assert.equal(await page.getByRole("menuitemradio").count(), 2)
    await page.getByRole("menuitemradio", { name: /English|英文/ }).click()
    await page.waitForFunction(() => document.documentElement.lang === "en")
    await page
      .getByRole("button", { name: /language/i })
      .first()
      .click()
    await page.getByRole("menuitemradio", { name: /简体中文|Chinese/ }).click()
    await page.waitForFunction(() => document.documentElement.lang === "zh-CN")
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({
    path: path.join(artifacts, "overview-mobile.png"),
    fullPage: true,
  })
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  )
  assert.deepEqual(errors, [])
  assert.deepEqual(failedRequests, [])
  assert.equal(await page.getByTestId("sidebar-footer-sponsor").count(), 0)
  await writeFile(
    path.join(artifacts, "pages.json"),
    JSON.stringify(headings, null, 2),
  )
  console.log(
    JSON.stringify({
      result: "passed",
      checks: [
        "15 original menus",
        "original Anyrouter and Relayfor backup import",
        "full export download",
        "Anyrouter keys with valid imported credentials",
        "model and key inventories survive reload and manual refresh fetches again",
        "separate key and model schedule settings persist",
        "saved API credential + model detection",
        "calibrated percentage and saved history",
        "daily schedule create enable pause delete",
        "streaming and persisted options across reload",
        "saved samples verified without another paid call",
        "Chinese and English switch",
        "fingerprint and overview mobile layout",
        "no sponsor UI",
        "no JS errors or failed resources",
      ],
      artifacts,
    }),
  )
} catch (error) {
  const pages = browser?.contexts()[0]?.pages()
  if (pages?.[0]) {
    await writeFile(
      path.join(artifacts, "fingerprint-v3-failure.txt"),
      await pages[0].locator("body").innerText(),
    )
    await pages[0].screenshot({
      path: path.join(artifacts, "fingerprint-v3-failure.png"),
      fullPage: true,
    })
  }
  throw error
} finally {
  await browser?.close()
  await new Promise((resolve) => server.close(resolve))
  await app.close()
  await rm(directory, { recursive: true, force: true })
}
