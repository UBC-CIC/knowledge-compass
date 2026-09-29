import { useEffect, useId, useState } from "react";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  FEEDBACK_COMMENT_MAX_LENGTH,
  useSessionFeedback,
  type FeedbackRating,
} from "@/hooks/useSessionFeedback";

type ConversationFeedbackProps = {
  sessionId: string;
  userId: string | null;
};

const RATING_OPTIONS: {
  value: FeedbackRating;
  label: string;
  Icon: typeof ThumbsUp;
}[] = [
  { value: "up", label: "Helpful", Icon: ThumbsUp },
  { value: "down", label: "Not helpful", Icon: ThumbsDown },
];

export default function ConversationFeedback({
  sessionId,
  userId,
}: ConversationFeedbackProps) {
  const { feedback, isLoading, isSaving, error, saveFeedback } =
    useSessionFeedback(sessionId, userId);

  const [draftComment, setDraftComment] = useState("");
  const [isCommentOpen, setIsCommentOpen] = useState(false);
  const [commentSent, setCommentSent] = useState(false);
  const commentId = useId();
  const hintId = useId();

  const savedComment = feedback?.comment ?? null;

  // Sync local draft with whatever was previously saved for this session.
  useEffect(() => {
    setDraftComment(savedComment ?? "");
    setCommentSent(Boolean(savedComment));
    setIsCommentOpen(false);
  }, [sessionId, savedComment]);

  const handleRate = async (rating: FeedbackRating) => {
    if (isSaving) return;
    const saved = await saveFeedback({
      rating,
      comment: feedback?.comment ?? null,
    });
    if (saved && !feedback?.comment) setIsCommentOpen(true);
  };

  const handleSubmitComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!feedback || isSaving) return;
    const saved = await saveFeedback({
      rating: feedback.rating,
      comment: draftComment,
    });
    if (saved) {
      setIsCommentOpen(false);
      setCommentSent(Boolean(draftComment.trim()));
    }
  };

  if (isLoading) return null;

  return (
    <section
      aria-label="Conversation feedback"
      className="rounded-[13px] border border-foreground/12 bg-white px-[18px] py-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[14.5px] font-semibold">
          {feedback ? "Thanks for letting us know." : "Was this conversation helpful?"}
        </p>
        <div className="flex gap-2" role="group" aria-label="Rate this conversation">
          {RATING_OPTIONS.map(({ value, label, Icon }) => {
            const selected = feedback?.rating === value;
            return (
              <button
                key={value}
                type="button"
                onClick={() => void handleRate(value)}
                disabled={isSaving}
                aria-pressed={selected}
                aria-label={label}
                title={label}
                className={cn(
                  "flex size-11 items-center justify-center rounded-[9px] border transition-colors disabled:opacity-60",
                  selected
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-foreground/20 bg-white hover:border-primary hover:bg-accent"
                )}
              >
                <Icon className="h-5 w-5" aria-hidden="true" />
              </button>
            );
          })}
        </div>
      </div>

      {feedback && !isCommentOpen ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 text-[13.5px] text-foreground/75">
          {commentSent ? <span>Your comment was sent.</span> : null}
          <button
            type="button"
            onClick={() => setIsCommentOpen(true)}
            className="font-semibold text-primary underline-offset-2 hover:underline"
          >
            {commentSent ? "Edit comment" : "Add a comment"}
          </button>
        </div>
      ) : null}

      {feedback && isCommentOpen ? (
        <form onSubmit={handleSubmitComment} className="mt-3 flex flex-col gap-2">
          <label htmlFor={commentId} className="text-[13.5px] font-semibold">
            Tell us more (optional)
          </label>
          <textarea
            id={commentId}
            aria-describedby={hintId}
            value={draftComment}
            onChange={(e) => setDraftComment(e.target.value)}
            maxLength={FEEDBACK_COMMENT_MAX_LENGTH}
            rows={3}
            className="w-full resize-y rounded-[9px] border-[1.5px] border-foreground/20 bg-white px-3 py-2 text-[14.5px] leading-normal focus:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
            placeholder="What worked well, or what could be better?"
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p id={hintId} className="text-xs text-foreground/70">
              Please don't include names or personal details.{" "}
              {draftComment.length}/{FEEDBACK_COMMENT_MAX_LENGTH}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setDraftComment(feedback.comment ?? "");
                  setIsCommentOpen(false);
                }}
                className="min-h-11 rounded-[9px] px-[15px] text-[14.5px] font-medium text-foreground/80 hover:bg-accent"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSaving}
                className="min-h-11 rounded-[9px] bg-primary px-[15px] text-[14.5px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-60"
              >
                {isSaving ? "Sending…" : "Send feedback"}
              </button>
            </div>
          </div>
        </form>
      ) : null}

      {error ? (
        <p role="alert" className="mt-2 text-[13.5px] text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
