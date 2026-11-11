import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"

export class Store {
  #queue = Promise.resolve()
  constructor(directory, key) {
    if (!/^[a-f\d]{64}$/i.test(key || ""))
      throw new Error("ENCRYPTION_KEY must contain 64 hexadecimal characters")
    this.directory = directory
    this.file = path.join(directory, "state.enc")
    this.key = Buffer.from(key, "hex")
  }
  async read() {
    let encoded
    try {
      encoded = await readFile(this.file)
    } catch (e) {
      if (e.code === "ENOENT")
        return { version: 1, accounts: [], history: [], settings: {} }
      throw e
    }
    if (encoded.subarray(0, 4).toString() !== "AAH1")
      throw new Error("Unsupported encrypted storage format")
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      encoded.subarray(4, 16),
    )
    decipher.setAuthTag(encoded.subarray(16, 32))
    const state = JSON.parse(
      Buffer.concat([decipher.update(encoded.subarray(32)), decipher.final()]),
    )
    if (
      state.version !== 1 ||
      !Array.isArray(state.accounts) ||
      !Array.isArray(state.history)
    )
      throw new Error("Unsupported state schema")
    return state
  }
  mutate(fn) {
    const operation = this.#queue.then(async () => {
      const state = await this.read()
      const result = await fn(state)
      const iv = randomBytes(12)
      const cipher = createCipheriv("aes-256-gcm", this.key, iv)
      const encrypted = Buffer.concat([
        cipher.update(JSON.stringify(state)),
        cipher.final(),
      ])
      const bytes = Buffer.concat([
        Buffer.from("AAH1"),
        iv,
        cipher.getAuthTag(),
        encrypted,
      ])
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const temp = this.file + ".tmp"
      await writeFile(temp, bytes, { mode: 0o600 })
      await rename(temp, this.file)
      return result
    })
    this.#queue = operation.catch(() => {})
    return operation
  }
}
