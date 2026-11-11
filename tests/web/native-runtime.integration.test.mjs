import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { createExtensionRuntime } from "../../web/server/extension-runtime.mjs"
import { Store } from "../../web/server/store.mjs"

const root = fileURLToPath(new URL("../../", import.meta.url))
const bundlePath = path.join(root, "web/server/generated/background.mjs")

test(
  "native importer keeps Anyrouter and Relayfor and original background handlers respond",
  { skip: !existsSync(bundlePath) },
  async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), "aah-native-import-"))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const store = new Store(directory, "bc".repeat(32))
    const runtime = await createExtensionRuntime({
      store,
      bundlePath,
      extensionPath: path.join(root, "web/dist"),
      fetchImpl: async () => Response.json({ models: {} }),
    })
    try {
      const now = Date.now()
      const accounts = ["anyrouter", "relayfor"].map((siteType) => ({
        id: `fixture-${siteType}`,
        site_name: siteType === "anyrouter" ? "Anyrouter" : "Relayfor",
        site_type: siteType,
        site_url: `https://${siteType}.example`,
        authType: "access_token",
        exchange_rate: 7.2,
        tagIds: [],
        notes: "",
        health: { status: "unknown" },
        disabled: true,
        excludeFromTotalBalance: false,
        excludeFromTodayIncome: false,
        account_info: {
          id: "7",
          access_token: `fixture-token-${siteType}`,
          username: siteType,
          quota: 0,
          today_prompt_tokens: 0,
          today_completion_tokens: 0,
          today_quota_consumption: 0,
          today_requests_count: 0,
          today_income: 0,
        },
        created_at: now,
        updated_at: now,
        user_updated_at: now,
        last_sync_time: 0,
        configVersion: 8,
        checkIn: {
          automaticExecutionEnabled: false,
          methodKnowledge: { methods: {} },
          selection: { mode: "automatic" },
        },
      }))
      const imported = await runtime.importBackup({
        version: "4.0",
        timestamp: now,
        accounts: {
          accounts,
          bookmarks: [],
          pinnedAccountIds: [],
          orderedAccountIds: accounts.map((a) => a.id),
          deletedEntryRecords: {},
          last_updated: now,
        },
      })
      assert.equal(imported.imported, 2)
      assert.deepEqual(imported.skipped, [])
      const data = await runtime.call("storage.local.get", ["site_accounts"])
      const config = JSON.parse(data.site_accounts)
      assert.deepEqual(
        config.accounts.map((account) => account.site_type).sort(),
        ["anyrouter", "relayfor"],
      )
      assert.equal(
        config.accounts.find((a) => a.site_type === "anyrouter").account_info
          .access_token,
        "fixture-token-anyrouter",
      )
      const status = await runtime.call("runtime.sendMessage", [
        {
          id: "fixture-message",
          type: "autoRefresh:getStatus",
          data: undefined,
          timestamp: now,
        },
      ])
      assert.ok(status)
      assert.equal(runtime.failed, false)
    } finally {
      await runtime.close()
    }
  },
)
