import { Fingerprint, RefreshCw } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { PageHeader } from "~/components/PageHeader"
import {
  Button,
  Card,
  Input,
  Label,
  SearchableSelect,
  Switch,
  Textarea,
} from "~/components/ui"
import {
  isAccountRuntimeKeyCompatibleWithModel,
  type AccountRuntimeKey,
} from "~/services/accounts/keys/accountRuntimeKeys"
import { toSanitizedErrorSummary } from "~/services/verification/aiApiVerification/utils"

import { fingerprintRequest } from "./api"
import { DetectionResultCard } from "./DetectionResultCard"
import {
  loadFingerprintKeys,
  loadFingerprintModels,
  loadFingerprintSources,
  resolveFingerprintCredential,
  type FingerprintCredential,
  type FingerprintSource,
} from "./library"
import { SavedDetections } from "./SavedDetections"
import { readDetectionStream } from "./stream"
import type { DetectionResult, DetectionTarget } from "./types"

type Preset = {
  id: string
  label: string
  api: string
  userAgent: string
  headers: Record<string, string>
}
const DEFAULT_PRESETS: Preset[] = [
  {
    id: "standard",
    label: "API",
    api: "chat_completions",
    userAgent: "All-API-Hub-Web/1.0",
    headers: {},
  },
  {
    id: "claude-code",
    label: "Claude Code",
    api: "messages",
    userAgent: "claude-cli/2.1.0 (external, cli)",
    headers: { "anthropic-version": "2023-06-01", "x-app": "cli" },
  },
  {
    id: "codex-cli",
    label: "Codex CLI",
    api: "responses",
    userAgent: "codex_cli_rs/0.100.0",
    headers: { originator: "codex_cli_rs" },
  },
]
const webUrl = (route: string) =>
  new URL(`api/${route}`, new URL("./", window.location.href))

/** Shared original-app page; credentials are read from their existing stores. */
export default function ModelFingerprint() {
  const { t } = useTranslation("modelFingerprint")
  const [sources, setSources] = useState<FingerprintSource[]>([])
  const [sourceId, setSourceId] = useState("")
  const [keys, setKeys] = useState<AccountRuntimeKey[]>([])
  const [keysSourceId, setKeysSourceId] = useState("")
  const [keyId, setKeyId] = useState("")
  const [credential, setCredential] = useState<FingerprintCredential | null>(
    null,
  )
  const [models, setModels] = useState<string[]>([])
  const [model, setModel] = useState("")
  const [presets, setPresets] = useState(DEFAULT_PRESETS)
  const [presetId, setPresetId] = useState("standard")
  const [protocol, setProtocol] = useState("chat_completions")
  const [ua, setUa] = useState(DEFAULT_PRESETS[0]!.userAgent)
  const [headersText, setHeadersText] = useState("{}")
  const [stream, setStream] = useState(false)
  const [parallel, setParallel] = useState(true)
  const [looseMode, setLooseMode] = useState(true)
  const [autoVerify, setAutoVerify] = useState(true)
  const [effort, setEffort] = useState("")
  const [serviceTier, setServiceTier] = useState("default")
  const [configLoaded, setConfigLoaded] = useState(false)
  const [configStatus, setConfigStatus] = useState<
    "saved" | "saving" | "error"
  >("saved")
  const [verifying, setVerifying] = useState(false)
  const configQueue = useRef(Promise.resolve())
  const savedConfig = useRef("")
  const forceModels = useRef(false)

  const [manualUrl, setManualUrl] = useState("")
  const [manualKey, setManualKey] = useState("")
  const [syncing, setSyncing] = useState(false)
  const [loadingKeys, setLoadingKeys] = useState(false)
  const [loadingModels, setLoadingModels] = useState(false)
  const [error, setError] = useState("")
  const [result, setResult] = useState<DetectionResult | null>(null)
  const [running, setRunning] = useState(false)
  const [savedRevision, setSavedRevision] = useState(0)
  const [resultContext, setResultContext] = useState("")
  const [modelsRevision, setModelsRevision] = useState(0)
  const controller = useRef<AbortController | null>(null)
  const source = sources.find((item) => item.id === sourceId)
  const key =
    keysSourceId === sourceId
      ? keys.find((item) => item.id === keyId)
      : undefined
  const manual = sourceId === "manual"
  const sanitize = useCallback(
    (failure: unknown) =>
      toSanitizedErrorSummary(
        failure,
        [
          credential?.apiKey ?? "",
          manualKey,
          ...Object.values(credential?.requestHeaders ?? {}),
        ].filter(Boolean),
      ),
    [credential, manualKey],
  )

  useEffect(() => {
    const abort = new AbortController()
    void fingerprintRequest<{ config: Partial<DetectionTarget> }>(
      "detection/config",
      { signal: abort.signal },
    )
      .then(({ config }) => {
        if (config.preset) setPresetId(config.preset)
        if (config.api) setProtocol(config.api)
        if (config.userAgent !== undefined) setUa(config.userAgent)
        if (config.headers)
          setHeadersText(JSON.stringify(config.headers, null, 2))
        if (typeof config.stream === "boolean") setStream(config.stream)
        if (typeof config.parallel === "boolean") setParallel(config.parallel)
        if (typeof config.looseMode === "boolean")
          setLooseMode(config.looseMode)
        if (typeof config.autoVerify === "boolean")
          setAutoVerify(config.autoVerify)
        if (config.effort !== undefined) setEffort(config.effort)
        if (config.serviceTier) setServiceTier(config.serviceTier)
        setConfigLoaded(true)
      })
      .catch((failure) => {
        if (!abort.signal.aborted) {
          setError(toSanitizedErrorSummary(failure, []))
          setConfigStatus("error")
        }
      })
    return () => abort.abort()
  }, [])

  useEffect(() => {
    if (!configLoaded) return
    let headers: Record<string, string>
    try {
      headers = JSON.parse(headersText)
      if (
        !headers ||
        Array.isArray(headers) ||
        typeof headers !== "object" ||
        Object.values(headers).some((value) => typeof value !== "string")
      )
        return
    } catch {
      return
    }
    const config = {
      preset: presetId,
      api: protocol,
      userAgent: ua,
      headers,
      stream,
      parallel,
      looseMode,
      autoVerify,
      effort,
      serviceTier,
    }
    const serialized = JSON.stringify(config)
    if (savedConfig.current === serialized) return
    setConfigStatus("saving")
    let mounted = true
    const timer = window.setTimeout(() => {
      configQueue.current = configQueue.current
        .catch(() => {})
        .then(async () => {
          try {
            await fingerprintRequest("detection/config", {
              method: "PATCH",
              body: config,
            })
            savedConfig.current = serialized
            if (mounted) setConfigStatus("saved")
          } catch {
            if (mounted) setConfigStatus("error")
          }
        })
    }, 500)
    return () => {
      mounted = false
      window.clearTimeout(timer)
    }
  }, [
    configLoaded,
    headersText,
    presetId,
    protocol,
    ua,
    stream,
    parallel,
    looseMode,
    autoVerify,
    effort,
    serviceTier,
  ])

  const verify = async () => {
    if (!result?.historyId) return
    setVerifying(true)
    setError("")
    try {
      const verified = await fingerprintRequest<DetectionResult>(
        `detection/history/${result.historyId}/verify`,
        { method: "POST" },
      )
      setResult(verified)
      setSavedRevision((value) => value + 1)
    } catch (failure) {
      setError(sanitize(failure))
    } finally {
      setVerifying(false)
    }
  }

  const synchronize = useCallback(async () => {
    setSyncing(true)
    setError("")
    try {
      const next = await loadFingerprintSources()
      setSources(next)
      setSourceId((current) =>
        current === "manual" || next.some((item) => item.id === current)
          ? current
          : (next[0]?.id ?? "manual"),
      )
    } catch (failure) {
      setError(toSanitizedErrorSummary(failure, []))
    } finally {
      setSyncing(false)
    }
  }, [])

  useEffect(() => {
    void synchronize()
    const abort = new AbortController()
    void fetch(webUrl("detection/presets"), {
      credentials: "same-origin",
      signal: abort.signal,
    })
      .then(async (response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (Array.isArray(data?.presets)) setPresets(data.presets)
      })
      .catch(() => {})
    return () => {
      abort.abort()
      controller.current?.abort()
    }
  }, [synchronize])

  useEffect(() => {
    const abort = new AbortController()
    setKeys([])
    setKeysSourceId("")
    setKeyId("")
    setCredential(null)
    setModels([])
    setModel("")
    setResult(null)
    setError("")
    if (!source) {
      setLoadingKeys(false)
      return
    }
    if (source.kind === "profile") {
      setLoadingKeys(false)
      return
    }
    setLoadingKeys(true)
    void loadFingerprintKeys(source, abort.signal)
      .then((next) => {
        if (abort.signal.aborted) return
        setKeys(next)
        setKeysSourceId(source.id)
        setKeyId(next[0]?.id ?? "")
        if (!next.length) setError(t("noKeys"))
      })
      .catch((failure) => {
        if (!abort.signal.aborted)
          setError(
            toSanitizedErrorSummary(failure, [
              source.account.token,
              source.account.cookieAuthSessionCookie ?? "",
            ]),
          )
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoadingKeys(false)
      })
    return () => abort.abort()
  }, [source, t])

  useEffect(() => {
    const abort = new AbortController()
    setCredential(null)
    setModels([])
    setModel("")
    setResult(null)
    if (!source || (source.kind === "account" && !key)) return
    void resolveFingerprintCredential(source, key, abort.signal)
      .then((next) => {
        if (abort.signal.aborted) return
        setCredential(next)
      })
      .catch((failure) => {
        if (!abort.signal.aborted)
          setError(
            toSanitizedErrorSummary(
              failure,
              source.kind === "profile"
                ? [source.profile.apiKey]
                : [source.account.token],
            ),
          )
      })
    return () => abort.abort()
  }, [source, key])

  useEffect(() => {
    const abort = new AbortController()
    setModels([])
    setModel("")
    setResult(null)
    if (!credential) {
      setLoadingModels(false)
      return
    }
    setLoadingModels(true)
    setError("")
    const refresh = forceModels.current
    forceModels.current = false
    void loadFingerprintModels(credential, protocol, abort.signal, refresh)
      .then((next) => {
        if (abort.signal.aborted) return
        setModels(next)
        setModel(next[0] ?? "")
        if (!next.length) setError(t("noModels"))
      })
      .catch((failure) => {
        if (!abort.signal.aborted)
          setError(
            toSanitizedErrorSummary(failure, [
              credential.apiKey,
              ...Object.values(credential.requestHeaders ?? {}),
            ]),
          )
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoadingModels(false)
      })
    return () => abort.abort()
  }, [credential, protocol, modelsRevision, t])

  const selectPreset = (value: string) => {
    const preset = presets.find((item) => item.id === value)
    if (!preset) return
    setPresetId(value)
    setProtocol(preset.api)
    setUa(preset.userAgent)
    setHeadersText(
      JSON.stringify(
        { ...credential?.requestHeaders, ...preset.headers },
        null,
        2,
      ),
    )
    setResult(null)
  }

  const getTarget = (): DetectionTarget | null => {
    setError("")
    const apiKey = manual ? manualKey : credential?.apiKey
    const baseUrl = manual ? manualUrl : credential?.baseUrl
    if (!apiKey || !baseUrl || !model.trim()) {
      setError(t("required"))
      return null
    }
    if (
      !manual &&
      credential?.runtimeKey &&
      !isAccountRuntimeKeyCompatibleWithModel(credential.runtimeKey, {
        id: model.trim(),
      })
    ) {
      setError(t("modelRestricted"))
      return null
    }
    let headers: Record<string, string>
    try {
      headers = JSON.parse(headersText)
      if (
        !headers ||
        Array.isArray(headers) ||
        typeof headers !== "object" ||
        Object.values(headers).some((value) => typeof value !== "string")
      )
        throw new Error()
    } catch {
      setError(t("headersInvalid"))
      return null
    }
    return {
      sourceId,
      sourceLabel: source?.label || t("manual"),
      keyId: manual ? undefined : keyId,
      baseUrl,
      ...(manual ? { apiKey } : {}),
      model: model.trim(),
      preset: presetId,
      api: protocol,
      userAgent: ua,
      headers: { ...credential?.requestHeaders, ...headers },
      stream,
      parallel,
      looseMode,
      autoVerify,
      effort,
      serviceTier,
    }
  }

  const detect = async () => {
    const target = getTarget()
    if (!target) return
    setResult(null)
    setResultContext("")
    const abort = new AbortController()
    controller.current = abort
    setRunning(true)
    try {
      const sessionResponse = await fetch(webUrl("session"), {
        credentials: "same-origin",
        signal: abort.signal,
      })
      const session = await sessionResponse.json()
      if (!session.authenticated || !session.csrfToken)
        throw new Error(t("loginRequired"))
      const response = await fetch(webUrl("detect"), {
        method: "POST",
        credentials: "same-origin",
        signal: abort.signal,
        headers: {
          "content-type": "application/json",
          accept: stream ? "text/event-stream" : "application/json",
          "x-csrf-token": session.csrfToken,
        },
        body: JSON.stringify(target),
      })
      if (!response.ok) {
        const failure = await response.json()
        throw new Error(failure.error || t("failed"))
      }
      const data = response.headers
        .get("content-type")
        ?.includes("text/event-stream")
        ? await readDetectionStream(response, (progress) =>
            setResult((current) => {
              const samples = [...(current?.samples || [])]
              samples[progress.index] = progress.sample
              return { ...current, samples }
            }),
          )
        : await response.json()
      setResult(data)
    } catch (failure) {
      setError(abort.signal.aborted ? t("cancelled") : sanitize(failure))
    } finally {
      if (controller.current === abort) {
        controller.current = null
        setRunning(false)
        setSavedRevision((value) => value + 1)
      }
    }
  }

  return (
    <div
      className="space-y-density-6 p-density-6"
      data-testid="model-fingerprint-page"
    >
      <PageHeader
        icon={Fingerprint}
        title={t("title")}
        description={t("description")}
        actions={
          <Button
            variant="outline"
            onClick={() => void synchronize()}
            disabled={syncing || running}
          >
            <RefreshCw className="mr-2 size-4" />
            {syncing ? t("syncing") : t("sync")}
          </Button>
        }
      />
      <div className="grid gap-density-6 xl:grid-cols-2">
        <Card padding="md" className="space-y-density-4">
          <div className="space-y-density-2">
            <Label htmlFor="fingerprint-source">{t("source")}</Label>
            <SearchableSelect
              id="fingerprint-source"
              value={sourceId}
              onChange={setSourceId}
              disabled={running}
              options={[
                ...sources.map((item) => ({
                  value: item.id,
                  label: `${item.kind === "account" ? t("account") : t("profile")} · ${item.label}`,
                })),
                { value: "manual", label: t("manual") },
              ]}
            />
          </div>
          {source?.kind === "account" && (
            <div className="space-y-density-2">
              <Label htmlFor="fingerprint-key">{t("key")}</Label>
              <SearchableSelect
                id="fingerprint-key"
                value={keyId}
                onChange={setKeyId}
                disabled={running || loadingKeys}
                loading={loadingKeys}
                options={keys.map((item) => ({
                  value: item.id,
                  label: item.label,
                }))}
                placeholder={t("noKeys")}
              />
            </div>
          )}
          {manual ? (
            <>
              <div className="space-y-density-2">
                <Label htmlFor="fingerprint-url">Base URL</Label>
                <Input
                  id="fingerprint-url"
                  type="url"
                  value={manualUrl}
                  onChange={(e) => setManualUrl(e.target.value)}
                  disabled={running}
                />
              </div>
              <div className="space-y-density-2">
                <Label htmlFor="fingerprint-secret">API Key</Label>
                <Input
                  id="fingerprint-secret"
                  type="password"
                  value={manualKey}
                  onChange={(e) => setManualKey(e.target.value)}
                  disabled={running}
                  autoComplete="off"
                />
              </div>
            </>
          ) : (
            <p className="text-sm break-all text-muted-foreground">
              {credential?.baseUrl || t("sourceHint")}
            </p>
          )}
          <div className="space-y-density-2">
            <Label htmlFor="fingerprint-model">{t("model")}</Label>
            <SearchableSelect
              id="fingerprint-model"
              value={model}
              onChange={(value) => {
                setModel(value)
                setResult(null)
              }}
              allowCustomValue
              disabled={running}
              loading={loadingModels}
              options={models.map((id) => ({ value: id, label: id }))}
              placeholder={t("modelHint")}
            />
            {!manual && (
              <Button
                size="sm"
                variant="ghost"
                disabled={!credential || loadingModels || running}
                onClick={() => {
                  forceModels.current = true
                  setModelsRevision((value) => value + 1)
                }}
              >
                {t("refreshModels")}
              </Button>
            )}
          </div>
          <div className="space-y-density-2">
            <Label htmlFor="fingerprint-preset">{t("client")}</Label>
            <SearchableSelect
              id="fingerprint-preset"
              value={presetId}
              onChange={selectPreset}
              disabled={running}
              options={presets.map((p) => ({
                value: p.id,
                label:
                  p.id === "standard"
                    ? t("standard")
                    : p.id === "claude-code"
                      ? "Claude Code"
                      : "Codex CLI",
              }))}
            />
          </div>
          <div className="space-y-density-2">
            <Label htmlFor="fingerprint-protocol">{t("protocol")}</Label>
            <SearchableSelect
              id="fingerprint-protocol"
              value={protocol}
              onChange={setProtocol}
              disabled={running}
              options={[
                { value: "chat_completions", label: "OpenAI Chat Completions" },
                { value: "responses", label: "OpenAI Responses" },
                { value: "messages", label: "Anthropic Messages" },
              ]}
            />
          </div>
          <div className="grid gap-density-4 sm:grid-cols-2">
            <div className="space-y-density-2">
              <Label htmlFor="fingerprint-effort">{t("effort")}</Label>
              <Input
                id="fingerprint-effort"
                value={effort}
                onChange={(event) => setEffort(event.target.value)}
                disabled={running || !configLoaded}
                placeholder={t("effortHint")}
              />
            </div>
            <div className="space-y-density-2">
              <Label htmlFor="fingerprint-tier">{t("serviceTier")}</Label>
              <SearchableSelect
                id="fingerprint-tier"
                value={serviceTier}
                onChange={setServiceTier}
                disabled={running || !configLoaded}
                options={[
                  { value: "default", label: t("tierDefault") },
                  { value: "flex", label: "Flex" },
                  { value: "fast", label: "Fast" },
                  { value: "ultrafast", label: "Ultrafast" },
                ]}
              />
            </div>
          </div>
          <div className="divide-y divide-border rounded-lg border border-border px-density-3">
            <div className="flex items-center justify-between gap-density-3 py-density-3">
              <div>
                <Label htmlFor="fingerprint-stream">{t("stream")}</Label>
                <p className="mt-density-1 text-xs text-muted-foreground">
                  {t("streamHint")}
                </p>
              </div>
              <Switch
                id="fingerprint-stream"
                checked={stream}
                onChange={setStream}
                disabled={running || !configLoaded}
              />
            </div>
            <div className="flex items-center justify-between gap-density-3 py-density-3">
              <div>
                <Label htmlFor="fingerprint-parallel">{t("parallel")}</Label>
                <p className="mt-density-1 text-xs text-muted-foreground">
                  {t("parallelHint")}
                </p>
              </div>
              <Switch
                id="fingerprint-parallel"
                checked={parallel}
                onChange={setParallel}
                disabled={running || !configLoaded}
              />
            </div>
            <div className="flex items-center justify-between gap-density-3 py-density-3">
              <div>
                <Label htmlFor="fingerprint-loose">{t("looseMode")}</Label>
                <p className="mt-density-1 text-xs text-muted-foreground">
                  {t("looseHint")}
                </p>
              </div>
              <Switch
                id="fingerprint-loose"
                checked={looseMode}
                onChange={setLooseMode}
                disabled={running || !configLoaded}
              />
            </div>
            <div className="flex items-center justify-between gap-density-3 py-density-3">
              <div>
                <Label htmlFor="fingerprint-auto-verify">
                  {t("autoVerify")}
                </Label>
                <p className="mt-density-1 text-xs text-muted-foreground">
                  {t("autoVerifyHint")}
                </p>
              </div>
              <Switch
                id="fingerprint-auto-verify"
                checked={autoVerify}
                onChange={setAutoVerify}
                disabled={running || !configLoaded}
              />
            </div>
          </div>
          <details>
            <summary className="cursor-pointer text-sm">
              {t("advanced")}
            </summary>
            <div className="mt-density-4 space-y-density-4">
              <div className="space-y-density-2">
                <Label htmlFor="fingerprint-ua">User-Agent</Label>
                <Input
                  id="fingerprint-ua"
                  value={ua}
                  onChange={(e) => setUa(e.target.value)}
                  disabled={running}
                />
              </div>
              <div className="space-y-density-2">
                <Label htmlFor="fingerprint-headers">{t("headers")}</Label>
                <Textarea
                  id="fingerprint-headers"
                  value={headersText}
                  onChange={(e) => setHeadersText(e.target.value)}
                  rows={5}
                  disabled={running}
                  spellCheck={false}
                />
              </div>
            </div>
          </details>
          <p role="status" className="text-xs text-muted-foreground">
            {configStatus === "saving"
              ? t("configSaving")
              : configStatus === "error"
                ? t("configSaveError")
                : t("configSaved")}
          </p>
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          <p className="text-sm text-muted-foreground">{t("cost")}</p>
          <div className="flex gap-2">
            <Button
              onClick={() => void detect()}
              disabled={
                running ||
                !configLoaded ||
                loadingModels ||
                loadingKeys ||
                !model ||
                (!manual && !credential)
              }
            >
              {running ? t("running") : t("detect")}
            </Button>
            {running && (
              <Button
                variant="outline"
                onClick={() => controller.current?.abort()}
              >
                {t("cancel")}
              </Button>
            )}
          </div>
        </Card>
        <div className="min-w-0 space-y-density-3">
          {resultContext && (
            <p className="text-sm text-muted-foreground">
              {t("viewingHistory", { context: resultContext })}
            </p>
          )}
          <DetectionResultCard
            key={result?.historyId || resultContext || "current"}
            result={result}
            running={running}
            verifying={verifying}
            onVerify={() => void verify()}
          />
        </div>
      </div>
      <SavedDetections
        revision={savedRevision}
        getTarget={getTarget}
        sanitize={sanitize}
        onSelectResult={(saved, context) => {
          setResult(saved)
          setResultContext(context)
          document
            .querySelector('[data-testid="fingerprint-result"]')
            ?.scrollIntoView({ behavior: "smooth", block: "start" })
        }}
      />
    </div>
  )
}
