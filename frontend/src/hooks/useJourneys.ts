import { useCallback, useEffect, useState } from "react";
import { AuthService } from "@/functions/authService";
import { DEMO_ADMIN_EMAIL, isDemoMode } from "@/lib/demo";
import { DEFAULT_JOURNEYS } from "@/components/Admin/defaultJourneys";
import {
  DEFAULT_PROMPT_LIMITS,
  type ClusterInput,
  type ClusterPatch,
  type Journey,
  type JourneyCluster,
  type JourneyFeedback,
  type JourneyInput,
  type JourneyPatch,
  type JourneyPromptField,
  type JourneyPromptVersion,
} from "@/types/journeys";

// ------------------------------------------------------------------
// API
// ------------------------------------------------------------------

async function adminFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await AuthService.getAdminIdToken();
  const res = await fetch(`${import.meta.env.VITE_API_ENDPOINT}${path}`, {
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

// ------------------------------------------------------------------
// Demo mode: in-memory copy of the seed
// ------------------------------------------------------------------

let demoJourneys: Journey[] = structuredClone(DEFAULT_JOURNEYS);
let demoCounter = 0;
const demoId = (prefix: string) => `demo-${prefix}-${Date.now()}-${++demoCounter}`;

function allVersions(journeys: Journey[]): JourneyPromptVersion[] {
  return journeys.flatMap((j) => [
    ...j.prompts.detective_questions,
    ...j.prompts.guidance,
    ...j.clusters.flatMap((c) => c.prompts.response_pattern),
  ]);
}

/** The version list for (field, owner) inside a mutable tree copy. */
function versionList(
  journeys: Journey[],
  field: JourneyPromptField,
  ownerId: string
): JourneyPromptVersion[] | null {
  for (const j of journeys) {
    if (field !== "response_pattern" && j.id === ownerId) return j.prompts[field];
    for (const c of j.clusters) {
      if (field === "response_pattern" && c.id === ownerId) return c.prompts.response_pattern;
    }
  }
  return null;
}

function demoAddVersion(
  journeys: Journey[],
  field: JourneyPromptField,
  ownerId: string,
  content: string
): JourneyPromptVersion {
  const list = versionList(journeys, field, ownerId);
  if (!list) throw new Error("Journey or situation not found");
  const limit = list[0]?.character_limit ?? DEFAULT_PROMPT_LIMITS[field];
  if (content.length > limit) throw new Error("content exceeds character_limit");
  list.forEach((v) => (v.is_active = false));
  const version: JourneyPromptVersion = {
    id: demoId("version"),
    field,
    owner_id: ownerId,
    content,
    character_limit: limit,
    version: list.reduce((m, v) => Math.max(m, v.version), 0) + 1,
    is_active: true,
    created_by_email: DEMO_ADMIN_EMAIL,
    created_at: new Date().toISOString(),
  };
  list.unshift(version);
  return version;
}

function demoFeedback(journeys: Journey[]): JourneyFeedback {
  // Deterministic sample numbers so the demo looks stable.
  const sample = (key: string, i: number) => {
    const seed = [...key].reduce((n, ch) => n + ch.charCodeAt(0), 0) + i * 7;
    const up = (seed % 9) + 2;
    const down = seed % 4;
    return { up, down, sessions: up + down + (seed % 3) };
  };
  return {
    days: 30,
    journeys: journeys.map((j, i) => ({ key: j.key, name: j.name, is_archived: j.is_archived, ...sample(j.key, i) })),
    clusters: journeys.flatMap((j) =>
      j.clusters.map((c, i) => ({
        key: c.key, name: c.name, journey_key: j.key, is_archived: c.is_archived, ...sample(c.key, i),
      }))
    ),
    untagged: { up: 1, down: 1, sessions: 3 },
  };
}

// ------------------------------------------------------------------
// Hooks
// ------------------------------------------------------------------

/** Journey tree plus every admin mutation. Mutations refetch the tree. */
export function useJourneys() {
  const [journeys, setJourneys] = useState<Journey[]>(isDemoMode ? demoJourneys : []);
  const [loading, setLoading] = useState(!isDemoMode);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (isDemoMode) {
      setJourneys(structuredClone(demoJourneys));
      return;
    }
    try {
      setLoading(true);
      const data = await adminFetch<{ journeys: Journey[] }>("/admin/journeys");
      setJourneys(data.journeys ?? []);
      setError(null);
    } catch (e) {
      console.error(e);
      setError(e instanceof Error ? e.message : "Failed to load journeys");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  /** Apply a demo-mode change to a copy of the store, then publish it. */
  const demoMutate = useCallback(<T,>(change: (tree: Journey[]) => T): T => {
    const tree = structuredClone(demoJourneys);
    const result = change(tree);
    demoJourneys = tree;
    setJourneys(structuredClone(tree));
    return result;
  }, []);

  const mutate = useCallback(
    async <T,>(remote: () => Promise<T>, demo: (tree: Journey[]) => T): Promise<T> => {
      if (isDemoMode) return demoMutate(demo);
      const result = await remote();
      await reload();
      return result;
    },
    [demoMutate, reload]
  );

  const createJourney = useCallback(
    (input: JourneyInput) =>
      mutate(
        () => adminFetch<{ id: string }>("/admin/journeys", { method: "POST", body: JSON.stringify(input) }),
        (tree) => {
          if (tree.some((j) => j.key === input.key)) throw new Error(`A journey with key ${input.key} already exists`);
          const id = demoId("journey");
          tree.push({
            id,
            key: input.key,
            name: input.name,
            description: input.description ?? "",
            detection_signals: input.detection_signals ?? "",
            sort_order: input.sort_order ?? tree.length + 1,
            is_archived: false,
            updated_by_email: DEMO_ADMIN_EMAIL,
            updated_at: new Date().toISOString(),
            prompts: { detective_questions: [], guidance: [] },
            clusters: [],
          });
          if (input.detective_questions) demoAddVersion(tree, "detective_questions", id, input.detective_questions);
          if (input.guidance) demoAddVersion(tree, "guidance", id, input.guidance);
          return { id };
        }
      ),
    [mutate]
  );

  const updateJourney = useCallback(
    (id: string, patch: JourneyPatch) =>
      mutate(
        () => adminFetch<{ id: string }>(`/admin/journeys/${encodeURIComponent(id)}`, {
          method: "PUT",
          body: JSON.stringify(patch),
        }),
        (tree) => {
          const journey = tree.find((j) => j.id === id);
          if (!journey) throw new Error("Journey not found");
          if (patch.is_archived && !journey.is_archived && !tree.some((j) => j.id !== id && !j.is_archived)) {
            throw new Error("At least one journey must stay active");
          }
          Object.assign(journey, patch, { updated_at: new Date().toISOString() });
          return { id };
        }
      ),
    [mutate]
  );

  const createCluster = useCallback(
    (journeyId: string, input: ClusterInput) =>
      mutate(
        () => adminFetch<{ id: string }>(`/admin/journeys/${encodeURIComponent(journeyId)}/clusters`, {
          method: "POST",
          body: JSON.stringify(input),
        }),
        (tree) => {
          const journey = tree.find((j) => j.id === journeyId);
          if (!journey) throw new Error("Journey not found");
          if (tree.some((j) => j.clusters.some((c) => c.key === input.key))) {
            throw new Error(`A situation with key ${input.key} already exists`);
          }
          const id = demoId("cluster");
          const cluster: JourneyCluster = {
            id,
            journey_id: journeyId,
            key: input.key,
            name: input.name,
            matches_when: input.matches_when,
            sort_order: input.sort_order ?? journey.clusters.length + 1,
            is_archived: false,
            updated_by_email: DEMO_ADMIN_EMAIL,
            updated_at: new Date().toISOString(),
            prompts: { response_pattern: [] },
          };
          journey.clusters.push(cluster);
          if (input.response_pattern) demoAddVersion(tree, "response_pattern", id, input.response_pattern);
          return { id };
        }
      ),
    [mutate]
  );

  const updateCluster = useCallback(
    (id: string, patch: ClusterPatch) =>
      mutate(
        () => adminFetch<{ id: string }>(`/admin/clusters/${encodeURIComponent(id)}`, {
          method: "PUT",
          body: JSON.stringify(patch),
        }),
        (tree) => {
          const cluster = tree.flatMap((j) => j.clusters).find((c) => c.id === id);
          if (!cluster) throw new Error("Situation not found");
          Object.assign(cluster, patch, { updated_at: new Date().toISOString() });
          return { id };
        }
      ),
    [mutate]
  );

  const saveVersion = useCallback(
    (field: JourneyPromptField, ownerId: string, content: string) =>
      mutate(
        () => adminFetch<JourneyPromptVersion>("/admin/journey-prompts", {
          method: "POST",
          body: JSON.stringify({ field, owner_id: ownerId, content }),
        }),
        (tree) => demoAddVersion(tree, field, ownerId, content)
      ),
    [mutate]
  );

  const deleteVersion = useCallback(
    (versionId: string) =>
      mutate(
        () => adminFetch<unknown>(`/admin/journey-prompts/${encodeURIComponent(versionId)}`, { method: "DELETE" }),
        (tree) => {
          const target = allVersions(tree).find((v) => v.id === versionId);
          if (!target) throw new Error("Prompt version not found");
          if (target.is_active) throw new Error("Cannot delete the active version");
          const list = versionList(tree, target.field, target.owner_id);
          list?.splice(list.indexOf(target), 1);
          return null;
        }
      ),
    [mutate]
  );

  const activateVersion = useCallback(
    (versionId: string) =>
      mutate(
        () => adminFetch<unknown>(`/admin/journey-prompts/${encodeURIComponent(versionId)}/activate`, {
          method: "POST",
        }),
        (tree) => {
          const target = allVersions(tree).find((v) => v.id === versionId);
          if (!target) throw new Error("Prompt version not found");
          versionList(tree, target.field, target.owner_id)?.forEach((v) => (v.is_active = v.id === versionId));
          return null;
        }
      ),
    [mutate]
  );

  return {
    journeys,
    loading,
    error,
    reload,
    createJourney,
    updateJourney,
    createCluster,
    updateCluster,
    saveVersion,
    deleteVersion,
    activateVersion,
  };
}

/** Thumbs up/down counts per journey and situation (counts only). */
export function useJourneyFeedback(timeRange: string, refreshKey = 0) {
  const [feedback, setFeedback] = useState<JourneyFeedback | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isDemoMode) {
      setFeedback(demoFeedback(demoJourneys));
      return;
    }
    let active = true;
    setLoading(true);
    adminFetch<JourneyFeedback>(`/admin/journeys/feedback?timeRange=${encodeURIComponent(timeRange)}`)
      .then((data) => {
        if (active) {
          setFeedback(data);
          setError(null);
        }
      })
      .catch((e) => {
        console.error(e);
        if (active) setError("Failed to load feedback by journey");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [timeRange, refreshKey]);

  return { feedback, loading, error };
}
