import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EMPTY_REGISTER_FORM,
  PROVIDERS,
  PURGE_RETENTION_DAYS,
  canActivate,
  canPurge,
  canRollback,
  canStartRebuild,
  coverageText,
  estimateLines,
  formatCost,
  formatDuration,
  hasActiveJob,
  jobProgressText,
  parseRegisterForm,
  parseValidationReport,
  purgeEligibilityText,
  validationReportOf,
  type EmbeddingJob,
  type EmbeddingSpace,
  type RegisterFormValues,
} from "@/lib/embeddingSpaces";

const repo = resolve(__dirname, "../../..");
const DAY = 24 * 60 * 60 * 1000;

function space(overrides: Partial<EmbeddingSpace> = {}): EmbeddingSpace {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    name: "titan-v2-1024",
    provider: "titan_v2",
    model_id: "amazon.titan-embed-text-v2:0",
    invoke_target: "amazon.titan-embed-text-v2:0",
    dimensions: 1024,
    version: "1",
    status: "building",
    is_active: false,
    min_score: null,
    split_threshold: null,
    price_per_1m_tokens: null,
    eol_date: null,
    settings: {},
    created_by: null,
    created_at: "2026-01-01T00:00:00Z",
    activated_at: null,
    retired_at: null,
    coverage: { current_vectors: 0, total_chunks: 0, percent: null },
    latest_job: null,
    ...overrides,
  };
}

function job(overrides: Partial<EmbeddingJob> = {}): EmbeddingJob {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    space_id: "22222222-2222-4222-8222-222222222222",
    mode: "rebuild",
    status: "running",
    total_chunks: 12540,
    processed: 4800,
    failed: 0,
    est_tokens: null,
    est_cost_usd: null,
    est_seconds: null,
    price_configured: false,
    current_step: null,
    steps: [],
    report: null,
    last_error: null,
    created_at: "2026-01-01T00:00:00Z",
    finished_at: null,
    ...overrides,
  };
}

const valid: RegisterFormValues = {
  ...EMPTY_REGISTER_FORM,
  name: "titan-v2-1024",
};

describe("register form (mirrors validate_registration)", () => {
  it("accepts a minimal valid form and sends nulls for the optional fields", () => {
    const result = parseRegisterForm(valid);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload).toMatchObject({
        name: "titan-v2-1024",
        provider: "titan_v2",
        dimensions: 1024,
        version: "1",
        price_per_1m_tokens: null,
        eol_date: null,
        min_score: null,
        split_threshold: null,
        settings: {},
      });
      expect(result.payload).not.toHaveProperty("model_id");
      expect(result.payload).not.toHaveProperty("invoke_target");
    }
  });

  it("converts optional text fields to numbers and settings", () => {
    const result = parseRegisterForm({
      ...valid,
      version: " 2 ",
      price_per_1m_tokens: "0.02",
      eol_date: "2027-02-28",
      min_score: "0.4",
      split_threshold: "1",
      batch_size: "1",
      max_chars: "100",
      concurrency: "8",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.version).toBe("2");
      expect(result.payload.price_per_1m_tokens).toBe(0.02);
      expect(result.payload.eol_date).toBe("2027-02-28");
      expect(result.payload.min_score).toBe(0.4);
      expect(result.payload.split_threshold).toBe(1);
      expect(result.payload.settings).toEqual({ batch_size: 1, max_chars: 100, concurrency: 8 });
    }
  });

  it("accepts the edge values the server accepts", () => {
    for (const patch of [
      { name: "abc" },
      { name: "a".repeat(63) },
      { price_per_1m_tokens: "0" },
      { min_score: "0" },
      { split_threshold: "1" },
      { eol_date: "2028-02-29" },
      { dimensions: 256 },
      { max_chars: "50000" },
      { concurrency: "32" },
    ]) {
      expect(parseRegisterForm({ ...valid, ...patch }).ok, JSON.stringify(patch)).toBe(true);
    }
  });

  it("rejects each invalid value with a message on the right field", () => {
    const cases: Array<[Partial<RegisterFormValues>, keyof RegisterFormValues]> = [
      [{ name: "ab" }, "name"],
      [{ name: "Titan-V2" }, "name"],
      [{ name: "-titan" }, "name"],
      [{ name: "a".repeat(64) }, "name"],
      [{ name: "has space" }, "name"],
      [{ provider: "openai" as never }, "provider"],
      [{ dimensions: 768 }, "dimensions"],
      [{ provider: "cohere_v3", dimensions: 512 }, "dimensions"],
      [{ dimensions: Number.NaN }, "dimensions"],
      [{ version: "v".repeat(33) }, "version"],
      [{ price_per_1m_tokens: "-0.01" }, "price_per_1m_tokens"],
      [{ price_per_1m_tokens: "cheap" }, "price_per_1m_tokens"],
      [{ price_per_1m_tokens: "Infinity" }, "price_per_1m_tokens"],
      [{ eol_date: "01/02/2026" }, "eol_date"],
      [{ eol_date: "2026-13-45" }, "eol_date"],
      [{ eol_date: "20260101" }, "eol_date"],
      [{ eol_date: "2026-02-30" }, "eol_date"],
      [{ min_score: "1.5" }, "min_score"],
      [{ min_score: "-0.1" }, "min_score"],
      [{ split_threshold: "abc" }, "split_threshold"],
      [{ batch_size: "0" }, "batch_size"],
      [{ batch_size: "257" }, "batch_size"],
      [{ batch_size: "2.5" }, "batch_size"],
      [{ max_chars: "99" }, "max_chars"],
      [{ max_chars: "50001" }, "max_chars"],
      [{ concurrency: "0" }, "concurrency"],
      [{ concurrency: "33" }, "concurrency"],
    ];
    for (const [patch, field] of cases) {
      const result = parseRegisterForm({ ...valid, ...patch });
      expect(result.ok, JSON.stringify(patch)).toBe(false);
      if (!result.ok) expect(result.errors[field], JSON.stringify(patch)).toBeTruthy();
    }
  });

  it("applies the provider batch-size limit (Cohere v3 allows at most 96)", () => {
    const v3 = { ...valid, provider: "cohere_v3" as const, dimensions: 1024 };
    expect(parseRegisterForm({ ...v3, batch_size: "96" }).ok).toBe(true);
    const over = parseRegisterForm({ ...v3, batch_size: "97" });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.errors.batch_size).toMatch(/at most 96/);
    expect(parseRegisterForm({ ...valid, batch_size: "200" }).ok).toBe(true);
  });

  it("reports every problem at once, one message per field", () => {
    const result = parseRegisterForm({ ...valid, name: "x", price_per_1m_tokens: "-1", eol_date: "nope" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.errors).sort()).toEqual(["eol_date", "name", "price_per_1m_tokens"]);
  });

  it("lists the same dimensions as the server adapters", () => {
    const py = readFileSync(resolve(repo, "cdk/containers/common/embeddings.py"), "utf8");
    const dims = (adapter: string) => {
      const block = py.slice(py.indexOf(`class ${adapter}`));
      const match = block.match(/allowed_dimensions = frozenset\(\{([^}]*)\}\)/);
      return match![1].split(",").map((s) => Number(s.trim())).sort((a, b) => a - b);
    };
    expect([...PROVIDERS.cohere_v3.dimensions].sort((a, b) => a - b)).toEqual(dims("CohereV3Adapter"));
    expect([...PROVIDERS.titan_v2.dimensions].sort((a, b) => a - b)).toEqual(dims("TitanV2Adapter"));
    expect([...PROVIDERS.cohere_v4.dimensions].sort((a, b) => a - b)).toEqual(dims("CohereV4Adapter"));
  });

  it("uses the same retention period as the server", () => {
    const py = readFileSync(resolve(repo, "cdk/lambda/knowledgeBase/helpers/embedding_admin.py"), "utf8");
    expect(Number(py.match(/^RETENTION_DAYS = (\d+)/m)?.[1])).toBe(PURGE_RETENTION_DAYS);
  });
});

describe("cost and time text", () => {
  it("shows 'price not configured' when the space has no price, never a guess", () => {
    expect(formatCost({ est_cost_usd: null, price_configured: false })).toBe("price not configured");
    expect(formatCost({ est_cost_usd: 12.5, price_configured: false })).toBe("price not configured");
    expect(formatCost({ est_cost_usd: null, price_configured: true })).toBe("price not configured");
  });

  it("formats a configured price", () => {
    expect(formatCost({ est_cost_usd: 12.5, price_configured: true })).toBe("$12.50");
    expect(formatCost({ est_cost_usd: 0, price_configured: true })).toBe("$0.00");
    expect(formatCost({ est_cost_usd: 0.004, price_configured: true })).toBe("less than $0.01");
  });

  it("formats durations", () => {
    expect(formatDuration(null)).toBe("not available");
    expect(formatDuration(0)).toBe("none");
    expect(formatDuration(1)).toBe("about 1 second");
    expect(formatDuration(45)).toBe("about 45 seconds");
    expect(formatDuration(60)).toBe("about 1 minute");
    expect(formatDuration(750)).toBe("about 13 minutes");
    expect(formatDuration(3600)).toBe("about 1 h");
    expect(formatDuration(7500)).toBe("about 2 h 5 min");
  });

  it("describes coverage as text", () => {
    expect(coverageText({ current_vectors: 12340, total_chunks: 12540, percent: 98.4 })).toBe("98.4% (12,340 / 12,540)");
    expect(coverageText({ current_vectors: 0, total_chunks: 0, percent: null })).toBe("No chunks yet");
  });

  it("builds the dry-run estimate lines with the price rule", () => {
    const lines = estimateLines(
      job({ mode: "dry_run", status: "succeeded", report: { chunks_to_embed: 1200, characters: 480000 }, est_tokens: 120000, est_seconds: 300 })
    );
    expect(Object.fromEntries(lines.map((l) => [l.label, l.value]))).toEqual({
      "Chunks to embed": "1,200",
      Characters: "480,000",
      "Estimated tokens": "120,000",
      "Estimated cost": "price not configured",
      "Estimated time": "about 5 minutes",
    });
  });
});

describe("job progress text", () => {
  it("reads like the spec example for a catch-up inside a cutover", () => {
    const steps = ["lock", "wait_idle", "delta", "revalidate", "flip", "post_flip_check", "unlock"].map((name) => ({
      name,
      status: "pending" as const,
      started_at: null,
      finished_at: null,
      detail: null,
    }));
    const text = jobProgressText(job({ mode: "activate", current_step: "delta", steps }));
    expect(text).toBe("Embedded 4,800 of 12,540 chunks, step 3 of 7: Catching up new content.");
  });

  it("covers queued, running, finished and failed jobs", () => {
    expect(jobProgressText(job({ status: "queued" }))).toBe("Rebuild is waiting to start.");
    expect(jobProgressText(job())).toBe("Embedded 4,800 of 12,540 chunks.");
    expect(jobProgressText(job({ total_chunks: null, processed: 0 }))).toBe("Rebuild is running.");
    expect(jobProgressText(job({ status: "succeeded", processed: 12540 }))).toBe("Embedded 12,540 of 12,540 chunks. Rebuild finished.");
    expect(jobProgressText(job({ status: "failed", last_error: "ThrottlingException" }))).toBe("Rebuild failed: ThrottlingException");
    expect(jobProgressText(job({ mode: "validate", status: "running", total_chunks: null, processed: 0 }))).toBe("Validation is running.");
  });
});

describe("eligibility", () => {
  const retiredAt = new Date("2026-01-01T00:00:00Z");
  const retired = (extra: Partial<EmbeddingSpace> = {}) =>
    space({ status: "retired", retired_at: retiredAt.toISOString(), ...extra });

  it("purge is allowed at exactly 30 days and refused one second earlier", () => {
    const exactly = new Date(retiredAt.getTime() + PURGE_RETENTION_DAYS * DAY);
    expect(canPurge(retired(), exactly)).toBe(true);
    expect(canPurge(retired(), new Date(exactly.getTime() - 1000))).toBe(false);
    expect(canPurge(retired(), new Date(retiredAt.getTime() + 29 * DAY + 23 * 60 * 60 * 1000))).toBe(false);
    expect(canPurge(retired(), new Date(exactly.getTime() + DAY))).toBe(true);
  });

  it("purge prefers the server's purge_eligible_at", () => {
    const s = retired({ purge_eligible_at: "2026-03-01T00:00:00Z" });
    expect(canPurge(s, new Date("2026-02-28T23:59:59Z"))).toBe(false);
    expect(canPurge(s, new Date("2026-03-01T00:00:00Z"))).toBe(true);
  });

  it("purge refuses active, non-retired, purged, unretired-date and locked spaces", () => {
    const late = new Date(retiredAt.getTime() + 90 * DAY);
    expect(canPurge(retired({ is_active: true }), late)).toBe(false);
    for (const status of ["building", "validated", "active", "purged"] as const) {
      expect(canPurge(space({ status, retired_at: retiredAt.toISOString() }), late), status).toBe(false);
    }
    expect(canPurge(space({ status: "retired", retired_at: null }), late)).toBe(false);
    expect(canPurge(retired(), late, { locked: true })).toBe(false);
  });

  it("explains in text when a purge becomes possible", () => {
    expect(purgeEligibilityText(retired(), new Date("2026-01-10T00:00:00Z"))).toBe("Can be purged from Jan 31, 2026.");
    expect(purgeEligibilityText(retired(), new Date("2026-02-01T00:00:00Z"))).toBe("Can be purged now.");
    expect(purgeEligibilityText(space({ status: "active" }), new Date())).toBe("Only a retired space can be purged.");
  });

  it("activate needs a validated, non-active space and no cutover lock", () => {
    expect(canActivate(space({ status: "validated" }))).toBe(true);
    expect(canActivate(space({ status: "validated" }), { locked: true })).toBe(false);
    expect(canActivate(space({ status: "validated", is_active: true }))).toBe(false);
    for (const status of ["building", "active", "retired", "purged"] as const) {
      expect(canActivate(space({ status }))).toBe(false);
    }
  });

  it("rollback needs a retired space and no cutover lock", () => {
    expect(canRollback(space({ status: "retired" }))).toBe(true);
    expect(canRollback(space({ status: "retired" }), { locked: true })).toBe(false);
    for (const status of ["building", "validated", "active", "purged"] as const) {
      expect(canRollback(space({ status }))).toBe(false);
    }
  });

  it("Start rebuild stays disabled until a dry run for this space has succeeded", () => {
    const s = space();
    expect(canStartRebuild(s, null)).toBe(false);
    expect(canStartRebuild(s, job({ mode: "dry_run", status: "running" }))).toBe(false);
    expect(canStartRebuild(s, job({ mode: "dry_run", status: "failed" }))).toBe(false);
    expect(canStartRebuild(s, job({ mode: "rebuild", status: "succeeded" }))).toBe(false);
    expect(canStartRebuild(s, job({ mode: "dry_run", status: "succeeded", space_id: "other" }))).toBe(false);
    expect(canStartRebuild(s, job({ mode: "dry_run", status: "succeeded" }))).toBe(true);
    expect(canStartRebuild(space({ status: "active" }), job({ mode: "dry_run", status: "succeeded" }))).toBe(false);
  });

  it("keeps polling while a job runs or a cutover lock is held", () => {
    const summary = (status: "queued" | "running" | "succeeded") => ({
      id: "j",
      mode: "rebuild" as const,
      status,
      processed: 0,
      total_chunks: null,
      current_step: null,
      last_error: null,
      created_at: "2026-01-01T00:00:00Z",
      finished_at: null,
    });
    const state = (latest: ReturnType<typeof summary> | null, locked = false) => ({
      spaces: [space({ latest_job: latest })],
      active_space_id: null,
      total_chunks: 0,
      cutover_locked: locked,
    });
    expect(hasActiveJob(null)).toBe(false);
    expect(hasActiveJob(state(summary("running")))).toBe(true);
    expect(hasActiveJob(state(summary("queued")))).toBe(true);
    expect(hasActiveJob(state(summary("succeeded")))).toBe(false);
    expect(hasActiveJob(state(null, true))).toBe(true);
  });
});

describe("validation report", () => {
  const report = {
    passed: false,
    tolerance: 0.05,
    criteria: { coverage: true, source_types: true, quality: false },
    coverage: { chunks_without_current_vector: 0, sample_chunk_ids: [], passed: true },
    source_types: {
      passed: true,
      by_source_type: [
        { source_type: "web", chunks: 100, target_current: 100, active_current: 100, target_gaps: 0, active_only: 0, passed: true },
        { source_type: "document", chunks: 20, target_current: 18, active_current: 20, target_gaps: 2, active_only: 2, passed: false },
      ],
    },
    quality: {
      active: { metrics: { "recall@5": 0.8, "recall@15": 0.9, mrr: 0.6 } },
      target: { metrics: { "recall@5": 0.7, "recall@15": 0.9, mrr: 0.55 }, suggested_min_score: 0.42 },
      comparison: {
        tolerance: 0.05,
        passed: false,
        deltas: { "recall@5": { delta: -0.1, passed: false }, "recall@15": { delta: 0, passed: true }, mrr: { delta: -0.05 } },
      },
    },
  };

  it("turns the report into plain table rows", () => {
    const view = parseValidationReport(report)!;
    expect(view.passed).toBe(false);
    expect(view.tolerance).toBe(0.05);
    expect(view.coverage).toEqual({ missing: 0, passed: true });
    expect(view.sourceTypes).toHaveLength(2);
    expect(view.sourceTypes[1]).toMatchObject({ type: "document", gaps: 2, activeOnly: 2, passed: false });
    expect(view.quality).toMatchObject({ skipped: false });
    if (view.quality && !view.quality.skipped) {
      expect(view.quality.rows[0]).toEqual({ metric: "recall@5", label: "Recall at 5", active: 0.8, target: 0.7, delta: -0.1, passed: false });
      expect(view.quality.rows[2].passed).toBeNull();
    }
    expect(view.suggestedMinScore).toBe(0.42);
  });

  it("handles a skipped quality check and unusable input", () => {
    const skipped = parseValidationReport({ ...report, quality: { skipped: true } })!;
    expect(skipped.quality).toEqual({ skipped: true });
    for (const bad of [null, undefined, "x", 3, [], {}]) expect(parseValidationReport(bad)).toBeNull();
  });

  it("finds the report of a validate, activate or rollback job", () => {
    expect(validationReportOf({ mode: "validate", report })).toBe(report);
    expect(validationReportOf({ mode: "activate", report: { revalidate: report } })).toBe(report);
    expect(validationReportOf({ mode: "rollback", report: { revalidate: report } })).toBe(report);
    expect(validationReportOf({ mode: "rebuild", report })).toBeNull();
    expect(validationReportOf({ mode: "activate", report: null })).toBeNull();
  });
});
