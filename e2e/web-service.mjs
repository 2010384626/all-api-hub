// Standalone Web service browser acceptance. Uses deterministic upstream fixtures;
// no requests are sent to real API providers and no model credits are consumed.
// AAH_PLAYWRIGHT_MODULE can point to a bundled playwright module directory.
// AAH_BROWSER_EXECUTABLE can point to an installed Chromium/Chrome executable.
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"

import { createApp } from "../web/server/app.mjs"

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.AAH_PLAYWRIGHT_MODULE || "playwright")
const directory = await mkdtemp(path.join(tmpdir(), "aah-web-browser-"))
const artifacts = path.resolve(
  process.env.AAH_BROWSER_ARTIFACTS ||
    `.scratch/vps-web/artifacts/browser-smoke/${new Date().toISOString().replace(/[:.]/g, "-")}`,
)
await mkdir(artifacts, { recursive: true })
const port = Number(process.env.AAH_BROWSER_PORT || 4399)
const origin = `http://127.0.0.1:${port}`
const adminPassword = "browser-fixture-password-only"
let detectorInput
const app = await createApp({
  env: {
    ADMIN_PASSWORD: adminPassword,
    ENCRYPTION_KEY: "3".repeat(64),
    DATA_DIR: directory,
    PUBLIC_ORIGIN: origin,
    BASE_PATH: "/hub/",
    SOURCE_URL: "https://github.com/qixing-jk/all-api-hub",
  },
  fetchImpl: async (url) => {
    if (url.endsWith("/api/user/self"))
      return Response.json({
        success: true,
        data: { quota: 12345678, used_quota: 3456789, request_count: 42 },
      })
    if (url.endsWith("/api/user/checkin"))
      return Response.json({ success: true, data: {} })
    if (url.endsWith("/v1/models"))
      return Response.json({
        data: [{ id: "fixture-model" }, { id: "fixture-reasoning-model" }],
      })
    if (url.includes("/api/token/"))
      return Response.json({
        success: true,
        data: {
          items: [
            {
              id: 1,
              name: "工作密钥",
              key: "sk-test-secret-do-not-show",
              status: 1,
            },
          ],
        },
      })
    throw new Error(`Unexpected fixture request: ${url}`)
  },
  detect: async (input) => {
    detectorInput = input
    if (input.model === "fixture-failure")
      return {
        analysis: null,
        error: "没有有效样本",
        samples: [
          { error: "Upstream returned HTTP 403" },
          { error: "DNS lookup failed" },
        ],
      }
    return {
      analysis: {
        prediction: "fixture-model",
        prediction_name: "Fixture Model · 示例候选",
        results: [
          {
            model: "fixture-model",
            display_name: "Fixture Model · 示例候选",
            score: 0.93,
            probability: 0.91,
          },
          {
            model: "fixture-other",
            display_name: "Fixture Other",
            score: 0.55,
            probability: 0.09,
          },
        ],
      },
      samples: [],
      preset: input.preset,
      api: input.api,
      disclaimer: "测试夹具：仅演示结果布局，不代表真实检测。",
    }
  },
})
const server = createServer(app.handler)
await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve))
let browser
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.AAH_BROWSER_EXECUTABLE
      ? { executablePath: process.env.AAH_BROWSER_EXECUTABLE }
      : {}),
  })
  const context = await browser.newContext({
    viewport: { width: 1360, height: 1000 },
    reducedMotion: "reduce",
    acceptDownloads: true,
  })
  const page = await context.newPage()
  const screenshot = async (name) => {
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.screenshot({ path: path.join(artifacts, name), fullPage: true })
  }
  const pageErrors = []
  page.on("pageerror", (error) => pageErrors.push(error.message))
  page.on("dialog", (dialog) => dialog.accept())
  await page.goto(`${origin}/hub/`)
  await page.locator("#login-view").waitFor({ state: "visible" })
  await screenshot("login-desktop.png")
  await page.locator("#password").fill("invalid-password")
  await page.locator("#login-form button").click()
  await page
    .locator("#login-error")
    .filter({ hasText: /密码|登录/ })
    .waitFor()
  await page.locator("#password").fill(adminPassword)
  await page.locator("#login-form button").click()
  await page.locator("#workspace").waitFor({ state: "visible" })
  await page.locator("#overview-accounts .empty-state").waitFor()
  await page.locator("#view-overview [data-add-account]").click()
  await page.locator("#account-name").fill("主力 API · 测试账户")
  await page.locator("#account-url").fill("https://fixture.example")
  await page.locator("#account-token").fill("fixture-account-token")
  await page.locator("#account-key").fill("fixture-api-key")
  await page.locator("#account-user-id").fill("7")
  await page.locator("#account-auto").check()
  await page.locator("#account-form button[type=submit]").click()
  await page.locator("#account-dialog").waitFor({ state: "hidden" })
  await page.locator("[data-view=accounts]").click()
  await page.locator(".account-card").waitFor()
  await page.locator(".account-card button").filter({ hasText: "刷新" }).click()
  await page
    .locator(".account-card strong")
    .filter({ hasText: "24.6914" })
    .waitFor()
  await page
    .locator(".account-card button")
    .filter({ hasText: /^签到$/ })
    .click()
  await page.locator("#toast").filter({ hasText: "签到请求已完成" }).waitFor()
  await page
    .locator(".account-card button")
    .filter({ hasText: /^模型$/ })
    .click()
  await page
    .locator("#detail-body")
    .filter({ hasText: "fixture-reasoning-model" })
    .waitFor()
  await page.locator("#detail-dialog .dialog-actions button").click()
  await page
    .locator(".account-card button")
    .filter({ hasText: /^密钥$/ })
    .click()
  await page.locator("#detail-body").filter({ hasText: "工作密钥" }).waitFor()
  assert.equal(
    (await page.locator("#detail-body").textContent()).includes(
      "secret-do-not-show",
    ),
    false,
  )
  await page.locator("#detail-dialog .dialog-actions button").click()
  await page
    .locator(".account-card button")
    .filter({ hasText: /^编辑$/ })
    .click()
  assert.equal(await page.locator("#account-token").inputValue(), "")
  await page.locator("#account-name").fill("主力 API · 已更新")
  await page.locator("#account-form button[type=submit]").click()
  await page.locator("#account-dialog").waitFor({ state: "hidden" })
  assert.equal(
    (await app.store.read()).accounts[0].token,
    "fixture-account-token",
  )
  await page.reload()
  await page
    .locator(".account-card")
    .filter({ hasText: "主力 API · 已更新" })
    .waitFor()
  await page.locator("[data-view=overview]").click()
  await screenshot("overview-desktop.png")
  await page.locator("[data-view=detector]").click()
  const storedAccount = (await app.store.read()).accounts[0]
  await page.locator("#detect-account").selectOption(storedAccount.id)
  await page.locator("#detect-model").fill("fixture-model")
  await page.locator("#detect-preset").selectOption("claude-code")
  assert.equal(await page.locator("#detect-api").inputValue(), "messages")
  await page.locator("#detect-preset").selectOption("codex-cli")
  assert.equal(await page.locator("#detect-api").inputValue(), "responses")
  await page.locator("#detect-ua").fill("Custom-Client/1.0")
  await page.locator("#detect-headers").fill("{invalid}")
  await page.locator("#detect-submit").click()
  await page.locator("#detect-error").filter({ hasText: "JSON" }).waitFor()
  await page.locator("#detect-headers").fill('{"x-client-version":"fixture"}')
  await page.locator("#detect-model").fill("fixture-failure")
  await page.locator("#detect-submit").click()
  await page.locator(".sample-errors").filter({ hasText: "HTTP 403" }).waitFor()
  await page
    .locator(".sample-errors")
    .filter({ hasText: "DNS lookup failed" })
    .waitFor()
  await screenshot("detector-error-desktop.png")
  await page.locator("#detect-model").fill("fixture-model")
  await page.locator("#detect-submit").click()
  await page
    .locator(".prediction-name")
    .filter({ hasText: "Fixture Model" })
    .waitFor()
  assert.equal(detectorInput.apiKey, "fixture-api-key")
  assert.equal(detectorInput.userAgent, "Custom-Client/1.0")
  assert.equal(detectorInput.headers["x-client-version"], "fixture")
  await screenshot("detector-desktop.png")
  await page.setViewportSize({ width: 390, height: 844 })
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    "Mobile detector must not overflow horizontally",
  )
  await screenshot("detector-mobile.png")
  await page.locator("[data-view=overview]").click()
  await screenshot("overview-mobile.png")
  await page.locator("[data-view=data]").click()
  const downloaded = page.waitForEvent("download")
  await page.locator("#export-data").click()
  assert.match((await downloaded).suggestedFilename(), /all-api-hub-backup/)
  await page.locator("#import-file").setInputFiles({
    name: "fixture-import.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        accounts: {
          accounts: [
            {
              site_name: "迁移测试",
              site_type: "new-api",
              site_url: "https://import.example",
              account_info: { access_token: "fixture-import-token", id: 8 },
            },
            { site_name: "不支持站点", site_type: "unsupported" },
          ],
        },
      }),
    ),
  })
  await page.locator("#import-form button").click()
  await page
    .locator("#import-result")
    .filter({ hasText: "已跳过 1 项：不支持站点" })
    .waitFor()
  await page.locator("[data-view=accounts]").click()
  await page
    .locator(".account-card")
    .filter({ hasText: "迁移测试" })
    .getByRole("button", { name: "删除", exact: true })
    .click()
  await page.locator("#toast").filter({ hasText: "账户已删除" }).waitFor()
  assert.equal((await app.store.read()).accounts.length, 1)
  await page.locator("[data-view=system]").click()
  await page
    .locator("#system-status")
    .filter({ hasText: "bash deploy/update.sh" })
    .waitFor()
  assert.equal(
    await page.locator("#source-link").getAttribute("href"),
    "https://github.com/qixing-jk/all-api-hub",
  )
  await page.locator("#logout-mobile").click()
  await page.locator("#login-view").waitFor({ state: "visible" })
  await page.reload()
  await page.locator("#login-view").waitFor({ state: "visible" })
  assert.deepEqual(pageErrors, [], "No page JavaScript errors")
  console.log(
    JSON.stringify(
      {
        result: "passed",
        checks: [
          "subpath mount",
          "login failure and success",
          "CSRF mutations",
          "account CRUD + secret preservation + reload persistence",
          "refresh/checkin",
          "model and masked-key lists",
          "preset protocol + custom UA/headers + saved API key",
          "invalid header JSON",
          "failed sample diagnostics + retry",
          "fixture result ranking",
          "mobile no overflow + logout",
          "backup download",
          "partial import",
          "source link",
          "no page errors",
        ],
        artifacts,
      },
      null,
      2,
    ),
  )
} finally {
  await browser?.close()
  await new Promise((resolve) => server.close(resolve))
  await rm(directory, { recursive: true, force: true })
}
