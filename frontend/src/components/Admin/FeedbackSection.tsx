import { useMemo, useRef, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  ChevronRight,
  EyeOff,
  Inbox,
  MessageSquareText,
  Star,
  ThumbsDown,
  ThumbsUp,
  Undo2,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ChartCard, CustomTooltip } from "@/components/Admin/analyticsCharts";
import { AuthService } from "@/functions/authService";
import { isDemoMode } from "@/lib/demo";
import { cn } from "@/lib/utils";
import {
  useFeedbackTriage,
  type FeedbackEntry,
  type FeedbackLists,
} from "@/hooks/useFeedbackTriage";

// ------------------------------------------------------------------
// Types and constants
// ------------------------------------------------------------------

export type FeedbackSeriesPoint = {
  date: string;
  thumbs_up?: number;
  thumbs_down?: number;
};

export type FeedbackSectionData = {
  timeSeries: FeedbackSeriesPoint[];
  totals?: { thumbs_up?: number; thumbs_down?: number };
  recentFeedback?: FeedbackEntry[];
  starredFeedback?: FeedbackEntry[];
  dismissedFeedback?: FeedbackEntry[];
};

/** The assistant reply a piece of feedback was left on. */
type RatedMessage = {
  id: string;
  sender: string;
  content: string;
  created_at: string;
};

type RatedMessageResponse = {
  message: RatedMessage | null;
  // True for older feedback saved before the reply was linked.
  inferred: boolean;
};

type FeedbackTab = keyof FeedbackLists;
type RatingFilter = "all" | "up" | "down";

const POSITIVE = "oklch(0.55 0.13 150)";
const NEGATIVE = "oklch(0.58 0.16 30)";

const FEEDBACK_TABS: Array<{
  id: FeedbackTab;
  label: string;
  description: string;
  empty: string;
}> = [
  {
    id: "recent",
    label: "Recent",
    description: "Latest written feedback in this range (up to 50).",
    empty: "No written feedback in this range yet.",
  },
  {
    id: "starred",
    label: "Starred",
    description: "Starred by any admin, from any date (up to 100).",
    empty: "Nothing starred yet. Star a comment to keep it here.",
  },
  {
    id: "dismissed",
    label: "Dismissed",
    description: "Dismissed in this range (up to 50). Their ratings still count in the totals.",
    empty: "No dismissed feedback in this range.",
  },
];

const RATING_FILTERS: Array<{ id: RatingFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "up", label: "Helpful" },
  { id: "down", label: "Not helpful" },
];

// ------------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------------

const relativeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const RELATIVE_STEPS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["second", 60],
  ["minute", 60],
  ["hour", 24],
  ["day", 7],
  ["week", 4.35],
  ["month", 12],
  ["year", Number.POSITIVE_INFINITY],
];

/** "3 days ago", "last week", ... */
function relativeTime(iso: string): string {
  let value = (new Date(iso).getTime() - Date.now()) / 1000;
  for (const [unit, size] of RELATIVE_STEPS) {
    if (Math.abs(value) < size) return relativeFormatter.format(Math.round(value), unit);
    value /= size;
  }
  return new Date(iso).toLocaleDateString();
}

function RatingIcon({ rating, className }: { rating: "up" | "down"; className?: string }) {
  const Icon = rating === "up" ? ThumbsUp : ThumbsDown;
  return <Icon className={className} style={{ color: rating === "up" ? POSITIVE : NEGATIVE }} aria-hidden="true" />;
}

function RatingPill({ rating }: { rating: "up" | "down" }) {
  const up = rating === "up";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[12px] font-semibold",
        up
          ? "bg-[oklch(0.55_0.13_150)]/12 text-[oklch(0.42_0.11_150)]"
          : "bg-[oklch(0.58_0.16_30)]/12 text-[oklch(0.46_0.14_30)]"
      )}
    >
      <RatingIcon rating={rating} className="h-3.5 w-3.5" />
      {up ? "Helpful" : "Not helpful"}
    </span>
  );
}

// ------------------------------------------------------------------
// Star / dismiss / restore controls
// ------------------------------------------------------------------

type TriageActionsProps = {
  starred: boolean;
  dismissed: boolean;
  disabled: boolean;
  onStar: (starred: boolean) => void;
  onDismiss: (dismissed: boolean) => void;
  /** "icon" for list rows, "labeled" for the review dialog. */
  variant?: "icon" | "labeled";
};

function TriageActions({
  starred,
  dismissed,
  disabled,
  onStar,
  onDismiss,
  variant = "icon",
}: TriageActionsProps) {
  const labeled = variant === "labeled";
  const size = labeled ? "sm" : "icon-sm";
  const buttonVariant = labeled ? "outline" : "ghost";
  const iconOnly = labeled ? "" : "text-foreground/55 hover:text-foreground";

  if (dismissed) {
    return (
      <Button
        type="button"
        variant={buttonVariant}
        size={size}
        className={iconOnly}
        disabled={disabled}
        onClick={() => onDismiss(false)}
        aria-label={labeled ? undefined : "Restore this feedback to Recent"}
        title="Restore to Recent"
      >
        <Undo2 aria-hidden="true" />
        {labeled && "Restore"}
      </Button>
    );
  }

  return (
    <>
      <Button
        type="button"
        variant={buttonVariant}
        size={size}
        className={cn(iconOnly, starred && "text-amber-600 hover:text-amber-700")}
        disabled={disabled}
        onClick={() => onStar(!starred)}
        aria-pressed={starred}
        aria-label={labeled ? undefined : starred ? "Unstar this feedback" : "Star this feedback"}
        title={starred ? "Unstar" : "Star"}
      >
        <Star className={cn(starred && "fill-amber-400 text-amber-500")} aria-hidden="true" />
        {labeled && (starred ? "Starred" : "Star")}
      </Button>
      <Button
        type="button"
        variant={buttonVariant}
        size={size}
        className={iconOnly}
        disabled={disabled}
        onClick={() => onDismiss(true)}
        aria-label={labeled ? undefined : "Dismiss this feedback"}
        title="Dismiss"
      >
        <EyeOff aria-hidden="true" />
        {labeled && "Dismiss"}
      </Button>
    </>
  );
}

// ------------------------------------------------------------------
// Rating summary
// ------------------------------------------------------------------

function RatingSummary({ up, down }: { up: number; down: number }) {
  const total = up + down;
  const upPct = total > 0 ? Math.round((up / total) * 100) : 0;

  return (
    <Card className="rounded-[13px] border-foreground/12 shadow-sm">
      <CardHeader className="border-b border-foreground/10 pb-3">
        <CardTitle className="text-base font-bold tracking-[-0.005em] text-foreground">
          Rating summary
        </CardTitle>
        <CardDescription className="text-[13px]">
          {total > 0
            ? `${total} rated conversation${total === 1 ? "" : "s"} in this range`
            : "No ratings in this range yet"}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex h-[300px] flex-col justify-center gap-6 p-6">
        <div>
          <div className="flex items-baseline gap-2">
            <span className="font-serif text-5xl font-semibold leading-none tracking-[-0.02em]">
              {total > 0 ? `${upPct}%` : "—"}
            </span>
            <span className="text-[13.5px] font-semibold text-foreground/70">positive</span>
          </div>
          <div
            className="mt-4 flex h-2.5 overflow-hidden rounded-full bg-foreground/[0.08]"
            role="img"
            aria-label={
              total > 0
                ? `${up} helpful and ${down} not helpful ratings`
                : "No ratings yet"
            }
          >
            {total > 0 && (
              <>
                <div style={{ width: `${upPct}%`, backgroundColor: POSITIVE }} />
                <div style={{ width: `${100 - upPct}%`, backgroundColor: NEGATIVE }} />
              </>
            )}
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-3">
          {(
            [
              ["up", "Helpful", up],
              ["down", "Not helpful", down],
            ] as const
          ).map(([rating, label, count]) => (
            <div
              key={rating}
              className="rounded-[10px] border border-foreground/10 bg-foreground/[0.02] px-3.5 py-3"
            >
              <dt className="flex items-center gap-1.5 text-[12.5px] font-semibold text-foreground/70">
                <RatingIcon rating={rating} className="h-3.5 w-3.5" />
                {label}
              </dt>
              <dd className="mt-1 font-serif text-2xl font-semibold leading-none">{count}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

// ------------------------------------------------------------------
// Section
// ------------------------------------------------------------------

export default function FeedbackSection({ data }: { data: FeedbackSectionData }) {
  const up = data.totals?.thumbs_up ?? 0;
  const down = data.totals?.thumbs_down ?? 0;

  const initialLists = useMemo<FeedbackLists>(
    () => ({
      recent: data.recentFeedback ?? [],
      starred: data.starredFeedback ?? [],
      dismissed: data.dismissedFeedback ?? [],
    }),
    [data.recentFeedback, data.starredFeedback, data.dismissedFeedback]
  );
  const triage = useFeedbackTriage(initialLists);

  const [activeTab, setActiveTab] = useState<FeedbackTab>("recent");
  const [ratingFilter, setRatingFilter] = useState<RatingFilter>("all");
  const tabRefs = useRef<Record<FeedbackTab, HTMLButtonElement | null>>({
    recent: null,
    starred: null,
    dismissed: null,
  });
  const activeTabInfo = FEEDBACK_TABS.find((t) => t.id === activeTab)!;
  const tabComments = triage.lists[activeTab];
  const comments =
    ratingFilter === "all" ? tabComments : tabComments.filter((e) => e.rating === ratingFilter);

  const onTabKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const index = FEEDBACK_TABS.findIndex((t) => t.id === activeTab);
    const step = e.key === "ArrowRight" ? 1 : -1;
    const next = FEEDBACK_TABS[(index + step + FEEDBACK_TABS.length) % FEEDBACK_TABS.length].id;
    setActiveTab(next);
    tabRefs.current[next]?.focus();
  };

  // --- Review dialog ---------------------------------------------------------

  const [selectedFeedback, setSelectedFeedback] = useState<FeedbackEntry | null>(null);
  const [rated, setRated] = useState<RatedMessageResponse | null>(null);
  const [ratedLoading, setRatedLoading] = useState(false);
  const [ratedError, setRatedError] = useState<string | null>(null);
  // Ignores a slow response if another comment was opened meanwhile.
  const openedIdRef = useRef<string | null>(null);

  const closeFeedback = () => {
    openedIdRef.current = null;
    setSelectedFeedback(null);
    setRated(null);
    setRatedError(null);
    setRatedLoading(false);
  };

  const openFeedback = async (entry: FeedbackEntry) => {
    const id = entry.chat_session_id;
    openedIdRef.current = id;
    setSelectedFeedback(entry);
    setRated(null);
    setRatedError(null);

    if (isDemoMode) {
      setRated({
        inferred: false,
        message: {
          id: "demo-msg-2",
          sender: "AI",
          content:
            "Yes. A reduced schedule should be a short-term, collaborative plan. Here are steps you can take and questions to bring to the school.",
          created_at: entry.updated_at,
        },
      });
      return;
    }

    try {
      setRatedLoading(true);
      const token = await AuthService.getAdminIdToken();
      // Only the rated reply is fetched, not the whole conversation.
      const res = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/admin/feedback/${encodeURIComponent(id)}/message`,
        { headers: { Authorization: token, "Content-Type": "application/json" } }
      );
      if (!res.ok) throw new Error("Failed to load rated message");
      const body: RatedMessageResponse = await res.json();
      if (openedIdRef.current === id) setRated(body);
    } catch {
      console.error("Error fetching rated message for feedback");
      if (openedIdRef.current === id) {
        setRatedError("Failed to load the reply this feedback was left on.");
      }
    } finally {
      if (openedIdRef.current === id) setRatedLoading(false);
    }
  };

  const selectedId = selectedFeedback?.chat_session_id ?? null;

  return (
    <section className="space-y-4" aria-labelledby="feedback-heading">
      <div>
        <h2 id="feedback-heading" className="font-serif text-[22px] font-semibold tracking-[-0.01em]">
          User feedback
        </h2>
        <p className="mt-1 text-[14px] text-foreground/70">
          How families rated their conversations, and what they told us.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <RatingSummary up={up} down={down} />

        <ChartCard title="Ratings over time" subtitle="Helpful and not helpful ratings per day">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data.timeSeries} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
              <XAxis
                dataKey="date"
                axisLine={false}
                tickLine={false}
                tick={{ fontSize: 12, fill: "#6b7280" }}
                dy={10}
              />
              <YAxis
                axisLine={false}
                tickLine={false}
                allowDecimals={false}
                tick={{ fontSize: 12, fill: "#6b7280" }}
              />
              <Tooltip content={<CustomTooltip />} />
              <Line
                type="monotone"
                dataKey="thumbs_up"
                name="Helpful"
                stroke={POSITIVE}
                strokeWidth={3}
                dot={false}
                activeDot={{ r: 6, strokeWidth: 0 }}
              />
              <Line
                type="monotone"
                dataKey="thumbs_down"
                name="Not helpful"
                stroke={NEGATIVE}
                strokeWidth={3}
                strokeDasharray="6 4"
                dot={false}
                activeDot={{ r: 6, strokeWidth: 0 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* Comments */}
      <Card className="gap-0 overflow-hidden rounded-[13px] border-foreground/12 py-0 shadow-sm">
        <CardHeader className="gap-0 border-b border-foreground/10 px-5 pb-0 pt-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle className="text-base font-bold tracking-[-0.005em] text-foreground">
                Comments
              </CardTitle>
              <CardDescription className="mt-1 text-[13px]">{activeTabInfo.description}</CardDescription>
            </div>
            <div
              role="group"
              aria-label="Filter by rating"
              className="flex w-fit shrink-0 rounded-[10px] border border-foreground/14 bg-white p-1 text-[12.5px] font-semibold"
            >
              {RATING_FILTERS.map((f) => {
                const selected = f.id === ratingFilter;
                return (
                  <button
                    key={f.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setRatingFilter(f.id)}
                    className={cn(
                      "flex items-center gap-1.5 rounded-md px-2.5 py-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                      selected
                        ? "bg-secondary text-secondary-foreground"
                        : "text-foreground/65 hover:text-foreground"
                    )}
                  >
                    {f.id !== "all" && <RatingIcon rating={f.id} className="h-3.5 w-3.5" />}
                    {f.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div role="tablist" aria-label="Feedback comments" className="mt-3 flex gap-5">
            {FEEDBACK_TABS.map((tab) => {
              const selected = tab.id === activeTab;
              const count = triage.lists[tab.id].length;
              return (
                <button
                  key={tab.id}
                  ref={(el) => {
                    tabRefs.current[tab.id] = el;
                  }}
                  type="button"
                  role="tab"
                  id={`feedback-tab-${tab.id}`}
                  aria-selected={selected}
                  aria-controls="feedback-tabpanel"
                  tabIndex={selected ? 0 : -1}
                  onClick={() => setActiveTab(tab.id)}
                  onKeyDown={onTabKeyDown}
                  className={cn(
                    "-mb-px flex items-center gap-2 border-b-2 pb-2.5 pt-1 text-[13.5px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                    selected
                      ? "border-primary text-foreground"
                      : "border-transparent text-foreground/60 hover:text-foreground"
                  )}
                >
                  {tab.id === "starred" && (
                    <Star
                      className={cn("h-3.5 w-3.5", selected && "fill-amber-400 text-amber-500")}
                      aria-hidden="true"
                    />
                  )}
                  {tab.label}
                  <span
                    className={cn(
                      "min-w-[22px] rounded-full px-1.5 py-px text-center text-[11.5px] tabular-nums",
                      selected ? "bg-primary text-primary-foreground" : "bg-foreground/[0.07] text-foreground/70"
                    )}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
        </CardHeader>

        {triage.error && (
          <p role="alert" className="border-b border-red-200 bg-red-50 px-5 py-2 text-[12.5px] text-red-700">
            {triage.error}
          </p>
        )}

        <CardContent
          id="feedback-tabpanel"
          role="tabpanel"
          aria-labelledby={`feedback-tab-${activeTab}`}
          className="max-h-[460px] min-h-[200px] overflow-y-auto p-0"
        >
          {comments.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 px-5 py-14 text-center">
              <div className="flex h-11 w-11 items-center justify-center rounded-full bg-foreground/[0.05]">
                {activeTab === "starred" ? (
                  <Star className="h-5 w-5 text-foreground/45" aria-hidden="true" />
                ) : (
                  <Inbox className="h-5 w-5 text-foreground/45" aria-hidden="true" />
                )}
              </div>
              <p className="text-[13.5px] text-foreground/70">
                {tabComments.length > 0
                  ? `No ${ratingFilter === "up" ? "helpful" : "not helpful"} comments here.`
                  : activeTabInfo.empty}
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-foreground/[0.08]">
              {comments.map((entry) => {
                const starred = activeTab === "starred" || Boolean(entry.starred);
                return (
                  <li
                    key={entry.chat_session_id}
                    className="group flex items-start gap-1 pr-3 transition-colors hover:bg-foreground/[0.025]"
                  >
                    <button
                      type="button"
                      onClick={() => openFeedback(entry)}
                      className="flex min-w-0 flex-1 gap-3.5 py-4 pl-5 pr-2 text-left focus-visible:bg-foreground/[0.04] focus-visible:outline-none"
                      aria-label={`${entry.rating === "up" ? "Helpful" : "Not helpful"} feedback. View the reply it was left on`}
                    >
                      <span
                        className={cn(
                          "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
                          entry.rating === "up"
                            ? "bg-[oklch(0.55_0.13_150)]/12"
                            : "bg-[oklch(0.58_0.16_30)]/12"
                        )}
                      >
                        <RatingIcon rating={entry.rating} className="h-4 w-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="line-clamp-3 whitespace-pre-line break-words text-[14px] leading-relaxed text-foreground">
                          {entry.comment}
                        </span>
                        <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-foreground/60">
                          <time dateTime={entry.updated_at} title={new Date(entry.updated_at).toLocaleString()}>
                            {relativeTime(entry.updated_at)}
                          </time>
                          {activeTab === "recent" && starred && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-px font-semibold text-amber-700">
                              <Star className="h-3 w-3 fill-amber-400 text-amber-500" aria-hidden="true" />
                              Starred
                            </span>
                          )}
                          <span className="inline-flex items-center gap-0.5 font-semibold text-primary opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                            View reply
                            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                          </span>
                        </span>
                      </span>
                    </button>
                    <div className="flex shrink-0 gap-0.5 pt-3.5">
                      <TriageActions
                        starred={starred}
                        dismissed={activeTab === "dismissed"}
                        disabled={triage.isPending(entry.chat_session_id)}
                        onStar={(s) => triage.setStarred(entry, s)}
                        onDismiss={(d) => triage.setDismissed(entry, d)}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Review dialog: the comment and only the reply it was left on */}
      <Dialog
        open={selectedFeedback !== null}
        onOpenChange={(open) => {
          if (!open) closeFeedback();
        }}
      >
        <DialogContent className="max-h-[85vh] gap-0 overflow-hidden p-0 sm:max-w-2xl">
          <DialogHeader className="space-y-2 border-b border-foreground/10 p-5 pr-12 text-left">
            {selectedFeedback && <RatingPill rating={selectedFeedback.rating} />}
            <DialogTitle className="text-lg font-bold">Feedback review</DialogTitle>
            <DialogDescription className="text-[13px]">
              {selectedFeedback
                ? `Left ${relativeTime(selectedFeedback.updated_at)} · ${new Date(
                    selectedFeedback.updated_at
                  ).toLocaleString()}`
                : null}
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-[56vh] space-y-5 overflow-y-auto p-5">
            {selectedFeedback && (
              <figure>
                <figcaption className="mb-1.5 flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-wide text-foreground/55">
                  <MessageSquareText className="h-3.5 w-3.5" aria-hidden="true" />
                  Their comment
                </figcaption>
                <blockquote
                  className="whitespace-pre-line break-words border-l-[3px] py-1 pl-3.5 text-[15px] leading-relaxed text-foreground"
                  style={{ borderColor: selectedFeedback.rating === "up" ? POSITIVE : NEGATIVE }}
                >
                  {selectedFeedback.comment}
                </blockquote>
              </figure>
            )}

            <section aria-label="Reply that was rated">
              <p className="mb-1.5 text-[11.5px] font-semibold uppercase tracking-wide text-foreground/55">
                Reply that was rated
              </p>
              {ratedLoading ? (
                <div className="space-y-2 rounded-[12px] border border-foreground/10 p-4" role="status">
                  <span className="sr-only">Loading the rated reply</span>
                  <div className="h-3 w-3/4 animate-pulse rounded bg-foreground/[0.08]" />
                  <div className="h-3 w-full animate-pulse rounded bg-foreground/[0.08]" />
                  <div className="h-3 w-2/3 animate-pulse rounded bg-foreground/[0.08]" />
                </div>
              ) : ratedError ? (
                <p className="rounded-[12px] border border-red-200 bg-red-50 px-4 py-3 text-[13.5px] text-red-700">
                  {ratedError}
                </p>
              ) : !rated?.message ? (
                <p className="rounded-[12px] border border-dashed border-foreground/15 px-4 py-3 text-[13.5px] text-foreground/70">
                  The reply for this feedback couldn't be found.
                </p>
              ) : (
                <>
                  <div className="rounded-[12px] border border-foreground/10 bg-foreground/[0.03] px-4 py-3.5">
                    <p className="mb-1.5 text-[12px] font-semibold text-foreground/60">
                      Assistant · {new Date(rated.message.created_at).toLocaleString()}
                    </p>
                    <p className="whitespace-pre-line break-words text-[14px] leading-relaxed text-foreground">
                      {rated.message.content}
                    </p>
                  </div>
                  {rated.inferred && (
                    <p className="mt-2 text-xs text-foreground/60">
                      This feedback was left before replies were linked to ratings, so this is the
                      last reply sent before the feedback was saved.
                    </p>
                  )}
                </>
              )}
            </section>
          </div>

          {selectedFeedback && selectedId && (
            <div className="flex items-center justify-end gap-2 border-t border-foreground/10 bg-foreground/[0.02] px-5 py-3">
              <TriageActions
                variant="labeled"
                starred={triage.isStarred(selectedId)}
                dismissed={triage.isDismissed(selectedId)}
                disabled={triage.isPending(selectedId)}
                onStar={(s) => triage.setStarred(selectedFeedback, s)}
                onDismiss={(d) => triage.setDismissed(selectedFeedback, d)}
              />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
