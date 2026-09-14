import { Link } from "react-router";
import { cn } from "@/lib/utils";

type BrandMarkProps = {
  subtitle?: string;
  to?: string;
  className?: string;
};

export default function BrandMark({
  subtitle = "Inclusion Canada",
  to,
  className,
}: BrandMarkProps) {
  const content = (
    <div className={cn("flex items-center gap-2.5", className)}>
      <div className="flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-primary">
        <div className="size-[11px] rounded-full border-2 border-white" />
      </div>
      <div className="min-w-0">
        <div className="text-[15px] font-bold leading-tight tracking-[-0.01em] text-foreground">
          Knowledge Compass
        </div>
        {subtitle ? (
          <div className="text-[11.5px] leading-tight text-foreground/75">
            {subtitle}
          </div>
        ) : null}
      </div>
    </div>
  );

  if (to) {
    return (
      <Link to={to} className="hover:opacity-90" aria-label="Knowledge Compass home">
        {content}
      </Link>
    );
  }

  return content;
}
