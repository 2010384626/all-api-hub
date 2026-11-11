import { CalendarClock, History, RefreshCw } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"

import { Button, Card, Input, Label, SearchableSelect } from "~/components/ui"

import { fingerprintRequest } from "./api"
import { confidencePercent } from "./confidence"
import type {
  DetectionHistory,
  DetectionResult,
  DetectionSchedule,
  DetectionTarget,
  DetectionTiming,
} from "./types"

/** Manage persisted detection jobs and revisit their results without copying secrets. */
export function SavedDetections({
  revision,
  getTarget,
  onSelectResult,
  sanitize,
}: {
  revision: number
  getTarget: () => DetectionTarget | null
  onSelectResult: (result: DetectionResult, context: string) => void
  sanitize: (error: unknown) => string
}) {
  const { t, i18n } = useTranslation("modelFingerprint")
  const [history, setHistory] = useState<DetectionHistory[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [schedules, setSchedules] = useState<DetectionSchedule[]>([])
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<DetectionSchedule | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [name, setName] = useState("")
  const [enabled, setEnabled] = useState(false)
  const [timingType, setTimingType] = useState("interval")
  const [minutes, setMinutes] = useState("1440")
  const [at, setAt] = useState("09:00")
  const [timeZone, setTimeZone] = useState("Asia/Shanghai")
  const [newTarget, setNewTarget] = useState<DetectionTarget | null>(null)
  const limit = 10
  const date = (value: string | number | null | undefined) => {
    if (!value) return "—"
    const parsed = new Date(value)
    return Number.isFinite(parsed.getTime())
      ? parsed.toLocaleString(i18n.language)
      : "—"
  }
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const [historyResponse, scheduleResponse] = await Promise.all([
        fingerprintRequest<{ items: DetectionHistory[]; total: number }>(
          `detection/history?offset=${offset}&limit=${limit}`,
          { signal },
        ),
        fingerprintRequest<{ schedules: DetectionSchedule[] }>(
          "detection/schedules",
          { signal },
        ),
      ])
      setHistory(historyResponse.items)
      setTotal(historyResponse.total)
      setSchedules(scheduleResponse.schedules)
    },
    [offset],
  )
  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal).catch((failure) => {
      if (!controller.signal.aborted) setError(sanitize(failure))
    })
    return () => controller.abort()
  }, [load, revision, sanitize])

  const refresh = async () => {
    setBusy(true)
    setError("")
    try {
      await load()
    } catch (failure) {
      setError(sanitize(failure))
    } finally {
      setBusy(false)
    }
  }
  const create = () => {
    const target = getTarget()
    if (!target) return
    setNewTarget(target)
    setEditing(null)
    setName(target.model)
    setEnabled(false)
    setTimingType("interval")
    setMinutes("1440")
    setAt("09:00")
    setTimeZone("Asia/Shanghai")
    setError("")
    setFormOpen(true)
  }
  const edit = (schedule: DetectionSchedule) => {
    setEditing(schedule)
    setNewTarget(null)
    setName(schedule.name)
    setEnabled(schedule.enabled)
    setTimingType(schedule.timing.type)
    if (schedule.timing.type === "interval")
      setMinutes(String(schedule.timing.everyMinutes))
    else {
      setAt(schedule.timing.at)
      setTimeZone(schedule.timing.timeZone)
    }
    setError("")
    setFormOpen(true)
  }
  const save = async () => {
    const everyMinutes = Number(minutes)
    if (
      !name.trim() ||
      (timingType === "interval" &&
        (!Number.isInteger(everyMinutes) || everyMinutes < 5))
    ) {
      setError(t("scheduleInvalid"))
      return
    }
    const timing: DetectionTiming =
      timingType === "interval"
        ? { type: "interval", everyMinutes }
        : { type: "daily", at, timeZone }
    setBusy(true)
    setError("")
    try {
      await fingerprintRequest(
        `detection/schedules${editing ? `/${editing.id}` : ""}`,
        {
          method: editing ? "PATCH" : "POST",
          body: {
            name: name.trim(),
            enabled,
            timing,
            ...(editing ? {} : { target: newTarget }),
          },
        },
      )
      setFormOpen(false)
      setNewTarget(null)
      setEditing(null)
      await load()
    } catch (failure) {
      setError(sanitize(failure))
    } finally {
      setBusy(false)
    }
  }
  const toggle = async (schedule: DetectionSchedule) => {
    setBusy(true)
    setError("")
    try {
      await fingerprintRequest(`detection/schedules/${schedule.id}`, {
        method: "PATCH",
        body: { enabled: !schedule.enabled },
      })
      await load()
    } catch (failure) {
      setError(sanitize(failure))
    } finally {
      setBusy(false)
    }
  }
  const remove = async (schedule: DetectionSchedule) => {
    if (!window.confirm(t("deleteScheduleConfirm", { name: schedule.name })))
      return
    setBusy(true)
    setError("")
    try {
      await fingerprintRequest(`detection/schedules/${schedule.id}`, {
        method: "DELETE",
      })
      if (editing?.id === schedule.id) setFormOpen(false)
      await load()
    } catch (failure) {
      setError(sanitize(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-density-6">
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <Card
        padding="md"
        className="space-y-density-4"
        data-testid="fingerprint-schedules"
      >
        <div className="flex flex-wrap items-center justify-between gap-density-3">
          <h2 className="flex items-center gap-density-2 text-lg font-semibold">
            <CalendarClock className="size-5" />
            {t("schedules")}
          </h2>
          <Button variant="outline" onClick={create} disabled={busy}>
            {t("addSchedule")}
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">{t("scheduleHint")}</p>
        {formOpen && (
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void save()
            }}
            className="space-y-density-4 rounded-lg border border-border bg-muted/30 p-density-4"
            data-testid="fingerprint-schedule-form"
          >
            <p className="text-sm font-medium break-all">
              {t("scheduleTarget", {
                model: editing?.target.model || newTarget?.model,
                source:
                  editing?.target.sourceLabel ||
                  editing?.target.sourceId ||
                  newTarget?.sourceLabel ||
                  newTarget?.sourceId,
              })}
            </p>
            <div className="grid gap-density-4 sm:grid-cols-2">
              <div className="space-y-density-2">
                <Label htmlFor="fingerprint-job-name">
                  {t("scheduleName")}
                </Label>
                <Input
                  id="fingerprint-job-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                  maxLength={100}
                  disabled={busy}
                />
              </div>
              <div className="space-y-density-2">
                <Label htmlFor="fingerprint-job-type">
                  {t("scheduleType")}
                </Label>
                <SearchableSelect
                  id="fingerprint-job-type"
                  value={timingType}
                  onChange={setTimingType}
                  disabled={busy}
                  options={[
                    { value: "interval", label: t("interval") },
                    { value: "daily", label: t("daily") },
                  ]}
                />
              </div>
            </div>
            {timingType === "interval" ? (
              <div className="space-y-density-2">
                <Label htmlFor="fingerprint-job-minutes">
                  {t("everyMinutes")}
                </Label>
                <Input
                  id="fingerprint-job-minutes"
                  type="number"
                  min={5}
                  step={1}
                  value={minutes}
                  onChange={(event) => setMinutes(event.target.value)}
                  disabled={busy}
                  required
                />
              </div>
            ) : (
              <div className="grid gap-density-4 sm:grid-cols-2">
                <div className="space-y-density-2">
                  <Label htmlFor="fingerprint-job-at">{t("dailyAt")}</Label>
                  <Input
                    id="fingerprint-job-at"
                    type="time"
                    value={at}
                    onChange={(event) => setAt(event.target.value)}
                    required
                    disabled={busy}
                  />
                </div>
                <div className="space-y-density-2">
                  <Label htmlFor="fingerprint-job-zone">{t("timeZone")}</Label>
                  <Input
                    id="fingerprint-job-zone"
                    value={timeZone}
                    readOnly
                    required
                    disabled={busy}
                  />
                </div>
              </div>
            )}
            <label className="flex items-center gap-density-2 text-sm">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(event) => setEnabled(event.target.checked)}
                disabled={busy}
              />
              {t("enableSchedule")}
            </label>
            <p className="text-sm text-muted-foreground">{t("scheduleCost")}</p>
            <div className="flex gap-density-2">
              <Button type="submit" disabled={busy}>
                {busy ? t("saving") : t("saveSchedule")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setFormOpen(false)
                  setNewTarget(null)
                }}
              >
                {t("cancel")}
              </Button>
            </div>
          </form>
        )}
        {!schedules.length && !formOpen && (
          <p className="py-density-4 text-center text-sm text-muted-foreground">
            {t("noSchedules")}
          </p>
        )}
        <div className="space-y-density-3">
          {schedules.map((schedule) => (
            <div
              key={schedule.id}
              className="flex flex-wrap items-start justify-between gap-density-3 rounded-lg border border-border p-density-4"
            >
              <div className="min-w-0 flex-1 space-y-density-1">
                <p className="font-medium break-words">
                  {schedule.name}{" "}
                  <span className="text-sm text-muted-foreground">
                    · {schedule.enabled ? t("enabled") : t("paused")}
                  </span>
                </p>
                <p className="text-sm break-all text-muted-foreground">
                  {schedule.target.model} ·{" "}
                  {schedule.target.sourceLabel || schedule.target.sourceId}
                </p>
                <p className="text-sm text-muted-foreground">
                  {schedule.timing.type === "interval"
                    ? t("intervalSummary", {
                        minutes: schedule.timing.everyMinutes,
                      })
                    : t("dailySummary", {
                        at: schedule.timing.at,
                        zone: schedule.timing.timeZone,
                      })}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("nextRun", {
                    date: schedule.enabled ? date(schedule.nextRunAt) : "—",
                  })}{" "}
                  · {t("lastRun", { date: date(schedule.lastRunAt) })}
                </p>
                {schedule.lastError && (
                  <p className="text-sm text-destructive">
                    {schedule.lastError}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap gap-density-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void toggle(schedule)}
                >
                  {schedule.enabled ? t("pause") : t("enable")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => edit(schedule)}
                >
                  {t("edit")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void remove(schedule)}
                >
                  {t("delete")}
                </Button>
              </div>
            </div>
          ))}
        </div>
      </Card>
      <Card
        padding="md"
        className="space-y-density-4"
        data-testid="fingerprint-history"
      >
        <div className="flex flex-wrap items-center justify-between gap-density-3">
          <h2 className="flex items-center gap-density-2 text-lg font-semibold">
            <History className="size-5" />
            {t("history")}
          </h2>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void refresh()}
          >
            <RefreshCw className="mr-2 size-4" />
            {t("refreshHistory")}
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">{t("historyHint")}</p>
        {!history.length && (
          <p className="py-density-4 text-center text-sm text-muted-foreground">
            {t("noHistory")}
          </p>
        )}
        <ol className="divide-y divide-border">
          {history.map((item) => {
            const confidence = confidencePercent(
              item.result?.analysis,
              item.result?.analysis?.probability,
            )
            return (
              <li
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-density-3 py-density-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-medium break-all">{item.target.model}</p>
                  <p className="mt-density-1 text-sm text-muted-foreground">
                    {date(item.startedAt)} ·{" "}
                    {item.sourceLabel || item.target.sourceId || t("manual")} ·{" "}
                    {item.status === "success"
                      ? t("statusSuccess")
                      : item.status === "partial"
                        ? t("statusPartial")
                        : item.status === "running"
                          ? t("statusRunning")
                          : item.status === "interrupted"
                            ? t("statusInterrupted")
                            : item.status === "sampled"
                              ? t("statusSampled")
                              : item.status === "cancelled"
                                ? t("statusCancelled")
                                : t("statusFailed")}
                  </p>
                  <p className="mt-density-1 text-sm break-all text-muted-foreground">
                    {item.result?.analysis?.prediction_name ||
                      item.result?.analysis?.prediction ||
                      "—"}
                    {confidence !== null ? ` · ${confidence.toFixed(1)}%` : ""}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!item.result}
                  onClick={() =>
                    onSelectResult(
                      { ...item.result, historyId: item.id },
                      `${item.target.model} · ${date(item.startedAt)}`,
                    )
                  }
                >
                  {t("viewResult")}
                </Button>
              </li>
            )
          })}
        </ol>
        <div className="flex items-center justify-between gap-density-3">
          <p className="text-sm text-muted-foreground">
            {t("historyTotal", { total })}
          </p>
          <div className="flex gap-density-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={!offset || busy}
              onClick={() => setOffset((value) => Math.max(0, value - limit))}
            >
              {t("previous")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={offset + limit >= total || busy}
              onClick={() => setOffset((value) => value + limit)}
            >
              {t("next")}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  )
}
