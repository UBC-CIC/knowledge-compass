import { useMemo, useState } from "react";
import {
  addDays,
  addMonths,
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
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
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

function rangeLabel(start: Date, end: Date): string {
  if (start.getFullYear() === end.getFullYear()) {
    return `${format(start, "MMMM d")} – ${format(end, "MMMM d, yyyy")}`;
  }
  return `${format(start, "MMMM d, yyyy")} – ${format(end, "MMMM d, yyyy")}`;
}

function sortedPair(a: Date, b: Date): [Date, Date] {
  return a.getTime() <= b.getTime() ? [a, b] : [b, a];
}

export default function DateRangeCalendar({
  start,
  end,
  onChange,
}: DateRangeCalendarProps) {
  const today = useMemo(() => new Date(), []);
  const [visible, setVisible] = useState(() => startOfMonth(end ?? start));
  const [hover, setHover] = useState<Date | null>(null);

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

  const showMonth = (next: Date) => {
    if (!monthHasSelectableDay(next, today)) return;
    setVisible(startOfMonth(next));
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

  return (
    <div className="w-[300px] rounded-[10px] border border-foreground/14 bg-white p-3">
      <div className="mb-2 flex items-center justify-between gap-1">
        <button
          type="button"
          aria-label="Previous month"
          disabled={!monthHasSelectableDay(addMonths(visible, -1), today)}
          onClick={() => showMonth(addMonths(visible, -1))}
          className="flex size-8 items-center justify-center rounded-md text-foreground/70 hover:bg-secondary disabled:pointer-events-none disabled:opacity-30"
        >
          <ChevronLeft className="size-4" />
        </button>

        <div className="flex items-center gap-1">
          <label className="relative flex items-center">
            <span className="sr-only">Month</span>
            <select
              aria-label="Month"
              value={visible.getMonth()}
              onChange={(event) =>
                showMonth(new Date(visible.getFullYear(), Number(event.target.value), 1))
              }
              className="cursor-pointer appearance-none bg-transparent pr-5 text-[15px] font-semibold outline-none"
            >
              {MONTHS.map((name, index) => (
                <option
                  key={name}
                  value={index}
                  disabled={!monthHasSelectableDay(new Date(visible.getFullYear(), index, 1), today)}
                >
                  {name}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-0 size-3.5 text-foreground/60" />
          </label>
          <label className="relative flex items-center">
            <span className="sr-only">Year</span>
            <select
              aria-label="Year"
              value={visible.getFullYear()}
              onChange={(event) => {
                const next = closestSelectableMonth(Number(event.target.value), visible.getMonth());
                if (next) showMonth(next);
              }}
              className="cursor-pointer appearance-none bg-transparent pr-5 text-[15px] font-semibold outline-none"
            >
              {years.map((year) => (
                <option key={year} value={year}>
                  {year}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-0 size-3.5 text-foreground/60" />
          </label>
        </div>

        <button
          type="button"
          aria-label="Next month"
          disabled={!monthHasSelectableDay(addMonths(visible, 1), today)}
          onClick={() => showMonth(addMonths(visible, 1))}
          className="flex size-8 items-center justify-center rounded-md text-foreground/70 hover:bg-secondary disabled:pointer-events-none disabled:opacity-30"
        >
          <ChevronRight className="size-4" />
        </button>
      </div>

      <div role="grid" aria-label="Choose a date range" className="select-none">
        <div role="row" className="grid grid-cols-7">
          {WEEKDAYS.map((label) => (
            <div
              key={label}
              role="columnheader"
              className="flex h-8 items-center justify-center text-[11px] font-semibold tracking-wide text-foreground/50"
            >
              {label}
            </div>
          ))}
        </div>
        <div role="rowgroup">
          {Array.from({ length: days.length / 7 }, (_, week) => (
          <div role="row" key={format(days[week * 7], "yyyy-MM-dd")} className="grid grid-cols-7">
          {days.slice(week * 7, week * 7 + 7).map((day) => {
            const selectable = isDayInWindow(day, today);
            const inMonth = isSameMonth(day, visible);
            const isRangeStart = highlighted ? isSameDay(day, highlighted[0]) : isSameDay(day, start);
            const isRangeEnd = highlighted ? isSameDay(day, highlighted[1]) : false;
            const inRange =
              highlighted != null &&
              isWithinInterval(day, { start: highlighted[0], end: highlighted[1] }) &&
              !isRangeStart &&
              !isRangeEnd;
            const committed =
              isSameDay(day, start) || (end != null && isSameDay(day, end));

            return (
              <div
                key={format(day, "yyyy-MM-dd")}
                role="gridcell"
                className={cn(
                  "flex h-9 items-center justify-center",
                  inRange && "bg-primary/15",
                  inRange && day.getDay() === 0 && "rounded-l-full",
                  inRange && day.getDay() === 6 && "rounded-r-full",
                  isRangeStart && highlighted && "rounded-l-full bg-primary/15",
                  isRangeEnd && "rounded-r-full bg-primary/15",
                )}
              >
                <button
                  type="button"
                  disabled={!selectable}
                  aria-label={format(day, "MMMM d, yyyy")}
                  aria-pressed={committed}
                  onMouseEnter={() => selectable && setHover(day)}
                  onMouseLeave={() => setHover(null)}
                  onClick={() => pickDay(day)}
                  className={cn(
                    "flex size-8 items-center justify-center rounded-full text-[13px] transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    (isRangeStart || isRangeEnd) && "bg-primary font-semibold text-primary-foreground",
                    !isRangeStart && !isRangeEnd && selectable && inMonth && "hover:bg-secondary",
                    !isRangeStart && !isRangeEnd && !inMonth && "text-foreground/35",
                    !selectable && "cursor-not-allowed text-foreground/25",
                    isSameDay(day, today) && !isRangeStart && !isRangeEnd && "font-semibold text-primary",
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

      <p className="mt-2 text-center text-[12.5px] text-foreground/70">
        {end ? rangeLabel(start, end) : "Now choose the end date."}
      </p>
    </div>
  );
}
