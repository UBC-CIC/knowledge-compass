import { useState, useEffect, useCallback } from "react";
import { Input } from "@/components/ui/input";
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
import { ChartCard, CustomTooltip } from "@/components/Admin/analyticsCharts";
import FeedbackSection, {
  type FeedbackSectionData,
} from "@/components/Admin/FeedbackSection";
import {
  DEMO_ANALYTICS_SERIES,
  DEMO_DISMISSED_FEEDBACK,
  DEMO_RECENT_FEEDBACK,
  DEMO_STARRED_FEEDBACK,
  isDemoMode,
} from "@/lib/demo";

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

type AnalyticsData = FeedbackSectionData & {
  timeSeries: TimeSeriesData[];
  totals?: AnalyticsTotals;
};

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

  const fetchAnalytics = useCallback(async () => {
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
  }, [query]);

  useEffect(() => {
    if (rangeInvalid) return;
    fetchAnalytics();
  }, [fetchAnalytics, rangeInvalid]);

  return (
    <div className="mx-auto max-w-[1080px] space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-serif text-[30px] font-semibold leading-tight tracking-[-0.015em]">
            Analytics
          </h1>
          <p className="mt-2 text-[15.5px] leading-relaxed text-foreground/80">
            Volume and feedback over time. Select a comment to review the
            reply it was left on.
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
