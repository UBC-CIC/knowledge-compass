import { useId, useMemo, useState } from "react";
import { Eye, Plus, RefreshCw } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AddJourneyDialog, FeedbackStat, JourneyCard, type JourneyActions } from "@/components/Admin/JourneyEditors";
import { useJourneyFeedback, useJourneys } from "@/hooks/useJourneys";
import { buildDetectiveBlock, buildSuggestionBlock, activeCatalog } from "@/lib/journeyPrompt";
import type { FeedbackCount, Journey } from "@/types/journeys";

const FEEDBACK_RANGES = [
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "1y", label: "Last year" },
  { value: "all", label: "All time" },
];

type PreviewPhase = "DETECTIVE" | "SUGGESTION";

function PreviewCard({ journeys }: { journeys: Journey[] }) {
  const journeyId = useId();
  const situationId = useId();
  const secondaryId = useId();
  const ids = { journey: journeyId, situation: situationId, secondary: secondaryId };
  const catalog = useMemo(() => activeCatalog(journeys), [journeys]);
  const [phase, setPhase] = useState<PreviewPhase>("SUGGESTION");
  const [journeyKey, setJourneyKey] = useState("UNCLEAR");
  const [situation, setSituation] = useState("UNKNOWN");
  const [secondary, setSecondary] = useState("NONE");

  const situations = catalog.flatMap((j) => j.clusters.map((c) => ({ ...c, journey: j.key })));
  const route = { journey: journeyKey, situation, secondary };
  const block =
    phase === "SUGGESTION" ? buildSuggestionBlock(journeys, route) : buildDetectiveBlock(journeys, route);
  const everything = buildSuggestionBlock(journeys, { journey: "UNCLEAR", situation: "UNKNOWN", secondary: "NONE" });

  return (
    <Card className="rounded-[13px] border-foreground/12 shadow-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-[18.5px] font-bold tracking-[-0.01em]">
          <Eye className="h-5 w-5 text-primary" aria-hidden="true" />
          What the guide receives
        </CardTitle>
        <CardDescription>
          Pick a route to preview the journey block added after the shared detective or suggestion prompt
          (Assistant settings). Uses the active versions shown on this page; archived items are left out.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="inline-flex w-fit rounded-lg border border-gray-200 bg-gray-50 p-1" role="group" aria-label="Phase">
          {(["DETECTIVE", "SUGGESTION"] as const).map((p) => (
            <Button
              key={p}
              type="button"
              variant={phase === p ? "default" : "ghost"}
              aria-pressed={phase === p}
              onClick={() => setPhase(p)}
            >
              {p === "DETECTIVE" ? "Detective" : "Guidance"}
            </Button>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor={ids.journey}>Journey</Label>
            <Select value={journeyKey} onValueChange={setJourneyKey}>
              <SelectTrigger id={ids.journey}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="UNCLEAR">Unclear</SelectItem>
                <SelectItem value="BOTH">More than one journey</SelectItem>
                {catalog.map((j) => (
                  <SelectItem key={j.key} value={j.key}>
                    {j.key} — {j.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={ids.situation}>Main situation</Label>
            <Select value={situation} onValueChange={setSituation}>
              <SelectTrigger id={ids.situation}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="UNKNOWN">Not known yet</SelectItem>
                {situations.map((c) => (
                  <SelectItem key={c.key} value={c.key}>
                    {c.key} — {c.name} ({c.journey})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={ids.secondary}>Second situation</Label>
            <Select value={secondary} onValueChange={setSecondary}>
              <SelectTrigger id={ids.secondary}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="NONE">None</SelectItem>
                {situations
                  .filter((c) => c.key !== situation)
                  .map((c) => (
                    <SelectItem key={c.key} value={c.key}>
                      {c.key} — {c.name} ({c.journey})
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <p className="text-xs text-gray-500" aria-live="polite">
          {block.length.toLocaleString()} characters
          {phase === "SUGGESTION" && everything.length > 0
            ? ` (sending every journey and situation would be ${everything.length.toLocaleString()})`
            : ""}
        </p>
        <pre
          tabIndex={0}
          aria-label="Prompt preview"
          className="max-h-[420px] overflow-auto whitespace-pre-wrap rounded-lg border border-gray-200 bg-gray-50 p-3 font-mono text-xs text-gray-800"
        >
          {block || "No active journeys."}
        </pre>
      </CardContent>
    </Card>
  );
}

export default function JourneyManagement() {
  const journeysState = useJourneys();
  const { journeys, loading, error, reload } = journeysState;
  const [showArchived, setShowArchived] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [range, setRange] = useState("30d");
  const [feedbackRefresh, setFeedbackRefresh] = useState(0);
  const { feedback, error: feedbackError } = useJourneyFeedback(range, feedbackRefresh);
  const archivedToggleId = useId();
  const rangeId = useId();

  const actions: JourneyActions = journeysState;

  const sorted = useMemo(
    () =>
      [...journeys]
        .filter((j) => showArchived || !j.is_archived)
        .sort((a, b) => a.sort_order - b.sort_order || a.key.localeCompare(b.key)),
    [journeys, showArchived]
  );
  const takenJourneyKeys = journeys.map((j) => j.key);
  const takenClusterKeys = journeys.flatMap((j) => j.clusters.map((c) => c.key));
  const archivedCount =
    journeys.filter((j) => j.is_archived).length +
    journeys.reduce((n, j) => n + j.clusters.filter((c) => c.is_archived).length, 0);

  const feedbackByJourney = useMemo(
    () => new Map<string, FeedbackCount>((feedback?.journeys ?? []).map((f) => [f.key, f])),
    [feedback]
  );
  const feedbackByCluster = useMemo(
    () => new Map<string, FeedbackCount>((feedback?.clusters ?? []).map((f) => [f.key, f])),
    [feedback]
  );

  return (
    <div className="mx-auto max-w-[1000px] space-y-6">
      <div>
        <h1 className="font-serif text-[30px] font-semibold leading-tight tracking-[-0.015em]">Journeys</h1>
        <p className="mt-2 text-[15.5px] leading-relaxed text-foreground/80">
          Each journey has its own detection signals, detective questions and guidance, and holds the
          situations families meet along the way. The guide only sends the journey and situations that fit
          each conversation. Changes reach new messages within about five minutes.
        </p>
      </div>

      <Card className="rounded-[13px] border-foreground/12 shadow-sm">
        <CardContent className="flex flex-col gap-4 pt-6 md:flex-row md:items-end md:justify-between">
          <div className="flex flex-wrap items-end gap-5">
            <div className="space-y-1.5">
              <Label htmlFor={rangeId}>Ratings from</Label>
              <Select value={range} onValueChange={setRange}>
                <SelectTrigger id={rangeId} className="w-[170px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FEEDBACK_RANGES.map((r) => (
                    <SelectItem key={r.value} value={r.value}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <label htmlFor={archivedToggleId} className="flex min-h-9 items-center gap-2 text-sm">
              <input
                id={archivedToggleId}
                type="checkbox"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
                className="h-4 w-4 accent-[var(--color-primary)]"
              />
              Show archived ({archivedCount})
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                reload();
                setFeedbackRefresh((n) => n + 1);
              }}
            >
              <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
              Refresh
            </Button>
            <Button type="button" onClick={() => setAddOpen(true)}>
              <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
              Add journey
            </Button>
          </div>
        </CardContent>
        <CardContent className="space-y-1 pb-6 text-xs text-gray-600">
          <p>
            Ratings count every journey and situation a rated conversation touched, so totals can add up to
            more than the number of conversations. Only counts are shown, never what families wrote.
          </p>
          {feedback && feedback.untagged.up + feedback.untagged.down > 0 ? (
            <p className="flex flex-wrap items-center gap-2">
              Rated conversations with no journey recorded: <FeedbackStat count={{ key: "", name: "", is_archived: false, ...feedback.untagged }} />
            </p>
          ) : null}
          {feedbackError ? <p role="alert" className="text-red-700">{feedbackError}</p> : null}
        </CardContent>
      </Card>

      {error ? (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      ) : null}

      {loading && journeys.length === 0 ? (
        <div className="flex items-center justify-center py-8" role="status" aria-label="Loading journeys">
          <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
        </div>
      ) : (
        <div className="space-y-4">
          {sorted.map((j) => (
            <JourneyCard
              key={j.id}
              journey={j}
              showArchived={showArchived}
              takenClusterKeys={takenClusterKeys}
              feedbackByJourney={feedbackByJourney}
              feedbackByCluster={feedbackByCluster}
              actions={actions}
            />
          ))}
          {sorted.length === 0 && !error ? <p className="text-sm text-gray-500">No journeys yet.</p> : null}
        </div>
      )}

      {journeys.length > 0 ? <PreviewCard journeys={journeys} /> : null}

      <AddJourneyDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        takenKeys={takenJourneyKeys}
        nextSortOrder={journeys.reduce((m, j) => Math.max(m, j.sort_order), 0) + 1}
        onCreate={journeysState.createJourney}
      />
    </div>
  );
}
