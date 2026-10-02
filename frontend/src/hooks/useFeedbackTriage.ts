import { useCallback, useEffect, useRef, useState } from "react";
import { AuthService } from "@/functions/authService";
import { isDemoMode } from "@/lib/demo";

/** A written feedback comment as returned by GET /admin/analytics. */
export type FeedbackEntry = {
  chat_session_id: string;
  rating: "up" | "down";
  comment: string;
  updated_at: string;
  starred?: boolean;
};

export type FeedbackLists = {
  recent: FeedbackEntry[];
  starred: FeedbackEntry[];
  dismissed: FeedbackEntry[];
};

export type TriageChange = { starred: boolean } | { dismissed: boolean };

const byUpdatedDesc = (a: FeedbackEntry, b: FeedbackEntry) =>
  new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();

/**
 * Moves an entry between lists the same way the server does:
 * dismissing removes the star, and restoring puts it back in Recent unstarred.
 */
export function applyTriage(
  lists: FeedbackLists,
  entry: FeedbackEntry,
  change: TriageChange
): FeedbackLists {
  const id = entry.chat_session_id;
  const without = (list: FeedbackEntry[]) =>
    list.filter((e) => e.chat_session_id !== id);
  const markRecent = (starred: boolean) =>
    lists.recent.map((e) => (e.chat_session_id === id ? { ...e, starred } : e));

  if ("starred" in change) {
    if (change.starred) {
      return {
        ...lists,
        recent: markRecent(true),
        starred: [{ ...entry, starred: true }, ...without(lists.starred)],
      };
    }
    return { ...lists, recent: markRecent(false), starred: without(lists.starred) };
  }

  if (change.dismissed) {
    return {
      recent: without(lists.recent),
      starred: without(lists.starred),
      dismissed: [{ ...entry, starred: false }, ...without(lists.dismissed)],
    };
  }
  return {
    ...lists,
    recent: [...without(lists.recent), { ...entry, starred: false }].sort(byUpdatedDesc),
    dismissed: without(lists.dismissed),
  };
}

async function putTriage(chatSessionId: string, change: TriageChange): Promise<void> {
  const token = await AuthService.getAdminIdToken();
  const res = await fetch(
    `${import.meta.env.VITE_API_ENDPOINT}/admin/feedback/${encodeURIComponent(chatSessionId)}`,
    {
      method: "PUT",
      headers: { Authorization: token, "Content-Type": "application/json" },
      body: JSON.stringify(change),
    }
  );
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
}

/**
 * Shared (all-admin) star / dismiss state for feedback comments. Updates are
 * optimistic and rolled back if the request fails.
 */
export function useFeedbackTriage(initial: FeedbackLists) {
  const [lists, setLists] = useState<FeedbackLists>(initial);
  const [pending, setPending] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const listsRef = useRef(lists);
  listsRef.current = lists;

  // New analytics data (range change or refetch) replaces local state.
  useEffect(() => {
    setLists(initial);
    setError(null);
  }, [initial]);

  const update = useCallback(async (entry: FeedbackEntry, change: TriageChange) => {
    const id = entry.chat_session_id;
    const snapshot = listsRef.current;
    setError(null);
    setLists(applyTriage(snapshot, entry, change));
    if (isDemoMode) return;

    setPending((p) => new Set(p).add(id));
    try {
      await putTriage(id, change);
    } catch {
      console.error("Error updating feedback triage");
      setLists(snapshot);
      setError("Couldn't save that change. Please try again.");
    } finally {
      setPending((p) => {
        const next = new Set(p);
        next.delete(id);
        return next;
      });
    }
  }, []);

  const isStarred = useCallback(
    (id: string) => lists.starred.some((e) => e.chat_session_id === id),
    [lists.starred]
  );
  const isDismissed = useCallback(
    (id: string) => lists.dismissed.some((e) => e.chat_session_id === id),
    [lists.dismissed]
  );

  return {
    lists,
    error,
    isPending: (id: string) => pending.has(id),
    isStarred,
    isDismissed,
    setStarred: (entry: FeedbackEntry, starred: boolean) => update(entry, { starred }),
    setDismissed: (entry: FeedbackEntry, dismissed: boolean) => update(entry, { dismissed }),
  };
}
