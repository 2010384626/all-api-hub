import type { DetectionResult } from "./types"

export type DetectionProgress = {
  type: "sample"
  index: number
  sample: NonNullable<DetectionResult["samples"]>[number]
}

/** Read complete SSE frames even when network chunks split their UTF-8 text. */
export async function readDetectionStream(
  response: Response,
  onProgress: (value: DetectionProgress) => void,
): Promise<DetectionResult> {
  if (!response.body) throw new Error("Empty detection response")
  const reader = response.body.getReader(),
    decoder = new TextDecoder()
  let pending = "",
    final: DetectionResult | undefined
  const frame = (text: string) => {
    const lines = text.split("\n")
    const event = lines
      .find((line) => line.startsWith("event:"))
      ?.slice(6)
      .trim()
    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
    if (!data) return
    const value = JSON.parse(data)
    if (event === "error")
      throw new Error(value.error || value.message || "Detection failed")
    if (event === "result") final = value
    else if (
      (event === "progress" || event === "sample") &&
      value.type === "sample"
    )
      onProgress(value)
  }
  try {
    while (true) {
      const { value, done } = await reader.read()
      pending = (pending + decoder.decode(value, { stream: !done })).replace(
        /\r\n/g,
        "\n",
      )
      let end
      while ((end = pending.indexOf("\n\n")) >= 0) {
        frame(pending.slice(0, end))
        pending = pending.slice(end + 2)
      }
      if (done) {
        if (pending.trim()) frame(pending)
        break
      }
    }
  } finally {
    reader.releaseLock()
  }
  if (!final) throw new Error("Detection stream ended before the result")
  return final
}
