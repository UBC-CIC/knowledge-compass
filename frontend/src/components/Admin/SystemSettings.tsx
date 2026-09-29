import { useState, useEffect, useMemo } from "react";
import {
  Save,
  Sparkles,
  Eye,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
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
import { AuthService } from "@/functions/authService";
import { getCurrentUser } from "aws-amplify/auth";
import SystemMessageEditor from "@/components/Admin/SystemMessageEditor";
import { DEFAULT_SYSTEM_MESSAGES } from "@/components/Admin/defaultSystemMessages";
import { DEMO_ADMIN_EMAIL, isDemoMode } from "@/lib/demo";
import type {
  SystemMessageType,
  SystemMessageVersion,
  MessagePlacement,
} from "@/components/Admin/SystemMessageEditor";

type RoutingMode = "fixed" | "dynamic";

type SystemSettingsDTO = {
  max_messages_per_day: number;
  min_messages_before_suggest: number;
  routing_mode: RoutingMode;
  min_exchanges_before_answer: number;
  max_characters_per_user_message: number;
  max_characters_per_ai_message: number;
  temperature: number;
  top_p: number;
  support_score_threshold: number;
  scope_alignment_score_threshold: number;
  grounded_threshold: number;
  partially_grounded_threshold: number;
  updated_at?: string;
  updated_by_email?: string | null;
};

type SystemSettingsAPIResponse = Partial<SystemSettingsDTO>;

const DEFAULT_SETTINGS: SystemSettingsDTO = {
  max_messages_per_day: 45,
  min_messages_before_suggest: 4,
  routing_mode: "fixed",
  min_exchanges_before_answer: 0,
  max_characters_per_user_message: 2000,
  max_characters_per_ai_message: 5000,
  temperature: 0.2,
  top_p: 0.9,
  support_score_threshold: 0.25,
  scope_alignment_score_threshold: 0.25,
  grounded_threshold: 0.75,
  partially_grounded_threshold: 0.5,
};

type MessageMeta = {
  title: string;
  description: string;
  affectsTextGeneration: boolean;
  placement: MessagePlacement;
};

// Ordered to match the prompt assembly in textGeneration/helpers/logic.py.
const MESSAGE_META: Record<SystemMessageType, MessageMeta> = {
  system_role: {
    title: "System Role",
    description: "Defines who the guide is, who it serves, and the two family journeys it supports",
    affectsTextGeneration: true,
    placement: "role",
  },
  guardrails: {
    title: "Guardrails",
    description: "Boundaries that keep the guide collaborative, non-legal, and grounded in the knowledge base",
    affectsTextGeneration: true,
    placement: "guardrails",
  },
  language_guidelines: {
    title: "Language Guidelines",
    description: "Inclusion Canada's preferred language for disability, identity, and support",
    affectsTextGeneration: true,
    placement: "language_guidelines",
  },
  detective_phase_prompt: {
    title: "Detective Phase Prompt",
    description:
      "Instructions for asking one question at a time to identify the family's journey and situation. Keep the {exchange_count} and {readiness_note} placeholders ({min_exchanges} and {may_suggest} are still supported)",
    affectsTextGeneration: true,
    placement: "phase_detective",
  },
  suggestion_phase_prompt: {
    title: "Suggestion Phase Prompt",
    description: "Journey stages and the guidance to give once the family's situation is clear",
    affectsTextGeneration: true,
    placement: "phase_suggestion",
  },
  output_format_detective: {
    title: "Detective Output Format",
    description: "How replies are shaped while the guide is still asking questions",
    affectsTextGeneration: true,
    placement: "output_format_detective",
  },
  output_format_suggestion: {
    title: "Suggestion Output Format",
    description:
      "How guidance replies are structured. Keep the <answer> and <cited_indices> tags, which the app uses to parse replies and sources",
    affectsTextGeneration: true,
    placement: "output_format_suggestion",
  },
  output_format_partial: {
    title: "Partial Guidance Output Format",
    description:
      "Used instead of the suggestion output format when the situation is mostly clear but one detail is missing (dynamic routing only): 1-2 low-risk steps plus one clarifying question. Keep the <answer>, <cited_indices> and <journey_state> tags",
    affectsTextGeneration: true,
    placement: "output_format_partial",
  },
  welcome_message: {
    title: "Welcome Message",
    description: "The first message shown to greet the family and start the conversation",
    affectsTextGeneration: false,
    placement: "ui_only",
  },
  disclaimer: {
    title: "Disclaimer",
    description: "A short note explaining the limits of the guide's information",
    affectsTextGeneration: false,
    placement: "ui_only",
  },
};

type PromptPhase = "DETECTIVE" | "SUGGESTION";

type PromptStackBlock = {
  key: string;
  title: string;
  preview: string;
};

const PROMPT_STACK_ORDER: Array<{
  key: string;
  title: (phase: PromptPhase) => string;
  getPreview: (
    phase: PromptPhase,
    messages: Record<SystemMessageType, SystemMessageVersion[]>
  ) => string;
}> = [
  {
    key: "role",
    title: () => "System Role",
    getPreview: (_, messages) => getActiveVersion(messages.system_role)?.content ?? "",
  },
  {
    key: "guardrails",
    title: () => "Guardrails",
    getPreview: (_, messages) => getActiveVersion(messages.guardrails)?.content ?? "",
  },
  {
    key: "language_guidelines",
    title: () => "Language Guidelines",
    getPreview: (_, messages) => getActiveVersion(messages.language_guidelines)?.content ?? "",
  },
  {
    key: "phase",
    title: (phase) => (phase === "DETECTIVE" ? "Detective Phase Prompt" : "Suggestion Phase Prompt"),
    getPreview: (phase, messages) =>
      phase === "DETECTIVE"
        ? getActiveVersion(messages.detective_phase_prompt)?.content ?? ""
        : getActiveVersion(messages.suggestion_phase_prompt)?.content ?? "",
  },
  {
    key: "output_format",
    title: (phase) => (phase === "DETECTIVE" ? "Detective Output Format" : "Suggestion Output Format"),
    getPreview: (phase, messages) =>
      phase === "DETECTIVE"
        ? getActiveVersion(messages.output_format_detective)?.content ?? ""
        : getActiveVersion(messages.output_format_suggestion)?.content ?? "",
  },
  {
    key: "retrieved_context",
    title: () => "Retrieved Knowledge Base Context",
    getPreview: (phase) =>
      `Up to ${phase === "DETECTIVE" ? 5 : 15} passages from the knowledge base that best match the conversation, added automatically.`,
  },
];

function getActiveVersion(
  versions: SystemMessageVersion[] | undefined
): SystemMessageVersion | undefined {
  return versions?.find((v) => v.is_active);
}

function getPromptStackBlocks(
  phase: PromptPhase,
  messages: Record<SystemMessageType, SystemMessageVersion[]>
): PromptStackBlock[] {
  return PROMPT_STACK_ORDER.map((item) => ({
    key: item.key,
    title: item.title(phase),
    preview: item.getPreview(phase, messages),
  }));
}

function truncatePreview(text?: string, max = 130) {
  const value = (text ?? "").trim();
  if (!value) return "No active content available.";
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function PromptAssemblyCard({
  phase,
  setPhase,
  settings,
  messages,
}: {
  phase: PromptPhase;
  setPhase: (phase: PromptPhase) => void;
  settings: SystemSettingsDTO;
  messages: Record<SystemMessageType, SystemMessageVersion[]>;
}) {
  const blocks = useMemo(
    () => getPromptStackBlocks(phase, messages),
    [phase, messages]
  );

  return (
    <Card className="rounded-[13px] border-foreground/12 shadow-sm">
      <CardHeader>
        <CardTitle className="text-[18.5px] font-bold tracking-[-0.01em]">
          How a reply is assembled
        </CardTitle>
        <CardDescription>
          Blocks are stacked in this fixed order. Role, guardrails and language guidelines are always sent; the phase and output format blocks switch when the conversation moves to the suggestion phase.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div className="inline-flex rounded-lg border border-gray-200 p-1 bg-gray-50 w-fit">
            <Button
              type="button"
              variant={phase === "DETECTIVE" ? "default" : "ghost"}
              className={phase === "DETECTIVE" ? "bg-primary hover:bg-primary/90" : ""}
              onClick={() => setPhase("DETECTIVE")}
            >
              Detective Phase
            </Button>
            <Button
              type="button"
              variant={phase === "SUGGESTION" ? "default" : "ghost"}
              className={phase === "SUGGESTION" ? "bg-primary hover:bg-primary/90" : ""}
              onClick={() => setPhase("SUGGESTION")}
            >
              Suggestion Phase
            </Button>
          </div>

          <div className="text-sm text-gray-500">
            {settings.routing_mode === "dynamic" ? (
              <>
                Each message is routed; guidance comes by exchange{" "}
                <span className="font-medium text-gray-700">
                  {settings.min_messages_before_suggest}
                </span>{" "}
                at the latest.
              </>
            ) : (
              <>
                Suggestion phase starts after{" "}
                <span className="font-medium text-gray-700">
                  {settings.min_messages_before_suggest}
                </span>{" "}
                exchange{settings.min_messages_before_suggest === 1 ? "" : "s"}.
              </>
            )}
          </div>
        </div>

        <div className="space-y-3">
          {blocks.map((block, index) => (
            <div key={block.key} className="relative">
              <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
                <div className="space-y-2 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-gray-900">{block.title}</span>
                  </div>

                  <div className="rounded-md bg-gray-50 border border-gray-200 px-3 py-2 text-sm text-gray-700">
                    {truncatePreview(block.preview)}
                  </div>
                </div>
              </div>

              {index < blocks.length - 1 ? (
                <div className="flex justify-center py-1">
                  <div className="h-5 w-px bg-gray-300" />
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export default function SystemSettings() {
  const [settings, setSettings] = useState<SystemSettingsDTO>(DEFAULT_SETTINGS);
  const [adminEmail, setAdminEmail] = useState<string | null>(null);


  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // System messages (frontend-only right now)
  const [messages, setMessages] = useState<
    Record<SystemMessageType, SystemMessageVersion[]>
  >(DEFAULT_SYSTEM_MESSAGES);

  const [promptPhase, setPromptPhase] = useState<PromptPhase>("DETECTIVE");

  const messageTypes = useMemo(
    () => Object.keys(MESSAGE_META) as SystemMessageType[],
    []
  );

  const textGenerationMessageTypes = useMemo(
    () => messageTypes.filter((t) => MESSAGE_META[t].affectsTextGeneration),
    [messageTypes]
  );

  const nonTextGenerationMessageTypes = useMemo(
    () => messageTypes.filter((t) => !MESSAGE_META[t].affectsTextGeneration),
    [messageTypes]
  );

  const fetchAdminCredentials = async () => {
    if (isDemoMode) {
      setAdminEmail(DEMO_ADMIN_EMAIL);
      return;
    }
    const user = await getCurrentUser();
    const email = user?.signInDetails?.loginId ?? null;
    setAdminEmail(email);
  };

  const fetchSystemSettings = async () => {
    if (isDemoMode) {
      setLoading(false);
      setError(null);
      return;
    }
    try {
      setLoading(true);
      setError(null);

      const token = await AuthService.getAdminIdToken();

      const res = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/admin/system-settings`,
        {
        headers: {
          Authorization: token,
          "Content-Type": "application/json",
        },
        }
      );

      if (!res.ok) throw new Error("Failed to fetch system settings");
      const data: SystemSettingsAPIResponse = await res.json();

      setSettings({
        max_messages_per_day:
          data.max_messages_per_day ?? DEFAULT_SETTINGS.max_messages_per_day,
        min_messages_before_suggest:
          data.min_messages_before_suggest ?? DEFAULT_SETTINGS.min_messages_before_suggest,
        routing_mode:
          data.routing_mode === "dynamic" || data.routing_mode === "fixed"
            ? data.routing_mode
            : DEFAULT_SETTINGS.routing_mode,
        min_exchanges_before_answer:
          data.min_exchanges_before_answer ?? DEFAULT_SETTINGS.min_exchanges_before_answer,
        max_characters_per_user_message:
          data.max_characters_per_user_message ?? DEFAULT_SETTINGS.max_characters_per_user_message,
        max_characters_per_ai_message:
          data.max_characters_per_ai_message ?? DEFAULT_SETTINGS.max_characters_per_ai_message,
        temperature: data.temperature ?? DEFAULT_SETTINGS.temperature,
        top_p: data.top_p ?? DEFAULT_SETTINGS.top_p,
        support_score_threshold: data.support_score_threshold ?? DEFAULT_SETTINGS.support_score_threshold,
        scope_alignment_score_threshold: data.scope_alignment_score_threshold ?? DEFAULT_SETTINGS.scope_alignment_score_threshold,
        grounded_threshold: data.grounded_threshold ?? DEFAULT_SETTINGS.grounded_threshold,
        partially_grounded_threshold: data.partially_grounded_threshold ?? DEFAULT_SETTINGS.partially_grounded_threshold,
        updated_at: data.updated_at,
        updated_by_email: data.updated_by_email ?? null,
      });
    } catch (e) {
      console.error(e);
      setError("Failed to load system settings");
    } finally {
      setLoading(false);
    }
  };

  const fetchSystemMessages = async () => {
    if (isDemoMode) {
      return;
    }
    try {
      const token = await AuthService.getAdminIdToken();

      const res = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/admin/system-messages`,
        {
        headers: {
          Authorization: token,
          "Content-Type": "application/json",
        },
        }
      );

      if (!res.ok) throw new Error("Failed to fetch system messages");
      const data = await res.json();
      setMessages(data);
    } catch (e) {
      console.error(e);
      // fallback to defaults if desired
      setMessages(DEFAULT_SYSTEM_MESSAGES);
    }
  };

  const handleSaveSystemSettings = async () => {
    if (settings.min_exchanges_before_answer > settings.min_messages_before_suggest) {
      setError(
        "Questions before guidance must be less than or equal to the exchange by which guidance is given"
      );
      return;
    }
    try {
      setSaving(true);
      setError(null);

      const token = await AuthService.getAdminIdToken();

      if (!adminEmail) throw new Error("Missing admin email (not authenticated?)");

      const payload = {
        max_messages_per_day: settings.max_messages_per_day,
        min_messages_before_suggest: settings.min_messages_before_suggest,
        routing_mode: settings.routing_mode,
        min_exchanges_before_answer: settings.min_exchanges_before_answer,
        max_characters_per_user_message: settings.max_characters_per_user_message,
        max_characters_per_ai_message: settings.max_characters_per_ai_message,
        temperature: settings.temperature,
        top_p: settings.top_p,
        support_score_threshold: settings.support_score_threshold,
        scope_alignment_score_threshold: settings.scope_alignment_score_threshold,
        grounded_threshold: settings.grounded_threshold,
        partially_grounded_threshold: settings.partially_grounded_threshold,
        updated_by_email: adminEmail,
      };

      const res = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/admin/system-settings`,
        {
        method: "PUT",
        headers: {
          Authorization: token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        }
      );

      if (!res.ok) throw new Error("Failed to save system settings");

      await fetchSystemSettings();
    } catch (e) {
      console.error(e);
      setError("Failed to save system settings");
    } finally {
      setSaving(false);
    }
  };

  const handleCreateSystemMessageVersion = (
    type: SystemMessageType,
    newVersion: SystemMessageVersion
  ) => {
    setMessages((prev) => {
      const existing = prev[type] ?? [];
      const deactivated = existing.map((v) => ({ ...v, is_active: false }));
      return {
        ...prev,
        [type]: [newVersion, ...deactivated],
      };
    });
  };

  const saveSystemMessage = async (
    type: SystemMessageType,
    content: string
  ): Promise<SystemMessageVersion> => {
    const token = await AuthService.getAdminIdToken();

    if (!adminEmail) throw new Error("Missing adminEmail");

    const res = await fetch(
      `${import.meta.env.VITE_API_ENDPOINT}/admin/system-messages/${type}`,
      {
      method: "POST",
      headers: {
        Authorization: token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content, adminEmail }),
      }
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Failed to save system message (${res.status}): ${text}`);
    }

    return (await res.json()) as SystemMessageVersion;
  };

  const handleDeleteSystemMessageVersion = (
    type: SystemMessageType,
    versionId: string
  ) => {
    setMessages((prev) => {
      const existing = prev[type] ?? [];
      return {
        ...prev,
        [type]: existing.filter((v) => v.id !== versionId),
      };
    });
  };

  const deleteSystemMessage = async (
    type: SystemMessageType,
    versionId: string
  ): Promise<void> => {
    const token = await AuthService.getAdminIdToken();

    if (!adminEmail) throw new Error("Missing adminEmail");

    const res = await fetch(
      `${import.meta.env.VITE_API_ENDPOINT}/admin/system-messages/${type}/${versionId}`,
      {
        method: "DELETE",
        headers: {
          Authorization: token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ adminEmail }),
      }
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Failed to delete system message (${res.status}): ${text}`);
    }
  };

  const handleActivateSystemMessageVersion = (
    type: SystemMessageType,
    versionId: string
  ) => {
    setMessages((prev) => {
      const existing = prev[type] ?? [];
      return {
        ...prev,
        [type]: existing.map((v) => ({
          ...v,
          is_active: v.id === versionId,
        })),
      };
    });
  };

  const activateSystemMessage = async (
    type: SystemMessageType,
    versionId: string
  ): Promise<void> => {
    const token = await AuthService.getAdminIdToken();

    if (!adminEmail) throw new Error("Missing adminEmail");

    const res = await fetch(
      `${import.meta.env.VITE_API_ENDPOINT}/admin/system-messages/${type}/${versionId}/activate`,
      {
        method: "POST",
        headers: {
          Authorization: token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ adminEmail }),
      }
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Failed to activate system message (${res.status}): ${text}`);
    }
  };

  useEffect(() => {
    fetchAdminCredentials();
    fetchSystemSettings();
    fetchSystemMessages();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="mx-auto max-w-[1000px] space-y-6">
      <div>
        <h1 className="font-serif text-[30px] font-semibold leading-tight tracking-[-0.015em]">
          Assistant settings
        </h1>
        <p className="mt-2 text-[15.5px] leading-relaxed text-foreground/80">
          Limits, tone of the detective questions, and the wording users see.
        </p>
      </div>

      {/* System settings */}
      <Card className="rounded-[13px] border-foreground/12 shadow-sm">
        <CardHeader>
          <CardTitle className="text-[18.5px] font-bold tracking-[-0.01em]">
            Conversation limits
          </CardTitle>
          <CardDescription>
            Changes apply to new conversations right away.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-6">
          {error ? (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
              {error}
            </div>
          ) : null}

          {loading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <Label htmlFor="max-messages-per-day">Max messages per day</Label>
                  <Input
                    id="max-messages-per-day"
                    type="number"
                    min={1}
                    value={settings.max_messages_per_day}
                    onChange={(e) =>
                      setSettings((s) => ({
                        ...s,
                        max_messages_per_day: Number(e.target.value),
                      }))
                    }
                  />
                  <p className="text-xs text-gray-500">
                    Maximum number of messages a user can send in a 24 hour window
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="routing-mode">When to give guidance</Label>
                  <Select
                    value={settings.routing_mode}
                    onValueChange={(value) =>
                      setSettings((s) => ({ ...s, routing_mode: value as RoutingMode }))
                    }
                  >
                    <SelectTrigger id="routing-mode" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="fixed">Fixed: after a set number of exchanges</SelectItem>
                      <SelectItem value="dynamic">Dynamic: as soon as the situation is clear</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-gray-500">
                    Dynamic mode reads each message and answers, asks, or gives a short
                    first step plus one question
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="min-messages-before-suggest">
                    {settings.routing_mode === "dynamic"
                      ? "Give guidance by exchange"
                      : "Min messages before suggest"}
                  </Label>
                  <Input
                    id="min-messages-before-suggest"
                    type="number"
                    min={0}
                    value={settings.min_messages_before_suggest}
                    onChange={(e) =>
                      setSettings((s) => ({
                        ...s,
                        min_messages_before_suggest: Number(e.target.value),
                      }))
                    }
                  />
                  <p className="text-xs text-gray-500">
                    {settings.routing_mode === "dynamic"
                      ? "Latest exchange at which guidance is always given, even if details are still missing"
                      : "Minimum back-and-forth before suggestion logic can activate"}
                  </p>
                </div>

                {settings.routing_mode === "dynamic" ? (
                  <div className="space-y-2">
                    <Label htmlFor="min-exchanges-before-answer">Questions before guidance</Label>
                    <Input
                      id="min-exchanges-before-answer"
                      type="number"
                      min={0}
                      max={settings.min_messages_before_suggest}
                      value={settings.min_exchanges_before_answer}
                      aria-describedby="min-exchanges-before-answer-help"
                      onChange={(e) =>
                        setSettings((s) => ({
                          ...s,
                          min_exchanges_before_answer: Number(e.target.value),
                        }))
                      }
                    />
                    <p id="min-exchanges-before-answer-help" className="text-xs text-gray-500">
                      Minimum questions to ask first. 0 lets a clear first message be answered
                      right away; urgent situations are always answered immediately
                    </p>
                  </div>
                ) : null}

                <div className="space-y-2">
                  <Label htmlFor="max-chars-user">Max characters per user message</Label>
                  <Input
                    id="max-chars-user"
                    type="number"
                    min={1}
                    value={settings.max_characters_per_user_message}
                    onChange={(e) =>
                      setSettings((s) => ({
                        ...s,
                        max_characters_per_user_message: Number(e.target.value),
                      }))
                    }
                  />
                  <p className="text-xs text-gray-500">Reject user messages above this length</p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="max-chars-ai">Max characters per AI message</Label>
                  <Input
                    id="max-chars-ai"
                    type="number"
                    min={1}
                    value={settings.max_characters_per_ai_message}
                    onChange={(e) =>
                      setSettings((s) => ({
                        ...s,
                        max_characters_per_ai_message: Number(e.target.value),
                      }))
                    }
                  />
                  <p className="text-xs text-gray-500">Cap AI response length to avoid runaway outputs</p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="temperature">Temperature</Label>
                  <Input
                    id="temperature"
                    type="number"
                    step="0.01"
                    min={0}
                    max={2}
                    value={settings.temperature}
                    onChange={(e) =>
                      setSettings((s) => ({
                        ...s,
                        temperature: Number(e.target.value),
                      }))
                    }
                  />
                  <p className="text-xs text-gray-500">How ‘creative’ vs ‘consistent’ the assistant should be. Typical range: 0–1</p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="top-p">Top P</Label>
                  <Input
                    id="top-p"
                    type="number"
                    step="0.01"
                    min={0}
                    max={1}
                    value={settings.top_p}
                    onChange={(e) =>
                      setSettings((s) => ({
                        ...s,
                        top_p: Number(e.target.value),
                      }))
                    }
                  />
                  <p className="text-xs text-gray-500">How strictly the assistant sticks to the most likely words when writing responses. Typical range: 0.8–0.95</p>
                </div>

                <div className="md:col-span-2 pt-2">
                  <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-4">
                    <div className="font-semibold text-amber-900">Hallucination Checks</div>
                    <p className="text-sm text-amber-800 mt-1">
                      The threshold values below do not change how the assistant writes its response.
                      They are only used after an answer is generated to check whether it is
                      supported by the retrieved sources and whether a warning should be shown.
                    </p>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="support-score-threshold">Evidence Match Threshold</Label>
                  <Input
                    id="support-score-threshold"
                    type="number"
                    step="0.01"
                    min={0}
                    max={1}
                    value={settings.support_score_threshold}
                    onChange={(e) =>
                      setSettings((s) => ({
                        ...s,
                        support_score_threshold: Number(e.target.value),
                      }))
                    }
                  />
                  <p className="text-xs text-gray-500">Minimum evidence score required for the answer to count as supported by the retrieved sources</p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="scope-alignment-score-threshold">Topic Match Threshold</Label>
                  <Input
                    id="scope-alignment-score-threshold"
                    type="number"
                    step="0.01"
                    min={0}
                    max={1}
                    value={settings.scope_alignment_score_threshold}
                    onChange={(e) =>
                      setSettings((s) => ({
                        ...s,
                        scope_alignment_score_threshold: Number(e.target.value),
                      }))
                    }
                  />
                  <p className="text-xs text-gray-500">Minimum match score required for the retrieved sources to be about the same topic the user asked about</p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="grounded-threshold">Reliable Answer Threshold</Label>
                  <Input
                    id="grounded-threshold"
                    type="number"
                    step="0.01"
                    min={0}
                    max={1}
                    value={settings.grounded_threshold}
                    onChange={(e) =>
                      setSettings((s) => ({
                        ...s,
                        grounded_threshold: Number(e.target.value),
                      }))
                    }
                  />
                  <p className="text-xs text-gray-500">Final score needed for an answer to be treated as well-supported and reliable</p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="partially-grounded-threshold">Partial Warning Threshold</Label>
                  <Input
                    id="partially-grounded-threshold"
                    type="number"
                    step="0.01"
                    min={0}
                    max={1}
                    value={settings.partially_grounded_threshold}
                    onChange={(e) =>
                      setSettings((s) => ({
                        ...s,
                        partially_grounded_threshold: Number(e.target.value),
                      }))
                    }
                  />
                  <p className="text-xs text-gray-500">Final score needed for an answer to be treated as only partly supported rather than fully unreliable</p>
                </div>
              </div>

              <div className="pt-6 border-t border-gray-100 mt-8">
                <Button
                  onClick={handleSaveSystemSettings}
                  disabled={saving}
                  className="bg-primary hover:bg-primary/90"
                >
                  <Save className="mr-2 h-4 w-4" />
                  {saving ? "Saving…" : "Save changes"}
                </Button>
              </div>

              {(settings.updated_at || settings.updated_by_email) && (
                <div className="text-xs text-gray-500 pt-2">
                  {settings.updated_at ? (
                    <div>Last updated: {new Date(settings.updated_at).toLocaleString()}</div>
                  ) : null}
                  {settings.updated_by_email ? <div>Updated by: {settings.updated_by_email}</div> : null}
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* System Messages */}
      <div className="space-y-4">
        <div>
          <h3 className="text-[18.5px] font-bold tracking-[-0.01em] text-foreground">
            Wording library
          </h3>
          <p className="mt-1 text-[13.5px] leading-normal text-foreground/80">
            Every edit creates a new version. The active version is what users get.
          </p>
        </div>

        <PromptAssemblyCard
          phase={promptPhase}
          setPhase={setPromptPhase}
          settings={settings}
          messages={messages}
        />

        <div className="space-y-10">
          <div className="space-y-4">
            <div>
              <h4 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
                <Sparkles className="h-5 w-5 text-primary" />
                Messages That Affect Text Generation
              </h4>
              <p className="text-sm text-gray-500 mt-1">
              These messages are included in the LLM prompt and influence response behavior.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-8">
              {textGenerationMessageTypes.map((t) => (
                <SystemMessageEditor
                  key={t}
                  type={t}
                  title={MESSAGE_META[t].title}
                  description={MESSAGE_META[t].description}
                  placement={MESSAGE_META[t].placement}
                  affectsTextGeneration={MESSAGE_META[t].affectsTextGeneration}
                  versions={messages[t] ?? []}
                  adminEmail={adminEmail}
                  onCreateVersion={handleCreateSystemMessageVersion}
                  onDeleteVersion={handleDeleteSystemMessageVersion}
                  onActivateVersion={handleActivateSystemMessageVersion}
                  onSave={saveSystemMessage}
                  onDelete={deleteSystemMessage}
                  onActivate={activateSystemMessage}
                />
              ))}
            </div>
          </div>

        {/* Visual divider */}
          <div className="border-t border-gray-200 pt-8 space-y-4">
            <div>
              <h4 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
                <Eye className="h-5 w-5 text-primary" />
                Messages That Do Not Affect Text Generation
              </h4>
              <p className="text-sm text-gray-500 mt-1">
                These are shown in the product UI, but they are not inserted into the LLM prompt.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-8">
              {nonTextGenerationMessageTypes.map((t) => (
                <SystemMessageEditor
                  key={t}
                  type={t}
                  title={MESSAGE_META[t].title}
                  description={MESSAGE_META[t].description}
                  placement={MESSAGE_META[t].placement}
                  affectsTextGeneration={MESSAGE_META[t].affectsTextGeneration}
                  versions={messages[t] ?? []}
                  adminEmail={adminEmail}
                  onCreateVersion={handleCreateSystemMessageVersion}
                  onDeleteVersion={handleDeleteSystemMessageVersion}
                  onActivateVersion={handleActivateSystemMessageVersion}
                  onSave={saveSystemMessage}
                  onDelete={deleteSystemMessage}
                  onActivate={activateSystemMessage}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}