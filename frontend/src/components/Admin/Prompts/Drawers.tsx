import { useId, useState } from "react";
import { LifeBuoy, Undo2 } from "lucide-react";
import { Alert, SideDrawer, outlineButton } from "@/components/Admin/Prompts/parts";
import { STAGE_STYLE, activeClusters, firstLines, situationLayer } from "@/lib/promptCatalog";
import { buildDetectiveBlock, buildSuggestionBlock } from "@/lib/journeyPrompt";
import { formatDate, sortVersions, type PromptVersion } from "@/lib/promptVersions";
import type { Journey } from "@/types/journeys";

// ------------------------------------------------------------------
// History
// ------------------------------------------------------------------

export function HistoryDrawer({
  open,
  onOpenChange,
  title,
  versions,
  onRestore,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  versions: PromptVersion[];
  onRestore: (versionId: string) => Promise<unknown>;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const restore = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      await onRestore(id);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "Could not restore this version.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <SideDrawer open={open} onOpenChange={onOpenChange} title={`History · ${title}`} description="Earlier versions of this text.">
      {error ? <Alert>{error}</Alert> : null}
      {versions.length === 0 ? <p className="text-[13px] text-foreground/70">No versions yet.</p> : null}
      <ol className="flex flex-col gap-2.5">
        {sortVersions(versions).map((v) => (
          <li key={v.id} className="rounded-[10px] border border-foreground/12 px-[15px] py-[13px]">
            <div className="flex items-center justify-between gap-2.5">
              <div>
                <div className="text-sm font-bold">Version {v.version}</div>
                <div className="mt-0.5 text-[12.5px] text-foreground/75">
                  {v.created_by_email || "Seeded with the project"} ·{" "}
                  {v.created_by_email && v.created_at ? formatDate(v.created_at) : "Original version"}
                </div>
              </div>
              {v.is_active ? (
                <span
                  className="rounded-full px-2.5 py-[3px] text-[11.5px] font-bold"
                  style={{ background: STAGE_STYLE.guiding.bg, color: STAGE_STYLE.guiding.fg }}
                >
                  Live
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => restore(v.id)}
                  disabled={busyId !== null}
                  className={`${outlineButton} h-8 text-[13px]`}
                  aria-label={`Restore version ${v.version}`}
                >
                  <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
                  {busyId === v.id ? "Restoring..." : "Restore"}
                </button>
              )}
            </div>
            <div className="mt-2.5 whitespace-pre-line rounded-[7px] bg-muted px-[11px] py-[9px] text-[12.5px] leading-normal text-foreground/82">
              {firstLines(v.content, 4)}
            </div>
          </li>
        ))}
      </ol>
      <p className="text-[12.5px] leading-normal text-foreground/72">
        Every save keeps the previous version here. Restoring makes an old version live again; nothing is deleted.
      </p>
    </SideDrawer>
  );
}

// ------------------------------------------------------------------
// Preview a reply
// ------------------------------------------------------------------

type Phase = "asking" | "guiding";

export function PreviewDrawer({
  open,
  onOpenChange,
  journeys,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  journeys: Journey[];
}) {
  const journeyId = useId();
  const situationId = useId();
  const [phase, setPhase] = useState<Phase>("guiding");
  const [journeyKey, setJourneyKey] = useState("UNCLEAR");
  const [situation, setSituation] = useState("UNKNOWN");

  const live = journeys.filter((j) => !j.is_archived);
  const selected = live.find((j) => j.key === journeyKey) ?? null;
  const guiding = phase === "guiding";
  const layer = situationLayer(journeys, journeyKey, situation);
  const situationOptions = (selected ? [selected] : live).flatMap((j) =>
    activeClusters(j).map((c) => ({ v: c.key, l: `${c.key} · ${c.name}` }))
  );

  const rows: Array<{ name: string; detail: string; safety?: boolean }> = [
    { name: "Who the assistant is", detail: "Every reply" },
    { name: "Boundaries", detail: "Every reply" },
    { name: "Preferred language", detail: "Every reply" },
    { name: guiding ? "How to give guidance" : "How to ask questions", detail: "Shared by all journeys" },
    guiding
      ? {
          name: selected ? `${selected.key} · How to guide` : "How to guide · every journey",
          detail: selected ? "This journey's guidance" : "Journey not clear yet, so all journeys are included",
          safety: !selected,
        }
      : {
          name: "Journeys to listen for",
          detail: selected
            ? `All journeys' descriptions and words, plus ${selected.key}'s questions`
            : "All journeys' descriptions, words and questions",
          safety: !selected,
        },
    ...(guiding ? [{ name: "Situation steps", detail: layer.text, safety: layer.mode !== "matched" }] : []),
    { name: guiding ? "Reply layout for guidance" : "Reply layout while asking", detail: "Shapes the reply" },
    {
      name: "Knowledge base passages",
      detail: `Up to ${guiding ? 15 : 5} passages that match the conversation, added automatically`,
    },
  ];

  let safety = "";
  if (guiding && layer.mode === "journey-fallback" && selected) {
    safety = layer.clusters.length
      ? `No situation picked yet, so the assistant gets the steps for all ${layer.clusters.length} situations in ${selected.key}. Once a situation fits, only its steps are sent.`
      : `${selected.key} has no situations yet, so the assistant uses its guidance plus the shared rules.`;
  } else if (guiding && layer.mode === "all-fallback") {
    safety =
      "The journey isn't clear yet, so the assistant gets every journey and every situation. It still answers; it just has more to choose from.";
  } else if (!guiding && !selected) {
    safety = "Journey not clear yet, so the assistant has every journey's questions to choose from.";
  }

  const route = { journey: journeyKey, situation, secondary: "NONE" };
  const exact = guiding ? buildSuggestionBlock(journeys, route) : buildDetectiveBlock(journeys, route);

  const tab = (on: boolean) =>
    `h-9 flex-1 rounded-lg border text-[13.5px] font-semibold ${
      on ? "border-foreground/14 bg-white text-primary shadow-sm" : "border-transparent text-foreground/82"
    }`;
  const selectClass =
    "h-[38px] rounded-[9px] border-[1.5px] border-foreground/20 bg-white px-2.5 text-[13.5px] font-normal text-foreground";

  return (
    <SideDrawer
      open={open}
      onOpenChange={onOpenChange}
      title="Preview a reply"
      description="Pick a moment in a conversation to see which prompts the assistant receives."
    >
      <div className="flex gap-1 rounded-[10px] border border-foreground/12 bg-muted p-1" role="group" aria-label="Step">
        <button type="button" aria-pressed={!guiding} onClick={() => setPhase("asking")} className={tab(!guiding)}>
          1 · Asking questions
        </button>
        <button type="button" aria-pressed={guiding} onClick={() => setPhase("guiding")} className={tab(guiding)}>
          2 · Giving guidance
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        <label htmlFor={journeyId} className="flex flex-col gap-1.5 text-[13px] font-bold">
          Journey
          <select
            id={journeyId}
            value={journeyKey}
            onChange={(e) => {
              setJourneyKey(e.target.value);
              setSituation("UNKNOWN");
            }}
            className={selectClass}
          >
            <option value="UNCLEAR">Not clear yet</option>
            {live.map((j) => (
              <option key={j.key} value={j.key}>
                {j.key} · {j.name}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor={situationId} className="flex flex-col gap-1.5 text-[13px] font-bold">
          Situation
          <select id={situationId} value={situation} onChange={(e) => setSituation(e.target.value)} className={selectClass}>
            <option value="UNKNOWN">Not known yet</option>
            {situationOptions.map((o) => (
              <option key={o.v} value={o.v}>
                {o.l}
              </option>
            ))}
          </select>
        </label>
      </div>

      <h3 className="text-xs font-bold uppercase tracking-[0.06em] text-foreground/70">
        Sent to the assistant, top to bottom
      </h3>
      <ol className="flex flex-col gap-1.5">
        {rows.map((r, i) => (
          <li
            key={r.name}
            className="flex items-start gap-2.5 rounded-[9px] border px-3 py-2.5"
            style={
              r.safety
                ? { background: "oklch(0.97 0.02 160)", borderColor: "oklch(0.80 0.06 160)" }
                : { background: "#fff", borderColor: "rgba(22,24,29,0.12)" }
            }
          >
            <span className="w-[22px] flex-none text-[12.5px] font-bold text-foreground/60">{i + 1}</span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13.5px] font-semibold">{r.name}</span>
              <span className="mt-0.5 block text-[12.5px] leading-snug text-foreground/75">{r.detail}</span>
            </span>
            {r.safety ? (
              <span
                className="inline-flex flex-none items-center gap-1 rounded-full px-[9px] py-[3px] text-[11.5px] font-bold"
                style={{ background: "oklch(0.95 0.04 160)", color: "oklch(0.32 0.09 160)" }}
              >
                <LifeBuoy className="h-[13px] w-[13px]" aria-hidden="true" />
                Safety net
              </span>
            ) : null}
          </li>
        ))}
      </ol>

      {safety ? (
        <div
          className="rounded-[10px] border border-dashed px-3.5 py-3 text-[13px] leading-relaxed"
          style={{ background: "oklch(0.97 0.02 160)", borderColor: "oklch(0.70 0.08 160)", color: "oklch(0.30 0.06 160)" }}
        >
          {safety}
        </div>
      ) : null}

      <details className="rounded-[10px] border border-foreground/12">
        <summary className="cursor-pointer px-3.5 py-2.5 text-[13px] font-semibold">
          Show the exact journey text ({exact.length.toLocaleString()} characters)
        </summary>
        <pre
          tabIndex={0}
          aria-label="Exact journey text"
          className="max-h-[360px] overflow-auto whitespace-pre-wrap border-t border-foreground/10 bg-muted p-3 font-mono text-xs text-foreground/85"
        >
          {exact || "No active journeys."}
        </pre>
      </details>
    </SideDrawer>
  );
}
