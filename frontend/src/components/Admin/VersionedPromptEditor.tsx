import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import {
  Bot,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  Save,
  Trash2,
  Power,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

import { formatDate, sortVersions, type PromptVersion } from "@/lib/promptVersions";

export type { PromptVersion };

/**
 * Result of a save. `notice` is shown to the admin but the save is treated
 * as done (used for the system messages' local fallback).
 */
export type PromptSaveResult = { notice?: string } | void;

type Props<V extends PromptVersion> = {
  title: ReactNode;
  /** Plain-text name used in confirmation dialogs. */
  label: string;
  description?: ReactNode;
  headerAction?: ReactNode;
  contentLabel?: string;
  versions: V[];
  /** Limit shown before the first version exists. */
  defaultCharacterLimit?: number;
  minRows?: number;

  onSave: (content: string) => Promise<PromptSaveResult>;
  onDelete: (versionId: string) => Promise<void>;
  onActivate: (versionId: string) => Promise<void>;

  /** Called with the version currently shown, e.g. for previews. */
  onCurrentChange?: (version: V | undefined) => void;
};

/**
 * Version history editor: browse versions, edit the active one, save a new
 * version (which becomes active), activate an older version, or delete an
 * inactive one.
 */
export default function VersionedPromptEditor<V extends PromptVersion>({
  title,
  label,
  description,
  headerAction,
  contentLabel = "Message content",
  versions,
  defaultCharacterLimit = 700,
  minRows = 10,
  onSave,
  onDelete,
  onActivate,
  onCurrentChange,
}: Props<V>) {
  const textareaId = useId();
  const sorted = useMemo(() => sortVersions(versions), [versions]);

  const [idx, setIdx] = useState(0);
  const current = sorted[idx];

  // draft content for the textarea
  const [draft, setDraft] = useState(current?.content ?? "");
  const [isDirty, setIsDirty] = useState(false);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [activating, setActivating] = useState(false);

  // character limit
  const characterLimit = current?.character_limit ?? defaultCharacterLimit;
  const currentLength = draft.length;
  const remainingCharacters = characterLimit - currentLength;
  const isOverLimit = currentLength > characterLimit;

  useEffect(() => {
    setDraft(current?.content ?? "");
    setIsDirty(false);
    setSaveError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, current?.id]);

  // Keep the index valid when versions change underneath (refetch, delete).
  useEffect(() => {
    if (idx > 0 && idx >= sorted.length) setIdx(Math.max(0, sorted.length - 1));
  }, [idx, sorted.length]);

  useEffect(() => {
    onCurrentChange?.(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, current?.content]);

  const canPrev = idx > 0;
  const canNext = idx < sorted.length - 1;

  // Only allow edits when viewing the active version (or when nothing exists yet)
  const canEdit = !current || !!current.is_active;

  const handleSave = async () => {
    const trimmed = (draft ?? "").trim();

    if (!trimmed) return;
    if (trimmed.length > characterLimit) {
      setSaveError(`Message exceeds the ${characterLimit}-character limit.`);
      return;
    }

    setSaving(true);
    setSaveError(null);

    try {
      const result = await onSave(trimmed);
      setIdx(0);
      setIsDirty(false);
      if (result && result.notice) setSaveError(result.notice);
    } catch (e) {
      console.error(e);
      setSaveError(e instanceof Error && e.message ? e.message : "Failed to save version.");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!current?.id) return;
    if (current.is_active) return;

    setDeleting(true);
    setSaveError(null);

    try {
      await onDelete(current.id);

      // Move index safely after deletion
      setIdx((prev) => {
        const nextLength = Math.max(sorted.length - 1, 0);
        if (nextLength === 0) return 0;
        return Math.min(prev, nextLength - 1);
      });

      setDeleteOpen(false);
    } catch (e) {
      console.error(e);
      setSaveError("Failed to delete version.");
    } finally {
      setDeleting(false);
    }
  };

  const handleActivate = async () => {
    if (!current?.id) return;
    if (current.is_active) return;

    setActivating(true);
    setSaveError(null);

    try {
      await onActivate(current.id);
    } catch (e) {
      console.error(e);
      setSaveError("Failed to activate version.");
    } finally {
      setActivating(false);
    }
  };

  return (
    <Card className="border-gray-200 shadow-sm w-full">
      <CardHeader className="space-y-2">
        <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3">
          <div className="space-y-2">
            <CardTitle className="flex items-center gap-2">
              <Bot className="h-5 w-5 text-primary" aria-hidden="true" />
              {title}
            </CardTitle>
            {description ? <CardDescription>{description}</CardDescription> : null}
          </div>

          {headerAction}
        </div>

        {sorted.length > 0 ? (
          <>
            <div className="flex items-center justify-between pt-2">
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setIdx((i) => Math.max(0, i - 1))}
                  disabled={!canPrev}
                  className="h-8"
                >
                  <ChevronLeft className="h-4 w-4 mr-1" aria-hidden="true" />
                  Prev
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setIdx((i) => Math.min(sorted.length - 1, i + 1))}
                  disabled={!canNext}
                  className="h-8"
                >
                  Next
                  <ChevronRight className="h-4 w-4 ml-1" aria-hidden="true" />
                </Button>
              </div>

              <div className="text-xs text-gray-500">
                This is version{" "}
                <span className="font-medium text-gray-700">{current?.version ?? 1}</span>{" "}
                and you have a total of{" "}
                <span className="font-medium text-gray-700">{sorted.length}</span>{" "}
                version{sorted.length > 1 ? "s " : " "}to choose from
              </div>
            </div>

            {/* Mini “side-scroll” chips */}
            <div className="flex gap-2 overflow-x-auto pb-1">
              {sorted.map((v, i) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => setIdx(i)}
                  aria-pressed={i === idx}
                  className={[
                    "shrink-0 rounded-full border px-3 py-1 text-xs transition",
                    i === idx
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50",
                  ].join(" ")}
                  title={`v${v.version}${v.is_active ? " (active)" : ""}`}
                >
                  v{v.version}
                  {v.is_active ? (
                    <>
                      <CheckCircle2
                        className="inline-block h-3.5 w-3.5 ml-1 text-green-600"
                        aria-hidden="true"
                      />
                      <span className="sr-only"> (active)</span>
                    </>
                  ) : null}
                </button>
              ))}
            </div>
          </>
        ) : null}
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Metadata row */}
        {current ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
            <div className="rounded-lg border border-gray-200 p-3 bg-gray-50">
              <div className="text-gray-500 font-medium">Active</div>
              <div className="mt-1 font-medium text-gray-800">
                {current.is_active ? "Yes" : "No"}
              </div>
            </div>
            <div className="rounded-lg border border-gray-200 p-3 bg-gray-50">
              <div className="text-gray-500 font-medium">Created by</div>
              <div className="mt-1 font-medium text-gray-800">
                {current.created_by_email ?? "—"}
              </div>
            </div>
            <div className="rounded-lg border border-gray-200 p-3 bg-gray-50">
              <div className="text-gray-500 font-medium">Created at</div>
              <div className="mt-1 font-medium text-gray-800">
                {formatDate(current.created_at)}
              </div>
            </div>
          </div>
        ) : (
          <p className="text-xs text-gray-500">
            No versions yet. Write the first version below and save it.
          </p>
        )}

        {/* Content editor */}
        <div className="space-y-2">
          <Label htmlFor={textareaId}>{contentLabel}</Label>

          <div className="space-y-2">
            <textarea
              id={textareaId}
              value={draft}
              rows={minRows}
              onChange={(e) => {
                setDraft(e.target.value);
                setIsDirty(true);
                if (saveError) setSaveError(null);
              }}
              readOnly={!canEdit}
              aria-invalid={isOverLimit}
              className={[
                "flex w-full rounded-md border px-3 py-2 text-sm ring-offset-background font-mono",
                minRows >= 10 ? "min-h-[240px]" : "min-h-[120px]",
                isOverLimit ? "border-red-300 focus-visible:ring-red-200" : "border-input",
                !canEdit ? "opacity-70 cursor-not-allowed bg-background" : "bg-background",
              ].join(" ")}
            />

            <div className="flex items-center justify-between text-xs" aria-live="polite">
              <div>
                {isOverLimit ? (
                  <span className="text-red-600 font-medium">
                    Exceeds limit by {Math.abs(remainingCharacters)} character{Math.abs(remainingCharacters) === 1 ? "" : "s"}.
                  </span>
                ) : (
                  <span className="text-gray-500">
                    Limit: {characterLimit} characters
                  </span>
                )}
              </div>

              <div className={isOverLimit ? "text-red-600 font-medium" : "text-gray-500"}>
                {currentLength} / {characterLimit}
              </div>
            </div>
          </div>

          {saveError ? (
            <p
              role="alert"
              className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2"
            >
              {saveError}
            </p>
          ) : null}

          {!canEdit ? (
            <p className="text-xs text-gray-500">
              Only the active version can be edited. To change history, create a new version via Save.
            </p>
          ) : (
            <p className="text-xs text-gray-500">
              Saving creates a new version and makes it active (rollback-safe).
            </p>
          )}
        </div>

        {/* Save and Delete buttons */}
        <div className="pt-2 flex flex-wrap gap-2">
          <Button
            type="button"
            onClick={handleSave}
            disabled={
              saving ||
              deleting ||
              !canEdit ||
              !isDirty ||
              !(draft ?? "").trim() ||
              isOverLimit
            }
            className="bg-primary hover:bg-primary/90"
          >
            <Save className="mr-2 h-4 w-4" aria-hidden="true" />
            {saving ? "Saving..." : "Save New Version"}
          </Button>

          {current && !current.is_active ? (
            <Button
              type="button"
              variant="outline"
              onClick={handleActivate}
              disabled={saving || deleting || activating || !current.id}
              className="border-green-200 text-green-700 hover:bg-green-50 hover:text-green-800"
            >
              <Power className="mr-2 h-4 w-4" aria-hidden="true" />
              {activating ? "Activating..." : "Activate Version"}
            </Button>
          ) : null}

          {current && !current.is_active ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeleteOpen(true)}
              disabled={saving || deleting || activating || !current.id}
              className="border-red-200 text-red-700 hover:bg-red-50 hover:text-red-800"
            >
              <Trash2 className="mr-2 h-4 w-4" aria-hidden="true" />
              Delete Version
            </Button>
          ) : null}
        </div>
      </CardContent>

      <Dialog open={deleteOpen} onOpenChange={(open) => !deleting && setDeleteOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Are you sure?</DialogTitle>
            <DialogDescription>
              This will permanently remove version{" "}
              <span className="font-medium">v{current?.version ?? "?"}</span> of{" "}
              <span className="font-medium">{label}</span>.
            </DialogDescription>
          </DialogHeader>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeleteOpen(false)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleDelete}
              disabled={deleting}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {deleting ? "Deleting..." : "Yes, Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
