import { useId, type ReactNode } from "react";
import { History, ThumbsDown, ThumbsUp } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { URGENCY_LEVELS, urgencyLabel } from "@/lib/promptCatalog";
import type { FeedbackCount } from "@/types/journeys";

export const ACCENT = "oklch(0.42 0.10 268)";

export const outlineButton =
  "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[9px] border-[1.5px] border-foreground/18 bg-white px-3 font-semibold text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60";

export const textareaClass =
  "w-full resize-none rounded-[10px] border-[1.5px] border-foreground/20 bg-white px-3.5 py-3 text-[14px] leading-relaxed text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary";

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

export function KeyPill({ value, solid = false }: { value: string; solid?: boolean }) {
  return (
    <span
      className={
        solid
          ? "shrink-0 rounded-full bg-primary px-[7px] py-px font-mono text-[11.5px] font-medium text-white"
          : "shrink-0 rounded-full border border-foreground/16 px-2 py-px font-mono text-xs font-medium"
      }
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
          : "rounded-[9px] border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-800"
      }
    >
      {children}
    </div>
  );
}

export function HistoryButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={`${outlineButton} h-9 text-[13.5px]`}>
      <History className="h-4 w-4" aria-hidden="true" />
      History
    </button>
  );
}

/** "👍 12 · 👎 3 · 80% positive in the last 30 days" */
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

export function SaveFooter({
  note,
  length,
  limit,
  dirty,
  canSave,
  saving,
  onDiscard,
  onSave,
}: {
  note: string;
  length: number;
  limit: number;
  dirty: boolean;
  canSave: boolean;
  saving: boolean;
  onDiscard: () => void;
  onSave: () => void;
}) {
  const over = length > limit;
  const enabled = dirty && canSave && !over && !saving;
  return (
    <div className="flex flex-none flex-wrap items-center justify-between gap-4 border-t border-foreground/10 bg-white px-[26px] py-3.5">
      <div className="text-[13px] text-foreground/75" aria-live="polite">
        {note}
      </div>
      <div className="flex items-center gap-2.5">
        <span
          className={`text-[12.5px] tabular-nums ${over ? "font-bold text-red-700" : "font-medium text-foreground/65"}`}
        >
          {length.toLocaleString()} / {limit.toLocaleString()}
          {over ? <span className="sr-only"> characters, over the limit</span> : <span className="sr-only"> characters</span>}
        </span>
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

/** Right-hand side panel (History, Preview). */
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
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  error?: string | null;
  required?: boolean;
  maxLength?: number;
  type?: string;
}) {
  const id = useId();
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ");
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </Label>
      <Input
        id={id}
        type={type}
        value={value}
        required={required}
        maxLength={maxLength}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint ? (
        <p id={`${id}-hint`} className="text-xs text-foreground/70">
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

export function TextAreaField({
  label,
  value,
  onChange,
  hint,
  error,
  required,
  maxLength,
  rows = 3,
  className = "",
  labelClassName = "",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  error?: string | null;
  required?: boolean;
  maxLength?: number;
  rows?: number;
  className?: string;
  labelClassName?: string;
}) {
  const id = useId();
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ");
  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <Label htmlFor={id} className={labelClassName}>
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </Label>
      <textarea
        id={id}
        value={value}
        rows={rows}
        required={required}
        maxLength={maxLength}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        onChange={(e) => onChange(e.target.value)}
        className={`${textareaClass} flex-1`}
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

/** 1-5 segmented control for situation urgency. */
export function UrgencyPicker({
  value,
  onChange,
  label = "Urgency",
}: {
  value: number;
  onChange: (value: number) => void;
  label?: string;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <span id={id} className="text-[13.5px] font-bold">
        {label}
      </span>
      <div
        role="radiogroup"
        aria-labelledby={id}
        className="flex gap-1 rounded-[10px] border border-foreground/12 bg-muted p-1"
      >
        {URGENCY_LEVELS.map((n) => {
          const on = n === value;
          return (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={`${n}, ${urgencyLabel(n)}`}
              onClick={() => onChange(n)}
              className={`h-[34px] flex-1 rounded-[7px] border text-sm font-bold ${
                on
                  ? "border-foreground/14 bg-white text-primary shadow-sm"
                  : "border-transparent text-foreground/75 hover:bg-white/60"
              }`}
            >
              {n}
            </button>
          );
        })}
      </div>
      <p className="text-[12.5px] leading-normal text-foreground/72">
        {value} · {urgencyLabel(value)}. If two situations fit, the more urgent one is handled first.
      </p>
    </div>
  );
}
