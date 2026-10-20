import { useId, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

/** Collapsible block on Assistant settings. The header is a button so it works from the keyboard. */
export default function SettingsSection({
  title,
  description,
  open,
  onOpenChange,
  children,
}: {
  title: string;
  description: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const panelId = useId();
  return (
    <Card className="rounded-[13px] border-foreground/12 shadow-sm">
      <CardHeader>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => onOpenChange(!open)}
          className="flex w-full cursor-pointer items-start justify-between gap-4 rounded-[10px] text-left outline-none focus-visible:ring-ring/50 focus-visible:ring-[3px]"
        >
          <span className="min-w-0">
            <span className="block text-[18.5px] font-bold leading-none tracking-[-0.01em]">{title}</span>
            <span className="mt-1.5 block text-[13.5px] leading-relaxed text-muted-foreground">{description}</span>
          </span>
          <ChevronDown
            className={`mt-0.5 h-5 w-5 shrink-0 text-foreground/60 transition-transform ${open ? "rotate-180" : ""}`}
            aria-hidden="true"
          />
        </button>
      </CardHeader>
      <CardContent id={panelId} hidden={!open} className={open ? "space-y-5" : "hidden"}>
        {children}
      </CardContent>
    </Card>
  );
}
