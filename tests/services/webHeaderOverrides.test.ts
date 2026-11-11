import { afterEach, describe, expect, it, vi } from "vitest"

import { fetchWithHeaderOverrides } from "~/services/apiTransport/headerOverrides"

describe("Web transport private headers", () => {
  afterEach(() => {
    delete (globalThis as { __AAH_WEB__?: boolean }).__AAH_WEB__
    vi.unstubAllGlobals()
  })

  it("sends explicit Cookie, origin and custom UA through the server bridge", async () => {
    ;(globalThis as { __AAH_WEB__?: boolean }).__AAH_WEB__ = true
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"))
    vi.stubGlobal("fetch", fetchMock)
    await fetchWithHeaderOverrides(
      "https://relay.example/api/user/self",
      { headers: { authorization: "Bearer token" } },
      { "user-agent": "custom-cli/1" },
      {
        cookieSession: {
          origin: "https://relay.example",
          cookieHeader: "session=private",
        },
      },
    )
    const headers = new Headers(fetchMock.mock.calls[0]?.[1].headers)
    expect(headers.get("cookie")).toBe("session=private")
    expect(headers.get("origin")).toBe("https://relay.example")
    expect(headers.get("user-agent")).toBe("custom-cli/1")
    expect(headers.get("authorization")).toBe("Bearer token")
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      credentials: "omit",
      redirect: "error",
    })
  })

  it("rejects cross-origin Cookie scope before dispatch", async () => {
    ;(globalThis as { __AAH_WEB__?: boolean }).__AAH_WEB__ = true
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    await expect(
      fetchWithHeaderOverrides(
        "https://other.example/api/user/self",
        undefined,
        undefined,
        {
          cookieSession: {
            origin: "https://relay.example",
            cookieHeader: "session=private",
          },
        },
      ),
    ).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
