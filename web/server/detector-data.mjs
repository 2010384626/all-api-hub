import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { decompress } from "fzstd"
import { loadDetector } from "lmfpd-sdk"

let loaded

/** Load only the integrity-checked, lockfile-pinned reference bank; no runtime download. */
export async function loadReferenceDetector() {
  loaded ??= readPackagedReference().catch((error) => {
    loaded = undefined
    throw error
  })
  return loaded
}

async function readPackagedReference() {
  const root = dirname(
    fileURLToPath(import.meta.resolve("lmfpd-data/package.json")),
  )
  const bundle = JSON.parse(await readFile(join(root, "bundle.json"), "utf8"))
  const info = bundle.files?.["shared_detector.bin"]
  if (
    bundle.schema !== "lmfpd-data-v1" ||
    bundle.detector_schema !== "shared-detector-v2" ||
    !Array.isArray(info?.parts) ||
    !info.parts.length ||
    info.parts.length > 64 ||
    !/^[a-f0-9]{64}$/.test(info.sha256)
  ) {
    throw new Error("模型指纹参考库格式不兼容，请更新服务。")
  }
  const parts = await Promise.all(
    info.parts.map((part) => {
      if (
        typeof part !== "string" ||
        basename(part) !== part ||
        part.includes("\\")
      ) {
        throw new Error("模型指纹参考库分片名称无效。")
      }
      return readFile(join(root, "chunks", part))
    }),
  )
  const binary = decompress(Buffer.concat(parts))
  if (createHash("sha256").update(binary).digest("hex") !== info.sha256) {
    throw new Error("模型指纹参考库完整性校验失败，请重新安装服务。")
  }
  // The SDK's local-source interface expects these two files. They are removed
  // after it has loaded them, so credentials and persistent storage never mix.
  const temporary = await mkdtemp(join(tmpdir(), "aah-detector-"))
  try {
    await Promise.all([
      writeFile(join(temporary, "unified_bank.json"), JSON.stringify(bundle)),
      writeFile(join(temporary, "shared_detector.bin"), binary),
    ])
    return await loadDetector({ source: temporary })
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
