import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  pruneWebCatalogOwners,
  readWebCatalogSchedule,
  readWebCatalogSnapshot,
  requestWebCatalogRefresh,
  saveWebCatalogSchedule,
} from "~/services/webCatalogs/snapshots"

const mocks = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  failRead: false,
  web: true,
}))
vi.mock("@plasmohq/storage", () => ({
  Storage: class {
    async get(key: string) {
      if (mocks.failRead) throw new Error("disk read failed")
      return structuredClone(mocks.values.get(key))
    }
    async set(key: string, value: unknown) {
      mocks.values.set(key, structuredClone(value))
    }
  },
}))
vi.mock("~/utils/browser/webService", () => ({ isWebService: () => mocks.web }))

describe("persistent Web catalogs", () => {
  beforeEach(() => {
    mocks.values.clear()
    mocks.failRead = false
    mocks.web = true
  })
  it("keeps the first successful result without TTL and explicitly replaces on refresh", async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce(["old"])
      .mockResolvedValueOnce(["new"])
    expect(
      await readWebCatalogSnapshot("keys", "account:1", "list", "auth", load),
    ).toEqual(["old"])
    expect(
      await readWebCatalogSnapshot("keys", "account:1", "list", "auth", load),
    ).toEqual(["old"])
    await requestWebCatalogRefresh("keys", "account:1")
    expect(
      await readWebCatalogSnapshot("keys", "account:1", "list", "auth", load),
    ).toEqual(["new"])
    expect(load).toHaveBeenCalledTimes(2)
  })
  it("retains the last success on a failed refresh and makes it readable on next visit", async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce(["saved"])
      .mockRejectedValueOnce(new Error("offline"))
    await readWebCatalogSnapshot("models", "profile:1", "models", "auth", load)
    await requestWebCatalogRefresh("models", "profile:1")
    await expect(
      readWebCatalogSnapshot("models", "profile:1", "models", "auth", load),
    ).rejects.toThrow("offline")
    expect(
      await readWebCatalogSnapshot(
        "models",
        "profile:1",
        "models",
        "auth",
        load,
      ),
    ).toEqual(["saved"])
  })
  it("credential changes and deleted owners cannot reuse their previous snapshots", async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce(["before"])
      .mockResolvedValueOnce(["after"])
      .mockResolvedValueOnce([])
    await readWebCatalogSnapshot("keys", "account:1", "list", "old-auth", load)
    expect(
      await readWebCatalogSnapshot(
        "keys",
        "account:1",
        "list",
        "new-auth",
        load,
      ),
    ).toEqual(["after"])
    await pruneWebCatalogOwners(new Set())
    expect(
      await readWebCatalogSnapshot(
        "keys",
        "account:1",
        "list",
        "new-auth",
        load,
      ),
    ).toEqual([])
  })
  it("reuses persisted results after module restart and serializes independent writes", async () => {
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        readWebCatalogSnapshot(
          "models",
          `account:${i}`,
          "models",
          "auth",
          async () => [i],
        ),
      ),
    )
    vi.resetModules()
    const fresh = await import("~/services/webCatalogs/snapshots")
    const load = vi.fn(async () => [99])
    expect(
      await fresh.readWebCatalogSnapshot(
        "models",
        "account:8",
        "models",
        "auth",
        load,
      ),
    ).toEqual([8])
    expect(load).not.toHaveBeenCalled()
  })
  it("fails closed on unreadable storage, while extension mode retains original network behavior", async () => {
    mocks.failRead = true
    const load = vi.fn(async () => [])
    await expect(
      readWebCatalogSnapshot("keys", "account:1", "list", "auth", load),
    ).rejects.toThrow("disk read failed")
    expect(load).not.toHaveBeenCalled()
    mocks.web = false
    await readWebCatalogSnapshot("keys", "account:1", "list", "auth", load)
    expect(load).toHaveBeenCalledOnce()
  })
  it("stores separate explicit schedules and rejects invalid intervals", async () => {
    expect((await readWebCatalogSchedule("keys")).enabled).toBe(false)
    await saveWebCatalogSchedule("keys", true, 30)
    expect((await readWebCatalogSchedule("keys")).everyMinutes).toBe(30)
    expect((await readWebCatalogSchedule("models")).enabled).toBe(false)
    await expect(saveWebCatalogSchedule("keys", true, 0)).rejects.toThrow(
      "Interval",
    )
  })
  it("does not let an old response overwrite a newer refresh or recreate a deleted owner", async () => {
    let release!: (value: string[]) => void
    const first = readWebCatalogSnapshot(
      "keys",
      "account:1",
      "list",
      "old",
      () =>
        new Promise<string[]>((resolve) => {
          release = resolve
        }),
    )
    await vi.waitFor(() => expect(release).toBeTypeOf("function"))
    await readWebCatalogSnapshot(
      "keys",
      "account:1",
      "list",
      "new",
      async () => ["new"],
    )
    release(["old"])
    await first
    expect(
      await readWebCatalogSnapshot(
        "keys",
        "account:1",
        "list",
        "new",
        async () => ["wrong"],
      ),
    ).toEqual(["new"])
    const pending = readWebCatalogSnapshot(
      "keys",
      "account:2",
      "list",
      "auth",
      () =>
        new Promise<string[]>((resolve) => {
          release = resolve
        }),
    )
    await vi.waitFor(() => expect(mocks.values.size).toBeGreaterThan(0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    await pruneWebCatalogOwners(new Set(["account:1"]))
    release(["removed"])
    await pending
    expect(
      await readWebCatalogSnapshot(
        "keys",
        "account:2",
        "list",
        "auth",
        async () => ["fresh"],
      ),
    ).toEqual(["fresh"])
  })
  it("refresh requested during a load rejects that response from the persisted snapshot", async () => {
    let release!: (value: string[]) => void
    const pending = readWebCatalogSnapshot(
      "models",
      "account:1",
      "catalog",
      "auth",
      () =>
        new Promise<string[]>((resolve) => {
          release = resolve
        }),
    )
    await vi.waitFor(() => expect(release).toBeTypeOf("function"))
    await requestWebCatalogRefresh("models", "account:1")
    release(["stale"])
    await pending
    const load = vi.fn(async () => ["refreshed"])
    expect(
      await readWebCatalogSnapshot(
        "models",
        "account:1",
        "catalog",
        "auth",
        load,
      ),
    ).toEqual(["refreshed"])
    expect(load).toHaveBeenCalledOnce()
  })
})
