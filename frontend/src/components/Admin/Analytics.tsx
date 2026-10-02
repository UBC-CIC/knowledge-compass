import { useState, useEffect, useMemo, useRef } from "react";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { AuthService } from "@/functions/authService";
import { EyeOff, Star, ThumbsDown, ThumbsUp, Undo2 } from "lucide-react";
import MetricCard from "@/components/Admin/MetricCard";
import {
  DEMO_ANALYTICS_SERIES,
  DEMO_DISMISSED_FEEDBACK,
  DEMO_RECENT_FEEDBACK,
  DEMO_STARRED_FEEDBACK,
  isDemoMode,
} from "@/lib/demo";
import {
  useFeedbackTriage,
  type FeedbackEntry,
  type FeedbackLists,
} from "@/hooks/useFeedbackTriage";

type TimeSeriesData = {
  date: string;
  users: number;
  chat_sessions: number;
  questions: number;
  thumbs_up?: number;
  thumbs_down?: number;
};

type AnalyticsTotals = {
  users?: number;
  chat_sessions?: number;
  messages?: number;
  questions?: number;
  thumbs_up?: number;
  thumbs_down?: number;
};

type ConversationMessage = {
  id: string;
  chat_session_id: string;
  sender: string;
  content: string;
  created_at: string;
};

type AnalyticsData = {
  timeSeries: TimeSeriesData[];
  totals?: AnalyticsTotals;
  recentFeedback?: FeedbackEntry[];
  starredFeedback?: FeedbackEntry[];
  dismissedFeedback?: FeedbackEntry[];
};

type FeedbackTab = keyof FeedbackLists;

const FEEDBACK_TABS: Array<{
  id: FeedbackTab;
  label: string;
  description: string;
  empty: string;
}> = [
  {
    id: "recent",
    label: "Recent",
    description: "Latest written feedback in this range (up to 50)",
    empty: "No written feedback in this range yet.",
  },
  {
    id: "starred",
    label: "Starred",
    description: "Starred by any admin, from any date (up to 100)",
    empty: "Nothing starred yet. Star a comment to keep it here.",
  },
  {
    id: "dismissed",
    label: "Dismissed",
    description: "Dismissed in this range (up to 50). Ratings still count in totals",
    empty: "No dismissed feedback in this range.",
  },
];

const iconButtonClass =
  "inline-flex h-8 w-8 items-center justify-center rounded-md text-foreground/60 transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50";

type TriageActionsProps = {
  starred: boolean;
  dismissed: boolean;
  disabled: boolean;
  onStar: (starred: boolean) => void;
  onDismiss: (dismissed: boolean) => void;
};

function TriageActions({
  starred,
  dismissed,
  disabled,
  onStar,
  onDismiss,
}: TriageActionsProps) {
  if (dismissed) {
    return (
      <button
        type="button"
        className={iconButtonClass}
        disabled={disabled}
        onClick={() => onDismiss(false)}
        aria-label="Restore this feedback to Recent"
        title="Restore"
      >
        <Undo2 className="h-4 w-4" aria-hidden="true" />
      </button>
    );
  }
  return (
    <>
      <button
        type="button"
        className={iconButtonClass}
        disabled={disabled}
        onClick={() => onStar(!starred)}
        aria-pressed={starred}
        aria-label={starred ? "Unstar this feedback" : "Star this feedback"}
        title={starred ? "Unstar" : "Star"}
      >
        <Star
          className={`h-4 w-4 ${starred ? "fill-amber-400 text-amber-500" : ""}`}
          aria-hidden="true"
        />
      </button>
      <button
        type="button"
        className={iconButtonClass}
        disabled={disabled}
        onClick={() => onDismiss(true)}
        aria-label="Dismiss this feedback"
        title="Dismiss"
      >
        <EyeOff className="h-4 w-4" aria-hidden="true" />
      </button>
    </>
  );
}

type ChartCardProps = {
  title: string;
  subtitle: string;
  children: React.ReactNode;
};

function ChartCard({ title, subtitle, children }: ChartCardProps) {
  return (
    <Card className="overflow-hidden rounded-[13px] border-foreground/12 shadow-sm">
      <CardHeader className="border-b border-foreground/10 pb-3">
        <CardTitle className="text-base font-bold tracking-[-0.005em] text-foreground">
          {title}
        </CardTitle>
        <CardDescription className="text-[13px]">{subtitle}</CardDescription>
      </CardHeader>
      <CardContent className="h-[300px] p-5">{children}</CardContent>
    </Card>
  );
}

function CustomTooltip({ active, payload, label }: any) {
  if (active && payload && payload.length) {
    return (
      <div className="bg-white border border-gray-200 p-3 rounded-lg shadow-xl text-sm">
        <p className="font-semibold text-gray-900 mb-2">{label}</p>
        {payload.map((entry: any, index: number) => (
          <div
            key={index}
            className="flex items-center gap-2 text-xs text-gray-600 mb-1"
          >
            <div
              className="w-2 h-2 rounded-full"
              style={{ backgroundColor: entry.color || entry.fill }}
            />
            <span className="capitalize">{entry.name}:</span>
            <span className="font-bold text-gray-900">{entry.value}</span>
          </div>
        ))}
      </div>
    );
  }
  return null;
}

function FeedbackSection({ data }: { data: AnalyticsData }) {
  const up = data.totals?.thumbs_up ?? 0;
  const down = data.totals?.thumbs_down ?? 0;
  const total = up + down;
  const positive = total > 0 ? `${Math.round((up / total) * 100)}%` : "—";

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
  const tabRefs = useRef<Record<FeedbackTab, HTMLButtonElement | null>>({
    recent: null,
    starred: null,
    dismissed: null,
  });
  const activeTabInfo = FEEDBACK_TABS.find((t) => t.id === activeTab)!;
  const comments = triage.lists[activeTab];

  const onTabKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const index = FEEDBACK_TABS.findIndex((t) => t.id === activeTab);
    const step = e.key === "ArrowRight" ? 1 : -1;
    const next = FEEDBACK_TABS[(index + step + FEEDBACK_TABS.length) % FEEDBACK_TABS.length].id;
    setActiveTab(next);
    tabRefs.current[next]?.focus();
  };

  const [selectedFeedback, setSelectedFeedback] = useState<FeedbackEntry | null>(
    null
  );
  const [conversation, setConversation] = useState<ConversationMessage[]>([]);
  const [conversationLoading, setConversationLoading] = useState(false);
  const [conversationError, setConversationError] = useState<string | null>(null);

  const openFeedback = async (entry: FeedbackEntry) => {
    setSelectedFeedback(entry);
    setConversation([]);
    setConversationError(null);

    if (isDemoMode) {
      setConversation([
        {
          id: "demo-msg-1",
          chat_session_id: entry.chat_session_id,
          sender: "user",
          content: "Can I ask the school for a reduced schedule for my child?",
          created_at: entry.updated_at,
        },
        {
          id: "demo-msg-2",
          chat_session_id: entry.chat_session_id,
          sender: "bot",
          content:
            "Yes. A reduced schedule should be a short-term, collaborative plan. Here are steps you can take and questions to bring to the school.",
          created_at: entry.updated_at,
        },
      ]);
      return;
    }

    try {
      setConversationLoading(true);
      const token = await AuthService.getAdminIdToken();
      const res = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/admin/chat_sessions/${entry.chat_session_id}/messages`,
        {
          headers: {
            Authorization: token,
            "Content-Type": "application/json",
          },
        }
      );
      if (!res.ok) throw new Error("Failed to load conversation");
      const rows: ConversationMessage[] = await res.json();
      setConversation(rows);
    } catch {
      console.error("Error fetching conversation for feedback");
      setConversationError("Failed to load the conversation for this feedback.");
    } finally {
      setConversationLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <h2 className="font-serif text-[22px] font-semibold tracking-[-0.01em]">
        User feedback
      </h2>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <MetricCard
          title="Thumbs up"
          value={String(up)}
          trend="Conversations rated helpful"
        />
        <MetricCard
          title="Thumbs down"
          value={String(down)}
          trend="Conversations rated not helpful"
        />
        <MetricCard
          title="Positive rating"
          value={positive}
          trend={`Based on ${total} rated conversation${total === 1 ? "" : "s"}`}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title="Ratings over time" subtitle="Thumbs up and thumbs down per day">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={data.timeSeries}
              margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
            >
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
                name="Thumbs up"
                stroke="oklch(0.55 0.13 150)"
                strokeWidth={3}
                dot={false}
                activeDot={{ r: 6, strokeWidth: 0 }}
              />
              <Line
                type="monotone"
                dataKey="thumbs_down"
                name="Thumbs down"
                stroke="oklch(0.58 0.16 30)"
                strokeWidth={3}
                strokeDasharray="6 4"
                dot={false}
                activeDot={{ r: 6, strokeWidth: 0 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <Card className="overflow-hidden rounded-[13px] border-foreground/12 shadow-sm">
          <CardHeader className="space-y-3 border-b border-foreground/10 pb-3">
            <div>
              <CardTitle className="text-base font-bold tracking-[-0.005em] text-foreground">
                Comments
              </CardTitle>
              <CardDescription className="text-[13px]">
                {activeTabInfo.description}
              </CardDescription>
            </div>
            <div
              role="tablist"
              aria-label="Feedback comments"
              className="flex w-fit rounded-[10px] border border-foreground/14 bg-white p-1 text-[13px] font-semibold"
            >
              {FEEDBACK_TABS.map((tab) => {
                const selected = tab.id === activeTab;
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
                    className={`rounded-md px-3 py-1 transition-colors ${
                      selected
                        ? "bg-primary text-primary-foreground"
                        : "text-foreground/70 hover:text-foreground"
                    }`}
                  >
                    {tab.label} ({triage.lists[tab.id].length})
                  </button>
                );
              })}
            </div>
            {triage.error && (
              <p role="alert" className="text-[12.5px] text-red-700">
                {triage.error}
              </p>
            )}
          </CardHeader>
          <CardContent
            id="feedback-tabpanel"
            role="tabpanel"
            aria-labelledby={`feedback-tab-${activeTab}`}
            className="h-[300px] overflow-y-auto p-0"
          >
            {comments.length === 0 ? (
              <p className="p-5 text-[13.5px] text-foreground/70">
                {activeTabInfo.empty}
              </p>
            ) : (
              <ul className="divide-y divide-foreground/10">
                {comments.map((entry) => (
                  <li key={entry.chat_session_id} className="flex items-start">
                    <button
                      type="button"
                      onClick={() => openFeedback(entry)}
                      className="flex min-w-0 flex-1 gap-3 py-3 pl-5 pr-2 text-left transition-colors hover:bg-foreground/[0.04] focus-visible:bg-foreground/[0.04] focus-visible:outline-none"
                      aria-label="View the conversation this feedback was left on"
                    >
                      {entry.rating === "up" ? (
                        <ThumbsUp
                          className="mt-0.5 h-4 w-4 shrink-0 text-[oklch(0.55_0.13_150)]"
                          aria-label="Thumbs up"
                        />
                      ) : (
                        <ThumbsDown
                          className="mt-0.5 h-4 w-4 shrink-0 text-[oklch(0.58_0.16_30)]"
                          aria-label="Thumbs down"
                        />
                      )}
                      <div className="min-w-0">
                        <p className="whitespace-pre-line break-words text-[14px] leading-normal">
                          {entry.comment}
                        </p>
                        <p className="mt-1 text-xs text-foreground/65">
                          {new Date(entry.updated_at).toLocaleString()}
                        </p>
                      </div>
                    </button>
                    <div className="flex shrink-0 gap-0.5 py-2 pr-3">
                      <TriageActions
                        starred={activeTab === "starred" || Boolean(entry.starred)}
                        dismissed={activeTab === "dismissed"}
                        disabled={triage.isPending(entry.chat_session_id)}
                        onStar={(s) => triage.setStarred(entry, s)}
                        onDismiss={(d) => triage.setDismissed(entry, d)}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog
        open={selectedFeedback !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedFeedback(null);
            setConversation([]);
            setConversationError(null);
          }
        }}
      >
        <DialogContent className="max-h-[85vh] gap-0 overflow-hidden p-0 sm:max-w-2xl">
          <DialogHeader className="border-b border-foreground/10 p-5 pr-12 text-left">
            {selectedFeedback && (
              <div className="float-right ml-3 flex gap-0.5">
                <TriageActions
                  starred={triage.isStarred(selectedFeedback.chat_session_id)}
                  dismissed={triage.isDismissed(selectedFeedback.chat_session_id)}
                  disabled={triage.isPending(selectedFeedback.chat_session_id)}
                  onStar={(s) => triage.setStarred(selectedFeedback, s)}
                  onDismiss={(d) => triage.setDismissed(selectedFeedback, d)}
                />
              </div>
            )}
            <DialogTitle className="flex items-center gap-2 text-base font-bold">
              {selectedFeedback?.rating === "up" ? (
                <ThumbsUp className="h-4 w-4 text-[oklch(0.55_0.13_150)]" />
              ) : (
                <ThumbsDown className="h-4 w-4 text-[oklch(0.58_0.16_30)]" />
              )}
              Conversation for this feedback
            </DialogTitle>
            <DialogDescription className="text-[13px]">
              {selectedFeedback
                ? `Rated ${selectedFeedback.rating === "up" ? "helpful" : "not helpful"} on ${new Date(
                    selectedFeedback.updated_at
                  ).toLocaleString()}`
                : null}
            </DialogDescription>
          </DialogHeader>

          {selectedFeedback && (
            <div className="border-b border-foreground/10 bg-foreground/[0.03] px-5 py-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-foreground/55">
                Comment left
              </p>
              <p className="mt-1 whitespace-pre-line break-words text-[14px] leading-normal">
                {selectedFeedback.comment}
              </p>
            </div>
          )}

          <div className="max-h-[52vh] overflow-y-auto p-5">
            {conversationLoading ? (
              <div className="flex items-center justify-center py-10">
                <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
              </div>
            ) : conversationError ? (
              <p className="text-[13.5px] text-red-700">{conversationError}</p>
            ) : conversation.length === 0 ? (
              <p className="text-[13.5px] text-foreground/70">
                No messages found for this conversation.
              </p>
            ) : (
              <ul className="space-y-3">
                {conversation.map((msg) => {
                  const isUser = msg.sender === "user";
                  return (
                    <li
                      key={msg.id}
                      className={`flex ${isUser ? "justify-end" : "justify-start"}`}
                    >
                      <div
                        className={`max-w-[80%] rounded-[12px] px-3.5 py-2.5 ${
                          isUser
                            ? "bg-primary text-primary-foreground"
                            : "bg-foreground/[0.06] text-foreground"
                        }`}
                      >
                        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide opacity-70">
                          {isUser ? "User" : "Assistant"}
                        </p>
                        <p className="whitespace-pre-line break-words text-[14px] leading-normal">
                          {msg.content}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const MAX_DAYS = 365;

const clampDays = (val: number, min: number) =>
  Math.min(Math.max(min, val), MAX_DAYS);

export default function Analytics() {
  const [rangeMode, setRangeMode] = useState<"last" | "between">("last");
  const [lastDays, setLastDays] = useState(90);
  const [fromDaysAgo, setFromDaysAgo] = useState(10);
  const [toDaysAgo, setToDaysAgo] = useState(4);
  const [analyticsData, setAnalyticsData] = useState<AnalyticsData>({
    timeSeries: [],
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const rangeInvalid = rangeMode === "between" && toDaysAgo >= fromDaysAgo;
  const query =
    rangeMode === "last"
      ? `timeRange=${lastDays}d`
      : `timeRange=${fromDaysAgo}d&endDaysAgo=${toDaysAgo}`;

  useEffect(() => {
    if (rangeInvalid) return;
    fetchAnalytics();
  }, [query, rangeInvalid]);

  const fetchAnalytics = async () => {
    if (isDemoMode) {
      setAnalyticsData({
        timeSeries: DEMO_ANALYTICS_SERIES,
        totals: {
          thumbs_up: DEMO_ANALYTICS_SERIES.reduce((sum, d) => sum + d.thumbs_up, 0),
          thumbs_down: DEMO_ANALYTICS_SERIES.reduce((sum, d) => sum + d.thumbs_down, 0),
        },
        recentFeedback: DEMO_RECENT_FEEDBACK,
        starredFeedback: DEMO_STARRED_FEEDBACK,
        dismissedFeedback: DEMO_DISMISSED_FEEDBACK,
      });
      setLoading(false);
      setError(null);
      return;
    }
    try {
      setLoading(true);
      setError(null);

      const token = await AuthService.getAdminIdToken();

      const analyticsUrl = `${import.meta.env.VITE_API_ENDPOINT}/admin/analytics?${query}`;

      const res = await fetch(analyticsUrl, {
        headers: {
          Authorization: token,
          "Content-Type": "application/json",
        },
      });

      if (!res.ok) throw new Error("Failed to fetch analytics data");

      const data = await res.json();
      setAnalyticsData(data);
    } catch (err) {
      console.error("Error fetching analytics:", err);
      setError("Failed to load analytics data");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-[1080px] space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-serif text-[30px] font-semibold leading-tight tracking-[-0.015em]">
            Analytics
          </h1>
          <p className="mt-2 text-[15.5px] leading-relaxed text-foreground/80">
            Volume and feedback over time. Select a comment to review the
            conversation it was left on.
          </p>
        </div>
        <div className="flex flex-col items-start gap-2 sm:items-end">
          <div className="flex rounded-[10px] border border-foreground/14 bg-white p-1 text-[13px] font-semibold">
            {(
              [
                ["last", "Last N days"],
                ["between", "Date range"],
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                onClick={() => setRangeMode(mode)}
                className={`rounded-md px-3 py-1 transition-colors ${
                  rangeMode === mode
                    ? "bg-primary text-primary-foreground"
                    : "text-foreground/70 hover:text-foreground"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 rounded-[10px] border border-foreground/14 bg-white px-3 py-1.5">
            {rangeMode === "last" ? (
              <>
                <span className="text-[13.5px] font-semibold">Last</span>
                <Input
                  type="number"
                  min={1}
                  max={MAX_DAYS}
                  className="h-[38px] w-[72px] rounded-lg border-[1.5px] border-foreground/20 text-center"
                  defaultValue={lastDays}
                  onChange={(e) => {
                    const val = parseInt(e.target.value);
                    if (!isNaN(val) && val > 0) setLastDays(clampDays(val, 1));
                  }}
                />
                <span className="text-[13.5px] font-semibold">days</span>
              </>
            ) : (
              <>
                <span className="text-[13.5px] font-semibold">From</span>
                <Input
                  type="number"
                  min={1}
                  max={MAX_DAYS}
                  className="h-[38px] w-[72px] rounded-lg border-[1.5px] border-foreground/20 text-center"
                  defaultValue={fromDaysAgo}
                  onChange={(e) => {
                    const val = parseInt(e.target.value);
                    if (!isNaN(val) && val > 0) setFromDaysAgo(clampDays(val, 1));
                  }}
                />
                <span className="text-[13.5px] font-semibold">to</span>
                <Input
                  type="number"
                  min={0}
                  max={MAX_DAYS}
                  className="h-[38px] w-[72px] rounded-lg border-[1.5px] border-foreground/20 text-center"
                  defaultValue={toDaysAgo}
                  onChange={(e) => {
                    const val = parseInt(e.target.value);
                    if (!isNaN(val) && val >= 0) setToDaysAgo(clampDays(val, 0));
                  }}
                />
                <span className="text-[13.5px] font-semibold">days ago</span>
              </>
            )}
          </div>
          {rangeInvalid && (
            <p className="text-[12.5px] text-red-700">
              "From" must be further back than "to".
            </p>
          )}
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
          <p className="font-medium">Error</p>
          <p className="text-sm">{error}</p>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
        </div>
      ) : (
        <>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {/* Total Users Chart */}
          <ChartCard
            title="Users reached"
            subtitle="Distinct people who started a conversation"
          >
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={analyticsData.timeSeries}
                margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  vertical={false}
                  stroke="#e5e7eb"
                />
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
                  tick={{ fontSize: 12, fill: "#6b7280" }}
                />
                <Tooltip content={<CustomTooltip />} />
                <Line
                  type="monotone"
                  dataKey="users"
                  stroke="oklch(0.42 0.10 268)"
                  strokeWidth={3}
                  dot={false}
                  activeDot={{ r: 6, strokeWidth: 0 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>

          {/* Total Chat Sessions Chart */}
          <ChartCard title="Conversations" subtitle="New conversations started">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={analyticsData.timeSeries}
                margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
              >
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
                  tick={{ fontSize: 12, fill: "#6b7280" }}
                />
                <Tooltip content={<CustomTooltip />} />
                <Line
                  type="monotone"
                  dataKey="chat_sessions"
                  stroke="oklch(0.48 0.09 268)"
                  strokeWidth={3}
                  dot={false}
                  activeDot={{ r: 6, strokeWidth: 0 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>

          {/* Total Questions Chart */}
          <ChartCard
            title="Messages exchanged"
            subtitle="User and assistant messages combined"
          >
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={analyticsData.timeSeries}
                margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  vertical={false}
                  stroke="#e5e7eb"
                />
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
                  tick={{ fontSize: 12, fill: "#6b7280" }}
                />
                <Tooltip content={<CustomTooltip />} />
                <Line
                  type="monotone"
                  dataKey="questions"
                  stroke="oklch(0.55 0.08 268)"
                  strokeWidth={3}
                  dot={false}
                  activeDot={{ r: 6, strokeWidth: 0 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>
        <FeedbackSection data={analyticsData} />
        </>
      )}
    </div>
  );
}