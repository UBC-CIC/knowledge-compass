import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Eye, Lock, Plus, Search } from "lucide-react";
import { PreviewDrawer } from "@/components/Admin/Prompts/Drawers";
import { AddJourneyDialog, AddSituationDialog } from "@/components/Admin/Prompts/PromptDialogs";
import { JourneyPagePane, SharedPagePane, SituationPagePane } from "@/components/Admin/Prompts/PromptPanes";
import { Alert, SELECTED_BG, Spinner } from "@/components/Admin/Prompts/parts";
import DeveloperSwitch from "@/components/Admin/DeveloperSwitch";
import { useJourneyFeedback, useJourneys } from "@/hooks/useJourneys";
import { useDeveloperSettings } from "@/lib/developerSettings";
import { useSystemMessages } from "@/hooks/useSystemMessages";
import {
  SHARED_PAGES,
  STAGE_SUMMARY,
  activeClusters,
  bySortOrder,
  nextJourneyKey,
  nextSituationKey,
  type SharedPageId,
} from "@/lib/promptCatalog";
import type { FeedbackCount, Journey } from "@/types/journeys";

type Page =
  | { type: "shared"; id: SharedPageId }
  | { type: "journey"; id: string }
  | { type: "situation"; id: string };

const pageKey = (p: Page) => `${p.type}:${p.id}`;

const isKeyConflict = (e: unknown) => e instanceof Error && /already exists/i.test(e.message);

/**
 * Create something with an internal key the admin never sees. If another
 * admin took the key first, refresh the list and retry once with the next one.
 */
async function withFreshKey<T>(
  keys: string[],
  pick: (taken: string[]) => string,
  reload: () => Promise<Journey[] | null>,
  takenIn: (journeys: Journey[]) => string[],
  create: (key: string) => Promise<T>
): Promise<T> {
  try {
    return await create(pick(keys));
  } catch (e) {
    if (!isKeyConflict(e)) throw e;
    const fresh = await reload();
    if (!fresh) throw e;
    return create(pick(takenIn(fresh)));
  }
}

const journeyKeysIn = (journeys: Journey[]) => journeys.map((j) => j.key);
const clusterKeysIn = (journeys: Journey[]) => journeys.flatMap((j) => j.clusters.map((c) => c.key));

export default function PromptManagement() {
  const sys = useSystemMessages();
  const jr = useJourneys();
  const { feedback } = useJourneyFeedback("30d");

  const [page, setPage] = useState<Page>({ type: "shared", id: "assistant" });
  const [dirty, setDirty] = useState(false);
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [showDeveloper, setShowDeveloper] = useDeveloperSettings();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [dialog, setDialog] = useState<"addJourney" | "addSituation" | null>(null);

  const journeys = useMemo(() => [...jr.journeys].sort(bySortOrder), [jr.journeys]);
  const activeJourneys = journeys.filter((j) => !j.is_archived);
  const archivedCount = journeys.length - activeJourneys.length;
  const q = query.trim().toLowerCase();
  const listed = (showArchived ? journeys : activeJourneys).filter((j) => !q || j.name.toLowerCase().includes(q));

  const feedbackByJourney = useMemo(
    () => new Map<string, FeedbackCount>((feedback?.journeys ?? []).map((f) => [f.key, f])),
    [feedback]
  );
  const feedbackByCluster = useMemo(
    () => new Map<string, FeedbackCount>((feedback?.clusters ?? []).map((f) => [f.key, f])),
    [feedback]
  );

  const findSituation = (id: string) => {
    for (const j of journeys) {
      const c = j.clusters.find((x) => x.id === id);
      if (c) return { journey: j, cluster: c };
    }
    return null;
  };

  /** Navigate, asking first if the current page has unsaved changes. */
  const go = (next: Page) => {
    if (pageKey(next) === pageKey(page)) return true;
    if (dirty && !window.confirm("You have unsaved changes on this page. Discard them?")) return false;
    setDirty(false);
    setPage(next);
    return true;
  };

  const toggleDeveloper = () => {
    const next = !showDeveloper;
    // Leaving Reply layouts open after hiding it would be confusing.
    if (!next && page.type === "shared" && page.id === "advanced" && !go({ type: "shared", id: "assistant" })) return;
    setShowDeveloper(next);
  };

  const onDirtyChange = useCallback((d: boolean) => setDirty(d), []);
  const key = pageKey(page);

  // ---- navigation ----
  const itemClass = (on: boolean) =>
    `w-full rounded-[9px] border px-2.5 py-[9px] text-left ${
      on ? "border-foreground/14 text-primary" : "border-transparent text-foreground hover:bg-muted"
    }`;
  const itemStyle = (on: boolean) => (on ? { background: SELECTED_BG } : undefined);

  const sharedItem = (id: SharedPageId, extra?: ReactNode) => {
    const p = SHARED_PAGES[id];
    const on = page.type === "shared" && page.id === id;
    return (
      <li key={id}>
        <button
          type="button"
          aria-current={on ? "page" : undefined}
          onClick={() => go({ type: "shared", id })}
          className={itemClass(on)}
          style={itemStyle(on)}
        >
          <span className="flex items-center gap-2">
            {id === "advanced" ? <Lock className="h-3.5 w-3.5 flex-none text-foreground/60" aria-hidden="true" /> : null}
            <span className="min-w-0 flex-1 text-sm font-semibold leading-snug">{p.name}</span>
            {extra}
          </span>
          <span className="mt-0.5 block text-[12.5px] leading-snug text-foreground/72">{p.sub}</span>
        </button>
      </li>
    );
  };

  const groupTitle = (title: string, right?: ReactNode) => (
    <div className="flex items-center justify-between gap-2 px-2 pb-1.5">
      <h2 className="text-[11px] font-bold uppercase tracking-[0.08em] text-foreground/72">{title}</h2>
      {right}
    </div>
  );

  const journeyActive = (id: string) =>
    (page.type === "journey" && page.id === id) ||
    (page.type === "situation" && findSituation(page.id)?.journey.id === id);

  // ---- current page ----
  const loading = (sys.loading && Object.keys(sys.messages).length === 0) || (jr.loading && jr.journeys.length === 0);
  let pane: ReactNode = null;
  const currentJourney = page.type === "journey" ? journeys.find((j) => j.id === page.id) ?? null : null;
  const currentSituation = page.type === "situation" ? findSituation(page.id) : null;

  if (page.type === "shared") {
    pane = (
      <SharedPagePane
        key={key}
        page={SHARED_PAGES[page.id]}
        messages={sys.messages}
        publish={sys.publish}
        activate={sys.activate}
        onDirtyChange={onDirtyChange}
      />
    );
  } else if (currentJourney) {
    pane = (
      <JourneyPagePane
        key={key}
        journey={currentJourney}
        feedback={feedbackByJourney.get(currentJourney.key)}
        sectionFeedback={(feedback?.sections ?? []).filter((s) => s.journey_key === currentJourney.key)}
        saveVersion={jr.saveVersion}
        activateVersion={jr.activateVersion}
        updateJourney={jr.updateJourney}
        onOpenSituation={(id) => go({ type: "situation", id })}
        onAddSituation={() => setDialog("addSituation")}
        onDirtyChange={onDirtyChange}
      />
    );
  } else if (currentSituation) {
    pane = (
      <SituationPagePane
        key={key}
        journey={currentSituation.journey}
        cluster={currentSituation.cluster}
        feedback={feedbackByCluster.get(currentSituation.cluster.key)}
        saveVersion={jr.saveVersion}
        activateVersion={jr.activateVersion}
        updateCluster={jr.updateCluster}
        onBack={() => go({ type: "journey", id: currentSituation.journey.id })}
        onDirtyChange={onDirtyChange}
      />
    );
  } else {
    pane = <p className="p-6 text-[13.5px] text-foreground/70">This page is no longer available. Pick another from the list.</p>;
  }

  return (
    <div className="flex flex-col gap-[18px]">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <h1 className="font-serif text-[30px] font-semibold leading-tight tracking-[-0.015em]">Prompts</h1>
          <p className="mt-1.5 max-w-[720px] text-[15px] leading-relaxed text-foreground/80">
            Shared pages hold rules for every journey. Anything about a specific journey lives only in that journey.
            Changes reach new messages within about five minutes.
          </p>
          <p className="mt-1 max-w-[720px] text-[13.5px] leading-relaxed text-foreground/70">{STAGE_SUMMARY}</p>
        </div>
        <button
          type="button"
          onClick={() => setPreviewOpen(true)}
          className="inline-flex h-10 items-center gap-2 rounded-[9px] bg-primary px-4 text-sm font-semibold text-white shadow-sm hover:bg-primary/90"
        >
          <Eye className="h-4 w-4" aria-hidden="true" />
          Preview a reply
        </button>
      </div>

      {sys.error ? <Alert>{sys.error}</Alert> : null}
      {jr.error ? <Alert>{jr.error}</Alert> : null}

      <div className="flex min-h-[620px] flex-col overflow-hidden rounded-[13px] border border-foreground/12 bg-white shadow-[0_1px_8px_rgba(22,24,29,0.05)] lg:h-[calc(100vh-260px)] lg:flex-row">
        <nav
          aria-label="Prompt pages"
          className="flex flex-none flex-col border-b border-foreground/10 lg:w-[320px] lg:overflow-y-auto lg:border-r lg:border-b-0"
        >
          <section className="px-3 pt-3.5 pb-1.5" aria-label="Shared by every journey">
            {groupTitle("Shared by every journey")}
            <ul className="flex flex-col gap-0.5">
              {sharedItem("assistant")}
              {sharedItem("talks")}
            </ul>
          </section>

          <section className="px-3 pt-3.5 pb-1.5" aria-label="Journeys">
            {groupTitle(
              `Journeys · ${activeJourneys.length}`,
              <button
                type="button"
                onClick={() => setDialog("addJourney")}
                className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-primary hover:underline"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                Add journey
              </button>
            )}
            {journeys.length > 5 || query ? (
              <div className="relative px-1 pb-2">
                <Search
                  className="pointer-events-none absolute top-1/2 left-3.5 h-3.5 w-3.5 -translate-y-1/2 text-foreground/50"
                  aria-hidden="true"
                />
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Find a journey"
                  aria-label="Find a journey"
                  className="h-8 w-full rounded-[8px] border border-foreground/16 bg-white pr-2 pl-8 text-[13px]"
                />
              </div>
            ) : null}
            <ul className="flex flex-col gap-0.5">
              {listed.map((j) => {
                const on = journeyActive(j.id);
                const n = activeClusters(j).length;
                return (
                  <li key={j.id}>
                    <button
                      type="button"
                      aria-current={on ? "page" : undefined}
                      onClick={() => go({ type: "journey", id: j.id })}
                      className={itemClass(on)}
                      style={itemStyle(on)}
                    >
                      <span className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 text-sm font-semibold leading-snug">{j.name}</span>
                        {j.is_archived ? (
                          <span className="flex-none rounded-full bg-foreground/7 px-[7px] py-px text-[11px] font-semibold text-foreground/72">
                            Archived
                          </span>
                        ) : null}
                      </span>
                      <span className="mt-0.5 block text-[12.5px] leading-snug text-foreground/72">
                        {n ? `${n} situation${n === 1 ? "" : "s"}` : "No situations yet"}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {listed.length === 0 && q ? (
              <p className="px-2 py-1.5 text-[12.5px] text-foreground/70">No journeys match “{query}”.</p>
            ) : null}
            {archivedCount ? (
              <button
                type="button"
                aria-pressed={showArchived}
                onClick={() => setShowArchived((s) => !s)}
                className="px-2 pt-1.5 text-[12.5px] font-semibold text-foreground/70 hover:underline"
              >
                {showArchived ? "Hide" : "Show"} archived ({archivedCount})
              </button>
            ) : null}
          </section>

          <section className="px-3 pt-3.5 pb-1.5" aria-label="Shown on screen">
            {groupTitle("Shown on screen")}
            <ul className="flex flex-col gap-0.5">{sharedItem("screen")}</ul>
          </section>

          <div className="mt-auto border-t border-foreground/10 px-3 py-2.5">
            {showDeveloper ? (
              <ul className="pb-2">
                {sharedItem(
                  "advanced",
                  <span className="flex-none rounded-full bg-foreground/7 px-[7px] py-px text-[11px] font-semibold text-foreground/72">
                    Developers
                  </span>
                )}
              </ul>
            ) : null}
            <DeveloperSwitch checked={showDeveloper} onChange={toggleDeveloper} />
          </div>
        </nav>

        <div className="flex min-h-[560px] min-w-0 flex-1 flex-col lg:min-h-0">
          {loading ? <Spinner label="Loading prompts" /> : pane}
        </div>
      </div>

      <PreviewDrawer open={previewOpen} onOpenChange={setPreviewOpen} journeys={journeys} />

      <AddJourneyDialog
        open={dialog === "addJourney"}
        onOpenChange={(o) => setDialog(o ? "addJourney" : null)}
        onCreate={async ({ name, description }) => {
          const sortOrder = journeys.reduce((m, j) => Math.max(m, j.sort_order), 0) + 1;
          const { id } = await withFreshKey(journeyKeysIn(journeys), nextJourneyKey, jr.reload, journeyKeysIn, (k) =>
            jr.createJourney({ key: k, name, description, sort_order: sortOrder })
          );
          setQuery("");
          go({ type: "journey", id });
        }}
      />
      {currentJourney ? (
        <AddSituationDialog
          open={dialog === "addSituation"}
          onOpenChange={(o) => setDialog(o ? "addSituation" : null)}
          journey={currentJourney}
          onCreate={async ({ name, matches_when }) => {
            const { id } = await withFreshKey(clusterKeysIn(journeys), nextSituationKey, jr.reload, clusterKeysIn, (k) =>
              jr.createCluster(currentJourney.id, {
                key: k,
                name,
                matches_when,
                sort_order: currentJourney.clusters.length + 1,
              })
            );
            go({ type: "situation", id });
          }}
        />
      ) : null}
    </div>
  );
}
