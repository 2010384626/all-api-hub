import { beforeEach, expect, it, vi } from "vitest"

import type { AccountKeyResourceSession } from "~/services/apiAdapters/contracts/accountKeyResource"
import { persistWebKeySession } from "~/services/webCatalogs/keySession"

const mocks = vi.hoisted(() => ({ values: new Map<string, unknown>() }))
vi.mock("@plasmohq/storage", () => ({
  Storage: class {
    async get(key: string) {
      return structuredClone(mocks.values.get(key))
    }
    async set(key: string, value: unknown) {
      mocks.values.set(key, structuredClone(value))
    }
  },
}))
vi.mock("~/utils/browser/webService", () => ({ isWebService: () => true }))
beforeEach(() => {
  mocks.values.clear()
})

it("native inventory survives reopening, and successful create/edit/delete make the next read fresh", async () => {
  const list = vi.fn(async () => ({ items: [] }))
  const submit = vi.fn(async () => ({ facts: null }))
  const remove = vi.fn(async () => {})
  const session = {
    resolveDefaultScope: async () => ({ scopeKey: "default" }),
    listScopes: async () => [],
    openCreateEditor: async () => ({ submit }),
    openCollection: async () => ({
      scope: { scopeKey: "default" },
      list,
      delete: remove,
      openEditEditor: async () => ({ submit }),
    }),
  } as unknown as AccountKeyResourceSession
  const open = () => persistWebKeySession(session, "account:1", "auth")
  await (await open().openCollection("default")).list()
  await (await open().openCollection("default")).list()
  expect(list).toHaveBeenCalledTimes(1)
  await (await open().openCreateEditor("default")).submit({})
  await (await open().openCollection("default")).list()
  expect(list).toHaveBeenCalledTimes(2)
  const ref = {
    accountId: "1",
    siteType: "new-api" as const,
    scopeKey: "default",
    resourceId: "1",
  }
  await (
    await (await open().openCollection("default")).openEditEditor(ref)
  ).submit({})
  await (await open().openCollection("default")).list()
  expect(list).toHaveBeenCalledTimes(3)
  await (await open().openCollection("default")).delete(ref)
  await (await open().openCollection("default")).list()
  expect(list).toHaveBeenCalledTimes(4)
})
