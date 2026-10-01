import { useEffect, useState, type ReactNode } from "react";
import { ChevronRight, Plus } from "lucide-react";
import {
  Alert,
  BackLink,
  FieldSection,
  KeyPill,
  PageFooter,
  PageHeader,
  Pill,
  Rating,
  SafetyBox,
  outlineButton,
} from "@/components/Admin/Prompts/parts";
import {
  CLEANUPS,
  TECH_NOTE,
  activeClusters,
  bySortOrder,
  signalChips,
  signalsFromWords,
  wordsKey,
  type SharedPage,
} from "@/lib/promptCatalog";
import type { PromptVersion } from "@/lib/promptVersions";
import {
  DEFAULT_PROMPT_LIMITS,
  type ClusterPatch,
  type FeedbackCount,
  type Journey,
  type JourneyCluster,
  type JourneyPatch,
  type JourneyPromptField,
} from "@/types/journeys";
import type { SystemMessageType, SystemMessages } from "@/types/systemMessages";

/** Reverts the last publish on a page. Kept by the parent for this session. */
export type UndoAction = () => Promise<void>;

/** Shared props every editor page receives from PromptManagement. */
type PageProps = {
  /** Undo for the last publish on this page, if any (session only). */
  undo: UndoAction | null;
  onPublished: (undo: UndoAction | null) => void;
  onDirtyChange: (dirty: boolean) => void;
};

const NAME_LIMIT = 120;
const DESCRIPTION_LIMIT = 2000;
const SIGNALS_LIMIT = 4000;
const MATCHES_LIMIT = 2000;
const SHARED_DEFAULT_LIMIT = 2000;

const errorMessage = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

const liveVersion = <V extends PromptVersion>(versions: V[] | undefined) => versions?.find((v) => v.is_active);

/** The newest version older than the live one (what "undo" goes back to). */
const previousVersion = <V extends PromptVersion>(versions: V[] | undefined) => {
  const live = liveVersion(versions);
  if (!live || !versions) return undefined;
  return versions
    .filter((v) => !v.is_active && v.version < live.version)
    .sort((a, b) => b.version - a.version)[0];
};

// ------------------------------------------------------------------
// Draft state for one page
// ------------------------------------------------------------------

type Equals = (a: string, b: string) => boolean;
const strictEquals: Equals = (a, b) => a === b;

/**
 * Per-field drafts on top of the live values. A field counts as changed only
 * when its draft differs from the live value (trimmed, or by `equals`).
 */
function useDraft<K extends string>(live: Record<K, string>, equals: Partial<Record<K, Equals>> = {}) {
  const [edits, setEdits] = useState<Partial<Record<K, string>>>({});
  const value = (k: K) => edits[k] ?? live[k];
  const set = (k: K) => (v: string) => setEdits((e) => ({ ...e, [k]: v }));
  const changed = (Object.keys(edits) as K[]).filter((k) => {
    const draft = edits[k];
    if (draft === undefined) return false;
    const eq = equals[k] ?? strictEquals;
    return !eq(draft.trim(), live[k].trim());
  });
  const clear = (keys?: K[]) =>
    setEdits((e) => {
      if (!keys) return {};
      const next = { ...e };
      keys.forEach((k) => delete next[k]);
      return next;
    });
  return { value, set, changed, clear };
}

function useReportDirty(dirty: boolean, onDirtyChange: (dirty: boolean) => void) {
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
}

/** Save/undo wiring shared by every page. */
function usePublish() {
  const [saving, setSaving] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (kind: "save" | "undo", fn: () => Promise<void>) => {
    const setBusy = kind === "save" ? setSaving : setUndoing;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e, kind === "save" ? "Could not publish. Please try again." : "Could not undo. Please try again."));
    } finally {
      setBusy(false);
    }
  };
  return { saving, undoing, error, run };
}

function Scroll({ children }: { children: ReactNode }) {
  return <div className="flex min-h-0 flex-1 flex-col gap-[22px] overflow-y-auto px-[26px] pt-[22px] pb-[26px]">{children}</div>;
}

function NameInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <input
      aria-label={label}
      value={value}
      maxLength={NAME_LIMIT}
      onChange={(e) => onChange(e.target.value)}
      aria-invalid={!value.trim() ? true : undefined}
      className="min-w-[200px] flex-1 rounded-md border border-transparent bg-transparent px-1 py-0.5 text-[20px] font-bold tracking-[-0.01em] hover:border-foreground/18 focus-visible:border-primary focus-visible:outline-none"
    />
  );
}

function ArchiveLink({ what, archived, onToggle }: { what: string; archived: boolean; onToggle: () => void }) {
  return (
    <div className="border-t border-foreground/8 pt-3">
      <button type="button" onClick={onToggle} className="text-[12.5px] font-semibold text-foreground/70 hover:underline">
        {archived ? `Restore this ${what}` : `Archive this ${what}`}
      </button>
    </div>
  );
}

// ------------------------------------------------------------------
// Shared pages: The assistant, How it talks, Welcome and disclaimer, Reply layouts
// ------------------------------------------------------------------

export function SharedPagePane({
  page,
  messages,
  publish,
  activate,
  undo,
  onPublished,
  onDirtyChange,
}: PageProps & {
  page: SharedPage;
  messages: SystemMessages;
  publish: (type: SystemMessageType, content: string) => Promise<void>;
  activate: (type: SystemMessageType, versionId: string) => Promise<void>;
}) {
  const ids = page.sections.map((s) => s.id);
  const live = Object.fromEntries(ids.map((id) => [id, liveVersion(messages[id])?.content ?? ""])) as Record<
    SystemMessageType,
    string
  >;
  const draft = useDraft(live);
  const { saving, undoing, error, run } = usePublish();
  useReportDirty(draft.changed.length > 0, onDirtyChange);

  const limitOf = (id: SystemMessageType) => liveVersion(messages[id])?.character_limit ?? SHARED_DEFAULT_LIMIT;
  const problems = ids.filter((id) => draft.value(id).length > limitOf(id) || !draft.value(id).trim());

  // Migration-published clean-ups (for example system_role in 025) can be undone.
  const cleanups = ids.flatMap((id) => {
    const c = CLEANUPS[id];
    const prev = previousVersion(messages[id]);
    return c && prev && live[id].trim() === c.content.trim() ? [{ id, note: c.note, prev }] : [];
  });

  const save = () =>
    run("save", async () => {
      const reverts: Array<[SystemMessageType, string]> = [];
      for (const id of draft.changed) {
        const prev = liveVersion(messages[id]);
        await publish(id, draft.value(id).trim());
        draft.clear([id]);
        if (prev) reverts.push([id, prev.id]);
      }
      onPublished(
        reverts.length
          ? async () => {
              for (const [id, versionId] of reverts) await activate(id, versionId);
            }
          : null
      );
    });

  const undoCleanup = () =>
    run("undo", async () => {
      for (const c of cleanups) await activate(c.id, c.prev.id);
    });

  const undoLabel = undo ? "Undo last publish" : cleanups.length ? "Undo cleanup" : null;
  const onUndo = undo
    ? () =>
        run("undo", async () => {
          await undo();
          onPublished(null);
        })
    : undoCleanup;

  return (
    <>
      <Scroll>
        <PageHeader title={<h2 className="text-[20px] font-bold tracking-[-0.01em]">{page.name}</h2>} explain={page.explain} />
        {page.technical ? <Alert tone="warning">{TECH_NOTE}</Alert> : null}
        {error ? <Alert>{error}</Alert> : null}
        {page.sections.map((s) => (
          <FieldSection
            key={s.id}
            title={s.title}
            stage={s.stage}
            value={draft.value(s.id)}
            onChange={draft.set(s.id)}
            limit={limitOf(s.id)}
            rows={page.technical ? 12 : s.id === "suggestion_phase_prompt" ? 14 : 8}
            mono={page.technical}
            autoInsert={s.autoInsert}
            warning={s.warning}
            note={cleanups.find((c) => c.id === s.id)?.note}
            error={!draft.value(s.id).trim() ? "This can't be empty." : null}
          />
        ))}
      </Scroll>
      <PageFooter
        changes={draft.changed.length}
        canSave={problems.length === 0}
        saving={saving}
        undoLabel={undoLabel}
        undoing={undoing}
        onUndo={onUndo}
        onDiscard={() => draft.clear()}
        onSave={save}
      />
    </>
  );
}

// ------------------------------------------------------------------
// Journey page
// ------------------------------------------------------------------

type JourneyKey = "name" | "description" | "words" | "detective_questions" | "guidance";

export function JourneyPagePane({
  journey,
  feedback,
  saveVersion,
  activateVersion,
  updateJourney,
  onOpenSituation,
  onAddSituation,
  undo,
  onPublished,
  onDirtyChange,
}: PageProps & {
  journey: Journey;
  feedback?: FeedbackCount;
  saveVersion: (field: JourneyPromptField, ownerId: string, content: string) => Promise<unknown>;
  activateVersion: (versionId: string) => Promise<unknown>;
  updateJourney: (id: string, patch: JourneyPatch) => Promise<unknown>;
  onOpenSituation: (key: string) => void;
  onAddSituation: () => void;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const live: Record<JourneyKey, string> = {
    name: journey.name,
    description: journey.description,
    words: signalChips(journey.detection_signals).join(", "),
    detective_questions: liveVersion(journey.prompts.detective_questions)?.content ?? "",
    guidance: liveVersion(journey.prompts.guidance)?.content ?? "",
  };
  const draft = useDraft(live, { words: (a, b) => wordsKey(a) === wordsKey(b) });
  const { saving, undoing, error, run } = usePublish();
  useReportDirty(draft.changed.length > 0, onDirtyChange);

  const limits: Record<JourneyKey, number> = {
    name: NAME_LIMIT,
    description: DESCRIPTION_LIMIT,
    words: SIGNALS_LIMIT,
    detective_questions:
      liveVersion(journey.prompts.detective_questions)?.character_limit ?? DEFAULT_PROMPT_LIMITS.detective_questions,
    guidance: liveVersion(journey.prompts.guidance)?.character_limit ?? DEFAULT_PROMPT_LIMITS.guidance,
  };
  const length = (k: JourneyKey) => (k === "words" ? signalsFromWords(draft.value(k)).length : draft.value(k).length);
  // Versioned prompt text can't be published empty once it exists.
  const emptyPrompt = (k: "detective_questions" | "guidance") => !!live[k].trim() && !draft.value(k).trim();
  const problems =
    !draft.value("name").trim() ||
    (Object.keys(limits) as JourneyKey[]).some((k) => length(k) > limits[k]) ||
    emptyPrompt("detective_questions") ||
    emptyPrompt("guidance");

  const clusters = activeClusters(journey);
  const archived = journey.clusters.filter((c) => c.is_archived).sort(bySortOrder);
  const rows = showArchived ? [...clusters, ...archived] : clusters;

  const save = () =>
    run("save", async () => {
      const changed = draft.changed;
      const patch: JourneyPatch = {};
      const oldPatch: JourneyPatch = {};
      if (changed.includes("name")) {
        patch.name = draft.value("name").trim();
        oldPatch.name = journey.name;
      }
      if (changed.includes("description")) {
        patch.description = draft.value("description").trim();
        oldPatch.description = journey.description;
      }
      if (changed.includes("words")) {
        patch.detection_signals = signalsFromWords(draft.value("words"));
        oldPatch.detection_signals = journey.detection_signals;
      }
      const reverts: string[] = [];
      let metaSaved = false;
      if (Object.keys(patch).length) {
        await updateJourney(journey.id, patch);
        metaSaved = true;
        draft.clear(["name", "description", "words"]);
      }
      for (const field of ["detective_questions", "guidance"] as const) {
        if (!changed.includes(field)) continue;
        const prev = liveVersion(journey.prompts[field]);
        await saveVersion(field, journey.id, draft.value(field).trim());
        draft.clear([field]);
        if (prev) reverts.push(prev.id);
      }
      onPublished(
        metaSaved || reverts.length
          ? async () => {
              if (metaSaved) await updateJourney(journey.id, oldPatch);
              for (const id of reverts) await activateVersion(id);
            }
          : null
      );
    });

  const toggleArchive = () => {
    const archiving = !journey.is_archived;
    if (
      archiving &&
      !window.confirm(
        `Archive ${journey.key}? The assistant stops using this journey and its situations. You can restore it later.`
      )
    ) {
      return;
    }
    run("save", async () => {
      await updateJourney(journey.id, { is_archived: archiving });
    });
  };

  const n = clusters.length;

  return (
    <>
      <Scroll>
        <PageHeader
          title={
            <>
              <KeyPill value={journey.key} solid />
              <NameInput label="Journey name" value={draft.value("name")} onChange={draft.set("name")} />
              {journey.is_archived ? (
                <Pill bg="rgba(22,24,29,0.07)" fg="rgba(22,24,29,0.75)">
                  Archived
                </Pill>
              ) : null}
            </>
          }
          explain="Everything specific to this journey, in one place. The shared pages pick it up automatically."
        >
          <div className="mt-2">
            <Rating count={feedback} />
          </div>
        </PageHeader>

        {journey.is_archived ? (
          <Alert tone="warning">This journey is archived, so the assistant does not use it or its situations.</Alert>
        ) : null}
        {error ? <Alert>{error}</Alert> : null}
        {!draft.value("name").trim() ? <Alert>Give the journey a name.</Alert> : null}

        <FieldSection
          title="Who it's for"
          help="Helps the assistant recognise this journey."
          placeholder="Describe the family's situation in a sentence or two."
          value={draft.value("description")}
          onChange={draft.set("description")}
          limit={limits.description}
          rows={3}
        />
        <FieldSection
          title="Words families use"
          help="Separate with commas."
          placeholder="sent home, reduced schedule, pick up early"
          value={draft.value("words")}
          onChange={draft.set("words")}
          limit={limits.words}
          rows={3}
        />
        <FieldSection
          title="Questions to ask"
          stage="asking"
          help="Asked one at a time, in this order, while the assistant learns where the family is."
          value={draft.value("detective_questions")}
          onChange={draft.set("detective_questions")}
          limit={limits.detective_questions}
          rows={7}
          error={emptyPrompt("detective_questions") ? "This can't be empty." : null}
        />
        <FieldSection
          title="How to guide"
          stage="guiding"
          help="Added to every guidance reply in this journey, before the situation's steps."
          value={draft.value("guidance")}
          onChange={draft.set("guidance")}
          limit={limits.guidance}
          rows={4}
          error={emptyPrompt("guidance") ? "This can't be empty." : null}
        />

        <section className="flex flex-col gap-2.5" aria-labelledby={`${journey.id}-situations`}>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h3 id={`${journey.id}-situations`} className="text-[15px] font-bold">
                Situations · {n}
              </h3>
              <p className="mt-0.5 max-w-[560px] text-[13px] leading-normal text-foreground/75">
                Specific needs within this journey. Each has two things: when it fits, and the steps to follow.
              </p>
            </div>
            <button type="button" onClick={onAddSituation} className={`${outlineButton} h-[34px] text-[13.5px]`}>
              <Plus className="h-[15px] w-[15px]" aria-hidden="true" />
              Add situation
            </button>
          </div>
          {rows.length ? (
            <ul className="overflow-hidden rounded-[11px] border border-foreground/12">
              {rows.map((c) => (
                <li key={c.id}>
                  <SituationRow cluster={c} onOpen={() => onOpenSituation(c.key)} />
                </li>
              ))}
            </ul>
          ) : null}
          {archived.length ? (
            <button
              type="button"
              onClick={() => setShowArchived((s) => !s)}
              aria-expanded={showArchived}
              className="self-start text-[12.5px] font-semibold text-primary hover:underline"
            >
              {showArchived ? "Hide" : "Show"} {archived.length} archived situation{archived.length === 1 ? "" : "s"}
            </button>
          ) : null}
          {n ? (
            <SafetyBox title="None of these fit? The family is still helped.">
              If the assistant can't tell which situation a family is in, it uses this journey's guidance with the steps
              from all {n} situation{n === 1 ? "" : "s"}. If even the journey is unclear, it uses every journey.
            </SafetyBox>
          ) : (
            <SafetyBox title="No situations yet? The family is still helped.">
              Families in this journey get its guidance plus the shared pages. Add situations to make answers more
              specific.
            </SafetyBox>
          )}
        </section>

        <ArchiveLink what="journey" archived={journey.is_archived} onToggle={toggleArchive} />
      </Scroll>
      <PageFooter
        changes={draft.changed.length}
        canSave={!problems}
        saving={saving}
        undoLabel={undo ? "Undo last publish" : null}
        undoing={undoing}
        onUndo={() =>
          run("undo", async () => {
            await undo?.();
            onPublished(null);
          })
        }
        onDiscard={() => draft.clear()}
        onSave={save}
      />
    </>
  );
}

function SituationRow({ cluster, onOpen }: { cluster: JourneyCluster; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="grid w-full grid-cols-[44px_minmax(0,1fr)_18px] items-center gap-3 border-b border-foreground/8 bg-white px-3.5 py-[11px] text-left last:border-b-0 hover:bg-muted"
    >
      <span className="justify-self-start">
        <KeyPill value={cluster.key} />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold leading-snug">
          {cluster.name}
          {cluster.is_archived ? <span className="ml-2 text-xs font-medium text-foreground/60">(archived)</span> : null}
        </span>
        <span className="mt-0.5 line-clamp-2 text-[12.5px] leading-snug text-foreground/72">
          {cluster.matches_when.replace(/\n/g, " ")}
        </span>
      </span>
      <ChevronRight className="h-4 w-4 text-foreground/50" aria-hidden="true" />
    </button>
  );
}

// ------------------------------------------------------------------
// Situation page
// ------------------------------------------------------------------

type SituationKey = "name" | "matches_when" | "response_pattern";

export function SituationPagePane({
  journey,
  cluster,
  feedback,
  saveVersion,
  activateVersion,
  updateCluster,
  onBack,
  undo,
  onPublished,
  onDirtyChange,
}: PageProps & {
  journey: Journey;
  cluster: JourneyCluster;
  feedback?: FeedbackCount;
  saveVersion: (field: JourneyPromptField, ownerId: string, content: string) => Promise<unknown>;
  activateVersion: (versionId: string) => Promise<unknown>;
  updateCluster: (id: string, patch: ClusterPatch) => Promise<unknown>;
  onBack: () => void;
}) {
  const steps = liveVersion(cluster.prompts.response_pattern);
  const live: Record<SituationKey, string> = {
    name: cluster.name,
    matches_when: cluster.matches_when,
    response_pattern: steps?.content ?? "",
  };
  const draft = useDraft(live);
  const { saving, undoing, error, run } = usePublish();
  useReportDirty(draft.changed.length > 0, onDirtyChange);

  const stepsLimit = steps?.character_limit ?? DEFAULT_PROMPT_LIMITS.response_pattern;
  const emptySteps = !!live.response_pattern.trim() && !draft.value("response_pattern").trim();
  const problems =
    !draft.value("name").trim() ||
    !draft.value("matches_when").trim() ||
    draft.value("matches_when").length > MATCHES_LIMIT ||
    draft.value("response_pattern").length > stepsLimit ||
    emptySteps;

  const save = () =>
    run("save", async () => {
      const changed = draft.changed;
      const patch: ClusterPatch = {};
      const oldPatch: ClusterPatch = {};
      if (changed.includes("name")) {
        patch.name = draft.value("name").trim();
        oldPatch.name = cluster.name;
      }
      if (changed.includes("matches_when")) {
        patch.matches_when = draft.value("matches_when").trim();
        oldPatch.matches_when = cluster.matches_when;
      }
      let metaSaved = false;
      let revert: string | null = null;
      if (Object.keys(patch).length) {
        await updateCluster(cluster.id, patch);
        metaSaved = true;
        draft.clear(["name", "matches_when"]);
      }
      if (changed.includes("response_pattern")) {
        await saveVersion("response_pattern", cluster.id, draft.value("response_pattern").trim());
        draft.clear(["response_pattern"]);
        revert = steps?.id ?? null;
      }
      onPublished(
        metaSaved || revert
          ? async () => {
              if (metaSaved) await updateCluster(cluster.id, oldPatch);
              if (revert) await activateVersion(revert);
            }
          : null
      );
    });

  const toggleArchive = () => {
    const archiving = !cluster.is_archived;
    if (
      archiving &&
      !window.confirm(`Archive ${cluster.key}? The assistant stops using this situation. You can restore it later.`)
    ) {
      return;
    }
    run("save", async () => {
      await updateCluster(cluster.id, { is_archived: archiving });
    });
  };

  return (
    <>
      <Scroll>
        <PageHeader
          crumb={<BackLink label={`${journey.key} · ${journey.name}`} onClick={onBack} />}
          title={
            <>
              <KeyPill value={cluster.key} />
              <NameInput label="Situation name" value={draft.value("name")} onChange={draft.set("name")} />
              {cluster.is_archived ? (
                <Pill bg="rgba(22,24,29,0.07)" fg="rgba(22,24,29,0.75)">
                  Archived
                </Pill>
              ) : null}
            </>
          }
          explain="A specific need within the journey. When it fits, its steps are added after the journey's guidance."
        >
          <div className="mt-2">
            <Rating count={feedback} />
          </div>
        </PageHeader>

        {cluster.is_archived ? (
          <Alert tone="warning">This situation is archived, so the assistant does not use it.</Alert>
        ) : null}
        {error ? <Alert>{error}</Alert> : null}
        {!draft.value("name").trim() ? <Alert>Give the situation a name.</Alert> : null}

        <FieldSection
          title="Use this when…"
          help="In plain words. The assistant reads this to decide if the situation fits."
          value={draft.value("matches_when")}
          onChange={draft.set("matches_when")}
          limit={MATCHES_LIMIT}
          rows={4}
          error={!draft.value("matches_when").trim() ? "Describe when this situation fits." : null}
        />
        <FieldSection
          title="Steps to follow"
          stage="guiding"
          help="What the assistant does for this situation."
          value={draft.value("response_pattern")}
          onChange={draft.set("response_pattern")}
          limit={stepsLimit}
          rows={14}
          error={emptySteps ? "This can't be empty." : null}
        />

        <ArchiveLink what="situation" archived={cluster.is_archived} onToggle={toggleArchive} />
      </Scroll>
      <PageFooter
        changes={draft.changed.length}
        canSave={!problems}
        saving={saving}
        undoLabel={undo ? "Undo last publish" : null}
        undoing={undoing}
        onUndo={() =>
          run("undo", async () => {
            await undo?.();
            onPublished(null);
          })
        }
        onDiscard={() => draft.clear()}
        onSave={save}
      />
    </>
  );
}
