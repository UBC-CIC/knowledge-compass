import { useId, useState } from "react";
import { LifeBuoy } from "lucide-react";
import { SideDrawer } from "@/components/Admin/Prompts/parts";
import { SAFETY, activeClusters, situationLayer } from "@/lib/promptCatalog";
import type { Journey } from "@/types/journeys";

type Phase = "asking" | "guiding";

/**
 * What the assistant receives at a chosen moment in a conversation, top to
 * bottom (mirrors textGeneration/helpers/logic.get_current_prompt).
 */
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
  const [phase, setPhase] = useState<Phase>("asking");
  const [journeyKey, setJourneyKey] = useState("UNCLEAR");
  const [situation, setSituation] = useState("UNKNOWN");

  const live = journeys.filter((j) => !j.is_archived);
  const selected = live.find((j) => j.key === journeyKey) ?? null;
  const guiding = phase === "guiding";
  const layer = situationLayer(journeys, journeyKey, situation);
  const situationOptions = selected ? activeClusters(selected) : [];

  const rows: Array<{ name: string; detail: string; safety?: boolean }> = [
    { name: "The assistant", detail: "Who it is, boundaries and preferred language, plus the journey list" },
    { name: `How it talks · ${guiding ? "giving guidance" : "asking questions"}`, detail: "Shared by every journey" },
    guiding
      ? selected
        ? { name: `${selected.key} · How to guide`, detail: "This journey's guidance" }
        : { name: "How to guide · every journey", detail: "Journey not clear yet, so every journey is included", safety: true }
      : {
          name: "Journeys to listen for",
          detail: selected
            ? `Every journey's description and words, plus ${selected.key}'s questions`
            : "Every journey's description, words and questions",
          safety: !selected,
        },
    ...(guiding ? [{ name: "Situation steps", detail: layer.text, safety: layer.mode !== "matched" }] : []),
    { name: "Reply layout", detail: guiding ? "Full guidance" : "While asking" },
    {
      name: "Knowledge base passages",
      detail: `Up to ${guiding ? 15 : 5} passages that match the conversation, added automatically`,
    },
  ];

  let safety = "";
  if (guiding && selected && layer.mode === "journey-fallback") {
    safety = layer.clusters.length
      ? `No situation picked yet, so the assistant gets the steps for all ${layer.clusters.length} situations in ${selected.key}. Once one fits, only its steps are sent.`
      : `${selected.key} has no situations yet, so the assistant uses its guidance plus the shared pages.`;
  } else if (guiding && layer.mode === "all-fallback") {
    safety =
      "The journey isn't clear yet, so the assistant gets every journey and every situation. It still answers; it just has more to choose from.";
  } else if (!guiding && !selected) {
    safety = "Journey not clear yet, so the assistant has every journey's questions to choose from.";
  }

  const tab = (on: boolean) =>
    `h-9 flex-1 rounded-lg border text-[13.5px] font-semibold ${
      on ? "border-foreground/14 bg-white text-primary shadow-sm" : "border-transparent text-foreground/82"
    }`;
  const selectClass =
    "h-[38px] rounded-[9px] border-[1.5px] border-foreground/20 bg-white px-2.5 text-[13.5px] font-normal text-foreground disabled:opacity-60";

  return (
    <SideDrawer
      open={open}
      onOpenChange={onOpenChange}
      title="Preview a reply"
      description="Pick a moment in a conversation to see what the assistant receives."
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
          <select
            id={situationId}
            value={situation}
            onChange={(e) => setSituation(e.target.value)}
            disabled={!selected}
            className={selectClass}
          >
            <option value="UNKNOWN">Not known yet</option>
            {situationOptions.map((c) => (
              <option key={c.key} value={c.key}>
                {c.key} · {c.name}
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
                ? { background: SAFETY.bg, borderColor: "oklch(0.80 0.06 160)" }
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
          style={{ background: SAFETY.bg, borderColor: SAFETY.border, color: SAFETY.fg }}
        >
          {safety}
        </div>
      ) : null}
    </SideDrawer>
  );
}
