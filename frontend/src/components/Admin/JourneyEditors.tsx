import { useEffect, useId, useState, type ReactNode } from "react";
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  Plus,
  Save,
  ThumbsDown,
  ThumbsUp,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import VersionedPromptEditor from "@/components/Admin/VersionedPromptEditor";
import {
  DEFAULT_PROMPT_LIMITS,
  MAX_PRIORITY,
  MIN_PRIORITY,
  keyError,
  type ClusterInput,
  type ClusterPatch,
  type FeedbackCount,
  type Journey,
  type JourneyCluster,
  type JourneyInput,
  type JourneyPatch,
  type JourneyPromptField,
} from "@/types/journeys";

export type JourneyActions = {
  updateJourney: (id: string, patch: JourneyPatch) => Promise<unknown>;
  createCluster: (journeyId: string, input: ClusterInput) => Promise<unknown>;
  updateCluster: (id: string, patch: ClusterPatch) => Promise<unknown>;
  saveVersion: (field: JourneyPromptField, ownerId: string, content: string) => Promise<unknown>;
  deleteVersion: (versionId: string) => Promise<unknown>;
  activateVersion: (versionId: string) => Promise<unknown>;
};

const PRIORITIES = Array.from({ length: MAX_PRIORITY - MIN_PRIORITY + 1 }, (_, i) => MIN_PRIORITY + i);

const textareaClass =
  "flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background";

const errorMessage = (e: unknown, fallback: string) =>
  e instanceof Error && e.message ? e.message : fallback;

// ------------------------------------------------------------------
// Small building blocks
// ------------------------------------------------------------------

function TextArea({
  label,
  value,
  onChange,
  rows = 3,
  hint,
  required,
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  hint?: string;
  required?: boolean;
  maxLength?: number;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </Label>
      <textarea
        id={id}
        value={value}
        rows={rows}
        required={required}
        maxLength={maxLength}
        aria-describedby={hint ? hintId : undefined}
        onChange={(e) => onChange(e.target.value)}
        className={textareaClass}
      />
      {hint ? (
        <p id={hintId} className="text-xs text-gray-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  hint,
  error,
  required,
  maxLength,
  type = "text",
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  error?: string | null;
  required?: boolean;
  maxLength?: number;
  type?: string;
  disabled?: boolean;
}) {
  const id = useId();
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ");
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </Label>
      <Input
        id={id}
        type={type}
        value={value}
        required={required}
        maxLength={maxLength}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint ? (
        <p id={`${id}-hint`} className="text-xs text-gray-500">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="text-xs text-red-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function PrioritySelect({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>Priority</Label>
      <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PRIORITIES.map((p) => (
            <SelectItem key={p} value={String(p)}>
              {p}
              {p === 1 ? " (most pressing)" : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-gray-500">
        When a conversation touches more than one situation, the guide addresses the lowest number first.
      </p>
    </div>
  );
}

function StatusMessage({ error, notice }: { error?: string | null; notice?: string | null }) {
  if (error) {
    return (
      <p role="alert" className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
        {error}
      </p>
    );
  }
  if (notice) {
    return (
      <p role="status" className="text-xs text-green-700">
        {notice}
      </p>
    );
  }
  return null;
}

/** Thumbs up/down counts with the share of positive ratings. */
export function FeedbackStat({ count }: { count?: FeedbackCount }) {
  if (!count || count.up + count.down === 0) {
    return <span className="text-xs text-gray-500">No ratings yet</span>;
  }
  const total = count.up + count.down;
  const positive = Math.round((count.up / total) * 100);
  const tone = positive >= 70 ? "text-green-700" : positive >= 40 ? "text-amber-700" : "text-red-700";
  return (
    <span className="inline-flex items-center gap-2 text-xs text-gray-700">
      <span className="inline-flex items-center gap-1">
        <ThumbsUp className="h-3.5 w-3.5" aria-hidden="true" />
        <span className="sr-only">Thumbs up:</span>
        {count.up}
      </span>
      <span className="inline-flex items-center gap-1">
        <ThumbsDown className="h-3.5 w-3.5" aria-hidden="true" />
        <span className="sr-only">Thumbs down:</span>
        {count.down}
      </span>
      <span className={`font-semibold ${tone}`}>{positive}% positive</span>
    </span>
  );
}

function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  busy,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  busy: boolean;
  error?: string | null;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <StatusMessage error={error} />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={onConfirm} disabled={busy}>
            {busy ? "Working..." : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ArchiveButton({
  archived,
  label,
  description,
  onToggle,
}: {
  archived: boolean;
  label: string;
  description: ReactNode;
  onToggle: () => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onToggle();
      setOpen(false);
    } catch (e) {
      setError(errorMessage(e, "Could not update. Please try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        {archived ? (
          <ArchiveRestore className="mr-1.5 h-4 w-4" aria-hidden="true" />
        ) : (
          <Archive className="mr-1.5 h-4 w-4" aria-hidden="true" />
        )}
        {archived ? "Restore" : "Archive"}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={archived ? `Restore ${label}?` : `Archive ${label}?`}
        description={description}
        confirmLabel={archived ? "Restore" : "Archive"}
        busy={busy}
        error={error}
        onConfirm={confirm}
      />
    </>
  );
}

function Collapsible({
  header,
  children,
  defaultOpen = false,
  level = "journey",
}: {
  header: (toggle: ReactNode) => ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  level?: "journey" | "cluster";
}) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();
  const toggle = (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={panelId}
      onClick={() => setOpen((o) => !o)}
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-foreground/12 bg-white hover:bg-muted"
    >
      {open ? <ChevronDown className="h-4 w-4" aria-hidden="true" /> : <ChevronRight className="h-4 w-4" aria-hidden="true" />}
      <span className="sr-only">{open ? "Collapse" : "Expand"}</span>
    </button>
  );
  return (
    <section
      className={
        level === "journey"
          ? "rounded-[13px] border border-foreground/12 bg-white shadow-sm"
          : "rounded-lg border border-gray-200 bg-gray-50/60"
      }
    >
      <div className={level === "journey" ? "p-4 md:p-5" : "p-3 md:p-4"}>{header(toggle)}</div>
      <div id={panelId} hidden={!open} className={level === "journey" ? "space-y-6 border-t border-foreground/10 p-4 md:p-5" : "space-y-5 border-t border-gray-200 p-3 md:p-4"}>
        {open ? children : null}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------
// Metadata forms
// ------------------------------------------------------------------

function JourneyDetailsForm({ journey, onSave }: { journey: Journey; onSave: (patch: JourneyPatch) => Promise<unknown> }) {
  const [name, setName] = useState(journey.name);
  const [description, setDescription] = useState(journey.description);
  const [signals, setSignals] = useState(journey.detection_signals);
  const [sortOrder, setSortOrder] = useState(String(journey.sort_order));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setName(journey.name);
    setDescription(journey.description);
    setSignals(journey.detection_signals);
    setSortOrder(String(journey.sort_order));
  }, [journey.name, journey.description, journey.detection_signals, journey.sort_order]);

  const dirty =
    name !== journey.name ||
    description !== journey.description ||
    signals !== journey.detection_signals ||
    sortOrder !== String(journey.sort_order);

  const save = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await onSave({
        name: name.trim(),
        description: description.trim(),
        detection_signals: signals.trim(),
        sort_order: Number(sortOrder) || 0,
      });
      setNotice("Details saved.");
    } catch (e) {
      setError(errorMessage(e, "Could not save details."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <h4 className="text-[15px] font-semibold">Journey details</h4>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_140px]">
        <TextField label="Name" value={name} onChange={setName} required maxLength={120} />
        <TextField label="Display order" type="number" value={sortOrder} onChange={setSortOrder} />
      </div>
      <TextArea
        label="Description"
        value={description}
        onChange={setDescription}
        maxLength={2000}
        hint="Who this journey is for. The router and the detective questions use it to recognise the journey."
      />
      <TextArea
        label="Detection signals"
        value={signals}
        onChange={setSignals}
        rows={4}
        maxLength={4000}
        hint='Words and phrases families use in this journey, for example "sent home," "reduced schedule."'
      />
      <StatusMessage error={error} notice={notice} />
      <Button type="button" onClick={save} disabled={saving || !dirty || !name.trim()}>
        <Save className="mr-2 h-4 w-4" aria-hidden="true" />
        {saving ? "Saving..." : "Save details"}
      </Button>
    </div>
  );
}

function ClusterDetailsForm({
  cluster,
  onSave,
}: {
  cluster: JourneyCluster;
  onSave: (patch: ClusterPatch) => Promise<unknown>;
}) {
  const [name, setName] = useState(cluster.name);
  const [matches, setMatches] = useState(cluster.matches_when);
  const [priority, setPriority] = useState(cluster.priority);
  const [sortOrder, setSortOrder] = useState(String(cluster.sort_order));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setName(cluster.name);
    setMatches(cluster.matches_when);
    setPriority(cluster.priority);
    setSortOrder(String(cluster.sort_order));
  }, [cluster.name, cluster.matches_when, cluster.priority, cluster.sort_order]);

  const dirty =
    name !== cluster.name ||
    matches !== cluster.matches_when ||
    priority !== cluster.priority ||
    sortOrder !== String(cluster.sort_order);

  const save = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await onSave({
        name: name.trim(),
        matches_when: matches.trim(),
        priority,
        sort_order: Number(sortOrder) || 0,
      });
      setNotice("Details saved.");
    } catch (e) {
      setError(errorMessage(e, "Could not save details."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_180px_140px]">
        <TextField label="Name" value={name} onChange={setName} required maxLength={120} />
        <PrioritySelect value={priority} onChange={setPriority} />
        <TextField label="Display order" type="number" value={sortOrder} onChange={setSortOrder} />
      </div>
      <TextArea
        label="Matches when"
        value={matches}
        onChange={setMatches}
        rows={4}
        required
        maxLength={2000}
        hint="Describe when this situation applies. The router reads this to pick the situation for each message."
      />
      <StatusMessage error={error} notice={notice} />
      <Button type="button" onClick={save} disabled={saving || !dirty || !name.trim() || !matches.trim()}>
        <Save className="mr-2 h-4 w-4" aria-hidden="true" />
        {saving ? "Saving..." : "Save details"}
      </Button>
    </div>
  );
}

// ------------------------------------------------------------------
// Create dialogs
// ------------------------------------------------------------------

export function AddJourneyDialog({
  open,
  onOpenChange,
  takenKeys,
  nextSortOrder,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  takenKeys: string[];
  nextSortOrder: number;
  onCreate: (input: JourneyInput) => Promise<unknown>;
}) {
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [signals, setSignals] = useState("");
  const [questions, setQuestions] = useState("");
  const [guidance, setGuidance] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (open) {
      setKey("");
      setName("");
      setDescription("");
      setSignals("");
      setQuestions("");
      setGuidance("");
      setError(null);
      setTouched(false);
    }
  }, [open]);

  const keyProblem = keyError(key, takenKeys);

  const create = async () => {
    setTouched(true);
    if (keyProblem || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate({
        key,
        name: name.trim(),
        description: description.trim(),
        detection_signals: signals.trim(),
        sort_order: nextSortOrder,
        detective_questions: questions.trim() || undefined,
        guidance: guidance.trim() || undefined,
      });
      onOpenChange(false);
    } catch (e) {
      setError(errorMessage(e, "Could not create the journey."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add a journey</DialogTitle>
          <DialogDescription>
            New journeys are used for the next conversations once saved (within about five minutes).
            You can add situations after creating it.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-[160px_1fr]">
            <TextField
              label="Key"
              value={key}
              onChange={(v) => setKey(v.toUpperCase())}
              maxLength={16}
              required
              hint="For example J3. Cannot be changed later."
              error={touched || key ? keyProblem : null}
            />
            <TextField label="Name" value={name} onChange={setName} required maxLength={120}
              error={touched && !name.trim() ? "Enter a name." : null} />
          </div>
          <TextArea label="Description" value={description} onChange={setDescription} maxLength={2000} />
          <TextArea label="Detection signals" value={signals} onChange={setSignals} rows={3} maxLength={4000}
            hint="Words and phrases families use in this journey." />
          <TextArea label="Detective questions" value={questions} onChange={setQuestions} rows={4}
            maxLength={DEFAULT_PROMPT_LIMITS.detective_questions}
            hint="The questions to ask, in order, to understand where the family is. Saved as version 1." />
          <TextArea label="Guidance" value={guidance} onChange={setGuidance} rows={3}
            maxLength={DEFAULT_PROMPT_LIMITS.guidance}
            hint="How to guide families in this journey. Saved as version 1." />
          <StatusMessage error={error} />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={create} disabled={busy}>
            {busy ? "Creating..." : "Create journey"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddClusterDialog({
  open,
  onOpenChange,
  journey,
  takenKeys,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  journey: Journey;
  takenKeys: string[];
  onCreate: (input: ClusterInput) => Promise<unknown>;
}) {
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [matches, setMatches] = useState("");
  const [priority, setPriority] = useState(5);
  const [pattern, setPattern] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (open) {
      setKey("");
      setName("");
      setMatches("");
      setPriority(5);
      setPattern("");
      setError(null);
      setTouched(false);
    }
  }, [open]);

  const keyProblem = keyError(key, takenKeys);

  const create = async () => {
    setTouched(true);
    if (keyProblem || !name.trim() || !matches.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate({
        key,
        name: name.trim(),
        matches_when: matches.trim(),
        priority,
        sort_order: journey.clusters.length + 1,
        response_pattern: pattern.trim() || undefined,
      });
      onOpenChange(false);
    } catch (e) {
      setError(errorMessage(e, "Could not create the situation."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add a situation to {journey.name}</DialogTitle>
          <DialogDescription>
            Situations are the specific needs within a journey. The router picks one for each message, and
            only the matching situation&apos;s response pattern is sent with the guidance.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-[160px_1fr]">
            <TextField
              label="Key"
              value={key}
              onChange={(v) => setKey(v.toUpperCase())}
              maxLength={16}
              required
              hint="For example P. Unique across all journeys."
              error={touched || key ? keyProblem : null}
            />
            <TextField label="Name" value={name} onChange={setName} required maxLength={120}
              error={touched && !name.trim() ? "Enter a name." : null} />
          </div>
          <PrioritySelect value={priority} onChange={setPriority} />
          <TextArea label="Matches when" value={matches} onChange={setMatches} rows={3} required maxLength={2000}
            hint={touched && !matches.trim() ? "Describe when this situation applies." : "When this situation applies, in plain language."} />
          <TextArea label="Response pattern" value={pattern} onChange={setPattern} rows={6}
            maxLength={DEFAULT_PROMPT_LIMITS.response_pattern}
            hint="The steps the guide follows for this situation. Saved as version 1." />
          <StatusMessage error={error} />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={create} disabled={busy}>
            {busy ? "Creating..." : "Create situation"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------
// Cards
// ------------------------------------------------------------------

function ClusterCard({
  cluster,
  journeyArchived,
  feedback,
  actions,
}: {
  cluster: JourneyCluster;
  journeyArchived: boolean;
  feedback?: FeedbackCount;
  actions: JourneyActions;
}) {
  return (
    <Collapsible
      level="cluster"
      header={(toggle) => (
        <div className="flex flex-wrap items-center gap-3">
          {toggle}
          <Badge variant="outline" className="font-mono">{cluster.key}</Badge>
          <h5 className="min-w-0 flex-1 text-[14.5px] font-semibold">{cluster.name}</h5>
          <span className="text-xs text-gray-600">Priority {cluster.priority}</span>
          {cluster.is_archived ? <Badge variant="secondary">Archived</Badge> : null}
          <FeedbackStat count={feedback} />
          <ArchiveButton
            archived={cluster.is_archived}
            label={`situation ${cluster.key}`}
            description={
              cluster.is_archived
                ? "The router can pick this situation again and its response pattern will be sent with guidance."
                : "The router will stop picking this situation and its response pattern will no longer be sent. History and feedback are kept, and you can restore it."
            }
            onToggle={() => actions.updateCluster(cluster.id, { is_archived: !cluster.is_archived })}
          />
        </div>
      )}
    >
      {journeyArchived && !cluster.is_archived ? (
        <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          This journey is archived, so its situations are not used either.
        </p>
      ) : null}
      <ClusterDetailsForm cluster={cluster} onSave={(patch) => actions.updateCluster(cluster.id, patch)} />
      <VersionedPromptEditor
        title={`Response pattern — ${cluster.key}`}
        label={`the ${cluster.name} response pattern`}
        description="Sent with guidance turns when the router picks this situation."
        contentLabel="Response pattern"
        versions={cluster.prompts.response_pattern}
        defaultCharacterLimit={DEFAULT_PROMPT_LIMITS.response_pattern}
        onSave={async (content) => {
          await actions.saveVersion("response_pattern", cluster.id, content);
        }}
        onDelete={async (id) => {
          await actions.deleteVersion(id);
        }}
        onActivate={async (id) => {
          await actions.activateVersion(id);
        }}
      />
    </Collapsible>
  );
}

export function JourneyCard({
  journey,
  showArchived,
  takenClusterKeys,
  feedbackByJourney,
  feedbackByCluster,
  actions,
}: {
  journey: Journey;
  showArchived: boolean;
  takenClusterKeys: string[];
  feedbackByJourney: Map<string, FeedbackCount>;
  feedbackByCluster: Map<string, FeedbackCount>;
  actions: JourneyActions;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const clusters = [...journey.clusters]
    .filter((c) => showArchived || !c.is_archived)
    .sort((a, b) => a.sort_order - b.sort_order || a.key.localeCompare(b.key));
  const activeCount = journey.clusters.filter((c) => !c.is_archived).length;

  return (
    <Collapsible
      header={(toggle) => (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            {toggle}
            <Badge className="font-mono">{journey.key}</Badge>
            <h3 className="min-w-0 flex-1 text-[17px] font-bold tracking-[-0.01em]">{journey.name}</h3>
            {journey.is_archived ? <Badge variant="secondary">Archived</Badge> : null}
            <FeedbackStat count={feedbackByJourney.get(journey.key)} />
            <ArchiveButton
              archived={journey.is_archived}
              label={`journey ${journey.key}`}
              description={
                journey.is_archived
                  ? "The router can pick this journey and its situations again."
                  : "The router will stop picking this journey and its situations. History and feedback are kept, and you can restore it."
              }
              onToggle={() => actions.updateJourney(journey.id, { is_archived: !journey.is_archived })}
            />
          </div>
          <p className="pl-11 text-[13.5px] text-foreground/75">
            {journey.description || "No description yet."}{" "}
            <span className="whitespace-nowrap text-gray-500">
              {activeCount} active situation{activeCount === 1 ? "" : "s"}
            </span>
          </p>
        </div>
      )}
    >
      <JourneyDetailsForm journey={journey} onSave={(patch) => actions.updateJourney(journey.id, patch)} />

      <div className="grid grid-cols-1 gap-6">
        <VersionedPromptEditor
          title={`Detective questions — ${journey.key}`}
          label={`the ${journey.name} detective questions`}
          description="Asked one at a time while the guide is still learning about the family's situation."
          contentLabel="Detective questions"
          versions={journey.prompts.detective_questions}
          defaultCharacterLimit={DEFAULT_PROMPT_LIMITS.detective_questions}
          minRows={6}
          onSave={async (content) => {
            await actions.saveVersion("detective_questions", journey.id, content);
          }}
          onDelete={async (id) => {
            await actions.deleteVersion(id);
          }}
          onActivate={async (id) => {
            await actions.activateVersion(id);
          }}
        />
        <VersionedPromptEditor
          title={`Journey guidance — ${journey.key}`}
          label={`the ${journey.name} guidance`}
          description="Sent with guidance turns for this journey, before the matching situation's response pattern."
          contentLabel="Journey guidance"
          versions={journey.prompts.guidance}
          defaultCharacterLimit={DEFAULT_PROMPT_LIMITS.guidance}
          minRows={6}
          onSave={async (content) => {
            await actions.saveVersion("guidance", journey.id, content);
          }}
          onDelete={async (id) => {
            await actions.deleteVersion(id);
          }}
          onActivate={async (id) => {
            await actions.activateVersion(id);
          }}
        />
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h4 className="text-[15px] font-semibold">Situations in this journey</h4>
            <p className="text-xs text-gray-500">
              Only the situation the router picks (plus a second one if the family has two needs) is sent with guidance.
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="mr-1.5 h-4 w-4" aria-hidden="true" />
            Add situation
          </Button>
        </div>
        {clusters.length === 0 ? (
          <p className="text-sm text-gray-500">No situations yet.</p>
        ) : (
          <div className="space-y-3">
            {clusters.map((c) => (
              <ClusterCard
                key={c.id}
                cluster={c}
                journeyArchived={journey.is_archived}
                feedback={feedbackByCluster.get(c.key)}
                actions={actions}
              />
            ))}
          </div>
        )}
      </div>

      <AddClusterDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        journey={journey}
        takenKeys={takenClusterKeys}
        onCreate={(input) => actions.createCluster(journey.id, input)}
      />
    </Collapsible>
  );
}
