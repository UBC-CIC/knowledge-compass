import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type ChartCardProps = {
  title: string;
  subtitle: string;
  children: React.ReactNode;
  className?: string;
};

export function ChartCard({ title, subtitle, children, className = "" }: ChartCardProps) {
  return (
    <Card className={`overflow-hidden rounded-[13px] border-foreground/12 shadow-sm ${className}`}>
      <CardHeader className="border-b border-foreground/10 pb-3">
        <CardTitle className="text-base font-bold tracking-[-0.005em] text-foreground">
          {title}
        </CardTitle>
        <CardDescription className="text-[13px]">{subtitle}</CardDescription>
      </CardHeader>
      <CardContent className="h-[300px] p-5">{children}</CardContent>
    </Card>
  );
}

type TooltipEntry = {
  name?: string;
  value?: number | string;
  color?: string;
  fill?: string;
};

type CustomTooltipProps = {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string;
};

export function CustomTooltip({ active, payload, label }: CustomTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3 text-sm shadow-xl">
      <p className="mb-2 font-semibold text-gray-900">{label}</p>
      {payload.map((entry, index) => (
        <div key={index} className="mb-1 flex items-center gap-2 text-xs text-gray-600">
          <div
            className="h-2 w-2 rounded-full"
            style={{ backgroundColor: entry.color || entry.fill }}
          />
          <span className="capitalize">{entry.name}:</span>
          <span className="font-bold text-gray-900">{entry.value}</span>
        </div>
      ))}
    </div>
  );
}
