import { describe, expect, it, vi } from "vitest"

import { readDetectionStream } from "~/features/ModelFingerprint/stream"

describe("fingerprint live results", () => {
  it("delivers sample updates before the final result across split UTF-8 and SSE frames", async () => {
    const encoder = new TextEncoder()
    const bytes = encoder.encode(
      'event: progress\r\ndata: {"type":"sample","index":0,"sample":{"state":"streaming","count":2,"text":"样本 12 34"}}\r\n\r\nevent: result\r\ndata: {"historyId":"saved","analysis":{"probability":0.998}}\r\n\r\n',
    )
    const progress = vi.fn()
    const response = new Response(
      new ReadableStream({
        start(controller) {
          for (let i = 0; i < bytes.length; i += 7)
            controller.enqueue(bytes.slice(i, i + 7))
          controller.close()
        },
      }),
    )
    const result = await readDetectionStream(response, progress)
    expect(progress).toHaveBeenCalledWith({
      type: "sample",
      index: 0,
      sample: { state: "streaming", count: 2, text: "样本 12 34" },
    })
    expect(result.historyId).toBe("saved")
  })
  it("does not treat a truncated or error stream as a completed detection", async () => {
    await expect(
      readDetectionStream(
        new Response(
          'event: progress\ndata: {"type":"sample","index":0,"sample":{"count":1}}\n\n',
        ),
        vi.fn(),
      ),
    ).rejects.toThrow("before the result")
    await expect(
      readDetectionStream(
        new Response(
          'event: error\ndata: {"error":"Upstream unavailable"}\n\n',
        ),
        vi.fn(),
      ),
    ).rejects.toThrow("Upstream unavailable")
  })
})
