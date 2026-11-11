import { lookup } from "node:dns/promises"
import ipaddr from "ipaddr.js"
import { Agent, fetch as undiciFetch } from "undici"

import { AppError, requireValue } from "./errors.mjs"

export function isPublicAddress(address) {
  try {
    const ip = ipaddr.process(address)
    return (
      ip.range() === "unicast" &&
      (ip.kind() === "ipv4" || ip.match(ipaddr.parse("2000::"), 3))
    )
  } catch {
    return false
  }
}

export function validateUrl(value, allowQuery = false) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new AppError(400, "请输入有效的 HTTPS 地址")
  }
  requireValue(url.protocol === "https:", "远程接口必须使用 HTTPS")
  requireValue(
    !url.username && !url.password && !url.hash && (allowQuery || !url.search),
    "地址不能包含凭据、查询参数或片段",
  )
  requireValue(
    url.hostname !== "localhost" && !url.hostname.endsWith(".localhost"),
    "不能访问本机或内网地址",
  )
  return url
}

/** Resolve once and pin the socket to the verified result; never follow redirects. */
export function createSafeFetch({
  lookupImpl = lookup,
  fetchImpl = undiciFetch,
  AgentImpl = Agent,
} = {}) {
  return async function safeFetch(input, init = {}) {
    const url = validateUrl(String(input), true)
    const hostname = url.hostname.replace(/^\[|\]$/g, "")
    const signal = AbortSignal.any([
      AbortSignal.timeout(120_000),
      ...(init.signal ? [init.signal] : []),
    ])
    let addresses
    try {
      signal.throwIfAborted()
      addresses = await new Promise((resolve, reject) => {
        const aborted = () => reject(signal.reason)
        signal.addEventListener("abort", aborted, { once: true })
        Promise.resolve()
          .then(() => lookupImpl(hostname, { all: true, verbatim: true }))
          .then(resolve, reject)
          .finally(() => signal.removeEventListener("abort", aborted))
      })
    } catch {
      throw new AppError(
        502,
        signal.aborted ? "请求超时或已取消" : "上游域名解析失败",
      )
    }
    requireValue(
      addresses.length > 0 &&
        addresses.every((a) => isPublicAddress(a.address)),
      "不能访问内网、回环或保留地址",
    )
    const chosen = addresses[0]
    const dispatcher = new AgentImpl({
      connect: {
        lookup: (_hostname, options, callback) =>
          options.all
            ? callback(null, [chosen])
            : callback(null, chosen.address, chosen.family),
        timeout: 15_000,
      },
    })
    try {
      const response = await fetchImpl(url, {
        ...init,
        dispatcher,
        signal,
        redirect: "manual",
      })
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel()
        throw new AppError(502, "上游返回重定向，请直接填写最终接口地址")
      }
      const chunks = []
      let size = 0
      if (response.body)
        for await (const chunk of response.body) {
          size += chunk.length
          if (size > 4 * 1024 * 1024)
            throw new AppError(502, "上游响应超过 4 MB 限制")
          chunks.push(chunk)
        }
      return new Response(
        [204, 205, 304].includes(response.status)
          ? null
          : Buffer.concat(chunks),
        {
          status: response.status,
          // Keep provider metadata used by pagination, rate limits and usage views.
          // The body is already decompressed, so its transport encoding/length is omitted.
          headers: Object.fromEntries(
            [...response.headers].filter(
              ([name]) =>
                ![
                  "content-encoding",
                  "content-length",
                  "transfer-encoding",
                  "connection",
                  "set-cookie",
                ].includes(name.toLowerCase()),
            ),
          ),
        },
      )
    } catch (error) {
      if (error instanceof AppError) throw error
      throw new AppError(
        502,
        signal.aborted ? "请求超时或已取消" : "上游连接失败，请检查地址和网络",
      )
    } finally {
      await dispatcher.close()
    }
  }
}
export const safeFetch = createSafeFetch()
