import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  MODE_TEXT,
  STEP_TEXT,
  estimateLines,
  formatCount,
  isJobActive,
  jobProgressText,
  parseValidationReport,
  validationReportOf,
  type EmbeddingJob,
  type ValidationView,
} from "@/lib/embeddingSpaces";

const pct = (n: number | null) => (n == null ? "n/a" : `${(n * 100).toFixed(1)}%`);
const signed = (n: number | null) => (n == null ? "n/a" : `${n > 0 ? "+" : ""}${(n * 100).toFixed(1)} points`);
const verdict = (ok: boolean | null) => (ok == null ? "Info" : ok ? "Pass" : "Fail");

function ValidationTables({ view }: { view: ValidationView }) {
  return (
    <div className="space-y-4">
      <p className="text-[14px] font-semibold">
        Result: {view.passed == null ? "not finished" : view.passed ? "passed" : "did not pass"}
        {view.tolerance != null ? ` (recall may be at most ${(view.tolerance * 100).toFixed(1)} points below the live index)` : ""}
      </p>

      {view.coverage ? (
        <p className="text-[13.5px]">
          Coverage: {formatCount(view.coverage.missing)} chunk{view.coverage.missing === 1 ? "" : "s"} without a current
          vector. {view.coverage.passed ? "Pass." : "Fail: every chunk needs a vector."}
        </p>
      ) : null}

      {view.sourceTypes.length ? (
        <Table>
          <TableCaption className="sr-only">Coverage by kind of source</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Kind of source</TableHead>
              <TableHead scope="col">Chunks</TableHead>
              <TableHead scope="col">With a vector in the new index</TableHead>
              <TableHead scope="col">Missing</TableHead>
              <TableHead scope="col">Only in the live index</TableHead>
              <TableHead scope="col">Result</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.sourceTypes.map((row) => (
              <TableRow key={row.type}>
                <TableCell>{row.type}</TableCell>
                <TableCell>{formatCount(row.chunks)}</TableCell>
                <TableCell>{formatCount(row.targetCurrent)}</TableCell>
                <TableCell>{formatCount(row.gaps)}</TableCell>
                <TableCell>{formatCount(row.activeOnly)}</TableCell>
                <TableCell>{verdict(row.passed)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}

      {view.quality == null ? null : view.quality.skipped ? (
        <p className="text-[13.5px]">Search quality check: skipped for this run.</p>
      ) : (
        <Table>
          <TableCaption className="sr-only">Search quality on the golden question set</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Measure</TableHead>
              <TableHead scope="col">Live index</TableHead>
              <TableHead scope="col">New index</TableHead>
              <TableHead scope="col">Change</TableHead>
              <TableHead scope="col">Result</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.quality.rows.map((row) => (
              <TableRow key={row.metric}>
                <TableCell>{row.label}</TableCell>
                <TableCell>{pct(row.active)}</TableCell>
                <TableCell>{pct(row.target)}</TableCell>
                <TableCell>{signed(row.delta)}</TableCell>
                <TableCell>{verdict(row.passed)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {view.suggestedMinScore != null ? (
        <p className="text-xs text-foreground/70">
          Suggested minimum match score for the new index: {view.suggestedMinScore}. This is only a suggestion and is not applied.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Progress, estimate and validation report of one job. Progress is plain text in a polite
 * live region, so screen reader users hear changes without losing their place. No chunk
 * text is requested or shown.
 */
export default function SpaceJobPanel({ job, error }: { job: EmbeddingJob | null; error: string | null }) {
  if (!job && !error) return null;
  const view = job ? parseValidationReport(validationReportOf(job)) : null;

  return (
    <section aria-label="Latest job" className="space-y-3 rounded-[11px] border border-foreground/12 bg-white px-4 py-3">
      <h3 className="text-[15px] font-bold">{job ? `Latest job: ${MODE_TEXT[job.mode]}` : "Latest job"}</h3>

      <div role="status" aria-live="polite" className="text-[14px]">
        {job ? jobProgressText(job) : null}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      ) : null}

      {job && isJobActive(job) && job.progress_percent != null ? (
        <progress className="h-2 w-full" max={100} value={job.progress_percent} aria-label={`${MODE_TEXT[job.mode]} progress`}>
          {job.progress_percent}%
        </progress>
      ) : null}

      {job && job.steps.length > 0 ? (
        <ol className="space-y-1 text-[13.5px]" aria-label="Steps">
          {job.steps.map((step) => (
            <li key={step.name}>
              {STEP_TEXT[step.name] ?? step.name}:{" "}
              <span className="font-semibold">
                {step.status === "done" ? "done" : step.status === "running" ? "in progress" : step.status === "failed" ? "failed" : "waiting"}
              </span>
              {step.detail ? <span className="text-foreground/70"> ({step.detail})</span> : null}
            </li>
          ))}
        </ol>
      ) : null}

      {job && job.mode === "dry_run" && job.status === "succeeded" ? (
        <div>
          <p className="text-[13.5px] font-semibold">Estimate before you start a rebuild</p>
          <dl className="mt-1 grid grid-cols-1 gap-x-6 gap-y-1 text-[13.5px] sm:grid-cols-[max-content_1fr]">
            {estimateLines(job).map((line) => (
              <div key={line.label} className="contents">
                <dt className="text-foreground/70">{line.label}</dt>
                <dd className="font-semibold">{line.value}</dd>
              </div>
            ))}
          </dl>
          {job.last_error ? <p className="mt-1 text-xs text-foreground/70">{job.last_error}</p> : null}
        </div>
      ) : null}

      {view ? <ValidationTables view={view} /> : null}
    </section>
  );
}
