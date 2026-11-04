import { useCallback, useEffect, useRef, useState } from "react";
import { AuthService } from "@/functions/authService";
import { isDemoMode } from "@/lib/demo";
import {
  DEMO_EMBEDDING_MODELS,
  EMPTY_SPACES_STATE,
  JOB_POLL_MS,
  hasActiveJob,
  isJobActive,
  type EmbeddingJob,
  type EmbeddingModelOption,
  type EmbeddingSpace,
  type RegisterPayload,
  type SpacesState,
} from "@/lib/embeddingSpaces";
import { API_ENDPOINT } from "@/lib/api";

// Embedding space admin API (cdk/lambda/knowledgeBase/helpers/embedding_admin.py).
// No call here requests or returns chunk text: only ids, counts and metrics.

async function adminFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await AuthService.getAdminIdToken();
  const res = await fetch(`${API_ENDPOINT}${path}`, {
    ...init,
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const data = await res.json();
      if (data && typeof data.error === "string") message = data.error;
    } catch {
      // keep the generic message
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

const DEMO_MESSAGE = "This action isn't available in demo mode.";

function refuseInDemo() {
  if (isDemoMode) throw new Error(DEMO_MESSAGE);
}

// Demo mode shows the one live space and nothing else; changes need the real backend.
const DEMO_STATE: SpacesState = {
  spaces: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      name: "cohere-v3-1024",
      provider: "cohere_v3",
      model_id: "cohere.embed-english-v3",
      invoke_target: "cohere.embed-english-v3",
      dimensions: 1024,
      version: "1",
      status: "active",
      is_active: true,
      min_score: 0.4,
      split_threshold: 0.6,
      price_per_1m_tokens: null,
      eol_date: null,
      settings: {},
      created_by: null,
      created_at: "2026-01-01T00:00:00Z",
      activated_at: "2026-01-01T00:00:00Z",
      retired_at: null,
      purge_eligible_at: null,
      coverage: { current_vectors: 1240, total_chunks: 1240, percent: 100 },
      latest_job: null,
    },
  ],
  active_space_id: "11111111-1111-4111-8111-111111111111",
  total_chunks: 1240,
  retention_days: 30,
  cutover_locked: false,
};

export function useEmbeddingSpaces() {
  const [state, setState] = useState<SpacesState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async (silent = false) => {
    if (isDemoMode) {
      setState(structuredClone(DEMO_STATE));
      setLoading(false);
      return;
    }
    try {
      if (!silent) setLoading(true);
      const data = await adminFetch<SpacesState>("/admin/embedding-spaces");
      if (!mounted.current) return;
      setState({ ...EMPTY_SPACES_STATE, ...data });
      setError(null);
    } catch (e) {
      console.error(e);
      if (mounted.current && !silent) setError("Couldn't load the search index. Please refresh the page.");
    } finally {
      if (mounted.current && !silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Keep the list fresh while any job runs or a cutover holds the lock.
  const polling = hasActiveJob(state);
  useEffect(() => {
    if (!polling) return;
    const timer = window.setInterval(() => load(true), JOB_POLL_MS);
    return () => window.clearInterval(timer);
  }, [polling, load]);

  const loadModels = useCallback(async (): Promise<EmbeddingModelOption[]> => {
    if (isDemoMode) return DEMO_EMBEDDING_MODELS;
    const data = await adminFetch<{ models: EmbeddingModelOption[] }>("/admin/embedding-models");
    return data.models ?? [];
  }, []);

  const register = useCallback(
    async (payload: RegisterPayload) => {
      refuseInDemo();
      await adminFetch("/admin/embedding-spaces", { method: "POST", body: JSON.stringify(payload) });
      await load(true);
    },
    [load]
  );

  /** Starts a dry run, rebuild or catch-up. Returns the job id to follow. */
  const startJob = useCallback(
    async (spaceId: string, mode: "dry_run" | "rebuild" | "delta"): Promise<string> => {
      refuseInDemo();
      const res = await adminFetch<{ id: string }>(`/admin/embedding-spaces/${encodeURIComponent(spaceId)}/jobs`, {
        method: "POST",
        body: JSON.stringify({ mode }),
      });
      await load(true);
      return res.id;
    },
    [load]
  );

  /** `skipQuality` skips the golden-set comparison with the live index; coverage is still checked. */
  const validate = useCallback(
    async (spaceId: string, opts: { skipQuality?: boolean } = {}): Promise<string> => {
      refuseInDemo();
      const res = await adminFetch<{ id: string }>(`/admin/embedding-spaces/${encodeURIComponent(spaceId)}/validate`, {
        method: "POST",
        body: JSON.stringify(opts.skipQuality ? { skip_quality: true } : {}),
      });
      await load(true);
      return res.id;
    },
    [load]
  );

  /** `skipQuality` applies to activation only (the server accepts it only there). */
  const cutover = useCallback(
    async (spaceId: string, action: "activate" | "rollback", opts: { skipQuality?: boolean } = {}): Promise<string> => {
      refuseInDemo();
      const res = await adminFetch<{ id: string }>(`/admin/embedding-spaces/${encodeURIComponent(spaceId)}/${action}`, {
        method: "POST",
        body: JSON.stringify(action === "activate" && opts.skipQuality ? { skip_quality: true } : {}),
      });
      await load(true);
      return res.id;
    },
    [load]
  );

  /** The server also requires confirm_name to equal the space name exactly. */
  const purge = useCallback(
    async (space: EmbeddingSpace, confirmName: string) => {
      refuseInDemo();
      await adminFetch(`/admin/embedding-spaces/${encodeURIComponent(space.id)}/purge`, {
        method: "POST",
        body: JSON.stringify({ confirm_name: confirmName }),
      });
      await load(true);
    },
    [load]
  );

  return { state, loading, error, reload: load, loadModels, register, startJob, validate, cutover, purge };
}

/** Follows one job: polls until it finishes, then calls `onFinished` once. */
export function useEmbeddingJob(jobId: string | null, onFinished?: (job: EmbeddingJob) => void) {
  const [job, setJob] = useState<EmbeddingJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const finishedRef = useRef(onFinished);

  useEffect(() => {
    finishedRef.current = onFinished;
  }, [onFinished]);

  useEffect(() => {
    if (!jobId || isDemoMode) {
      setJob(null);
      setError(null);
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    // Only a job seen running is "finished" here; opening an old finished job is not news.
    let sawActive = false;

    const tick = async () => {
      try {
        const data = await adminFetch<EmbeddingJob>(`/admin/embedding-jobs/${encodeURIComponent(jobId)}`);
        if (cancelled) return;
        setJob(data);
        setError(null);
        if (isJobActive(data)) {
          sawActive = true;
          timer = window.setTimeout(tick, JOB_POLL_MS);
        } else if (sawActive) {
          finishedRef.current?.(data);
        }
      } catch (e) {
        console.error(e);
        if (cancelled) return;
        setError(e instanceof Error && e.message ? e.message : "Couldn't read the job's progress.");
        timer = window.setTimeout(tick, JOB_POLL_MS * 2);
      }
    };

    tick();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [jobId]);

  return { job, error };
}
