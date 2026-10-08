import { useId, useState } from "react";
import { Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  SERVICE_MESSAGE_MAX,
  SERVICE_OPTIONS,
  cleanServiceMessage,
  serviceChanges,
  validateServiceDraft,
  type ServicePatch,
  type ServiceState,
  type ServiceStatus,
} from "@/lib/serviceStatus";

/**
 * "Service status" card on the Assistant settings page: a maintenance banner or a
 * read-only pause, switched on and off here with no deploy. It saves on its own through
 * PUT /admin/system-settings (only the fields that changed), separately from the other
 * settings, so switching it off in a hurry never depends on other unsaved edits.
 */
export default function ServiceStatusCard({
  saved,
  onSave,
}: {
  saved: ServiceState;
  onSave: (patch: ServicePatch) => Promise<void>;
}) {
  // The settings page shows a spinner (unmounting this card) while it reloads, so the draft always starts from what was saved.
  const [draft, setDraft] = useState<ServiceState>(saved);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const groupName = useId();
  const messageId = useId();

  const patch = serviceChanges(saved, draft);
  const changed = Object.keys(patch).length > 0;
  const problem = changed ? validateServiceDraft(draft) : null;
  const needsMessage = draft.status !== "normal";
  const remaining = SERVICE_MESSAGE_MAX - cleanServiceMessage(draft.message ?? "").length;

  const choose = (status: ServiceStatus) => {
    setNotice(null);
    setDraft((d) => ({ ...d, status }));
  };

  const save = async () => {
    if (!changed || problem) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await onSave(patch);
      setNotice(
        draft.status === "normal"
          ? "Saved. Families will no longer see a notice within about a minute."
          : draft.status === "banner"
            ? "Saved. Families will see the banner within about a minute."
            : "Saved. New messages will be paused within about a minute."
      );
    } catch (e) {
      console.error(e);
      setError(e instanceof Error && e.message ? `Couldn't save: ${e.message}` : "Couldn't save the service status.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="rounded-[13px] border-foreground/12 shadow-sm">
      <CardHeader>
        <CardTitle className="text-[18.5px] font-bold tracking-[-0.01em]">Service status</CardTitle>
        <CardDescription className="text-[13.5px] leading-relaxed">
          Let families know about planned work, or pause new messages if something is wrong. Use this only when you need to;
          normally leave it on Normal. It takes effect within about a minute and needs no deploy. The message is visible to
          anyone who opens the chat, so do not include private details.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <fieldset className="space-y-2.5">
          <legend className="sr-only">Service status</legend>
          {SERVICE_OPTIONS.map((option) => {
            const checked = draft.status === option.value;
            return (
              <label
                key={option.value}
                className={`flex cursor-pointer gap-3 rounded-[11px] border-[1.5px] px-4 py-3 ${
                  checked ? "border-primary bg-[oklch(0.96_0.02_268)]" : "border-foreground/14 hover:bg-muted"
                }`}
              >
                <input
                  type="radio"
                  name={groupName}
                  value={option.value}
                  checked={checked}
                  onChange={() => choose(option.value)}
                  className="mt-1 h-4 w-4 accent-[oklch(0.42_0.10_268)]"
                />
                <span>
                  <span className="block text-[14.5px] font-bold">{option.title}</span>
                  <span className="mt-0.5 block text-[13px] leading-normal text-foreground/75">{option.body}</span>
                </span>
              </label>
            );
          })}
        </fieldset>

        <div className="space-y-2">
          <Label htmlFor={messageId}>
            Message for families{needsMessage ? " (required)" : " (optional)"}
          </Label>
          <textarea
            id={messageId}
            value={draft.message ?? ""}
            onChange={(e) => {
              setNotice(null);
              setDraft((d) => ({ ...d, message: e.target.value }));
            }}
            rows={3}
            aria-invalid={problem ? true : undefined}
            aria-describedby={`${messageId}-help${problem ? ` ${messageId}-error` : ""}`}
            className="focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive w-full rounded-md border bg-transparent px-3 py-2 text-base shadow-xs outline-none focus-visible:ring-[3px] md:text-sm"
          />
          <p id={`${messageId}-help`} className="text-xs leading-normal text-foreground/70">
            One short paragraph, for example: “Chat will be unavailable on Saturday from 8 to 10 pm for planned work.” You have{" "}
            {remaining} character{remaining === 1 ? "" : "s"} left.
          </p>
          {problem ? (
            <p id={`${messageId}-error`} className="text-xs text-red-700">
              {problem}
            </p>
          ) : null}
        </div>

        {error ? (
          <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-3 border-t border-foreground/10 pt-4">
          <Button type="button" onClick={save} disabled={!changed || Boolean(problem) || saving}>
            <Save className="mr-2 h-4 w-4" aria-hidden="true" />
            {saving ? "Saving…" : "Save service status"}
          </Button>
          {changed ? (
            <Button type="button" variant="outline" onClick={() => setDraft(saved)} disabled={saving}>
              Discard
            </Button>
          ) : null}
          <span className="text-xs text-foreground/75" aria-live="polite">
            {changed ? "Unsaved changes." : notice ?? ""}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
