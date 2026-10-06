import { useCallback, useEffect, useState } from "react";
import { AuthService } from "@/functions/authService";
import { DEMO_ADMIN_EMAIL, isDemoMode } from "@/lib/demo";
import { DEFAULT_SYSTEM_MESSAGES } from "@/components/Admin/defaultSystemMessages";
import type {
  SystemMessageType,
  SystemMessageVersion,
  SystemMessages,
} from "@/types/systemMessages";

async function adminFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await AuthService.getAdminIdToken();
  const res = await fetch(`${import.meta.env.VITE_API_ENDPOINT}${path}`, {
    ...init,
    headers: { Authorization: token, "Content-Type": "application/json", ...(init.headers ?? {}) },
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

// Demo mode keeps edits in memory for the session.
let demoMessages: SystemMessages = structuredClone(DEFAULT_SYSTEM_MESSAGES);

/**
 * Versioned system messages (GET/POST /admin/system-messages...). Saving
 * creates a new active version; activating makes an older version live again.
 */
export function useSystemMessages() {
  const [messages, setMessages] = useState<SystemMessages>(isDemoMode ? demoMessages : {});
  const [loading, setLoading] = useState(!isDemoMode);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (isDemoMode) {
      setMessages(structuredClone(demoMessages));
      return;
    }
    try {
      setLoading(true);
      setMessages(await adminFetch<SystemMessages>("/admin/system-messages"));
      setError(null);
    } catch (e) {
      console.error(e);
      setError("Failed to load the shared prompts");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const publish = useCallback(
    async (type: SystemMessageType, content: string) => {
      if (isDemoMode) {
        const list = (demoMessages[type] ?? []).map((v) => ({ ...v, is_active: false }));
        const latest = demoMessages[type]?.[0];
        if (latest && content.length > latest.character_limit) throw new Error("content exceeds character_limit");
        const version: SystemMessageVersion = {
          id: `demo-${type}-${Date.now()}`,
          type,
          content,
          character_limit: latest?.character_limit ?? 2000,
          version: list.reduce((m, v) => Math.max(m, v.version), 0) + 1,
          is_active: true,
          affects_text_generation: latest?.affects_text_generation ?? true,
          created_by_email: DEMO_ADMIN_EMAIL,
          created_at: new Date().toISOString(),
        };
        demoMessages = { ...demoMessages, [type]: [version, ...list] };
        setMessages(structuredClone(demoMessages));
        return;
      }
      // The backend takes the admin identity from the authorizer.
      await adminFetch(`/admin/system-messages/${type}`, {
        method: "POST",
        body: JSON.stringify({ content }),
      });
      await reload();
    },
    [reload]
  );

  const activate = useCallback(
    async (type: SystemMessageType, versionId: string) => {
      if (isDemoMode) {
        demoMessages = {
          ...demoMessages,
          [type]: (demoMessages[type] ?? []).map((v) => ({ ...v, is_active: v.id === versionId })),
        };
        setMessages(structuredClone(demoMessages));
        return;
      }
      await adminFetch(`/admin/system-messages/${type}/${encodeURIComponent(versionId)}/activate`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      await reload();
    },
    [reload]
  );

  return { messages, loading, error, reload, publish, activate };
}
