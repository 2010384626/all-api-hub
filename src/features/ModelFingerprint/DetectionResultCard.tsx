import { Fingerprint } from "lucide-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"

import { Button, Card, Progress } from "~/components/ui"

import { confidencePercent } from "./confidence"
import type { DetectionResult } from "./types"

/** Present calibrated confidence without substituting a raw ranking score. */
export function DetectionResultCard({
  result,
  running,
  verifying,
  onVerify,
}: {
  result: DetectionResult | null
  running: boolean
  verifying: boolean
  onVerify: () => void
}) {
  const { t } = useTranslation("modelFingerprint")
  const [showAll, setShowAll] = useState(false)
  const analysis = result?.analysis
  const candidates = analysis?.results ?? []
  const top = candidates[0]
  const confidence = confidencePercent(
    analysis,
    analysis?.probability ?? top?.probability,
  )
  const hasCandidates = candidates.length > 0
  return (
    <Card
      padding="md"
      className="min-w-0 space-y-density-4"
      data-testid="fingerprint-result"
    >
      <h2 className="text-lg font-semibold">{t("result")}</h2>
      {!result && (
        <div className="flex min-h-52 flex-col items-center justify-center gap-density-3 text-center text-muted-foreground">
          <Fingerprint className="size-10" />
          <p>{running ? t("running") : t("emptyResult")}</p>
        </div>
      )}
      {result?.error && (
        <p role="alert" className="text-sm text-destructive">
          {result.error}
        </p>
      )}
      {analysis && hasCandidates && (
        <>
          <div className="flex flex-wrap items-start justify-between gap-density-4 rounded-xl border border-border bg-muted/40 p-density-5">
            <div className="min-w-0 flex-1 space-y-density-2">
              <p className="text-sm text-muted-foreground">
                {t("topCandidate")}
              </p>
              <h3 className="text-xl font-semibold break-words">
                {analysis.prediction_name ||
                  analysis.prediction ||
                  top?.display_name ||
                  top?.model}
              </h3>
              <p className="text-sm text-muted-foreground">
                {analysis.family_prediction_name ||
                  top?.family_name ||
                  top?.family}
              </p>
            </div>
            <div className="text-right">
              <p
                className="text-3xl font-semibold tabular-nums"
                data-testid="fingerprint-top-confidence"
              >
                {confidence === null ? "—" : `${confidence.toFixed(1)}%`}
              </p>
              <p className="mt-density-1 text-sm text-muted-foreground">
                {t("confidence")}
              </p>
            </div>
          </div>
          {confidence === null && (
            <p
              role="status"
              className="rounded-lg border border-border bg-muted/40 p-density-3 text-sm text-muted-foreground"
            >
              {t("confidenceUnavailable")}
            </p>
          )}
          <p className="text-sm text-muted-foreground">
            {t("probabilityScope")}
          </p>
          <ol className="divide-y divide-border">
            {(showAll ? candidates : candidates.slice(0, 8)).map(
              (candidate, index) => {
                const percent = confidencePercent(
                  analysis,
                  candidate.probability,
                )
                return (
                  <li
                    key={`${candidate.model}-${index}`}
                    className="grid grid-cols-[1.5rem_minmax(0,1fr)_4.5rem] items-center gap-density-3 py-density-3"
                  >
                    <span className="text-sm text-muted-foreground tabular-nums">
                      {index + 1}
                    </span>
                    <div className="min-w-0 space-y-density-2">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-density-3">
                        <span className="font-medium break-all">
                          {candidate.display_name || candidate.model}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {candidate.family_name || candidate.family}
                        </span>
                      </div>
                      {percent !== null && (
                        <Progress
                          value={percent}
                          aria-label={candidate.display_name || candidate.model}
                          className="h-1.5"
                        />
                      )}
                    </div>
                    <span className="text-right text-sm font-medium tabular-nums">
                      {percent === null ? "—" : `${percent.toFixed(1)}%`}
                    </span>
                  </li>
                )
              },
            )}
          </ol>
          {candidates.length > 8 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowAll((value) => !value)}
            >
              {showAll
                ? t("showLess")
                : t("showAll", { total: candidates.length })}
            </Button>
          )}
        </>
      )}
      {result?.verificationPending && (
        <div className="space-y-density-3 rounded-lg border border-border p-density-4">
          <p className="text-sm text-muted-foreground">
            {t("verificationPending")}
          </p>
          <Button
            disabled={!result.historyId || verifying || running}
            onClick={onVerify}
          >
            {verifying ? t("verifying") : t("verifySaved")}
          </Button>
        </div>
      )}
      {result &&
        !hasCandidates &&
        !result.error &&
        !result.verificationPending &&
        !running && (
          <p className="text-sm text-muted-foreground">{t("noRanking")}</p>
        )}
      {result?.samples && (
        <details
          className="rounded-lg border border-border p-density-3"
          open={running || result.samples.some((sample) => sample?.error)}
        >
          <summary className="cursor-pointer text-sm font-medium">
            {t("sampleDetails")}
          </summary>
          <div className="mt-density-3 space-y-density-2">
            {result.samples.map((sample, index) => (
              <div key={index} className="space-y-density-2">
                <p className="text-sm text-muted-foreground">
                  {t("sample", { number: index + 1, integers: sample.count })}
                  {sample.error ? ` · ${sample.error}` : ""}
                </p>
                {sample.text && (
                  <pre className="max-h-32 overflow-auto rounded-md bg-muted/40 p-density-2 font-mono text-xs break-all whitespace-pre-wrap">
                    {sample.text}
                  </pre>
                )}
              </div>
            ))}
          </div>
        </details>
      )}
      {result && (
        <p className="text-xs text-muted-foreground">{t("resultMeaning")}</p>
      )}
    </Card>
  )
}
