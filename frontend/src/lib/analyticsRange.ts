import {
  addDays,
  differenceInCalendarDays,
  endOfMonth,
  isAfter,
  isBefore,
  startOfDay,
  startOfMonth,
} from "date-fns";

/** Matches the analytics API cap (`timeRange` is clamped to 365 days). */
export const MAX_RANGE_DAYS = 365;

export type RangeQuery =
  | { ok: true; query: string }
  | { ok: false; reason: string };

/** Local calendar day, `days` before `today`. */
export function daysBefore(today: Date, days: number): Date {
  return startOfDay(addDays(today, -days));
}

/**
 * Map a calendar range onto the analytics query.
 * `timeRange` is how many days ago the start falls; `endDaysAgo` is the
 * inclusive end. The end must be after the start, and both days must sit
 * inside the last {@link MAX_RANGE_DAYS} days, including today.
 */
export function buildRangeQuery(
  start: Date | null,
  end: Date | null,
  today: Date = new Date(),
): RangeQuery {
  if (!start || !end) {
    return { ok: false, reason: "Choose an end date." };
  }

  const todayDay = startOfDay(today);
  const startDay = startOfDay(start);
  const endDay = startOfDay(end);

  if (isAfter(startDay, todayDay) || isAfter(endDay, todayDay)) {
    return { ok: false, reason: "Dates can't be in the future." };
  }

  const fromDaysAgo = differenceInCalendarDays(todayDay, startDay);
  const toDaysAgo = differenceInCalendarDays(todayDay, endDay);

  if (fromDaysAgo > MAX_RANGE_DAYS || toDaysAgo > MAX_RANGE_DAYS) {
    return {
      ok: false,
      reason: `Choose dates within the last ${MAX_RANGE_DAYS} days.`,
    };
  }

  if (toDaysAgo >= fromDaysAgo) {
    return { ok: false, reason: "Choose an end date after the start date." };
  }

  return {
    ok: true,
    query: `timeRange=${fromDaysAgo}d&endDaysAgo=${toDaysAgo}`,
  };
}

/** True when this calendar day can be the start or end of a range. */
export function isDayInWindow(day: Date, today: Date = new Date()): boolean {
  const todayDay = startOfDay(today);
  const dayStart = startOfDay(day);
  if (isAfter(dayStart, todayDay)) return false;
  return differenceInCalendarDays(todayDay, dayStart) <= MAX_RANGE_DAYS;
}

/** True when the month still contains at least one selectable day. */
export function monthHasSelectableDay(month: Date, today: Date = new Date()): boolean {
  const earliest = addDays(startOfDay(today), -MAX_RANGE_DAYS);
  const start = startOfMonth(month);
  const end = endOfMonth(month);
  return !isAfter(start, startOfDay(today)) && !isBefore(end, earliest);
}
