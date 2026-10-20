/**
 * Embedding spaces ("Search index" admin view): types, the register-form schema and pure
 * helpers shared by hooks/useEmbeddingSpaces.ts and components/Admin/Embeddings/*.
 *
 * Limits mirror cdk/lambda/knowledgeBase/helpers/embedding_admin.py (validate_registration,
 * RETENTION_DAYS) and the adapters in cdk/containers/common/embeddings.py. The server
 * checks every rule again; nothing here is a security boundary.
 *
 * Nothing in this module (or the API it describes) carries chunk text: only ids, counts
 * and metrics.
 */
import { z } from "zod";

// ── API types ────────────────────────────────────────────────────────────────

export type SpaceStatus = "building" | "validated" | "active" | "retired" | "purged";
export type ProviderId = "cohere_v3" | "titan_v2" | "cohere_v4";
export type JobMode = "dry_run" | "rebuild" | "delta" | "validate" | "activate" | "rollback";
export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type JobSummary = {
  id: string;
  mode: JobMode;
  status: JobStatus;
  processed: number;
  total_chunks: number | null;
  current_step: string | null;
  last_error: string | null;
  created_at: string;
  finished_at: string | null;
};

export type EmbeddingSpace = {
  id: string;
  name: string;
  provider: ProviderId;
  model_id: string;
  invoke_target: string;
  dimensions: number;
  version: string;
  status: SpaceStatus;
  is_active: boolean;
  min_score: number | null;
  split_threshold: number | null;
  price_per_1m_tokens: number | null;
  eol_date: string | null;
  settings: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
  activated_at: string | null;
  retired_at: string | null;
  purge_eligible_at?: string | null;
  coverage: { current_vectors: number; total_chunks: number; percent: number | null };
  latest_job: JobSummary | null;
};

export type SpacesState = {
  spaces: EmbeddingSpace[];
  active_space_id: string | null;
  total_chunks: number;
  retention_days?: number;
  cutover_locked: boolean;
  cutover?: { locked: boolean; locked_at: string | null; job_id: string | null };
};

export type JobStep = {
  name: string;
  status: "pending" | "running" | "done" | "failed";
  started_at: string | null;
  finished_at: string | null;
  detail: string | null;
};

export type EmbeddingJob = {
  id: string;
  space_id: string;
  mode: JobMode;
  status: JobStatus;
  total_chunks: number | null;
  processed: number;
  failed: number;
  progress_percent?: number | null;
  est_tokens: number | null;
  est_cost_usd: number | null;
  est_seconds: number | null;
  price_configured: boolean;
  cost_note?: string;
  current_step: string | null;
  steps: JobStep[];
  report: unknown;
  last_error: string | null;
  created_at: string;
  finished_at: string | null;
};

export const EMPTY_SPACES_STATE: SpacesState = {
  spaces: [],
  active_space_id: null,
  total_chunks: 0,
  retention_days: 30,
  cutover_locked: false,
};

// ── Providers (mirror the adapters) ──────────────────────────────────────────

export const PROVIDERS: Record<
  ProviderId,
  { label: string; dimensions: number[]; maxBatchSize: number | null }
> = {
  cohere_v3: { label: "Cohere Embed English v3", dimensions: [1024], maxBatchSize: 96 },
  titan_v2: { label: "Amazon Titan Text Embeddings V2", dimensions: [256, 512, 1024], maxBatchSize: null },
  cohere_v4: { label: "Cohere Embed v4", dimensions: [256, 512, 1024, 1536], maxBatchSize: null },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

/** A model the register form can offer. `model_id` and `invoke_target` come from Amazon Bedrock. */
export type EmbeddingModelOption = {
  provider: ProviderId;
  label: string;
  dimensions: number[];
  available: boolean;
  model_id: string | null;
  invoke_target: string | null;
  cross_region: boolean;
  unavailable_reason: string | null;
};

/** Demo mode does not call Amazon Bedrock. These are the same three adapters, with their known ids. */
const DEMO_MODEL_IDS: Record<ProviderId, string> = {
  cohere_v3: "cohere.embed-english-v3",
  titan_v2: "amazon.titan-embed-text-v2:0",
  cohere_v4: "cohere.embed-v4:0",
};

export const DEMO_EMBEDDING_MODELS: EmbeddingModelOption[] = PROVIDER_IDS.map((provider) => ({
  provider,
  label: PROVIDERS[provider].label,
  dimensions: [...PROVIDERS[provider].dimensions],
  available: true,
  model_id: DEMO_MODEL_IDS[provider],
  invoke_target: DEMO_MODEL_IDS[provider],
  cross_region: false,
  unavailable_reason: null,
}));

/** How long a retired space is kept before it may be purged (RETENTION_DAYS on the server). */
export const PURGE_RETENTION_DAYS = 30;
/** Poll interval while a job is queued or running. */
export const JOB_POLL_MS = 4000;

// ── Register form ────────────────────────────────────────────────────────────

export type RegisterFormValues = {
  name: string;
  provider: ProviderId;
  dimensions: number;
  version: string;
  price_per_1m_tokens: string;
  eol_date: string;
  min_score: string;
  split_threshold: string;
  batch_size: string;
  max_chars: string;
  concurrency: string;
};

export const EMPTY_REGISTER_FORM: RegisterFormValues = {
  name: "",
  provider: "titan_v2",
  dimensions: 1024,
  version: "1",
  price_per_1m_tokens: "",
  eol_date: "",
  min_score: "",
  split_threshold: "",
  batch_size: "",
  max_chars: "",
  concurrency: "",
};

export type RegisterPayload = {
  name: string;
  provider: ProviderId;
  dimensions: number;
  version: string;
  price_per_1m_tokens: number | null;
  eol_date: string | null;
  min_score: number | null;
  split_threshold: number | null;
  settings: { batch_size?: number; max_chars?: number; concurrency?: number };
};

export const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{2,62}$/;
const MAX_VERSION = 32;
const MAX_PRICE = 99_999_999;

const isBlank = (v: string) => v.trim() === "";
const numberOf = (v: string) => (isBlank(v) ? Number.NaN : Number(v.trim()));

/** Optional number field written as text: empty is fine, otherwise a number in [min, max]. */
const optionalNumber = (message: string, min: number, max: number, integer = false) =>
  z.string().refine((v) => {
    if (isBlank(v)) return true;
    const n = numberOf(v);
    return Number.isFinite(n) && n >= min && n <= max && (!integer || Number.isInteger(n));
  }, message);

function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export const registerSchema = z
  .object({
    name: z
      .string()
      .regex(NAME_PATTERN, "Use 3 to 63 characters: lowercase letters, digits, '-' or '_', starting with a letter or digit."),
    provider: z.enum(PROVIDER_IDS as [ProviderId, ...ProviderId[]], { message: "Choose a provider from the list." }),
    dimensions: z.number({ message: "Choose a dimension." }).int("Choose a dimension."),
    version: z.string().refine((v) => v.trim().length <= MAX_VERSION, `Use at most ${MAX_VERSION} characters.`),
    price_per_1m_tokens: optionalNumber(
      "Leave empty, or enter a price of 0 or more (USD per 1 million tokens).",
      0,
      MAX_PRICE
    ),
    eol_date: z.string().refine((v) => isBlank(v) || isRealDate(v.trim()), "Leave empty, or use a date written YYYY-MM-DD."),
    min_score: optionalNumber("Leave empty, or enter a number from 0 to 1.", 0, 1),
    split_threshold: optionalNumber("Leave empty, or enter a number from 0 to 1.", 0, 1),
    batch_size: optionalNumber("Leave empty, or enter a whole number from 1 to 256.", 1, 256, true),
    max_chars: optionalNumber("Leave empty, or enter a whole number from 100 to 50,000.", 100, 50_000, true),
    concurrency: optionalNumber("Leave empty, or enter a whole number from 1 to 32.", 1, 32, true),
  })
  .superRefine((values, ctx) => {
    const provider = PROVIDERS[values.provider];
    if (provider && !provider.dimensions.includes(values.dimensions)) {
      ctx.addIssue({
        code: "custom",
        path: ["dimensions"],
        message: `${provider.label} supports ${provider.dimensions.join(", ")} dimensions.`,
      });
    }
    if (provider?.maxBatchSize != null && !isBlank(values.batch_size) && numberOf(values.batch_size) > provider.maxBatchSize) {
      ctx.addIssue({
        code: "custom",
        path: ["batch_size"],
        message: `${provider.label} allows a batch size of at most ${provider.maxBatchSize}.`,
      });
    }
  });

export type RegisterErrors = Partial<Record<keyof RegisterFormValues, string>>;

export type RegisterResult =
  | { ok: true; payload: RegisterPayload }
  | { ok: false; errors: RegisterErrors };

const nullableNumber = (v: string) => (isBlank(v) ? null : Number(v.trim()));

/** Validates the form and builds the POST /admin/embedding-spaces body. */
export function parseRegisterForm(values: RegisterFormValues): RegisterResult {
  const parsed = registerSchema.safeParse(values);
  if (!parsed.success) {
    const errors: RegisterErrors = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0] as keyof RegisterFormValues | undefined;
      if (key && !errors[key]) errors[key] = issue.message;
    }
    return { ok: false, errors };
  }
  const settings: RegisterPayload["settings"] = {};
  if (!isBlank(values.batch_size)) settings.batch_size = Number(values.batch_size.trim());
  if (!isBlank(values.max_chars)) settings.max_chars = Number(values.max_chars.trim());
  if (!isBlank(values.concurrency)) settings.concurrency = Number(values.concurrency.trim());
  return {
    ok: true,
    payload: {
      name: values.name,
      provider: values.provider,
      dimensions: values.dimensions,
      version: isBlank(values.version) ? "1" : values.version.trim(),
      price_per_1m_tokens: nullableNumber(values.price_per_1m_tokens),
      eol_date: isBlank(values.eol_date) ? null : values.eol_date.trim(),
      min_score: nullableNumber(values.min_score),
      split_threshold: nullableNumber(values.split_threshold),
      settings,
    },
  };
}

// ── Formatting ───────────────────────────────────────────────────────────────

/** 12340 -> "12,340" (fixed locale so the text is the same for every administrator). */
export function formatCount(n: number | null | undefined): string {
  return typeof n === "number" && Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "unknown";
}

/** "98.4% (12,340 / 12,540)". */
export function coverageText(coverage: EmbeddingSpace["coverage"]): string {
  if (!coverage.total_chunks || coverage.percent == null) return "No chunks yet";
  return `${coverage.percent.toFixed(1)}% (${formatCount(coverage.current_vectors)} / ${formatCount(coverage.total_chunks)})`;
}

/** Cost as text. A space without a price shows "price not configured", never a guess. */
export function formatCost(estimate: { est_cost_usd: number | null; price_configured: boolean }): string {
  if (!estimate.price_configured || estimate.est_cost_usd == null) return "price not configured";
  const cost = estimate.est_cost_usd;
  if (cost > 0 && cost < 0.01) return "less than $0.01";
  return `$${cost.toFixed(2)}`;
}

/** Seconds as "about 45 seconds", "about 12 minutes", "about 2 h 5 min". */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "not available";
  if (seconds === 0) return "none";
  if (seconds < 60) {
    const s = Math.max(1, Math.round(seconds));
    return `about ${s} second${s === 1 ? "" : "s"}`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `about ${hours} h ${rest} min` : `about ${hours} h`;
}

/** An ISO timestamp as a date, or "not yet". */
export function formatDate(value: string | null | undefined): string {
  if (!value) return "not yet";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "not yet";
  return d.toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

export const STATUS_TEXT: Record<SpaceStatus, string> = {
  building: "Building",
  validated: "Ready to activate",
  active: "Active",
  retired: "Retired",
  purged: "Purged",
};

export const MODE_TEXT: Record<JobMode, string> = {
  dry_run: "Dry run",
  rebuild: "Rebuild",
  delta: "Catch-up",
  validate: "Validation",
  activate: "Activation",
  rollback: "Rollback",
};

/** Cutover step names (cutover.py STEP_NAMES) in plain language. */
export const STEP_TEXT: Record<string, string> = {
  lock: "Pausing syncing",
  wait_idle: "Waiting for running syncs to finish",
  delta: "Catching up new content",
  revalidate: "Checking the new index",
  flip: "Switching to the new index",
  post_flip_check: "Checking after the switch",
  unlock: "Resuming syncing",
};

// ── Eligibility (the server enforces all of these again) ─────────────────────

export function canValidate(space: EmbeddingSpace): boolean {
  return space.status === "building" || space.status === "validated";
}

export function canBuild(space: EmbeddingSpace): boolean {
  return space.status === "building" || space.status === "validated";
}

/** Activate: only a validated space that is not already live, and not during a cutover. */
export function canActivate(space: EmbeddingSpace, opts: { locked?: boolean } = {}): boolean {
  return space.status === "validated" && !space.is_active && !opts.locked;
}

/** Roll back: only a retired space, and not during a cutover. */
export function canRollback(space: EmbeddingSpace, opts: { locked?: boolean } = {}): boolean {
  return space.status === "retired" && !opts.locked;
}

/** The moment a retired space may be purged: the server's value, else retired_at + 30 days. */
export function purgeEligibleAt(space: EmbeddingSpace): Date | null {
  const fromServer = space.purge_eligible_at ? new Date(space.purge_eligible_at) : null;
  if (fromServer && !Number.isNaN(fromServer.getTime())) return fromServer;
  if (!space.retired_at) return null;
  const retired = new Date(space.retired_at);
  if (Number.isNaN(retired.getTime())) return null;
  return new Date(retired.getTime() + PURGE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

/** Purge: retired, not active, and kept for the full retention period (exactly 30 days is enough). */
export function canPurge(space: EmbeddingSpace, now: Date, opts: { locked?: boolean } = {}): boolean {
  if (space.status !== "retired" || space.is_active || opts.locked) return false;
  const eligible = purgeEligibleAt(space);
  return eligible != null && now.getTime() >= eligible.getTime();
}

/** Text shown next to a disabled Purge button. */
export function purgeEligibilityText(space: EmbeddingSpace, now: Date): string {
  if (space.status !== "retired") return "Only a retired space can be purged.";
  const eligible = purgeEligibleAt(space);
  if (!eligible) return "Not available yet.";
  if (now.getTime() >= eligible.getTime()) return "Can be purged now.";
  return `Can be purged from ${formatDate(eligible.toISOString())}.`;
}

/** The Start rebuild button stays disabled until a dry run for this space has finished. */
export function canStartRebuild(space: EmbeddingSpace, dryRun: EmbeddingJob | null): boolean {
  return (
    canBuild(space) &&
    dryRun != null &&
    dryRun.mode === "dry_run" &&
    dryRun.status === "succeeded" &&
    dryRun.space_id === space.id
  );
}

export function isJobActive(job: { status: JobStatus } | null | undefined): boolean {
  return job != null && (job.status === "queued" || job.status === "running");
}

/** True when any space's latest job is still running, so the list should keep refreshing. */
export function hasActiveJob(state: SpacesState | null): boolean {
  return state != null && (state.cutover_locked || state.spaces.some((s) => isJobActive(s.latest_job)));
}

// ── Job progress and reports ─────────────────────────────────────────────────

/** "Embedded 4,800 of 12,540 chunks, step 3 of 7: Catching up new content". Plain text for aria-live. */
export function jobProgressText(job: EmbeddingJob): string {
  if (job.status === "queued") return `${MODE_TEXT[job.mode]} is waiting to start.`;
  if (job.status === "failed") {
    return `${MODE_TEXT[job.mode]} failed${job.last_error ? `: ${job.last_error}` : "."}`;
  }
  if (job.status === "cancelled") return `${MODE_TEXT[job.mode]} was cancelled.`;

  const parts: string[] = [];
  if (job.total_chunks != null && job.mode !== "validate") {
    parts.push(`Embedded ${formatCount(job.processed)} of ${formatCount(job.total_chunks)} chunks`);
  } else if (job.processed > 0 && job.mode !== "validate") {
    parts.push(`Embedded ${formatCount(job.processed)} chunks`);
  }
  if (job.steps.length > 0 && job.current_step) {
    const index = job.steps.findIndex((s) => s.name === job.current_step);
    if (index >= 0) {
      parts.push(`step ${index + 1} of ${job.steps.length}: ${STEP_TEXT[job.current_step] ?? job.current_step}`);
    }
  }
  if (job.status === "succeeded") {
    const done = parts.length ? `${parts.join(", ")}. ` : "";
    return `${done}${MODE_TEXT[job.mode]} finished.`;
  }
  if (parts.length === 0) return `${MODE_TEXT[job.mode]} is running.`;
  const text = parts.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1) + ".";
}

/** Label/value lines for a finished dry run. The cost line never guesses a price. */
export function estimateLines(job: EmbeddingJob): Array<{ label: string; value: string }> {
  const report = (job.report ?? {}) as { chunks_to_embed?: number; characters?: number };
  return [
    { label: "Chunks to embed", value: formatCount(report.chunks_to_embed ?? job.total_chunks) },
    { label: "Characters", value: formatCount(report.characters) },
    { label: "Estimated tokens", value: formatCount(job.est_tokens) },
    { label: "Estimated cost", value: formatCost(job) },
    { label: "Estimated time", value: formatDuration(job.est_seconds) },
  ];
}

export type ValidationView = {
  passed: boolean | null;
  tolerance: number | null;
  coverage: { missing: number; passed: boolean } | null;
  sourceTypes: Array<{
    type: string;
    chunks: number;
    targetCurrent: number;
    gaps: number;
    activeOnly: number;
    passed: boolean;
  }>;
  quality:
    | { skipped: true }
    | {
        skipped: false;
        rows: Array<{ metric: string; label: string; active: number | null; target: number | null; delta: number | null; passed: boolean | null }>;
      }
    | null;
  suggestedMinScore: number | null;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The validation report of a job, whichever job type produced it (validate, activate, rollback). */
export function validationReportOf(job: Pick<EmbeddingJob, "mode" | "report">): unknown {
  if (job.mode === "validate") return job.report;
  if ((job.mode === "activate" || job.mode === "rollback") && isRecord(job.report)) return job.report.revalidate ?? null;
  return null;
}

/** Defensive parse of validate_space's report into rows for a plain table. */
export function parseValidationReport(report: unknown): ValidationView | null {
  if (!isRecord(report) || (!isRecord(report.criteria) && !isRecord(report.coverage))) return null;

  const coverage = isRecord(report.coverage)
    ? { missing: num(report.coverage.chunks_without_current_vector) ?? 0, passed: report.coverage.passed === true }
    : null;

  const sourceTypes =
    isRecord(report.source_types) && Array.isArray(report.source_types.by_source_type)
      ? report.source_types.by_source_type.filter(isRecord).map((e) => ({
          type: String(e.source_type ?? "unknown"),
          chunks: num(e.chunks) ?? 0,
          targetCurrent: num(e.target_current) ?? 0,
          gaps: num(e.target_gaps) ?? 0,
          activeOnly: num(e.active_only) ?? 0,
          passed: e.passed === true,
        }))
      : [];

  let quality: ValidationView["quality"] = null;
  let suggestedMinScore: number | null = null;
  if (isRecord(report.quality)) {
    if (report.quality.skipped === true) {
      quality = { skipped: true };
    } else if (isRecord(report.quality.comparison)) {
      const q = report.quality;
      const comparison = q.comparison as Record<string, unknown>;
      const deltas = isRecord(comparison.deltas) ? comparison.deltas : {};
      const metricsOf = (side: unknown) => (isRecord(side) && isRecord(side.metrics) ? side.metrics : {});
      const active = metricsOf(q.active);
      const target = metricsOf(q.target);
      const labels: Array<[string, string]> = [
        ["recall@5", "Recall at 5"],
        ["recall@15", "Recall at 15"],
        ["mrr", "Mean reciprocal rank"],
      ];
      quality = {
        skipped: false,
        rows: labels.map(([metric, label]) => {
          const d = isRecord(deltas[metric]) ? (deltas[metric] as Record<string, unknown>) : {};
          return {
            metric,
            label,
            active: num(active[metric]),
            target: num(target[metric]),
            delta: num(d.delta),
            passed: typeof d.passed === "boolean" ? d.passed : null,
          };
        }),
      };
      suggestedMinScore = isRecord(q.target) ? num(q.target.suggested_min_score) : null;
    }
  }

  return {
    passed: typeof report.passed === "boolean" ? report.passed : null,
    tolerance: num(report.tolerance) ?? (isRecord(report.quality) && isRecord(report.quality.comparison) ? num(report.quality.comparison.tolerance) : null),
    coverage,
    sourceTypes,
    quality,
    suggestedMinScore,
  };
}
