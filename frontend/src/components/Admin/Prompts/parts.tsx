import { useId, type ReactNode } from "react";
import { ChevronLeft, Info, LifeBuoy, Sparkles, ThumbsDown, ThumbsUp } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SAFETY, STAGE_STYLE, type PromptStage } from "@/lib/promptCatalog";
import type { FeedbackCount } from "@/types/journeys";

export const ACCENT = "oklch(0.42 0.10 268)";
export const SELECTED_BG = "oklch(0.96 0.02 268)";

export const outlineButton =
  "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[9px] border-[1.5px] border-foreground/18 bg-white px-3 font-semibold text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60";

export const textareaClass =
  "w-full resize-y rounded-[10px] border-[1.5px] border-foreground/20 bg-white px-3.5 py-3 text-[14px] leading-relaxed text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary";

export function Pill({ bg, fg, children }: { bg: string; fg: string; children: ReactNode }) {
  return (
    <span
      className="whitespace-nowrap rounded-full px-[9px] py-[3px] text-[11.5px] font-bold"
      style={{ background: bg, color: fg }}
    >
      {children}
    </span>
  );
}

export function StageTag({ stage }: { stage: PromptStage }) {
  const s = STAGE_STYLE[stage];
  return (
    <Pill bg={s.bg} fg={s.fg}>
      {s.label}
    </Pill>
  );
}

export function KeyPill({ value, solid = false }: { value: string; solid?: boolean }) {
  return (
    <span
      className={
        solid
          ? "shrink-0 rounded-full px-[7px] py-px font-mono text-[11.5px] font-medium text-white"
          : "shrink-0 rounded-full border border-foreground/16 px-2 py-px font-mono text-xs font-medium"
      }
      style={solid ? { background: ACCENT } : undefined}
    >
      {value}
    </span>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <div className="flex flex-1 items-center justify-center py-10" role="status" aria-label={label}>
      <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
    </div>
  );
}

export function Alert({ children, tone = "error" }: { children: ReactNode; tone?: "error" | "warning" }) {
  return (
    <div
      role={tone === "error" ? "alert" : undefined}
      className={
        tone === "error"
          ? "rounded-[9px] border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700"
          : "flex gap-2.5 rounded-[9px] border border-amber-200 bg-amber-50 px-3 py-2.5 text-[13px] leading-normal text-amber-800"
      }
    >
      {tone === "warning" ? <Info className="mt-0.5 h-4 w-4 flex-none" aria-hidden="true" /> : null}
      <span>{children}</span>
    </div>
  );
}

export function BackLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mb-2 inline-flex items-center gap-1 text-[13px] font-semibold text-primary hover:underline"
    >
      <ChevronLeft className="h-[15px] w-[15px]" aria-hidden="true" />
      {label}
    </button>
  );
}

/** Green "the family is still helped" box. */
export function SafetyBox({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div
      className="flex items-start gap-3 rounded-[11px] border border-dashed px-4 py-3.5"
      style={{ background: SAFETY.bg, borderColor: SAFETY.border }}
    >
      <LifeBuoy className="mt-px h-5 w-5 flex-none" style={{ color: "oklch(0.38 0.09 160)" }} aria-hidden="true" />
      <div>
        <div className="text-sm font-bold" style={{ color: "oklch(0.30 0.08 160)" }}>
          {title}
        </div>
        <p className="mt-0.5 text-[13px] leading-relaxed" style={{ color: SAFETY.fg }}>
          {children}
        </p>
      </div>
    </div>
  );
}

/** "👍 12 · 👎 3 · 80% positive in the last 30 days" (counts only, no chat content). */
export function Rating({ count, days = 30 }: { count?: FeedbackCount; days?: number }) {
  if (!count || count.up + count.down === 0) {
    return <span className="text-[12.5px] text-foreground/65">No ratings in the last {days} days</span>;
  }
  const share = Math.round((count.up / (count.up + count.down)) * 100);
  const tone = share >= 70 ? "text-green-700" : share >= 40 ? "text-amber-700" : "text-red-700";
  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-[12.5px] text-foreground/75">
      <span className="inline-flex items-center gap-1">
        <ThumbsUp className="h-3.5 w-3.5" aria-hidden="true" />
        <span className="sr-only">Thumbs up:</span>
        {count.up}
      </span>
      <span className="inline-flex items-center gap-1">
        <ThumbsDown className="h-3.5 w-3.5" aria-hidden="true" />
        <span className="sr-only">Thumbs down:</span>
        {count.down}
      </span>
      <span className={`font-semibold ${tone}`}>{share}% positive</span>
      <span>in the last {days} days</span>
    </span>
  );
}

/** Page heading + explain line shared by every editor page. */
export function PageHeader({
  crumb,
  title,
  explain,
  children,
}: {
  crumb?: ReactNode;
  title: ReactNode;
  explain: string;
  children?: ReactNode;
}) {
  return (
    <div className="min-w-0">
      {crumb}
      <div className="flex flex-wrap items-center gap-2.5">{title}</div>
      <p className="mt-1.5 max-w-[640px] text-[13.5px] leading-relaxed text-foreground/80">{explain}</p>
      {children}
    </div>
  );
}

/** One editable text on a page: title, tag, help, textarea, counter and notes. */
export function FieldSection({
  title,
  stage,
  help,
  value,
  onChange,
  limit,
  placeholder,
  rows = 6,
  mono = false,
  autoInsert,
  warning,
  note,
  error,
}: {
  title: string;
  stage?: PromptStage;
  help?: string;
  value: string;
  onChange: (value: string) => void;
  limit: number;
  placeholder?: string;
  rows?: number;
  mono?: boolean;
  autoInsert?: string;
  warning?: string;
  note?: string;
  error?: string | null;
}) {
  const id = useId();
  const over = value.length > limit;
  const describedBy = [help ? `${id}-help` : null, `${id}-count`, error ? `${id}-error` : null]
    .filter(Boolean)
    .join(" ");
  return (
    <section className="flex flex-col gap-2" aria-labelledby={`${id}-title`}>
      <div className="flex flex-wrap items-center gap-2.5">
        <h3 id={`${id}-title`} className="text-[15px] font-bold">
          <label htmlFor={id}>{title}</label>
        </h3>
        {stage && stage !== "every" ? <StageTag stage={stage} /> : null}
      </div>
      {help ? (
        <p id={`${id}-help`} className="-mt-1 text-[13px] leading-normal text-foreground/75">
          {help}
        </p>
      ) : null}
      {note ? (
        <div className="rounded-[9px] border px-3 py-2.5 text-[13px] leading-normal" style={{ background: SAFETY.bg, borderColor: SAFETY.border, color: SAFETY.fg }}>
          {note}
        </div>
      ) : null}
      {warning ? <Alert tone="warning">{warning}</Alert> : null}
      <textarea
        id={id}
        value={value}
        rows={rows}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={over || error ? true : undefined}
        aria-describedby={describedBy}
        className={`${textareaClass} ${mono ? "font-mono text-[12.5px]" : ""}`}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        {autoInsert ? (
          <span
            className="inline-flex items-center gap-1.5 rounded-full border border-dashed px-2.5 py-[3px] text-[12px] font-semibold"
            style={{ borderColor: "rgba(22,24,29,0.28)", color: "rgba(22,24,29,0.72)" }}
          >
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
            {autoInsert}
          </span>
        ) : (
          <span />
        )}
        <span
          id={`${id}-count`}
          className={`text-[12.5px] tabular-nums ${over ? "font-bold text-red-700" : "font-medium text-foreground/65"}`}
        >
          {value.length.toLocaleString()} / {limit.toLocaleString()}
          <span className="sr-only">{over ? " characters, over the limit" : " characters"}</span>
        </span>
      </div>
      {error ? (
        <p id={`${id}-error`} className="text-xs text-red-700">
          {error}
        </p>
      ) : null}
    </section>
  );
}

/** Sticky footer: unsaved count, undo, discard, save and publish. */
export function PageFooter({
  changes,
  canSave,
  saving,
  undoLabel,
  undoing,
  onUndo,
  onDiscard,
  onSave,
}: {
  changes: number;
  canSave: boolean;
  saving: boolean;
  undoLabel?: string | null;
  undoing?: boolean;
  onUndo?: () => void;
  onDiscard: () => void;
  onSave: () => void;
}) {
  const dirty = changes > 0;
  const enabled = dirty && canSave && !saving;
  return (
    <div className="flex flex-none flex-wrap items-center justify-between gap-4 border-t border-foreground/10 bg-white px-[26px] py-3.5">
      <div className="flex flex-wrap items-center gap-3 text-[13px] text-foreground/75" aria-live="polite">
        <span>
          {dirty
            ? `${changes} unsaved change${changes === 1 ? "" : "s"} on this page.`
            : "All changes published."}
        </span>
        {!dirty && undoLabel && onUndo ? (
          <button
            type="button"
            onClick={onUndo}
            disabled={undoing}
            className="font-semibold text-primary hover:underline disabled:opacity-60"
          >
            {undoing ? "Undoing..." : undoLabel}
          </button>
        ) : null}
      </div>
      <div className="flex items-center gap-2.5">
        {dirty ? (
          <button type="button" onClick={onDiscard} disabled={saving} className={`${outlineButton} h-[38px] px-3.5 text-[13.5px]`}>
            Discard
          </button>
        ) : null}
        <button
          type="button"
          onClick={onSave}
          disabled={!enabled}
          className={`h-[38px] whitespace-nowrap rounded-[9px] px-4 text-[13.5px] font-semibold ${
            enabled ? "bg-primary text-white hover:bg-primary/90" : "cursor-default bg-foreground/12 text-foreground/60"
          }`}
        >
          {saving ? "Publishing..." : "Save and publish"}
        </button>
      </div>
    </div>
  );
}

/** Right-hand side panel (Preview). */
export function SideDrawer({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-0 right-0 left-auto flex h-full max-h-screen w-full translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-l p-0 sm:max-w-[500px]">
        <DialogHeader className="flex-none border-b border-foreground/10 px-[22px] py-5 pr-14 text-left">
          <DialogTitle className="text-[18px] font-bold tracking-[-0.01em]">{title}</DialogTitle>
          <DialogDescription className="text-[13px] leading-normal text-foreground/78">{description}</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-[22px] py-4">{children}</div>
      </DialogContent>
    </Dialog>
  );
}

export function TextField({
  label,
  value,
  onChange,
  hint,
  error,
  required,
  maxLength,
  placeholder,
  className = "",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  error?: string | null;
  required?: boolean;
  maxLength?: number;
  placeholder?: string;
  className?: string;
}) {
  const id = useId();
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ");
  return (
    <div className={`space-y-1.5 ${className}`}>
      <Label htmlFor={id}>
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </Label>
      <Input
        id={id}
        value={value}
        required={required}
        maxLength={maxLength}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {error ? (
        <p id={`${id}-error`} className="text-xs text-red-700">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-foreground/70">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function TextAreaField({
  label,
  value,
  onChange,
  hint,
  error,
  required,
  maxLength,
  placeholder,
  rows = 3,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  error?: string | null;
  required?: boolean;
  maxLength?: number;
  placeholder?: string;
  rows?: number;
}) {
  const id = useId();
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ");
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </Label>
      <textarea
        id={id}
        value={value}
        rows={rows}
        required={required}
        maxLength={maxLength}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        onChange={(e) => onChange(e.target.value)}
        className={textareaClass}
      />
      {hint ? (
        <p id={`${id}-hint`} className="text-[12.5px] text-foreground/72">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="text-xs text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
