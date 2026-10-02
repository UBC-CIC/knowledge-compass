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
import { Alert, TextAreaField, TextField } from "@/components/Admin/Prompts/parts";
import { SAFETY } from "@/lib/promptCatalog";
import type { Journey } from "@/types/journeys";

const errorMessage = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

/** Reset on open, busy/error state and a single create call. */
function useCreate(open: boolean) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (open) {
      setError(null);
      setTouched(false);
    }
  }, [open]);
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
  return { busy, error, touched, setTouched, run };
}

function GreenNote({ children }: { children: string }) {
  return (
    <div
      className="rounded-[10px] border border-dashed px-3.5 py-3 text-[13px] leading-relaxed"
      style={{ background: SAFETY.bg, borderColor: SAFETY.border, color: SAFETY.fg }}
    >
      {children}
    </div>
  );
}

export function AddJourneyDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The parent picks the internal key. */
  onCreate: (input: { name: string; description: string }) => Promise<unknown>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const { busy, error, touched, setTouched, run } = useCreate(open);

  useEffect(() => {
    if (!open) return;
    setName("");
    setDescription("");
  }, [open]);

  const create = async () => {
    setTouched(true);
    if (!name.trim()) return;
    const ok = await run(
      () => onCreate({ name: name.trim(), description: description.trim() }),
      "Could not create the journey."
    );
    if (ok) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Add a journey</DialogTitle>
          <DialogDescription>
            Only this form. Shared pages pick up the new journey automatically, so there's nothing else to update.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <TextField
            label="Name"
            value={name}
            onChange={setName}
            required
            maxLength={120}
            placeholder="e.g. Getting an assessment"
            error={touched && !name.trim() ? "Give the journey a name." : null}
          />
          <TextAreaField
            label="Who it's for"
            value={description}
            onChange={setDescription}
            maxLength={2000}
            placeholder="Describe the family's situation in a sentence or two."
          />
          <GreenNote>
            Add words, questions, guidance and situations on the next screen. Until then, families in this journey are
            guided by the shared pages.
          </GreenNote>
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

export function AddSituationDialog({
  open,
  onOpenChange,
  journey,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  journey: Journey;
  /** The parent picks the internal key. */
  onCreate: (input: { name: string; matches_when: string }) => Promise<unknown>;
}) {
  const [name, setName] = useState("");
  const [matches, setMatches] = useState("");
  const { busy, error, touched, setTouched, run } = useCreate(open);

  useEffect(() => {
    if (!open) return;
    setName("");
    setMatches("");
  }, [open]);

  const create = async () => {
    setTouched(true);
    if (!name.trim() || !matches.trim()) return;
    const ok = await run(
      () => onCreate({ name: name.trim(), matches_when: matches.trim() }),
      "Could not create the situation."
    );
    if (ok) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Add a situation</DialogTitle>
          <DialogDescription>
            A specific need within {journey.name}. Add its steps on the next screen.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <TextField
            label="Name"
            value={name}
            onChange={setName}
            required
            maxLength={120}
            placeholder="e.g. Asking for an assessment"
            error={touched && !name.trim() ? "Give the situation a name." : null}
          />
          <TextAreaField
            label="Use this when…"
            value={matches}
            onChange={setMatches}
            required
            maxLength={2000}
            hint="In plain words. The assistant reads this to decide if the situation fits."
            error={touched && !matches.trim() ? "Describe when this situation fits." : null}
          />
          <GreenNote>
            Until it has steps, families in this situation get the journey's guidance plus the shared pages.
          </GreenNote>
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
