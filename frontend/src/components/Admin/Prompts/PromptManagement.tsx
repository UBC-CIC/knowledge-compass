import { Fragment, useCallback, useMemo, useState, type ReactNode } from "react";
import { ArrowRight, Eye, Plus } from "lucide-react";
import { HistoryDrawer, PreviewDrawer } from "@/components/Admin/Prompts/Drawers";
import {
  AddJourneyDialog,
  AddSituationDialog,
  JourneyDetailsDialog,
  SituationDetailsDialog,
} from "@/components/Admin/Prompts/PromptDialogs";
import { JourneyPane, PromptTextPane, SituationPane } from "@/components/Admin/Prompts/PromptPanes";
import { Alert, KeyPill, Spinner, outlineButton } from "@/components/Admin/Prompts/parts";
import { useJourneyFeedback, useJourneys } from "@/hooks/useJourneys";
import { useSystemMessages } from "@/hooks/useSystemMessages";
import {
  GENERAL_PROMPTS,
  STAGE_STYLE,
  activeClusters,
  bySortOrder,
  positiveShare,
  type GeneralPrompt,
  type PromptStage,
} from "@/lib/promptCatalog";
import type { PromptVersion } from "@/lib/promptVersions";
import { DEFAULT_PROMPT_LIMITS, type FeedbackCount } from "@/types/journeys";
import type { SystemMessageType } from "@/types/systemMessages";

type JourneyField = "detective_questions" | "guidance";

type Selection =
  | { type: "prompt"; id: SystemMessageType }
  | { type: "journeyPrompt"; journeyKey: string; field: JourneyField }
  | { type: "journey"; key: string }
  | { type: "situation"; key: string };

type StageFilter = "all" | "every" | "asking" | "guiding";

const STAGE_CARDS: Array<{ k: Exclude<StageFilter, "all">; num: string; title: string; count: string; body: string }> = [
  {
    k: "every",
    num: "",
    title: "Every reply",
    count: "3 prompts",
    body: "Who the assistant is, its boundaries and preferred language. Always included.",
  },
  {
    k: "asking",
    num: "1",
    title: "Asking questions",
    count: "2 shared + each journey",
    body: "The first few messages. One question at a time, to find the right journey and situation.",
  },
  {
    k: "guiding",
    num: "2",
    title: "Giving guidance",
    count: "3 shared + each journey",
    body: "Once the picture is clear. Follows the journey's guidance and the situation's steps.",
  },
];

const FIELD_COPY: Record<JourneyField, { title: string; stage: PromptStage; tag: (key: string) => string; explain: string }> = {
  detective_questions: {
    title: "Questions to ask",
    stage: "asking",
    tag: (k) => `Asking questions · ${k} only`,
    explain:
      "The questions to work through, in order, while the assistant is still learning where the family is. Added after the shared “How to ask questions” rules.",
  },
  guidance: {
    title: "How to guide this journey",
    stage: "guiding",
    tag: (k) => `Giving guidance · ${k} only`,
    explain:
      "Added to every guidance reply in this journey, after the shared “How to give guidance” rules and before the situation's steps.",
  },
};

const sameSelection = (a: Selection | null, b: Selection) => JSON.stringify(a) === JSON.stringify(b);

export default function PromptManagement() {
  const sys = useSystemMessages();
  const jr = useJourneys();
  const { feedback } = useJourneyFeedback("30d");

  const [stage, setStage] = useState<StageFilter>("all");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [dirty, setDirty] = useState(false);
  const [paneKey, setPaneKey] = useState(0);
  const [drawer, setDrawer] = useState<"history" | "preview" | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [dialog, setDialog] = useState<"addJourney" | "journeyDetails" | "addSituation" | "situationDetails" | null>(null);

  const journeys = useMemo(() => [...jr.journeys].sort(bySortOrder), [jr.journeys]);
  const listed = journeys.filter((j) => showArchived || !j.is_archived);
  const archivedJourneys = journeys.filter((j) => j.is_archived).length;

  // Default to the first active journey, as in the design.
  const sel: Selection | null =
    selection ?? (listed[0] ? { type: "journey", key: listed[0].key } : { type: "prompt", id: "system_role" });

  const feedbackByJourney = useMemo(
    () => new Map<string, FeedbackCount>((feedback?.journeys ?? []).map((f) => [f.key, f])),
    [feedback]
  );
  const feedbackByCluster = useMemo(
    () => new Map<string, FeedbackCount>((feedback?.clusters ?? []).map((f) => [f.key, f])),
    [feedback]
  );

  const select = (next: Selection) => {
    if (sameSelection(sel, next)) return;
    if (dirty && !window.confirm("You have unsaved changes. Discard them?")) return;
    setDirty(false);
    setSelection(next);
    setDrawer(null);
  };

  const onDirtyChange = useCallback((d: boolean) => setDirty(d), []);

  // ---- resolve the current selection ----
  const journeyOf = (key: string) => journeys.find((j) => j.key === key);
  const situationOf = (key: string) => {
    for (const j of journeys) {
      const c = j.clusters.find((x) => x.key === key);
      if (c) return { journey: j, cluster: c };
    }
    return null;
  };

  let historyTitle = "";
  let historyVersions: PromptVersion[] = [];
  let restore: (id: string) => Promise<unknown> = async () => undefined;

  if (sel.type === "prompt") {
    historyTitle = GENERAL_PROMPTS.find((g) => g.id === sel.id)?.name ?? sel.id;
    historyVersions = sys.messages[sel.id] ?? [];
    restore = (id) => sys.activate(sel.id, id);
  } else if (sel.type === "journeyPrompt") {
    const j = journeyOf(sel.journeyKey);
    historyTitle = `${FIELD_COPY[sel.field].title} · ${sel.journeyKey}`;
    historyVersions = j?.prompts[sel.field] ?? [];
    restore = (id) => jr.activateVersion(id);
  } else if (sel.type === "situation") {
    historyTitle = `Steps to follow · ${sel.key}`;
    historyVersions = situationOf(sel.key)?.cluster.prompts.response_pattern ?? [];
    restore = (id) => jr.activateVersion(id);
  }

  const restoreAndReset = async (id: string) => {
    if (dirty && !window.confirm("Restoring replaces your unsaved changes. Continue?")) return;
    await restore(id);
    setDirty(false);
    setPaneKey((k) => k + 1);
  };

  // ---- left list ----
  const show = (k: string) => stage === "all" || stage === k || (k === "journeys" && stage !== "every");
  const isJourneyActive = (key: string) =>
    (sel.type === "journey" && sel.key === key) ||
    (sel.type === "journeyPrompt" && sel.journeyKey === key) ||
    (sel.type === "situation" && situationOf(sel.key)?.journey.key === key);

  const itemClass = (on: boolean) =>
    `w-full rounded-[9px] border px-2.5 py-[9px] text-left ${
      on ? "border-foreground/14 bg-[oklch(0.96_0.02_268)] text-primary" : "border-transparent text-foreground hover:bg-muted"
    }`;

  const promptItem = (g: GeneralPrompt) => {
    const on = sel.type === "prompt" && sel.id === g.id;
    return (
      <li key={g.id}>
        <button type="button" aria-current={on ? "true" : undefined} onClick={() => select({ type: "prompt", id: g.id })} className={itemClass(on)}>
          <span className="flex items-center gap-2">
            <span className="min-w-0 flex-1 text-sm font-semibold leading-snug">{g.name}</span>
            {g.technical ? (
              <span className="flex-none rounded-full bg-foreground/7 px-[7px] py-px text-[11px] font-semibold text-foreground/72">
                Technical
              </span>
            ) : null}
          </span>
          <span className="mt-0.5 block text-[12.5px] leading-snug text-foreground/72">{g.sub}</span>
        </button>
      </li>
    );
  };

  const group = (k: string, title: string, color: string, items: ReactNode, note?: string, extra?: ReactNode) =>
    show(k) ? (
      <section key={k} className="px-3 pt-3.5 pb-1.5" aria-label={title}>
        <div className="flex items-center gap-2 px-2 pb-1.5">
          <span className="h-2 w-2 rounded-full" style={{ background: color }} aria-hidden="true" />
          <h2 className="text-[11px] font-bold uppercase tracking-[0.08em] text-foreground/72">{title}</h2>
        </div>
        {note ? <p className="px-2 pb-2 text-xs leading-snug text-foreground/68">{note}</p> : null}
        <ul className="flex flex-col gap-0.5">{items}</ul>
        {extra}
      </section>
    ) : null;

  const byStage = (s: PromptStage) => GENERAL_PROMPTS.filter((g) => g.stage === s).map(promptItem);

  // ---- detail pane ----
  const loading = (sys.loading && Object.keys(sys.messages).length === 0) || (jr.loading && jr.journeys.length === 0);
  let pane: ReactNode = null;
  const currentJourney = sel.type === "journey" ? journeyOf(sel.key) ?? null : null;
  const currentCluster = sel.type === "situation" ? situationOf(sel.key) : null;

  if (sel.type === "prompt") {
    const g = GENERAL_PROMPTS.find((x) => x.id === sel.id)!;
    const style = STAGE_STYLE[g.stage];
    pane = sys.loading && !sys.messages[sel.id] ? (
      <Spinner label="Loading prompt" />
    ) : (
      <PromptTextPane
        key={`${sel.id}-${paneKey}`}
        title={g.name}
        tag={{ label: style.label, bg: style.bg, fg: style.fg }}
        explain={g.explain}
        technical={g.technical}
        versions={sys.messages[sel.id] ?? []}
        defaultLimit={2000}
        onPublish={(content) => sys.publish(sel.id, content)}
        onHistory={() => setDrawer("history")}
        onDirtyChange={onDirtyChange}
      />
    );
  } else if (sel.type === "journeyPrompt") {
    const j = journeyOf(sel.journeyKey);
    const copy = FIELD_COPY[sel.field];
    const style = STAGE_STYLE[copy.stage];
    pane = j ? (
      <PromptTextPane
        key={`${j.id}-${sel.field}-${paneKey}`}
        title={copy.title}
        tag={{ label: copy.tag(j.key), bg: style.bg, fg: style.fg }}
        explain={copy.explain}
        crumb={`${j.key} · ${j.name}`}
        onBack={() => select({ type: "journey", key: j.key })}
        versions={j.prompts[sel.field]}
        defaultLimit={DEFAULT_PROMPT_LIMITS[sel.field]}
        onPublish={(content) => jr.saveVersion(sel.field, j.id, content)}
        onHistory={() => setDrawer("history")}
        onDirtyChange={onDirtyChange}
      />
    ) : null;
  } else if (sel.type === "journey") {
    const j = currentJourney;
    pane = j ? (
      <JourneyPane
        key={j.id}
        journey={j}
        feedback={feedbackByJourney.get(j.key)}
        clusterFeedback={feedbackByCluster}
        onOpenPrompt={(field) => select({ type: "journeyPrompt", journeyKey: j.key, field })}
        onOpenSituation={(key) => select({ type: "situation", key })}
        onAddSituation={() => setDialog("addSituation")}
        onEditDetails={() => setDialog("journeyDetails")}
      />
    ) : null;
  } else {
    const found = currentCluster;
    pane = found ? (
      <SituationPane
        key={`${found.cluster.id}-${paneKey}`}
        journey={found.journey}
        cluster={found.cluster}
        feedback={feedbackByCluster.get(found.cluster.key)}
        onBack={() => select({ type: "journey", key: found.journey.key })}
        onHistory={() => setDrawer("history")}
        onEditDetails={() => setDialog("situationDetails")}
        onPublishSteps={(content) => jr.saveVersion("response_pattern", found.cluster.id, content)}
        onUpdate={(patch) => jr.updateCluster(found.cluster.id, patch)}
        onDirtyChange={onDirtyChange}
      />
    ) : null;
  }

  const takenClusterKeys = journeys.flatMap((j) => j.clusters.map((c) => c.key));

  return (
    <div className="flex flex-col gap-[18px]">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <h1 className="font-serif text-[30px] font-semibold leading-tight tracking-[-0.015em]">Prompts</h1>
          <p className="mt-1.5 max-w-[720px] text-[15px] leading-relaxed text-foreground/80">
            Everything the assistant is told, in the order a conversation happens. Changes reach new messages within
            about five minutes.
          </p>
        </div>
        <button type="button" onClick={() => setDrawer("preview")} className={`${outlineButton} h-10 px-4 text-sm`}>
          <Eye className="h-4 w-4" aria-hidden="true" />
          Preview a reply
        </button>
      </div>

      {/* Conversation stages: also filter the list below */}
      <div className="grid grid-cols-1 items-stretch gap-2 lg:grid-cols-[minmax(0,1fr)_24px_minmax(0,1fr)_24px_minmax(0,1fr)] lg:gap-0" role="group" aria-label="Filter by conversation step">
        {STAGE_CARDS.map((d, i) => {
          const on = stage === d.k;
          const color = STAGE_STYLE[d.k];
          return (
            <Fragment key={d.k}>
              {i > 0 ? (
                <div className="hidden items-center justify-center text-foreground/45 lg:flex" aria-hidden="true">
                  <ArrowRight className="h-[18px] w-[18px]" />
                </div>
              ) : null}
              <button
                type="button"
                aria-pressed={on}
                onClick={() => setStage((s) => (s === d.k ? "all" : d.k))}
                className="rounded-[11px] border-[1.5px] px-[15px] py-[13px] text-left shadow-[0_1px_8px_rgba(22,24,29,0.05)]"
                style={{ background: on ? color.bg : "#fff", borderColor: on ? color.fg : "rgba(22,24,29,0.12)" }}
              >
                <span className="flex items-center gap-2">
                  {d.num ? (
                    <span
                      className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-full text-xs font-bold text-white"
                      style={{ background: color.fg }}
                      aria-hidden="true"
                    >
                      {d.num}
                    </span>
                  ) : (
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: color.fg }} aria-hidden="true" />
                  )}
                  <span className="text-[15px] font-bold">{d.title}</span>
                  <span className="ml-auto text-xs text-foreground/70">{d.count}</span>
                </span>
                <span className="mt-1.5 block text-[13px] leading-normal text-foreground/80">{d.body}</span>
              </button>
            </Fragment>
          );
        })}
      </div>

      {sys.error ? <Alert>{sys.error}</Alert> : null}
      {jr.error ? <Alert>{jr.error}</Alert> : null}

      <div className="flex min-h-[620px] flex-col overflow-hidden rounded-[13px] border border-foreground/12 bg-white shadow-[0_1px_8px_rgba(22,24,29,0.05)] lg:h-[calc(100vh-330px)] lg:flex-row">
        <nav aria-label="Prompts" className="flex flex-none flex-col border-b border-foreground/10 lg:w-[340px] lg:overflow-y-auto lg:border-r lg:border-b-0">
          {group("every", "Every reply", STAGE_STYLE.every.fg, byStage("every"))}
          {group("asking", "1 · Asking questions", STAGE_STYLE.asking.fg, byStage("asking"))}
          {group("guiding", "2 · Giving guidance", STAGE_STYLE.guiding.fg, byStage("guiding"))}
          {group(
            "journeys",
            "Journeys · used in both steps",
            "oklch(0.42 0.10 268)",
            listed.map((j) => {
              const on = isJourneyActive(j.key);
              const n = activeClusters(j).length;
              const share = positiveShare(feedbackByJourney.get(j.key));
              return (
                <li key={j.id}>
                  <button type="button" aria-current={on ? "true" : undefined} onClick={() => select({ type: "journey", key: j.key })} className={itemClass(on)}>
                    <span className="flex items-center gap-2">
                      <KeyPill value={j.key} solid />
                      <span className="min-w-0 flex-1 text-sm font-semibold leading-snug">{j.name}</span>
                      {j.is_archived ? (
                        <span className="flex-none rounded-full bg-foreground/7 px-[7px] py-px text-[11px] font-semibold text-foreground/72">
                          Archived
                        </span>
                      ) : null}
                    </span>
                    <span className="mt-0.5 block text-[12.5px] leading-snug text-foreground/72">
                      {n} situation{n === 1 ? "" : "s"}
                      {share ? ` · ${share}` : ""}
                    </span>
                  </button>
                </li>
              );
            }),
            "Each adds its own questions, guidance and situations.",
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-2 pt-2">
              <button type="button" onClick={() => setDialog("addJourney")} className="inline-flex items-center gap-1 text-[13px] font-semibold text-primary hover:underline">
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                Add journey
              </button>
              {archivedJourneys ? (
                <button
                  type="button"
                  aria-pressed={showArchived}
                  onClick={() => setShowArchived((s) => !s)}
                  className="text-[12.5px] font-semibold text-foreground/70 hover:underline"
                >
                  {showArchived ? "Hide" : "Show"} archived ({archivedJourneys})
                </button>
              ) : null}
            </div>
          )}
          {group(
            "screen",
            "Shown on screen",
            "rgba(22,24,29,0.45)",
            byStage("screen"),
            "Families read these. They are not sent to the assistant."
          )}
        </nav>

        <div className="flex min-h-[560px] min-w-0 flex-1 flex-col lg:min-h-0">
          {loading ? <Spinner label="Loading prompts" /> : pane}
        </div>
      </div>

      <HistoryDrawer
        open={drawer === "history"}
        onOpenChange={(o) => setDrawer(o ? "history" : null)}
        title={historyTitle}
        versions={historyVersions}
        onRestore={restoreAndReset}
      />
      <PreviewDrawer open={drawer === "preview"} onOpenChange={(o) => setDrawer(o ? "preview" : null)} journeys={journeys} />

      <AddJourneyDialog
        open={dialog === "addJourney"}
        onOpenChange={(o) => setDialog(o ? "addJourney" : null)}
        takenKeys={journeys.map((j) => j.key)}
        nextSortOrder={journeys.reduce((m, j) => Math.max(m, j.sort_order), 0) + 1}
        onCreate={async (input) => {
          await jr.createJourney(input);
          setSelection({ type: "journey", key: input.key });
        }}
      />
      {currentJourney ? (
        <>
          <JourneyDetailsDialog
            open={dialog === "journeyDetails"}
            onOpenChange={(o) => setDialog(o ? "journeyDetails" : null)}
            journey={currentJourney}
            onSave={async (patch) => {
              await jr.updateJourney(currentJourney.id, patch);
              if (patch.is_archived) setShowArchived(true);
            }}
          />
          <AddSituationDialog
            open={dialog === "addSituation"}
            onOpenChange={(o) => setDialog(o ? "addSituation" : null)}
            journey={currentJourney}
            takenKeys={takenClusterKeys}
            onCreate={(input) => jr.createCluster(currentJourney.id, input)}
          />
        </>
      ) : null}
      {currentCluster ? (
        <SituationDetailsDialog
          open={dialog === "situationDetails"}
          onOpenChange={(o) => setDialog(o ? "situationDetails" : null)}
          cluster={currentCluster.cluster}
          onSave={(patch) => jr.updateCluster(currentCluster.cluster.id, patch)}
        />
      ) : null}
    </div>
  );
}
