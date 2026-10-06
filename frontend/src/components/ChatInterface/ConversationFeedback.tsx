import { useEffect, useId, useRef, useState } from "react";
import { ArrowUp, MessageSquare, ThumbsDown, ThumbsUp, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  FEEDBACK_COMMENT_MAX_LENGTH,
  type FeedbackRating,
  type SessionFeedback,
} from "@/hooks/useSessionFeedback";

type ConversationFeedbackProps = {
  feedback: SessionFeedback | null;
  isSaving: boolean;
  error: string | null;
  onSave: (next: SessionFeedback) => Promise<boolean>;
};

const RATING_OPTIONS: {
  value: FeedbackRating;
  label: string;
  Icon: typeof ThumbsUp;
}[] = [
  { value: "up", label: "Helpful", Icon: ThumbsUp },
  { value: "down", label: "Not helpful", Icon: ThumbsDown },
];

/**
 * Compact feedback row rendered as the footer of the latest assistant reply.
 * Presentational only; loading/saving lives in useSessionFeedback.
 */
export default function ConversationFeedback({
  feedback,
  isSaving,
  error,
  onSave,
}: ConversationFeedbackProps) {
  const savedComment = feedback?.comment ?? null;
  const [draftComment, setDraftComment] = useState(savedComment ?? "");
  const [isCommentOpen, setIsCommentOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const commentId = useId();
  const hintId = useId();

  useEffect(() => {
    setDraftComment(savedComment ?? "");
  }, [savedComment]);

  useEffect(() => {
    if (isCommentOpen) textareaRef.current?.focus();
  }, [isCommentOpen]);

  // Grow the comment box with its content, up to a few lines.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [draftComment, isCommentOpen]);

  const handleRate = async (rating: FeedbackRating) => {
    if (isSaving || feedback?.rating === rating) return;
    const saved = await onSave({ rating, comment: savedComment });
    if (saved && !savedComment) setIsCommentOpen(true);
  };

  const closeComment = () => {
    setDraftComment(savedComment ?? "");
    setIsCommentOpen(false);
  };

  const submitComment = async () => {
    if (!feedback || isSaving) return;
    const saved = await onSave({ rating: feedback.rating, comment: draftComment });
    if (saved) setIsCommentOpen(false);
  };

  const statusText = !feedback
    ? "Was this helpful?"
    : savedComment
    ? "Thanks, your feedback was sent."
    : "Thanks for your feedback.";

  return (
    <div aria-label="Conversation feedback" role="region">
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        <span className="mr-1 text-[13px] text-foreground/65" aria-live="polite">
          {statusText}
        </span>

        <div className="flex items-center" role="group" aria-label="Rate this conversation">
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
                  "flex size-8 items-center justify-center rounded-full transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                  "disabled:cursor-default disabled:opacity-60",
                  selected
                    ? "text-primary"
                    : "text-foreground/50 hover:bg-foreground/[0.06] hover:text-foreground/80"
                )}
              >
                <Icon
                  className="h-4 w-4"
                  fill={selected ? "currentColor" : "none"}
                  strokeWidth={selected ? 1.75 : 2}
                  aria-hidden="true"
                />
              </button>
            );
          })}
        </div>

        {feedback && !isCommentOpen ? (
          <button
            type="button"
            onClick={() => setIsCommentOpen(true)}
            className="ml-0.5 flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[13px] text-foreground/60 transition-colors hover:bg-foreground/[0.06] hover:text-foreground/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
            {savedComment ? "Edit comment" : "Add a comment"}
          </button>
        ) : null}
      </div>

      {feedback && isCommentOpen ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submitComment();
          }}
          className="mt-2 animate-in fade-in slide-in-from-top-1 duration-200 motion-reduce:animate-none"
        >
          <label htmlFor={commentId} className="sr-only">
            Tell us more (optional)
          </label>
          <div className="flex items-end gap-1.5 rounded-[12px] border border-foreground/15 bg-white py-1.5 pl-3 pr-1.5 transition-colors focus-within:border-primary/60 focus-within:ring-2 focus-within:ring-primary/15">
            <textarea
              ref={textareaRef}
              id={commentId}
              aria-describedby={hintId}
              value={draftComment}
              onChange={(e) => setDraftComment(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void submitComment();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  closeComment();
                }
              }}
              maxLength={FEEDBACK_COMMENT_MAX_LENGTH}
              rows={1}
              placeholder="Tell us more (optional)"
              className="max-h-[140px] min-h-[32px] flex-1 resize-none bg-transparent py-1 text-[14px] leading-normal placeholder:text-foreground/45 focus:outline-none"
            />
            <button
              type="button"
              onClick={closeComment}
              aria-label="Cancel comment"
              title="Cancel"
              className="flex size-8 shrink-0 items-center justify-center rounded-full text-foreground/50 transition-colors hover:bg-foreground/[0.06] hover:text-foreground/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
            <button
              type="submit"
              disabled={isSaving}
              aria-label={isSaving ? "Sending comment" : "Send comment"}
              title="Send"
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-60"
            >
              <ArrowUp className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          <p id={hintId} className="mt-1.5 flex justify-between gap-3 px-1 text-[11.5px] text-foreground/55">
            <span>Please don't include names or personal details.</span>
            <span aria-hidden="true">
              {draftComment.length}/{FEEDBACK_COMMENT_MAX_LENGTH}
            </span>
          </p>
        </form>
      ) : null}

      {error ? (
        <p role="alert" className="mt-1.5 px-1 text-[12.5px] text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
