type AdminSidebarProps = {
  activeView: "dashboard" | "analytics" | "system-settings";
  onViewChange: (view: "dashboard" | "analytics" | "system-settings") => void;
};

const NAV_ITEMS: Array<{
  key: AdminSidebarProps["activeView"];
  label: string;
  hint: string;
}> = [
  { key: "dashboard", label: "Overview", hint: "Usage and data sources" },
  { key: "analytics", label: "Analytics", hint: "Trends over time" },
  { key: "system-settings", label: "Assistant settings", hint: "Limits and wording" },
];

export default function AdminSidebar({
  activeView,
  onViewChange,
}: AdminSidebarProps) {
  return (
    <nav className="hidden w-[246px] shrink-0 flex-col gap-5 border-r border-foreground/10 bg-white px-3.5 py-5 md:flex">
      <div className="flex flex-col gap-1">
        <div className="px-2.5 pb-1.5 text-[11px] font-bold uppercase tracking-[0.08em] text-foreground/70">
          Console
        </div>
        {NAV_ITEMS.map((item) => {
          const active = activeView === item.key;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => onViewChange(item.key)}
              className={`min-h-14 w-full rounded-[10px] px-3 py-2.5 text-left ${
                active
                  ? "border border-foreground/14 bg-[oklch(0.96_0.02_268)] text-primary"
                  : "border border-transparent text-foreground/90 hover:bg-muted"
              }`}
            >
              <span className="block text-[14.5px] font-semibold">{item.label}</span>
              <span className="mt-0.5 block text-xs leading-snug opacity-80">
                {item.hint}
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-auto rounded-[11px] border border-foreground/10 bg-muted px-3 py-3.5">
        <div className="text-[12.5px] font-bold">Knowledge base</div>
        <div className="mt-1 text-xs leading-snug text-foreground/80">
          Staged items only go live after a sync.
        </div>
      </div>
    </nav>
  );
}
