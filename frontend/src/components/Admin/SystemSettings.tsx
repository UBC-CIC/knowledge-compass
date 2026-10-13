import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { RotateCcw, Save } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import DeveloperSwitch from "@/components/Admin/DeveloperSwitch";
import { AuthService } from "@/functions/authService";
import { DEMO_ADMIN_EMAIL, isDemoMode } from "@/lib/demo";
import { useDeveloperSettings } from "@/lib/developerSettings";
import { changedBy } from "@/lib/promptVersions";
import {
  DEVELOPER_KEYS,
  FLOW_PRESETS,
  RECOMMENDED,
  URGENT_NOTE,
  changedSettings,
  flowPresetFor,
  fromApi,
  validateSettings,
  type AssistantSettings,
  type RoutingMode,
  type SettingKey,
} from "@/lib/assistantSettings";

type Meta = { updated_at?: string; updated_by_email?: string | null };

// Demo mode keeps edits in memory for the session.
let demoSettings: AssistantSettings = { ...RECOMMENDED };
let demoMeta: Meta = {};

async function settingsFetch<T>(init: RequestInit = {}): Promise<T> {
  const token = await AuthService.getAdminIdToken();
  const res = await fetch(`${import.meta.env.VITE_API_ENDPOINT}/admin/system-settings`, {
    ...init,
    headers: { Authorization: token, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const data = await res.json();
      if (data && typeof data.error === "string") message = data.error;
    } catch {
      // keep the generic message
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

function NumberField({
  label,
  help,
  value,
  onChange,
  error,
  step,
  min,
  max,
}: {
  label: string;
  help: string;
  value: number;
  onChange: (value: number) => void;
  error?: string;
  step?: string;
  min?: number;
  max?: number;
}) {
  const id = useId();
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        step={step}
        min={min}
        max={max}
        value={Number.isFinite(value) ? value : ""}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-help${error ? ` ${id}-error` : ""}`}
        onChange={(e) => onChange(e.target.value === "" ? Number.NaN : e.target.valueAsNumber)}
      />
      <p id={`${id}-help`} className="text-xs leading-normal text-foreground/70">
        {help}
      </p>
      {error ? (
        <p id={`${id}-error`} className="text-xs text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function SettingsCard({ title, description, children }: { title: string; description: ReactNode; children: ReactNode }) {
  return (
    <Card className="rounded-[13px] border-foreground/12 shadow-sm">
      <CardHeader>
        <CardTitle className="text-[18.5px] font-bold tracking-[-0.01em]">{title}</CardTitle>
        <CardDescription className="text-[13.5px] leading-relaxed">{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">{children}</CardContent>
    </Card>
  );
}

export default function SystemSettings() {
  const [saved, setSaved] = useState<AssistantSettings>(RECOMMENDED);
  const [draft, setDraft] = useState<AssistantSettings>(RECOMMENDED);
  const [meta, setMeta] = useState<Meta>({});
  const [loading, setLoading] = useState(!isDemoMode);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showDeveloper, setShowDeveloper] = useDeveloperSettings();
  const flowGroupId = useId();

  const load = useCallback(async () => {
    if (isDemoMode) {
      setSaved(demoSettings);
      setDraft(demoSettings);
      setMeta(demoMeta);
      return;
    }
    try {
      setLoading(true);
      const data = await settingsFetch<Partial<Record<SettingKey, unknown>> & Meta>();
      const s = fromApi(data);
      setSaved(s);
      setDraft(s);
      setMeta({ updated_at: data.updated_at ?? undefined, updated_by_email: data.updated_by_email ?? null });
      setError(null);
    } catch (e) {
      console.error(e);
      setError("Couldn't load the assistant settings. Please refresh the page.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const set = <K extends SettingKey>(key: K) => (value: AssistantSettings[K]) => {
    setNotice(null);
    setDraft((d) => ({ ...d, [key]: value }));
  };

  const errors = validateSettings(draft);
  const patch = changedSettings(saved, draft);
  const changes = Object.keys(patch).length;
  const hasErrors = Object.keys(errors).length > 0;
  const preset = flowPresetFor(draft);
  const resetNeeded = DEVELOPER_KEYS.some((k) => draft[k] !== RECOMMENDED[k]);

  const save = async () => {
    if (!changes || hasErrors) return;
    setSaving(true);
    setError(null);
    try {
      if (isDemoMode) {
        demoSettings = { ...draft };
        demoMeta = { updated_at: new Date().toISOString(), updated_by_email: DEMO_ADMIN_EMAIL };
      } else {
        // The backend records the admin from the authorizer.
        await settingsFetch({ method: "PUT", body: JSON.stringify(patch) });
      }
      await load();
      setNotice("Saved. New conversations use these settings within about five minutes.");
    } catch (e) {
      console.error(e);
      setError(e instanceof Error && e.message ? `Couldn't save: ${e.message}` : "Couldn't save the settings.");
    } finally {
      setSaving(false);
    }
  };

  const resetDeveloper = () => {
    setNotice(null);
    setDraft((d) => {
      const next = { ...d };
      for (const k of DEVELOPER_KEYS) (next as Record<string, unknown>)[k] = RECOMMENDED[k];
      return next;
    });
  };

  const lastChanged = changedBy(meta.updated_by_email, meta.updated_at);

  const presetOption = (
    id: string,
    title: string,
    body: string,
    checked: boolean,
    onSelect?: () => void
  ) => (
    <label
      key={id}
      className={`flex gap-3 rounded-[11px] border-[1.5px] px-4 py-3 ${onSelect ? "cursor-pointer" : "cursor-default"} ${
        checked ? "border-primary bg-[oklch(0.96_0.02_268)]" : "border-foreground/14 hover:bg-muted"
      }`}
    >
      <input
        type="radio"
        name={flowGroupId}
        value={id}
        checked={checked}
        disabled={!onSelect}
        onChange={onSelect}
        className="mt-1 h-4 w-4 accent-[oklch(0.42_0.10_268)]"
      />
      <span>
        <span className="block text-[14.5px] font-bold">{title}</span>
        <span className="mt-0.5 block text-[13px] leading-normal text-foreground/75">{body}</span>
      </span>
    </label>
  );

  return (
    <div className="mx-auto max-w-[1000px] space-y-6">
      <div>
        <h1 className="font-serif text-[30px] font-semibold leading-tight tracking-[-0.015em]">Assistant settings</h1>
        <p className="mt-2 text-[15.5px] leading-relaxed text-foreground/80">
          How conversations flow and how much families can send. Wording lives on the Prompts page. Changes reach new
          conversations within about five minutes.
        </p>
      </div>

      {error ? (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="flex items-center justify-center py-12" role="status" aria-label="Loading settings">
          <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
        </div>
      ) : (
        <>
          <SettingsCard
            title="How the conversation flows"
            description="When the assistant stops asking questions and starts giving guidance."
          >
            <fieldset className="space-y-2.5">
              <legend className="sr-only">How the conversation flows</legend>
              {FLOW_PRESETS.map((p) =>
                presetOption(p.id, p.title, p.body, preset === p.id, () => {
                  setNotice(null);
                  setDraft((d) => ({ ...d, ...p.values }));
                })
              )}
              {preset === null
                ? presetOption(
                    "custom",
                    "Custom (set by a developer)",
                    "These numbers don't match a preset. Pick one above to replace them, or adjust them under developer settings.",
                    true
                  )
                : null}
            </fieldset>
            <p className="text-[13px] leading-normal text-foreground/70">{URGENT_NOTE}</p>
          </SettingsCard>

          <SettingsCard title="Daily limits" description="Keeps the assistant available and costs predictable.">
            <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
              <NumberField
                label="Messages a person can send per day"
                help="Counted over 24 hours for each person."
                min={1}
                max={1000}
                value={draft.max_messages_per_day}
                onChange={set("max_messages_per_day")}
                error={errors.max_messages_per_day}
              />
              <NumberField
                label="Longest message a person can send"
                help="In characters. About 2,000 characters is a long paragraph or two."
                min={1}
                value={draft.max_characters_per_user_message}
                onChange={set("max_characters_per_user_message")}
                error={errors.max_characters_per_user_message}
              />
              <NumberField
                label="Characters a person can send per day"
                help="Counted for each person from midnight UTC. 10,000 characters is about five long messages."
                min={1}
                max={1000000}
                value={draft.max_characters_per_day}
                onChange={set("max_characters_per_day")}
                error={errors.max_characters_per_day}
              />
            </div>
          </SettingsCard>

          <SettingsCard
            title="Answer checks"
            description="After each answer, the app checks it against the sources it used. If the support looks weak, families see a short warning under the answer. These checks never change what the assistant says."
          >
            {showDeveloper ? (
              <p className="text-[13px] text-foreground/70">The check thresholds are under developer settings below.</p>
            ) : (
              <p className="text-[13px] text-foreground/70">
                Thresholds are managed by a developer. Turn on developer settings to see them.
              </p>
            )}
          </SettingsCard>

          {showDeveloper ? (
            <SettingsCard
              title="Developer settings"
              description="Model and check values. Changes here affect every conversation, so test in a dev environment first."
            >
              <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="routing-mode">Routing mode</Label>
                  <Select
                    value={draft.routing_mode}
                    onValueChange={(v) => set("routing_mode")(v as RoutingMode)}
                  >
                    <SelectTrigger id="routing-mode" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="fixed">Fixed: after a set number of messages</SelectItem>
                      <SelectItem value="dynamic">Dynamic: as soon as the situation is clear</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs leading-normal text-foreground/70">The flow presets above set this for you.</p>
                </div>
                <NumberField
                  label={draft.routing_mode === "dynamic" ? "Give guidance by message" : "Give guidance after message"}
                  help={
                    draft.routing_mode === "dynamic"
                      ? "Latest message at which guidance is always given, even if details are missing."
                      : "Number of question-and-answer rounds before guidance."
                  }
                  min={0}
                  max={500}
                  value={draft.min_messages_before_suggest}
                  onChange={set("min_messages_before_suggest")}
                  error={errors.min_messages_before_suggest}
                />
                {draft.routing_mode === "dynamic" ? (
                  <NumberField
                    label="Questions before guidance"
                    help="Minimum questions to ask first. 0 lets a clear first message be answered right away."
                    min={0}
                    max={500}
                    value={draft.min_exchanges_before_answer}
                    onChange={set("min_exchanges_before_answer")}
                    error={errors.min_exchanges_before_answer}
                  />
                ) : null}
                <NumberField
                  label="Longest reply (characters)"
                  help="Caps reply length to avoid runaway outputs."
                  min={1}
                  value={draft.max_characters_per_ai_message}
                  onChange={set("max_characters_per_ai_message")}
                  error={errors.max_characters_per_ai_message}
                />
                <NumberField
                  label="Temperature"
                  help={`Lower is more consistent. Recommended ${RECOMMENDED.temperature}.`}
                  step="0.01"
                  min={0}
                  max={2}
                  value={draft.temperature}
                  onChange={set("temperature")}
                  error={errors.temperature}
                />
                <NumberField
                  label="Top P"
                  help={`How strictly the model sticks to likely words. Recommended ${RECOMMENDED.top_p}.`}
                  step="0.01"
                  min={0}
                  max={1}
                  value={draft.top_p}
                  onChange={set("top_p")}
                  error={errors.top_p}
                />
                <NumberField
                  label="Evidence match threshold"
                  help="Minimum score for an answer to count as supported by its sources."
                  step="0.01"
                  min={0}
                  max={1}
                  value={draft.support_score_threshold}
                  onChange={set("support_score_threshold")}
                  error={errors.support_score_threshold}
                />
                <NumberField
                  label="Topic match threshold"
                  help="Minimum score for the sources to be about what the family asked."
                  step="0.01"
                  min={0}
                  max={1}
                  value={draft.scope_alignment_score_threshold}
                  onChange={set("scope_alignment_score_threshold")}
                  error={errors.scope_alignment_score_threshold}
                />
                <NumberField
                  label="Reliable answer threshold"
                  help="Final score for an answer to show no warning."
                  step="0.01"
                  min={0}
                  max={1}
                  value={draft.grounded_threshold}
                  onChange={set("grounded_threshold")}
                  error={errors.grounded_threshold}
                />
                <NumberField
                  label="Partial warning threshold"
                  help="Final score for a 'partly supported' warning instead of a stronger one."
                  step="0.01"
                  min={0}
                  max={1}
                  value={draft.partially_grounded_threshold}
                  onChange={set("partially_grounded_threshold")}
                  error={errors.partially_grounded_threshold}
                />
              </div>
              <div className="flex flex-wrap items-center gap-3 border-t border-foreground/10 pt-4">
                <Button type="button" variant="outline" onClick={resetDeveloper} disabled={!resetNeeded}>
                  <RotateCcw className="mr-2 h-4 w-4" aria-hidden="true" />
                  Reset to recommended
                </Button>
                <span className="text-xs text-foreground/70">
                  Resets the values in this card only. Save to apply.
                </span>
              </div>
            </SettingsCard>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-4 rounded-[13px] border border-foreground/12 bg-white px-5 py-3.5 shadow-sm">
            <div className="text-[13px] text-foreground/75" aria-live="polite">
              {changes
                ? hasErrors
                  ? "Fix the highlighted values to save."
                  : `${changes} unsaved change${changes === 1 ? "" : "s"}.`
                : notice ?? lastChanged ?? "All changes saved."}
            </div>
            <div className="flex items-center gap-2.5">
              {changes ? (
                <Button type="button" variant="outline" onClick={() => setDraft(saved)} disabled={saving}>
                  Discard
                </Button>
              ) : null}
              <Button type="button" onClick={save} disabled={!changes || hasErrors || saving}>
                <Save className="mr-2 h-4 w-4" aria-hidden="true" />
                {saving ? "Saving…" : "Save changes"}
              </Button>
            </div>
          </div>

          <div>
            <DeveloperSwitch checked={showDeveloper} onChange={setShowDeveloper} />
          </div>
        </>
      )}
    </div>
  );
}
