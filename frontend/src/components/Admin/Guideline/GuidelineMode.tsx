import { useId, useRef, useState, type DragEvent, type ReactNode } from "react";
import { FileText, Pencil, RefreshCw, RotateCcw, Trash2, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useGuideline } from "@/hooks/useGuideline";
import { changedBy } from "@/lib/promptVersions";
import {
  MARKDOWN_ACCEPT,
  MAX_LABEL_CHARS,
  STATUS_TEXT,
  validateLabel,
  type GuidelineDocument,
  type GuidelineMode as Mode,
  type GuidelineSection,
  type GuidelineStatus,
} from "@/lib/guideline";

const STATUS_CLASS: Record<GuidelineStatus, string> = {
  processing: "border-amber-300 bg-amber-50 text-amber-900",
  ready: "border-emerald-300 bg-emerald-50 text-emerald-900",
  failed: "border-red-300 bg-red-50 text-red-800",
};

function Section({ title, description, children }: { title: string; description: ReactNode; children: ReactNode }) {
  return (
    <Card className="rounded-[13px] border-foreground/12 shadow-sm">
      <CardHeader>
        <CardTitle className="text-[18.5px] font-bold tracking-[-0.01em]">{title}</CardTitle>
        <CardDescription className="text-[13.5px] leading-relaxed">{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}

function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  destructive,
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => (!next ? onCancel() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="text-[14px] leading-relaxed text-foreground/80">{body}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" variant={destructive ? "destructive" : "default"} onClick={onConfirm} disabled={busy}>
            {busy ? "Working…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SituationRow({
  section,
  onRename,
}: {
  section: GuidelineSection;
  onRename: (label: string) => Promise<void>;
}) {
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(section.label);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const renamed = Boolean(section.label_override);

  const save = async (label: string) => {
    const invalid = validateLabel(label);
    if (invalid) {
      setError(invalid);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onRename(label);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "Couldn't save the name.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <li className="rounded-[10px] border border-foreground/10 bg-white px-4 py-3">
      {editing ? (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            save(value);
          }}
        >
          <Label htmlFor={id}>Situation name</Label>
          <Input
            id={id}
            value={value}
            maxLength={MAX_LABEL_CHARS + 20}
            onChange={(e) => setValue(e.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={`${id}-help${error ? ` ${id}-error` : ""}`}
            autoFocus
          />
          <p id={`${id}-help`} className="text-xs text-foreground/70">
            Detected name: {section.auto_label}. Leave empty to use it.
          </p>
          {error ? (
            <p id={`${id}-error`} className="text-xs text-red-700">
              {error}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={saving}>
              {saving ? "Saving…" : "Save name"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={saving}
              onClick={() => {
                setEditing(false);
                setValue(section.label);
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[14.5px] font-semibold">
              {section.label}
              {renamed ? <span className="ml-2 text-xs font-normal text-foreground/65">(renamed)</span> : null}
            </div>
            {section.summary ? (
              <p className="mt-0.5 text-[13px] leading-normal text-foreground/75">{section.summary}</p>
            ) : null}
            {section.heading_path ? (
              <p className="mt-1 text-xs text-foreground/60">From heading: {section.heading_path}</p>
            ) : null}
            {error ? <p className="mt-1 text-xs text-red-700">{error}</p> : null}
          </div>
          <div className="flex gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setValue(section.label);
                setEditing(true);
              }}
              aria-label={`Rename situation ${section.label}`}
            >
              <Pencil className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              Rename
            </Button>
            {renamed ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={saving}
                onClick={() => save("")}
                aria-label={`Reset ${section.label} to the detected name`}
              >
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                Reset to detected
              </Button>
            ) : null}
          </div>
        </div>
      )}
    </li>
  );
}

function GuideCard({
  doc,
  onReplace,
  onRemove,
  onRename,
}: {
  doc: GuidelineDocument;
  onReplace: () => void;
  onRemove: () => void;
  onRename: (sectionId: string, label: string) => Promise<void>;
}) {
  const uploaded = changedBy(doc.uploaded_by, doc.updated_at);
  return (
    <li className="rounded-[12px] border border-foreground/12 bg-muted/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <FileText className="h-4 w-4 text-foreground/70" aria-hidden="true" />
            <span className="break-all text-[15px] font-bold">{doc.file_name}</span>
            <Badge variant="outline" className={STATUS_CLASS[doc.status]}>
              {STATUS_TEXT[doc.status]}
            </Badge>
          </div>
          <p className="mt-1 text-xs text-foreground/70">
            {doc.status === "ready"
              ? `${doc.section_count} situation${doc.section_count === 1 ? "" : "s"} found`
              : doc.status === "processing"
                ? "This usually takes under a minute."
                : null}
            {uploaded ? `${doc.status !== "failed" ? " · " : ""}${uploaded.replace("Last changed", "Uploaded")}` : null}
          </p>
          {doc.status === "failed" && doc.error ? (
            <p className="mt-1.5 text-[13px] text-red-700">{doc.error}</p>
          ) : null}
        </div>
        <div className="flex gap-1.5">
          <Button type="button" size="sm" variant="outline" onClick={onReplace} disabled={doc.status === "processing"}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            Replace
          </Button>
          <Button type="button" size="sm" variant="outline" className="text-destructive" onClick={onRemove}>
            <Trash2 className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            Remove
          </Button>
        </div>
      </div>

      {doc.status === "ready" && doc.sections.length ? (
        <details className="mt-3" open>
          <summary className="cursor-pointer text-[13.5px] font-semibold text-primary">
            Situations the assistant found in this guide
          </summary>
          <p className="mt-1.5 text-xs text-foreground/70">
            Check these look right. Renaming is optional and only changes how a situation is matched and shown.
          </p>
          <ul className="mt-2 space-y-2">
            {doc.sections.map((s) => (
              <SituationRow key={s.id} section={s} onRename={(label) => onRename(s.id, label)} />
            ))}
          </ul>
        </details>
      ) : null}
    </li>
  );
}

export default function GuidelineMode() {
  const { state, loading, error, setMode, upload, remove, rename } = useGuideline();
  const fileInputId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const [replaceTarget, setReplaceTarget] = useState<GuidelineDocument | null>(null);
  const [removeTarget, setRemoveTarget] = useState<GuidelineDocument | null>(null);
  const [pendingMode, setPendingMode] = useState<Mode | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const mode = state?.mode ?? "standard";
  const documents = state?.documents ?? [];
  const readyCount = documents.filter((d) => d.status === "ready").length;
  const modeChanged = changedBy(state?.mode_updated_by, state?.mode_updated_at ?? undefined);

  const runUpload = async (files: File[], replace?: GuidelineDocument) => {
    if (!files.length) return;
    setUploading(true);
    setProblems([]);
    setNotice(null);
    setActionError(null);
    try {
      const failed = await upload(files, replace?.id);
      setProblems(failed);
      const okCount = files.length - failed.length;
      if (okCount > 0) {
        setNotice(
          replace
            ? `Replacing "${replace.file_name}". The assistant is reading the new version.`
            : `${okCount} guide${okCount === 1 ? "" : "s"} uploaded. The assistant is reading ${okCount === 1 ? "it" : "them"} now.`
        );
      }
    } finally {
      setUploading(false);
    }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    runUpload(Array.from(e.dataTransfer.files));
  };

  const confirmMode = async () => {
    if (!pendingMode) return;
    setBusy(true);
    setActionError(null);
    try {
      await setMode(pendingMode);
      setNotice(
        pendingMode === "guideline"
          ? "Guideline mode is on. Families will get answers from your guides within about five minutes."
          : "Standard mode is on. Families will get the usual assistant within about five minutes."
      );
      setPendingMode(null);
    } catch (e) {
      setActionError(e instanceof Error && e.message ? `Couldn't change the mode: ${e.message}` : "Couldn't change the mode.");
    } finally {
      setBusy(false);
    }
  };

  const confirmRemove = async () => {
    if (!removeTarget) return;
    setBusy(true);
    setActionError(null);
    try {
      await remove(removeTarget.id);
      setNotice(`"${removeTarget.file_name}" was removed.`);
      setRemoveTarget(null);
    } catch (e) {
      setActionError(e instanceof Error && e.message ? `Couldn't remove the guide: ${e.message}` : "Couldn't remove the guide.");
    } finally {
      setBusy(false);
    }
  };

  const isOn = mode === "guideline";

  return (
    <div className="mx-auto max-w-[1000px] space-y-6">
      <div>
        <h1 className="font-serif text-[30px] font-semibold leading-tight tracking-[-0.015em]">Guideline mode</h1>
        <p className="mt-2 text-[15.5px] leading-relaxed text-foreground/80">
          Upload the guides your team already uses to help families. The assistant finds the situations in them, picks
          the one that fits each family, and answers only from that part of the guide. There are no prompts to write.
          Your existing prompts and settings stay as they are, so you can switch back at any time.
        </p>
      </div>

      {error || actionError ? (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {actionError ?? error}
        </div>
      ) : null}
      <div aria-live="polite" className="sr-only">
        {notice ?? ""}
      </div>
      {notice ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">{notice}</div>
      ) : null}

      {loading ? (
        <div className="flex items-center justify-center py-12" role="status" aria-label="Loading guideline mode">
          <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
        </div>
      ) : (
        <>
          <Section
            title="Which answers families get"
            description="This applies to every family using the assistant. Changes can take up to five minutes to reach new messages."
          >
            <div className="flex flex-wrap items-center justify-between gap-4 rounded-[11px] border border-foreground/12 bg-white px-4 py-3">
              <div>
                <div className="text-[15px] font-bold">
                  {isOn ? "Answering from your uploaded guides" : "Answering with the standard prompts"}
                </div>
                <div className="mt-0.5 text-[13px] text-foreground/70">
                  {modeChanged ?? "Standard prompts are used until you turn guideline mode on."}
                </div>
              </div>
              <label className="inline-flex cursor-pointer items-center gap-2.5 text-[14px] font-semibold">
                <button
                  type="button"
                  role="switch"
                  aria-checked={isOn}
                  aria-label="Answer from uploaded guides"
                  onClick={() => setPendingMode(isOn ? "standard" : "guideline")}
                  className="relative h-[22px] w-[40px] flex-none rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                  style={{ background: isOn ? "oklch(0.42 0.10 268)" : "rgba(22,24,29,0.22)" }}
                >
                  <span
                    className="absolute top-[3px] h-[16px] w-[16px] rounded-full bg-white shadow transition-[left]"
                    style={{ left: isOn ? 21 : 3 }}
                  />
                </button>
                Answer from uploaded guides
              </label>
            </div>
            {isOn && readyCount === 0 ? (
              <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                Guideline mode is on but no guide is ready yet, so the assistant can only ask families questions. Upload
                a guide below, or switch back to the standard prompts.
              </p>
            ) : null}
          </Section>

          <Section
            title="Upload guides"
            description="Markdown files (.md), up to 1 MB each. You can upload several at once. Headings help, but aren't required."
          >
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              className={`flex flex-col items-center justify-center gap-3 rounded-[12px] border-2 border-dashed px-6 py-8 text-center ${
                dragging ? "border-primary bg-[oklch(0.96_0.02_268)]" : "border-foreground/18 bg-white"
              }`}
            >
              <Upload className="h-6 w-6 text-foreground/60" aria-hidden="true" />
              <p className="text-[14px] text-foreground/80">Drag guides here, or</p>
              <input
                id={fileInputId}
                ref={fileInput}
                type="file"
                accept={MARKDOWN_ACCEPT}
                multiple
                className="sr-only"
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  e.target.value = "";
                  runUpload(files);
                }}
              />
              <Button type="button" onClick={() => fileInput.current?.click()} disabled={uploading}>
                {uploading ? "Uploading…" : "Choose files"}
              </Button>
              <p className="max-w-[560px] text-xs leading-normal text-foreground/65">
                Tip: a heading for each situation (for example "## Child sent home early") makes matching more
                reliable, but plain text works too.
              </p>
            </div>
            {problems.length ? (
              <ul role="alert" className="space-y-1 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            ) : null}
          </Section>

          <Section
            title="Your guides"
            description="Every ready guide is searched for each family's message. Remove a guide to stop using it."
          >
            {documents.length ? (
              <ul className="space-y-3">
                {documents.map((doc) => (
                  <GuideCard
                    key={doc.id}
                    doc={doc}
                    onReplace={() => {
                      setReplaceTarget(doc);
                      replaceInput.current?.click();
                    }}
                    onRemove={() => setRemoveTarget(doc)}
                    onRename={rename}
                  />
                ))}
              </ul>
            ) : (
              <p className="text-[14px] text-foreground/70">No guides uploaded yet.</p>
            )}
            <input
              ref={replaceInput}
              type="file"
              accept={MARKDOWN_ACCEPT}
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []).slice(0, 1);
                e.target.value = "";
                const target = replaceTarget;
                setReplaceTarget(null);
                if (target) runUpload(files, target);
              }}
            />
          </Section>
        </>
      )}

      <ConfirmDialog
        open={pendingMode !== null}
        title={pendingMode === "guideline" ? "Answer from your uploaded guides?" : "Switch back to the standard prompts?"}
        body="This changes answers for all families. It can take up to 5 minutes."
        confirmLabel={pendingMode === "guideline" ? "Turn on guideline mode" : "Use standard prompts"}
        busy={busy}
        onConfirm={confirmMode}
        onCancel={() => setPendingMode(null)}
      />
      <ConfirmDialog
        open={removeTarget !== null}
        title="Remove this guide?"
        body={`"${removeTarget?.file_name ?? ""}" and its situations will be removed. The assistant will stop using it within about five minutes.`}
        confirmLabel="Remove guide"
        destructive
        busy={busy}
        onConfirm={confirmRemove}
        onCancel={() => setRemoveTarget(null)}
      />
    </div>
  );
}
