import { useEffect, useState } from "react";
import { Map } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import VersionedPromptEditor from "@/components/Admin/VersionedPromptEditor";
import { sortVersions, type PromptVersion } from "@/lib/promptVersions";

export type SystemMessageType =
  | "system_role"
  | "guardrails"
  | "language_guidelines"
  | "detective_phase_prompt"
  | "suggestion_phase_prompt"
  | "output_format_detective"
  | "output_format_suggestion"
  | "output_format_partial"
  | "welcome_message"
  | "disclaimer";

export type MessagePlacement =
  | "role"
  | "guardrails"
  | "language_guidelines"
  | "phase_detective"
  | "phase_suggestion"
  | "output_format_detective"
  | "output_format_suggestion"
  | "output_format_partial"
  | "ui_only";

export type SystemMessageVersion = PromptVersion & {
  type: SystemMessageType;
  affects_text_generation: boolean;
};

type Props = {
  type: SystemMessageType;
  title: string;
  description?: string;
  placement: MessagePlacement;
  affectsTextGeneration: boolean;
  versions: SystemMessageVersion[];
  adminEmail?: string | null;

  onCreateVersion: (type: SystemMessageType, newVersion: SystemMessageVersion) => void;
  onDeleteVersion: (type: SystemMessageType, versionId: string) => void;
  onActivateVersion: (type: SystemMessageType, versionId: string) => void;
  onSave: (type: SystemMessageType, content: string) => Promise<SystemMessageVersion>;
  onDelete: (type: SystemMessageType, versionId: string) => Promise<void>;
  onActivate: (type: SystemMessageType, versionId: string) => Promise<void>;
};

type PromptPhase = "DETECTIVE" | "SUGGESTION";

// Mirrors textGeneration/helpers/logic.py + chat.py: a static system block,
// then the phase-specific block (shared base prompt + the routed journey and
// situation prompts from the Journeys tab), then the retrieved knowledge base
// context.
const STACK_ROWS: Array<{
  key: string;
  title: (selectedPhase: PromptPhase) => string;
  isActive: (placement: MessagePlacement, selectedPhase: PromptPhase) => boolean;
}> = [
  {
    key: "role",
    title: () => "System Role",
    isActive: (placement) => placement === "role",
  },
  {
    key: "guardrails",
    title: () => "Guardrails",
    isActive: (placement) => placement === "guardrails",
  },
  {
    key: "language_guidelines",
    title: () => "Language Guidelines",
    isActive: (placement) => placement === "language_guidelines",
  },
  {
    key: "phase",
    title: (selectedPhase) =>
      selectedPhase === "DETECTIVE"
        ? "Detective Phase Prompt (shared base)"
        : "Suggestion Phase Prompt (shared base)",
    isActive: (placement, selectedPhase) =>
      (placement === "phase_detective" && selectedPhase === "DETECTIVE") ||
      (placement === "phase_suggestion" && selectedPhase === "SUGGESTION"),
  },
  {
    key: "journeys",
    title: (selectedPhase) =>
      selectedPhase === "DETECTIVE"
        ? "Journey signals and detective questions (Journeys tab)"
        : "Routed journey guidance and situation patterns (Journeys tab)",
    isActive: () => false,
  },
  {
    key: "output_format",
    title: (selectedPhase) =>
      selectedPhase === "DETECTIVE" ? "Detective Output Format" : "Suggestion Output Format",
    isActive: (placement, selectedPhase) =>
      (placement === "output_format_detective" && selectedPhase === "DETECTIVE") ||
      // Partial turns use the suggestion prompt with this format in place of
      // the suggestion output format.
      ((placement === "output_format_suggestion" || placement === "output_format_partial") &&
        selectedPhase === "SUGGESTION"),
  },
  {
    key: "retrieved_context",
    title: () => "Retrieved Knowledge Base Context",
    isActive: () => false,
  },
];

const PHASE_ONLY_PLACEMENTS: Partial<Record<MessagePlacement, PromptPhase>> = {
  phase_detective: "DETECTIVE",
  output_format_detective: "DETECTIVE",
  phase_suggestion: "SUGGESTION",
  output_format_suggestion: "SUGGESTION",
  output_format_partial: "SUGGESTION",
};

function nextVersionNumber(list: SystemMessageVersion[]) {
  const maxV = list.reduce((m, v) => Math.max(m, v.version ?? 0), 0);
  return maxV + 1;
}

function defaultAffectsTextGeneration(type: SystemMessageType) {
  return !["disclaimer", "welcome_message"].includes(type);
}

function truncatePreview(text?: string, max = 120) {
  const value = (text ?? "").trim();
  if (!value) return "No active content available.";
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function PlacementStack({
  placement,
  selectedPhase,
}: {
  placement: MessagePlacement;
  selectedPhase: PromptPhase;
}) {
  return (
    <div className="space-y-2">
      {STACK_ROWS.map((row, index) => {
        const title = row.title(selectedPhase);
        const active = row.isActive(placement, selectedPhase);

        return (
          <div key={row.key}>
            <div
              className={[
                "rounded-lg border px-3 py-3 transition",
                active
                  ? "border-primary bg-primary/10"
                  : "border-gray-200 bg-gray-50",
              ].join(" ")}
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-sm text-gray-900">{title}</span>
                {active ? (
                  <span className="text-xs rounded-full bg-primary text-white px-2 py-1">
                    This message
                  </span>
                ) : null}
              </div>
            </div>

            {index < STACK_ROWS.length - 1 ? (
              <div className="flex justify-center py-1">
                <div className="h-4 w-px bg-gray-300" />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export default function SystemMessageEditor({
  type,
  title,
  description,
  placement,
  affectsTextGeneration,
  versions,
  adminEmail,
  onCreateVersion,
  onDeleteVersion,
  onActivateVersion,
  onSave,
  onDelete,
  onActivate,
}: Props) {
  const [current, setCurrent] = useState<SystemMessageVersion | undefined>();

  const [placementOpen, setPlacementOpen] = useState(false);
  const onlyPhase = PHASE_ONLY_PLACEMENTS[placement];
  const [placementPhase, setPlacementPhase] = useState<PromptPhase>(
    onlyPhase ?? "DETECTIVE"
  );

  useEffect(() => {
    if (onlyPhase) setPlacementPhase(onlyPhase);
  }, [onlyPhase]);

  const handleSave = async (content: string) => {
    try {
      // should return the newly created active version
      const created = await onSave(type, content);
      onCreateVersion(type, created);
    } catch (e) {
      console.error(e);

      // fallback
      const sorted = sortVersions(versions);
      const latest = sorted[0];
      const localVersion: SystemMessageVersion = {
        id: `local-${type}-v${nextVersionNumber(sorted)}-${Date.now()}`,
        type,
        content,
        character_limit: latest?.character_limit ?? 700,
        version: nextVersionNumber(sorted),
        is_active: true,
        affects_text_generation: defaultAffectsTextGeneration(type),
        created_by_email: adminEmail ?? undefined,
        created_at: new Date().toISOString(),
      };

      onCreateVersion(type, localVersion);
      return { notice: "Saved locally (backend save failed)." };
    }
  };

  const handleDelete = async (versionId: string) => {
    await onDelete(type, versionId);
    // Remove from parent state
    onDeleteVersion(type, versionId);
  };

  const handleActivate = async (versionId: string) => {
    await onActivate(type, versionId);
    // Update parent-local versions state so selected version is active
    onActivateVersion(type, versionId);
  };

  return (
    <>
      <VersionedPromptEditor<SystemMessageVersion>
        title={title}
        label={title}
        description={description}
        versions={versions}
        onSave={handleSave}
        onDelete={handleDelete}
        onActivate={handleActivate}
        onCurrentChange={setCurrent}
        headerAction={
          <Button
            type="button"
            variant="outline"
            onClick={() => setPlacementOpen(true)}
            className="shrink-0"
          >
            <Map className="mr-2 h-4 w-4" aria-hidden="true" />
            Where does this go?
          </Button>
        }
      />

      <Dialog open={placementOpen} onOpenChange={setPlacementOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Map className="h-5 w-5 text-primary" aria-hidden="true" />
              Where does this go?
            </DialogTitle>
            <DialogDescription>
              {affectsTextGeneration
                ? <>See where <span className="font-medium">{title}</span> fits into the overall prompt flow.</>
                : <>This message is shown in the UI and does not affect text generation.</>}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5">
            {placement !== "ui_only" && (
              <>
                <div className="flex items-center justify-between gap-4">
                  <div className="text-sm font-medium text-gray-800">
                    Prompt position preview
                  </div>

                  <div className="inline-flex rounded-lg border border-gray-200 p-1 bg-gray-50 w-fit">
                    <Button
                      type="button"
                      variant={placementPhase === "DETECTIVE" ? "default" : "ghost"}
                      className={
                        placementPhase === "DETECTIVE"
                          ? "bg-primary hover:bg-primary/90"
                          : ""
                      }
                      onClick={() => setPlacementPhase("DETECTIVE")}
                    >
                      Detective
                    </Button>
                    <Button
                      type="button"
                      variant={placementPhase === "SUGGESTION" ? "default" : "ghost"}
                      className={
                        placementPhase === "SUGGESTION"
                          ? "bg-primary hover:bg-primary/90"
                          : ""
                      }
                      onClick={() => setPlacementPhase("SUGGESTION")}
                    >
                      Suggestion
                    </Button>
                  </div>
                </div>

                {onlyPhase && onlyPhase !== placementPhase && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                    This message is only used in the{" "}
                    <span className="font-medium">
                      {onlyPhase === "DETECTIVE" ? "Detective" : "Suggestion"}
                    </span>{" "}
                    phase.
                  </div>
                )}

                <PlacementStack
                  placement={placement}
                  selectedPhase={placementPhase}
                />
              </>
            )}

            <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">
              <div className="text-sm font-medium text-gray-900 mb-2">Current active content preview</div>
              <div className="text-sm text-gray-700 whitespace-pre-wrap">
                {truncatePreview(current?.content, 240)}
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPlacementOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
