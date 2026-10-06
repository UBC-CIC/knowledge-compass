/** "Show developer settings" switch (state lives in useDeveloperSettings). */
export default function DeveloperSwitch({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2.5 px-2 py-1 text-[12.5px] font-semibold text-foreground/72">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className="relative h-[18px] w-[32px] flex-none rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        style={{ background: checked ? "oklch(0.42 0.10 268)" : "rgba(22,24,29,0.22)" }}
      >
        <span
          className="absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white shadow transition-[left]"
          style={{ left: checked ? 16 : 2 }}
        />
      </button>
      Show developer settings
    </label>
  );
}
