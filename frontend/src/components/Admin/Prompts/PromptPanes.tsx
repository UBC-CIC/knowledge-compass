import { useEffect, useId, useState } from "react";
import { ChevronLeft, ChevronRight, Info, LifeBuoy, Pencil, Plus, Settings2 } from "lucide-react";
import {
  Alert,
  HistoryButton,
  KeyPill,
  Pill,
  Rating,
  SaveFooter,
  TextAreaField,
  UrgencyPicker,
  outlineButton,
  textareaClass,
} from "@/components/Admin/Prompts/parts";
import {
  STAGE_STYLE,
  TECH_NOTE,
  activeClusters,
  bySortOrder,
  firstLines,
  signalChips,
  urgencyLabel,
} from "@/lib/promptCatalog";
import type { PromptVersion } from "@/lib/promptVersions";
import { formatDate } from "@/lib/promptVersions";
import {
  DEFAULT_PROMPT_LIMITS,
  type ClusterPatch,
  type FeedbackCount,
  type Journey,
  type JourneyCluster,
} from "@/types/journeys";

const errorMessage = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

const liveVersion = <V extends PromptVersion>(versions: V[]) => versions.find((v) => v.is_active);

function liveNote(live: PromptVersion | undefined, dirty: boolean) {
  if (dirty) return "Unsaved changes. Publishing keeps the current version in History.";
  if (!live) return "Not written yet. Publishing creates version 1.";
  const when = live.created_by_email && live.created_at ? `saved ${formatDate(live.created_at)}` : "original version";
  return `Live · version ${live.version} · ${when}`;
}

function BackLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mb-2 inline-flex items-center gap-1 text-[13px] font-semibold text-primary hover:underline"
    >
      <ChevronLeft className="h-[15px] w-[15px]" aria-hidden="true" />
      {label}
    </button>
  );
}

// ------------------------------------------------------------------
// Single prompt text (shared prompts and a journey's two prompts)
// ------------------------------------------------------------------

export function PromptTextPane({
  title,
  tag,
  explain,
  technical,
  crumb,
  onBack,
  versions,
  defaultLimit,
  onPublish,
  onHistory,
  onDirtyChange,
}: {
  title: string;
  tag: { label: string; bg: string; fg: string };
  explain: string;
  technical?: boolean;
  crumb?: string;
  onBack?: () => void;
  versions: PromptVersion[];
  defaultLimit: number;
  onPublish: (content: string) => Promise<unknown>;
  onHistory: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const textareaId = useId();
  const live = liveVersion(versions);
  const liveText = live?.content ?? "";
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const text = draft ?? liveText;
  const dirty = draft !== null && draft !== liveText;
  const limit = live?.character_limit ?? defaultLimit;

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onPublish(text.trim());
      setDraft(null);
    } catch (e) {
      setError(errorMessage(e, "Could not publish. Please try again."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-[26px] pt-[22px] pb-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            {crumb && onBack ? <BackLink label={crumb} onClick={onBack} /> : null}
            <div className="flex flex-wrap items-center gap-2.5">
              <h2 className="text-[20px] font-bold tracking-[-0.01em]">{title}</h2>
              <Pill bg={tag.bg} fg={tag.fg}>
                {tag.label}
              </Pill>
            </div>
            <p className="mt-1.5 max-w-[620px] text-[13.5px] leading-relaxed text-foreground/80">{explain}</p>
          </div>
          <HistoryButton onClick={onHistory} />
        </div>
        {technical ? (
          <div className="flex gap-2.5 rounded-[9px] border border-amber-200 bg-amber-50 px-3 py-2.5 text-[13px] leading-normal text-amber-800">
            <Info className="mt-0.5 h-4 w-4 flex-none" aria-hidden="true" />
            <span>{TECH_NOTE}</span>
          </div>
        ) : null}
        {error ? <Alert>{error}</Alert> : null}
        <label htmlFor={textareaId} className="sr-only">
          {title}
        </label>
        <textarea
          id={textareaId}
          value={text}
          onChange={(e) => setDraft(e.target.value)}
          aria-invalid={text.length > limit ? true : undefined}
          className={`${textareaClass} min-h-[320px] flex-1 text-[14.5px]`}
        />
      </div>
      <SaveFooter
        note={liveNote(live, dirty)}
        length={text.length}
        limit={limit}
        dirty={dirty}
        canSave={!!text.trim()}
        saving={saving}
        onDiscard={() => setDraft(null)}
        onSave={save}
      />
    </>
  );
}

// ------------------------------------------------------------------
// Journey overview
// ------------------------------------------------------------------

export function JourneyPane({
  journey,
  feedback,
  clusterFeedback,
  onOpenPrompt,
  onOpenSituation,
  onAddSituation,
  onEditDetails,
}: {
  journey: Journey;
  feedback?: FeedbackCount;
  clusterFeedback: Map<string, FeedbackCount>;
  onOpenPrompt: (field: "detective_questions" | "guidance") => void;
  onOpenSituation: (key: string) => void;
  onAddSituation: () => void;
  onEditDetails: () => void;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const live = activeClusters(journey);
  const archived = journey.clusters.filter((c) => c.is_archived).sort(bySortOrder);
  const rows = showArchived ? [...live, ...archived] : live;
  const chips = signalChips(journey.detection_signals);

  const promptCards = [
    {
      field: "detective_questions" as const,
      num: "1",
      title: "Questions to ask",
      when: "While asking questions · this journey only",
      color: STAGE_STYLE.asking.fg,
      text: liveVersion(journey.prompts.detective_questions)?.content ?? "",
    },
    {
      field: "guidance" as const,
      num: "2",
      title: "How to guide",
      when: "While giving guidance · this journey only",
      color: STAGE_STYLE.guiding.fg,
      text: liveVersion(journey.prompts.guidance)?.content ?? "",
    },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-[22px] overflow-y-auto px-[26px] pt-[22px] pb-[26px]">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="rounded-full bg-primary px-[9px] py-0.5 font-mono text-xs font-medium text-white">
              {journey.key}
            </span>
            <h2 className="text-[20px] font-bold tracking-[-0.01em]">{journey.name}</h2>
            {journey.is_archived ? (
              <Pill bg="rgba(22,24,29,0.07)" fg="rgba(22,24,29,0.75)">
                Archived
              </Pill>
            ) : null}
          </div>
          <p className="mt-2 max-w-[640px] text-[13.5px] leading-relaxed text-foreground/80">
            A journey is a family's broad situation. It adds its own questions and guidance on top of the shared
            rules, and holds the specific situations families meet along the way.
          </p>
          <div className="mt-2">
            <Rating count={feedback} />
          </div>
        </div>
        <button type="button" onClick={onEditDetails} className={`${outlineButton} h-9 text-[13.5px]`}>
          <Settings2 className="h-4 w-4" aria-hidden="true" />
          Details
        </button>
      </div>

      {journey.is_archived ? (
        <Alert tone="warning">
          This journey is archived, so the assistant does not use it or its situations. Restore it from Details.
        </Alert>
      ) : null}

      <section className="flex flex-col gap-2.5" aria-labelledby={`${journey.id}-spots`}>
        <h3 id={`${journey.id}-spots`} className="text-[15px] font-bold">
          How the assistant spots this journey
        </h3>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="rounded-[10px] border border-foreground/10 bg-muted px-4 py-3.5">
            <div className="text-xs font-bold uppercase tracking-[0.04em] text-foreground/70">Who it's for</div>
            <p className="mt-1.5 text-[13.5px] leading-relaxed">
              {journey.description.replace(/\n/g, " ") || "No description yet."}
            </p>
          </div>
          <div className="rounded-[10px] border border-foreground/10 bg-muted px-4 py-3.5">
            <div className="text-xs font-bold uppercase tracking-[0.04em] text-foreground/70">Words families use</div>
            {chips.length ? (
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {chips.map((w) => (
                  <li key={w} className="rounded-full border border-foreground/14 bg-white px-[9px] py-[3px] text-[12.5px]">
                    {w}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1.5 text-[13.5px] text-foreground/70">None yet. Add them in Details.</p>
            )}
          </div>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {promptCards.map((card) => (
          <button
            key={card.field}
            type="button"
            onClick={() => onOpenPrompt(card.field)}
            className="flex flex-col gap-2 rounded-[11px] border border-foreground/14 bg-white p-4 text-left hover:border-primary/40"
          >
            <span className="flex w-full items-center gap-2">
              <span
                className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-full text-xs font-bold text-white"
                style={{ background: card.color }}
                aria-hidden="true"
              >
                {card.num}
              </span>
              <span className="text-[14.5px] font-bold">{card.title}</span>
              <span className="ml-auto inline-flex items-center gap-1 text-[13px] font-semibold text-primary">
                <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                Edit
              </span>
            </span>
            <span className="text-[12.5px] text-foreground/72">{card.when}</span>
            <span className="block whitespace-pre-line rounded-lg bg-muted px-3 py-2.5 text-[13px] leading-relaxed text-foreground/88">
              {card.text ? firstLines(card.text, 3) : "Not written yet."}
            </span>
          </button>
        ))}
      </div>

      <section className="flex flex-col gap-2.5" aria-labelledby={`${journey.id}-situations`}>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h3 id={`${journey.id}-situations`} className="text-[15px] font-bold">
              Situations · {live.length}
            </h3>
            <p className="mt-0.5 max-w-[560px] text-[13px] leading-normal text-foreground/75">
              Specific needs within this journey. When giving guidance, the assistant adds the steps for the one or
              two that fit best.
            </p>
          </div>
          <button type="button" onClick={onAddSituation} className={`${outlineButton} h-[34px] text-[13.5px]`}>
            <Plus className="h-[15px] w-[15px]" aria-hidden="true" />
            Add situation
          </button>
        </div>
        <div className="overflow-hidden rounded-[11px] border border-foreground/12">
          <ul>
            {rows.map((c) => (
              <li key={c.id}>
                <SituationRow cluster={c} feedback={clusterFeedback.get(c.key)} onOpen={() => onOpenSituation(c.key)} />
              </li>
            ))}
          </ul>
          {rows.length === 0 ? (
            <p className="px-4 py-3 text-[13px] text-foreground/70">No situations yet.</p>
          ) : null}
          {archived.length ? (
            <button
              type="button"
              onClick={() => setShowArchived((s) => !s)}
              aria-expanded={showArchived}
              className="w-full border-b border-foreground/8 bg-white px-4 py-2 text-left text-[12.5px] font-semibold text-primary hover:underline"
            >
              {showArchived ? "Hide" : "Show"} {archived.length} archived situation{archived.length === 1 ? "" : "s"}
            </button>
          ) : null}
          <div className="flex items-start gap-3 border-t border-dashed px-4 py-3.5" style={{ background: "oklch(0.97 0.02 160)", borderColor: "oklch(0.70 0.08 160)" }}>
            <LifeBuoy className="mt-px h-5 w-5 flex-none" style={{ color: "oklch(0.38 0.09 160)" }} aria-hidden="true" />
            <div>
              <div className="text-sm font-bold" style={{ color: "oklch(0.30 0.08 160)" }}>
                None of these fit? The family is still helped.
              </div>
              <p className="mt-0.5 text-[13px] leading-relaxed" style={{ color: "oklch(0.30 0.06 160)" }}>
                If the assistant can't tell which situation a family is in, it uses this journey's guidance with the
                steps from all {live.length} situations. If even the journey is unclear, it uses every journey.
                Situations make answers sharper; they never leave a family without help.
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function SituationRow({
  cluster,
  feedback,
  onOpen,
}: {
  cluster: JourneyCluster;
  feedback?: FeedbackCount;
  onOpen: () => void;
}) {
  const urgent = cluster.priority <= 2;
  const rated = feedback && feedback.up + feedback.down > 0;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="grid w-full grid-cols-[40px_minmax(0,1fr)_18px] items-center gap-3 border-b border-foreground/8 bg-white px-3.5 py-[11px] text-left hover:bg-muted md:grid-cols-[40px_minmax(0,1.1fr)_minmax(0,1.4fr)_130px_18px]"
    >
      <span className="justify-self-start">
        <KeyPill value={cluster.key} />
      </span>
      <span className="text-sm font-semibold leading-snug">
        {cluster.name}
        {cluster.is_archived ? <span className="ml-2 text-xs font-medium text-foreground/60">(archived)</span> : null}
        {rated ? (
          <span className="block text-xs font-medium text-foreground/65">
            {feedback.up} up · {feedback.down} down
          </span>
        ) : null}
      </span>
      <span className="hidden text-[12.5px] leading-snug text-foreground/72 md:line-clamp-2">
        {cluster.matches_when.replace(/\n/g, " ")}
      </span>
      <span className="hidden justify-self-start md:inline">
        <Pill
          bg={urgent ? "oklch(0.95 0.04 75)" : "rgba(22,24,29,0.06)"}
          fg={urgent ? "oklch(0.38 0.09 75)" : "rgba(22,24,29,0.75)"}
        >
          {cluster.priority} · {urgencyLabel(cluster.priority)}
        </Pill>
      </span>
      <ChevronRight className="h-4 w-4 text-foreground/50" aria-hidden="true" />
    </button>
  );
}

// ------------------------------------------------------------------
// Situation editor
// ------------------------------------------------------------------

export function SituationPane({
  journey,
  cluster,
  feedback,
  onBack,
  onHistory,
  onEditDetails,
  onPublishSteps,
  onUpdate,
  onDirtyChange,
}: {
  journey: Journey;
  cluster: JourneyCluster;
  feedback?: FeedbackCount;
  onBack: () => void;
  onHistory: () => void;
  onEditDetails: () => void;
  onPublishSteps: (content: string) => Promise<unknown>;
  onUpdate: (patch: ClusterPatch) => Promise<unknown>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const versions = cluster.prompts.response_pattern;
  const live = liveVersion(versions);
  const liveSteps = live?.content ?? "";
  const [steps, setSteps] = useState<string | null>(null);
  const [matches, setMatches] = useState<string | null>(null);
  const [urgency, setUrgency] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stepsText = steps ?? liveSteps;
  const matchesText = matches ?? cluster.matches_when;
  const urgencyValue = urgency ?? cluster.priority;
  const stepsDirty = steps !== null && steps !== liveSteps;
  const metaPatch: ClusterPatch = {};
  if (matches !== null && matches.trim() !== cluster.matches_when) metaPatch.matches_when = matches.trim();
  if (urgency !== null && urgency !== cluster.priority) metaPatch.priority = urgency;
  const dirty = stepsDirty || Object.keys(metaPatch).length > 0;
  const limit = live?.character_limit ?? DEFAULT_PROMPT_LIMITS.response_pattern;

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const discard = () => {
    setSteps(null);
    setMatches(null);
    setUrgency(null);
    setError(null);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      if (Object.keys(metaPatch).length) {
        await onUpdate(metaPatch);
        setMatches(null);
        setUrgency(null);
      }
      if (stepsDirty) {
        await onPublishSteps(stepsText.trim());
        setSteps(null);
      }
    } catch (e) {
      setError(errorMessage(e, "Could not publish. Please try again."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-[26px] py-[22px]">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <BackLink label={`${journey.key} · ${journey.name}`} onClick={onBack} />
            <div className="flex flex-wrap items-center gap-2.5">
              <KeyPill value={cluster.key} />
              <h2 className="text-[20px] font-bold tracking-[-0.01em]">{cluster.name}</h2>
              <Pill bg={STAGE_STYLE.guiding.bg} fg={STAGE_STYLE.guiding.fg}>
                Giving guidance · when this fits
              </Pill>
              {cluster.is_archived ? (
                <Pill bg="rgba(22,24,29,0.07)" fg="rgba(22,24,29,0.75)">
                  Archived
                </Pill>
              ) : null}
            </div>
            <div className="mt-2">
              <Rating count={feedback} />
            </div>
          </div>
          <div className="flex flex-none gap-2">
            <button type="button" onClick={onEditDetails} className={`${outlineButton} h-9 text-[13.5px]`}>
              <Settings2 className="h-4 w-4" aria-hidden="true" />
              Details
            </button>
            <HistoryButton onClick={onHistory} />
          </div>
        </div>

        {error ? <Alert>{error}</Alert> : null}

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
          <TextAreaField
            label="Use this situation when…"
            labelClassName="text-[13.5px] font-bold"
            value={matchesText}
            onChange={setMatches}
            rows={4}
            maxLength={2000}
            required
            error={!matchesText.trim() ? "Describe when this situation applies." : null}
            hint="Plain words. The assistant reads this to decide if the situation fits a family."
          />
          <UrgencyPicker value={urgencyValue} onChange={setUrgency} />
        </div>

        <TextAreaField
          label="Steps to follow"
          labelClassName="text-[13.5px] font-bold"
          value={stepsText}
          onChange={setSteps}
          className="min-h-[250px] flex-1"
          rows={10}
          hint="Added after the journey's guidance, only when this situation fits."
        />
      </div>
      <SaveFooter
        note={liveNote(live, dirty)}
        length={stepsText.length}
        limit={limit}
        dirty={dirty}
        canSave={!!stepsText.trim() && !!matchesText.trim()}
        saving={saving}
        onDiscard={discard}
        onSave={save}
      />
    </>
  );
}
