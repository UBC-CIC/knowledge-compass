import { Info, X } from "lucide-react";
import { Button } from "@/components/ui/button";

type GroundingWarningBannerProps = {
  warning: string;
  onDismiss: () => void;
};

/** Grounding warning shown just above the chat input for the latest reply. */
export default function GroundingWarningBanner({
  warning,
  onDismiss,
}: GroundingWarningBannerProps) {
  return (
    <div
      role="status"
      className="mb-2.5 flex items-start gap-2.5 rounded-[10px] bg-[oklch(0.97_0.015_268)] py-3 pl-4 pr-2 text-sm leading-normal text-secondary-foreground"
    >
      <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <p className="min-w-0 flex-1 break-words">{warning}</p>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Dismiss warning"
        onClick={onDismiss}
        className="-my-1 shrink-0 text-secondary-foreground hover:bg-foreground/5"
      >
        <X aria-hidden="true" />
      </Button>
    </div>
  );
}
