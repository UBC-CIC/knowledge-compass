import { useCallback, useEffect, useState } from "react";
import { isDemoMode } from "@/lib/demo";
import { getPublicToken } from "@/lib/publicToken";
import { API_ENDPOINT } from "@/lib/api";

export type FeedbackRating = "up" | "down";

export type SessionFeedback = {
  rating: FeedbackRating;
  comment: string | null;
};

export const FEEDBACK_COMMENT_MAX_LENGTH = 1000;

// Demo mode keeps feedback in memory only, keyed by session id.
const demoFeedbackStore = new Map<string, SessionFeedback>();

function feedbackUrl(sessionId: string, userId: string): string {
  const url = new URL(
    `${API_ENDPOINT}/chat_sessions/${encodeURIComponent(sessionId)}/feedback`
  );
  url.searchParams.set("user_id", userId);
  return url.toString();
}

/**
 * Loads and saves the end-of-conversation feedback (thumbs up/down plus an
 * optional comment) for one chat session owned by the anonymous user.
 */
export function useSessionFeedback(
  sessionId: string | null,
  userId: string | null
) {
  const [feedback, setFeedback] = useState<SessionFeedback | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setFeedback(null);
    setError(null);

    if (!sessionId || !userId) return;

    if (isDemoMode) {
      setFeedback(demoFeedbackStore.get(sessionId) ?? null);
      return;
    }

    let isActive = true;
    setIsLoading(true);

    (async () => {
      try {
        const token = await getPublicToken();
        const response = await fetch(feedbackUrl(sessionId, userId), {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok) throw new Error("Failed to load feedback");
        const data: { feedback: SessionFeedback | null } = await response.json();
        if (isActive) setFeedback(data.feedback ?? null);
      } catch (err) {
        // Not fatal: the user can still leave feedback.
        if (isActive) console.error("Failed to load session feedback:", err);
      } finally {
        if (isActive) setIsLoading(false);
      }
    })();

    return () => {
      isActive = false;
    };
  }, [sessionId, userId]);

  const saveFeedback = useCallback(
    async (next: SessionFeedback): Promise<boolean> => {
      if (!sessionId || !userId) return false;

      const payload: SessionFeedback = {
        rating: next.rating,
        comment: next.comment?.trim()
          ? next.comment.trim().slice(0, FEEDBACK_COMMENT_MAX_LENGTH)
          : null,
      };

      setError(null);

      if (isDemoMode) {
        demoFeedbackStore.set(sessionId, payload);
        setFeedback(payload);
        return true;
      }

      setIsSaving(true);
      try {
        const token = await getPublicToken();
        const response = await fetch(feedbackUrl(sessionId, userId), {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });
        if (!response.ok) throw new Error("Failed to save feedback");
        setFeedback(payload);
        return true;
      } catch (err) {
        console.error("Failed to save session feedback:", err);
        setError("We couldn't save your feedback. Please try again.");
        return false;
      } finally {
        setIsSaving(false);
      }
    },
    [sessionId, userId]
  );

  return { feedback, isLoading, isSaving, error, saveFeedback };
}
