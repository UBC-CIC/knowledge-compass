import { useCallback, useEffect, useRef, useState } from "react";
import { AuthService } from "@/functions/authService";
import { DEMO_ADMIN_EMAIL, isDemoMode } from "@/lib/demo";
import {
  EMPTY_GUIDELINE_STATE,
  GUIDE_FILE_TYPES,
  guideFileKind,
  hasProcessing,
  normalizeLabel,
  validateGuideFile,
  validateLabel,
  type GuidelineMode,
  type GuidelineState,
} from "@/lib/guideline";
import { API_ENDPOINT } from "@/lib/api";

// Guideline mode admin API (cdk/lambda/knowledgeBase/helpers/guideline_admin.py).

const POLL_MS = 4000;

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

// Demo mode keeps the mode in memory; uploads need the real backend.
let demoState: GuidelineState = structuredClone(EMPTY_GUIDELINE_STATE);

type UploadUrl = { presignedUrl: string; key: string; contentType: string };

async function uploadOne(file: File, replaceDocumentId?: string, journeyId?: string): Promise<void> {
  const kind = guideFileKind(file.name);
  if (!kind) throw new Error(`"${file.name}" can't be used.`);
  const target = await adminFetch<UploadUrl>("/admin/guideline/upload-url", {
    method: "POST",
    body: JSON.stringify({ file_name: file.name, content_type: GUIDE_FILE_TYPES[kind].contentType }),
  });
  const put = await fetch(target.presignedUrl, {
    method: "PUT",
    headers: { "Content-Type": target.contentType },
    body: file,
  });
  if (!put.ok) throw new Error(`Upload of "${file.name}" failed. Please try again.`);
  await adminFetch("/admin/guideline/documents", {
    method: "POST",
    body: JSON.stringify({
      s3_key: target.key,
      file_name: file.name,
      ...(replaceDocumentId ? { replace_document_id: replaceDocumentId } : {}),
      ...(journeyId ? { journey_id: journeyId } : {}),
    }),
  });
}

export function useGuideline() {
  const [state, setState] = useState<GuidelineState | null>(null);
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
      setState(structuredClone(demoState));
      setLoading(false);
      return;
    }
    try {
      if (!silent) setLoading(true);
      const data = await adminFetch<GuidelineState>("/admin/guideline");
      if (!mounted.current) return;
      setState(data);
      setError(null);
    } catch (e) {
      console.error(e);
      if (mounted.current && !silent) setError("Couldn't load guideline mode. Please refresh the page.");
    } finally {
      if (mounted.current && !silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Poll while any guide is still being read.
  const processing = hasProcessing(state);
  useEffect(() => {
    if (!processing) return;
    const timer = window.setInterval(() => load(true), POLL_MS);
    return () => window.clearInterval(timer);
  }, [processing, load]);

  const setMode = useCallback(
    async (mode: GuidelineMode) => {
      if (isDemoMode) {
        demoState = {
          ...demoState,
          mode,
          mode_updated_by: DEMO_ADMIN_EMAIL,
          mode_updated_at: new Date().toISOString(),
        };
        await load(true);
        return;
      }
      await adminFetch("/admin/guideline/mode", { method: "PUT", body: JSON.stringify({ mode }) });
      await load(true);
    },
    [load]
  );

  /** Uploads each file; returns plain-language problems for files that failed. */
  const upload = useCallback(
    async (files: File[], replaceDocumentId?: string, journeyId?: string): Promise<string[]> => {
      if (isDemoMode) return ["Uploading guides isn't available in demo mode."];
      const problems: string[] = [];
      for (const file of files) {
        const invalid = validateGuideFile(file);
        if (invalid) {
          problems.push(invalid);
          continue;
        }
        try {
          await uploadOne(file, replaceDocumentId, journeyId);
        } catch (e) {
          console.error(e);
          problems.push(e instanceof Error && e.message ? e.message : `Couldn't upload "${file.name}".`);
        }
      }
      await load(true);
      return problems;
    },
    [load]
  );

  const remove = useCallback(
    async (documentId: string) => {
      if (isDemoMode) return;
      await adminFetch(`/admin/guideline/documents/${encodeURIComponent(documentId)}`, { method: "DELETE" });
      await load(true);
    },
    [load]
  );

  const rename = useCallback(
    async (sectionId: string, label: string) => {
      const invalid = validateLabel(label);
      if (invalid) throw new Error(invalid);
      if (isDemoMode) return;
      await adminFetch(`/admin/guideline/sections/${encodeURIComponent(sectionId)}`, {
        method: "PATCH",
        body: JSON.stringify({ label: normalizeLabel(label) }),
      });
      await load(true);
    },
    [load]
  );

  return { state, loading, error, reload: load, setMode, upload, remove, rename };
}
