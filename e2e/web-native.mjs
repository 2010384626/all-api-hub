// Native options UI + real Node background; upstream requests use local fixtures.
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { chromium } from "@playwright/test"

import { createApp } from "../web/server/app.mjs"
import { createExtensionRuntime } from "../web/server/extension-runtime.mjs"

const directory = await mkdtemp(path.join(tmpdir(), "aah-native-web-"))
const artifacts = path.resolve(".scratch/vps-web/artifacts/native-ui")
await mkdir(artifacts, { recursive: true })
const port = 4419
const password = "native-browser-fixture-password"
const origin = `http://127.0.0.1:${port}`
let detectionInput
const fetchImpl = async (raw) => {
  const url = String(raw)
  if (url.includes("/models"))
    return Response.json({
      data: [{ id: "fixture-model" }, { id: "fixture-second" }],
    })
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
  if (url.includes("/api/token/"))
    return Response.json({
      success: true,
      data: {
        items: [
          {
            id: 1,
            name: "fixture key",
            key: "fixture-key",
            status: 1,
            models: "",
          },
        ],
      },
    })
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
  detect: async (input) => {
    detectionInput = input
    return {
      analysis: {
        prediction: "fixture-model",
        results: [{ model: "fixture-model", score: 0.9 }],
      },
      samples: [],
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
        disabled: false,
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
  for (let attempt = 0; attempt < 50; attempt++) {
    const count = await page.evaluate(
      async () =>
        JSON.parse(
          (await browser.storage.local.get("site_accounts")).site_accounts ||
            "{}",
        ).accounts?.length,
    )
    if (count === 2) break
    await page.waitForTimeout(100)
  }
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
  await page.screenshot({
    path: path.join(artifacts, "fingerprint-desktop.png"),
    fullPage: true,
  })
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
        "saved API credential + model detection",
        "Chinese and English switch",
        "mobile layout",
        "no sponsor UI",
        "no JS errors or failed resources",
      ],
      artifacts,
    }),
  )
} finally {
  await browser?.close()
  await new Promise((resolve) => server.close(resolve))
  await app.close()
  await rm(directory, { recursive: true, force: true })
}
