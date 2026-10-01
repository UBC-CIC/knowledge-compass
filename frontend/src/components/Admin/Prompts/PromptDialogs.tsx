import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Alert, TextAreaField, TextField, UrgencyPicker } from "@/components/Admin/Prompts/parts";
import {
  DEFAULT_PROMPT_LIMITS,
  keyError,
  type ClusterInput,
  type ClusterPatch,
  type Journey,
  type JourneyCluster,
  type JourneyInput,
  type JourneyPatch,
} from "@/types/journeys";

const errorMessage = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

function useBusy() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>, fallback: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(errorMessage(e, fallback));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}

/** Archive / restore with an inline confirmation step. */
function ArchiveSection({
  archived,
  what,
  effect,
  busy,
  onToggle,
}: {
  archived: boolean;
  what: string;
  effect: string;
  busy: boolean;
  onToggle: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="rounded-[10px] border border-foreground/12 bg-muted px-4 py-3">
      <div className="text-[13.5px] font-bold">{archived ? `Restore this ${what}` : `Archive this ${what}`}</div>
      <p className="mt-1 text-[12.5px] leading-normal text-foreground/75">{effect}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {confirming ? (
          <>
            <Button type="button" size="sm" onClick={onToggle} disabled={busy}>
              {busy ? "Working..." : archived ? "Yes, restore" : "Yes, archive"}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setConfirming(false)} disabled={busy}>
              Cancel
            </Button>
          </>
        ) : (
          <Button type="button" size="sm" variant="outline" onClick={() => setConfirming(true)}>
            {archived ? `Restore ${what}` : `Archive ${what}`}
          </Button>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// Journeys
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
  const [touched, setTouched] = useState(false);
  const { busy, error, setError, run } = useBusy();

  useEffect(() => {
    if (!open) return;
    setKey("");
    setName("");
    setDescription("");
    setSignals("");
    setQuestions("");
    setGuidance("");
    setTouched(false);
    setError(null);
  }, [open, setError]);

  const keyProblem = keyError(key, takenKeys);

  const create = async () => {
    setTouched(true);
    if (keyProblem || !name.trim()) return;
    const ok = await run(
      () =>
        onCreate({
          key,
          name: name.trim(),
          description: description.trim(),
          detection_signals: signals.trim(),
          sort_order: nextSortOrder,
          detective_questions: questions.trim() || undefined,
          guidance: guidance.trim() || undefined,
        }),
      "Could not create the journey."
    );
    if (ok) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add a journey</DialogTitle>
          <DialogDescription>
            A journey is a family's broad situation. Add its situations after creating it. New journeys reach
            conversations within about five minutes.
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
            <TextField
              label="Name"
              value={name}
              onChange={setName}
              required
              maxLength={120}
              error={touched && !name.trim() ? "Enter a name." : null}
            />
          </div>
          <TextAreaField label="Who it's for" value={description} onChange={setDescription} maxLength={2000} />
          <TextAreaField
            label="Words families use"
            value={signals}
            onChange={setSignals}
            maxLength={4000}
            hint='Put each phrase in quotes, for example "moving to high school," "course selection".'
          />
          <TextAreaField
            label="Questions to ask"
            value={questions}
            onChange={setQuestions}
            rows={4}
            maxLength={DEFAULT_PROMPT_LIMITS.detective_questions}
            hint="The questions to work through, in order, while the assistant learns where the family is."
          />
          <TextAreaField
            label="How to guide"
            value={guidance}
            onChange={setGuidance}
            rows={3}
            maxLength={DEFAULT_PROMPT_LIMITS.guidance}
            hint="Added to every guidance reply in this journey."
          />
          {error ? <Alert>{error}</Alert> : null}
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

export function JourneyDetailsDialog({
  open,
  onOpenChange,
  journey,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  journey: Journey;
  onSave: (patch: JourneyPatch) => Promise<unknown>;
}) {
  const [name, setName] = useState(journey.name);
  const [description, setDescription] = useState(journey.description);
  const [signals, setSignals] = useState(journey.detection_signals);
  const [order, setOrder] = useState(String(journey.sort_order));
  const { busy, error, setError, run } = useBusy();

  useEffect(() => {
    if (!open) return;
    setName(journey.name);
    setDescription(journey.description);
    setSignals(journey.detection_signals);
    setOrder(String(journey.sort_order));
    setError(null);
  }, [open, journey, setError]);

  const save = async () => {
    if (!name.trim()) return;
    const ok = await run(
      () =>
        onSave({
          name: name.trim(),
          description: description.trim(),
          detection_signals: signals.trim(),
          sort_order: Number(order) || 0,
        }),
      "Could not save the journey."
    );
    if (ok) onOpenChange(false);
  };

  const toggleArchive = async () => {
    const ok = await run(() => onSave({ is_archived: !journey.is_archived }), "Could not update the journey.");
    if (ok) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {journey.key} · Journey details
          </DialogTitle>
          <DialogDescription>
            The assistant reads these to recognise the journey. The key cannot be changed.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_140px]">
            <TextField
              label="Name"
              value={name}
              onChange={setName}
              required
              maxLength={120}
              error={!name.trim() ? "Enter a name." : null}
            />
            <TextField label="Display order" type="number" value={order} onChange={setOrder} />
          </div>
          <TextAreaField label="Who it's for" value={description} onChange={setDescription} maxLength={2000} />
          <TextAreaField
            label="Words families use"
            value={signals}
            onChange={setSignals}
            rows={4}
            maxLength={4000}
            hint='Put each phrase in quotes, for example "sent home," "reduced schedule".'
          />
          <ArchiveSection
            archived={journey.is_archived}
            what="journey"
            busy={busy}
            onToggle={toggleArchive}
            effect={
              journey.is_archived
                ? "The assistant can pick this journey and its situations again."
                : "The assistant stops using this journey and its situations. Its history and ratings are kept, and you can restore it. At least one journey must stay active."
            }
          />
          {error ? <Alert>{error}</Alert> : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={save} disabled={busy || !name.trim()}>
            {busy ? "Saving..." : "Save details"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------
// Situations
// ------------------------------------------------------------------

export function AddSituationDialog({
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
  const [urgency, setUrgency] = useState(5);
  const [steps, setSteps] = useState("");
  const [touched, setTouched] = useState(false);
  const { busy, error, setError, run } = useBusy();

  useEffect(() => {
    if (!open) return;
    setKey("");
    setName("");
    setMatches("");
    setUrgency(5);
    setSteps("");
    setTouched(false);
    setError(null);
  }, [open, setError]);

  const keyProblem = keyError(key, takenKeys);

  const create = async () => {
    setTouched(true);
    if (keyProblem || !name.trim() || !matches.trim()) return;
    const ok = await run(
      () =>
        onCreate({
          key,
          name: name.trim(),
          matches_when: matches.trim(),
          priority: urgency,
          sort_order: journey.clusters.length + 1,
          response_pattern: steps.trim() || undefined,
        }),
      "Could not create the situation."
    );
    if (ok) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add a situation to {journey.key}</DialogTitle>
          <DialogDescription>
            A specific need within {journey.name}. When giving guidance, the assistant adds this situation's
            steps only when it fits.
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
            <TextField
              label="Name"
              value={name}
              onChange={setName}
              required
              maxLength={120}
              error={touched && !name.trim() ? "Enter a name." : null}
            />
          </div>
          <TextAreaField
            label="Use this situation when…"
            value={matches}
            onChange={setMatches}
            required
            maxLength={2000}
            hint="Plain words. The assistant reads this to decide if the situation fits a family."
            error={touched && !matches.trim() ? "Describe when this situation applies." : null}
          />
          <UrgencyPicker value={urgency} onChange={setUrgency} />
          <TextAreaField
            label="Steps to follow"
            value={steps}
            onChange={setSteps}
            rows={6}
            maxLength={DEFAULT_PROMPT_LIMITS.response_pattern}
            hint="Added after the journey's guidance, only when this situation fits."
          />
          {error ? <Alert>{error}</Alert> : null}
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

export function SituationDetailsDialog({
  open,
  onOpenChange,
  cluster,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cluster: JourneyCluster;
  onSave: (patch: ClusterPatch) => Promise<unknown>;
}) {
  const [name, setName] = useState(cluster.name);
  const [order, setOrder] = useState(String(cluster.sort_order));
  const { busy, error, setError, run } = useBusy();

  useEffect(() => {
    if (!open) return;
    setName(cluster.name);
    setOrder(String(cluster.sort_order));
    setError(null);
  }, [open, cluster, setError]);

  const save = async () => {
    if (!name.trim()) return;
    const ok = await run(
      () => onSave({ name: name.trim(), sort_order: Number(order) || 0 }),
      "Could not save the situation."
    );
    if (ok) onOpenChange(false);
  };

  const toggleArchive = async () => {
    const ok = await run(() => onSave({ is_archived: !cluster.is_archived }), "Could not update the situation.");
    if (ok) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{cluster.key} · Situation details</DialogTitle>
          <DialogDescription>The key cannot be changed.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_140px]">
            <TextField
              label="Name"
              value={name}
              onChange={setName}
              required
              maxLength={120}
              error={!name.trim() ? "Enter a name." : null}
            />
            <TextField label="Display order" type="number" value={order} onChange={setOrder} />
          </div>
          <ArchiveSection
            archived={cluster.is_archived}
            what="situation"
            busy={busy}
            onToggle={toggleArchive}
            effect={
              cluster.is_archived
                ? "The assistant can pick this situation again."
                : "The assistant stops picking this situation and its steps are no longer sent. Its history and ratings are kept, and you can restore it."
            }
          />
          {error ? <Alert>{error}</Alert> : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={save} disabled={busy || !name.trim()}>
            {busy ? "Saving..." : "Save details"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
