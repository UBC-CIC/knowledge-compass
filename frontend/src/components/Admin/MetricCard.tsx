type MetricCardProps = {
  title: string;
  value: string;
  icon?: React.ReactNode;
  trend: string;
  tooltip?: string;
};

export default function MetricCard({
  title,
  value,
  trend,
}: MetricCardProps) {
  return (
    <div className="rounded-[13px] border border-foreground/12 bg-white px-[22px] py-5 shadow-sm">
      <div className="text-[13px] font-bold tracking-[0.01em] text-foreground/80">
        {title}
      </div>
      <div className="mt-2.5 font-serif text-4xl font-semibold leading-none tracking-[-0.02em]">
        {value}
      </div>
      <div className="mt-2 text-[13px] leading-normal text-foreground/75">
        {trend}
      </div>
    </div>
  );
}
