import { useMemo, useState } from "react";
import {
  addDays,
  addMonths,
  differenceInCalendarDays,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  isWithinInterval,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import { ArrowRight, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { isDayInWindow, MAX_RANGE_DAYS, monthHasSelectableDay } from "@/lib/analyticsRange";
import { cn } from "@/lib/utils";

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

type DateRangeCalendarProps = {
  start: Date;
  end: Date | null;
  onChange: (start: Date, end: Date | null) => void;
};

type Picker = "month" | "year" | null;

function rangeDayCount(from: Date, to: Date): number {
  return differenceInCalendarDays(to, from) + 1;
}

function sortedPair(a: Date, b: Date): [Date, Date] {
  return a.getTime() <= b.getTime() ? [a, b] : [b, a];
}

function RangeSummary({
  label,
  date,
  pending,
}: {
  label: string;
  date: Date | null;
  pending?: boolean;
}) {
  return (
    <div
      className={cn(
        "min-w-0 rounded-lg px-2.5 py-2",
        pending ? "border border-dashed border-primary/30 bg-primary/[0.06]" : "bg-muted",
      )}
    >
      <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "mt-0.5 truncate text-[13px] font-semibold tabular-nums",
          pending && !date && "font-medium text-primary",
          pending && date && "text-primary",
        )}
      >
        {date ? format(date, "MMM d, yyyy") : "Select date"}
      </div>
    </div>
  );
}

export default function DateRangeCalendar({
  start,
  end,
  onChange,
}: DateRangeCalendarProps) {
  const today = useMemo(() => new Date(), []);
  const [visible, setVisible] = useState(() => startOfMonth(end ?? start));
  const [hover, setHover] = useState<Date | null>(null);
  const [picker, setPicker] = useState<Picker>(null);

  const years = useMemo(() => {
    const earliest = addDays(today, -MAX_RANGE_DAYS).getFullYear();
    const list: number[] = [];
    for (let year = earliest; year <= today.getFullYear(); year += 1) list.push(year);
    return list;
  }, [today]);

  const closestSelectableMonth = (year: number, preferredMonth: number) => {
    let best: number | null = null;
    for (let month = 0; month < 12; month += 1) {
      if (!monthHasSelectableDay(new Date(year, month, 1), today)) continue;
      if (best == null || Math.abs(month - preferredMonth) < Math.abs(best - preferredMonth)) {
        best = month;
      }
    }
    return best == null ? null : new Date(year, best, 1);
  };

  const days = useMemo(() => {
    const monthStart = startOfMonth(visible);
    return eachDayOfInterval({
      start: startOfWeek(monthStart),
      end: endOfWeek(endOfMonth(monthStart)),
    });
  }, [visible]);

  const previewEnd = end ?? hover;
  const highlighted =
    previewEnd && !isSameDay(start, previewEnd) ? sortedPair(start, previewEnd) : null;
  const fromDate = highlighted?.[0] ?? start;
  const toDate = highlighted?.[1] ?? null;
  const choosingEnd = end == null;

  const showMonth = (next: Date) => {
    if (!monthHasSelectableDay(next, today)) return;
    setVisible(startOfMonth(next));
    setPicker(null);
  };

  const pickDay = (day: Date) => {
    if (!isDayInWindow(day, today)) return;
    if (end) {
      onChange(day, null);
      return;
    }
    if (isSameDay(day, start)) return;
    const [from, to] = sortedPair(start, day);
    onChange(from, to);
  };

  const togglePicker = (next: Exclude<Picker, null>) => {
    setPicker((current) => (current === next ? null : next));
  };

  return (
    <div
      className="w-[328px] max-w-full shrink-0 rounded-[13px] border border-foreground/12 bg-white p-3 shadow-sm"
      onKeyDown={(event) => {
        if (event.key === "Escape") setPicker(null);
      }}
    >
      <div className="mb-1 flex items-center justify-between gap-1">
        <button
          type="button"
          aria-label="Previous month"
          disabled={!monthHasSelectableDay(addMonths(visible, -1), today) || picker != null}
          onClick={() => showMonth(addMonths(visible, -1))}
          className="flex size-8 items-center justify-center rounded-full text-foreground/70 transition-colors hover:bg-secondary hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
        >
          <ChevronLeft className="size-4" />
        </button>

        <div className="flex items-center gap-0.5">
          <button
            type="button"
            aria-label="Choose month"
            aria-expanded={picker === "month"}
            onClick={() => togglePicker("month")}
            className={cn(
              "flex items-center gap-0.5 rounded-md px-1.5 py-1 font-serif text-[17px] font-semibold leading-none tracking-[-0.02em] transition-colors hover:bg-secondary",
              picker === "month" && "bg-secondary",
            )}
          >
            {format(visible, "MMMM")}
            <ChevronDown
              className={cn(
                "size-3.5 text-foreground/50 transition-transform",
                picker === "month" && "rotate-180",
              )}
            />
          </button>
          <button
            type="button"
            aria-label="Choose year"
            aria-expanded={picker === "year"}
            onClick={() => togglePicker("year")}
            className={cn(
              "flex items-center gap-0.5 rounded-md px-1.5 py-1 text-[15px] font-semibold tabular-nums transition-colors hover:bg-secondary",
              picker === "year" && "bg-secondary",
            )}
          >
            {format(visible, "yyyy")}
            <ChevronDown
              className={cn(
                "size-3.5 text-foreground/50 transition-transform",
                picker === "year" && "rotate-180",
              )}
            />
          </button>
        </div>

        <button
          type="button"
          aria-label="Next month"
          disabled={!monthHasSelectableDay(addMonths(visible, 1), today) || picker != null}
          onClick={() => showMonth(addMonths(visible, 1))}
          className="flex size-8 items-center justify-center rounded-full text-foreground/70 transition-colors hover:bg-secondary hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
        >
          <ChevronRight className="size-4" />
        </button>
      </div>

      <div>
        {picker === "month" ? (
          <div className="grid grid-cols-3 gap-1 py-2" role="listbox" aria-label="Month">
            {MONTHS.map((name, index) => {
              const enabled = monthHasSelectableDay(
                new Date(visible.getFullYear(), index, 1),
                today,
              );
              const selected = index === visible.getMonth();
              return (
                <button
                  key={name}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  disabled={!enabled}
                  onClick={() => showMonth(new Date(visible.getFullYear(), index, 1))}
                  className={cn(
                    "w-full rounded-md px-2 py-2 text-center text-[13px] font-medium transition-colors",
                    selected && "bg-primary font-semibold text-primary-foreground",
                    !selected && enabled && "hover:bg-secondary",
                    !enabled && "cursor-not-allowed text-foreground/25",
                  )}
                >
                  {name.slice(0, 3)}
                </button>
              );
            })}
          </div>
        ) : picker === "year" ? (
          <div
            className="flex flex-col justify-center gap-2 py-6"
            role="listbox"
            aria-label="Year"
          >
            {years.map((year) => {
              const selected = year === visible.getFullYear();
              return (
                <button
                  key={year}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => {
                    const next = closestSelectableMonth(year, visible.getMonth());
                    if (next) showMonth(next);
                  }}
                  className={cn(
                    "w-full rounded-md px-3 py-2.5 text-center text-[15px] font-semibold tabular-nums transition-colors",
                    selected
                      ? "bg-primary text-primary-foreground"
                      : "hover:bg-secondary",
                  )}
                >
                  {year}
                </button>
              );
            })}
          </div>
        ) : (
          <div role="grid" aria-label="Choose a date range" className="select-none">
            <div role="row" className="grid grid-cols-7">
              {WEEKDAYS.map((label) => (
                <div
                  key={label}
                  role="columnheader"
                  className="flex h-8 items-center justify-center text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground"
                >
                  {label}
                </div>
              ))}
            </div>
            <div role="rowgroup">
              {Array.from({ length: days.length / 7 }, (_, week) => (
                <div
                  role="row"
                  key={format(days[week * 7], "yyyy-MM-dd")}
                  className="grid grid-cols-7"
                >
                  {days.slice(week * 7, week * 7 + 7).map((day) => {
                    const selectable = isDayInWindow(day, today);
                    const inMonth = isSameMonth(day, visible);
                    const isRangeStart = highlighted
                      ? isSameDay(day, highlighted[0])
                      : isSameDay(day, start);
                    const isRangeEnd = highlighted ? isSameDay(day, highlighted[1]) : false;
                    const inRange =
                      highlighted != null &&
                      isWithinInterval(day, { start: highlighted[0], end: highlighted[1] }) &&
                      !isRangeStart &&
                      !isRangeEnd;
                    const endpoint = isRangeStart || isRangeEnd;
                    const weekday = day.getDay();
                    const committed =
                      isSameDay(day, start) || (end != null && isSameDay(day, end));
                    // A one-cell stub at the edge of a week reads as a stray mark,
                    // so the bar starts fresh on the next row instead.
                    const drawRight =
                      highlighted != null && (inRange || isRangeStart) && !(isRangeStart && weekday === 6);
                    const drawLeft =
                      highlighted != null && (inRange || isRangeEnd) && !(isRangeEnd && weekday === 0);

                    return (
                      <div
                        key={format(day, "yyyy-MM-dd")}
                        role="gridcell"
                        className="relative flex h-10 items-center justify-center"
                      >
                        {(drawLeft || drawRight) && (
                          <span
                            aria-hidden
                            className={cn(
                              "absolute top-1 bottom-1 bg-primary/15",
                              drawLeft && drawRight && "inset-x-0",
                              drawRight && !drawLeft && "right-0 left-[calc(50%-1rem)]",
                              drawLeft && !drawRight && "left-0 right-[calc(50%-1rem)]",
                              drawLeft && drawRight && weekday === 0 && "rounded-l-full",
                              drawLeft && drawRight && weekday === 6 && "rounded-r-full",
                            )}
                          />
                        )}
                        <button
                          type="button"
                          disabled={!selectable}
                          aria-label={format(day, "MMMM d, yyyy")}
                          aria-pressed={committed}
                          onMouseEnter={() => selectable && setHover(day)}
                          onMouseLeave={() => setHover(null)}
                          onClick={() => pickDay(day)}
                          className={cn(
                            "relative z-10 flex size-8 items-center justify-center rounded-full text-[13px] tabular-nums transition-colors",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                            !inMonth && "text-foreground/40",
                            !selectable && "cursor-not-allowed text-foreground/25",
                            selectable &&
                              !endpoint &&
                              "hover:bg-secondary",
                            isSameDay(day, today) &&
                              !endpoint &&
                              "font-semibold text-primary ring-1 ring-primary/40",
                            endpoint &&
                              "bg-primary font-semibold text-primary-foreground shadow-sm",
                          )}
                        >
                          {format(day, "d")}
                        </button>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="mt-1 border-t border-foreground/10 pt-3">
        <div className="grid grid-cols-[1fr_auto_1fr] items-stretch gap-1.5">
          <RangeSummary label="From" date={fromDate} />
          <div className="flex w-11 flex-col items-center justify-center gap-1 px-0.5 text-foreground/35">
            <ArrowRight className="size-3.5" />
            {toDate && (
              <span className="text-center leading-tight">
                <span className="block text-[11px] font-semibold tabular-nums text-primary">
                  {rangeDayCount(fromDate, toDate)}
                </span>
                <span className="block text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {rangeDayCount(fromDate, toDate) === 1 ? "day" : "days"}
                </span>
              </span>
            )}
          </div>
          <RangeSummary label="To" date={toDate} pending={choosingEnd} />
        </div>
      </div>
    </div>
  );
}
