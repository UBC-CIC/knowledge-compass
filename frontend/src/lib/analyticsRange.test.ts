import { describe, expect, it } from "vitest";
import {
  buildRangeQuery,
  isDayInWindow,
  monthHasSelectableDay,
} from "@/lib/analyticsRange";

const today = new Date(2026, 9, 20);

describe("buildRangeQuery", () => {
  it("maps a calendar range to days-ago query params", () => {
    const result = buildRangeQuery(new Date(2026, 9, 10), new Date(2026, 9, 16), today);
    expect(result).toEqual({ ok: true, query: "timeRange=10d&endDaysAgo=4" });
  });

  it("maps a range in an earlier month", () => {
    const result = buildRangeQuery(new Date(2026, 6, 1), new Date(2026, 6, 31), today);
    expect(result).toEqual({ ok: true, query: "timeRange=111d&endDaysAgo=81" });
  });

  it("treats today as the inclusive end", () => {
    const result = buildRangeQuery(new Date(2026, 9, 1), today, today);
    expect(result).toEqual({ ok: true, query: "timeRange=19d&endDaysAgo=0" });
  });

  it("waits until both ends are chosen", () => {
    expect(buildRangeQuery(new Date(2026, 9, 10), null, today)).toEqual({
      ok: false,
      reason: "Choose an end date.",
    });
  });

  it("rejects a range that does not move forward", () => {
    expect(buildRangeQuery(new Date(2026, 9, 10), new Date(2026, 9, 10), today).ok).toBe(
      false,
    );
    expect(buildRangeQuery(new Date(2026, 9, 16), new Date(2026, 9, 10), today).ok).toBe(
      false,
    );
  });

  it("rejects future dates and dates older than a year", () => {
    expect(buildRangeQuery(new Date(2026, 9, 10), new Date(2026, 9, 21), today).ok).toBe(
      false,
    );
    expect(buildRangeQuery(new Date(2025, 9, 19), new Date(2025, 9, 20), today).ok).toBe(
      false,
    );
  });
});

describe("calendar window", () => {
  it("allows today and a day a year back, and blocks the day before that", () => {
    expect(isDayInWindow(today, today)).toBe(true);
    expect(isDayInWindow(new Date(2025, 9, 20), today)).toBe(true);
    expect(isDayInWindow(new Date(2025, 9, 19), today)).toBe(false);
    expect(isDayInWindow(new Date(2026, 9, 21), today)).toBe(false);
  });

  it("knows which months still have a selectable day", () => {
    expect(monthHasSelectableDay(new Date(2026, 6, 1), today)).toBe(true);
    expect(monthHasSelectableDay(new Date(2026, 9, 1), today)).toBe(true);
    expect(monthHasSelectableDay(new Date(2026, 10, 1), today)).toBe(false);
    expect(monthHasSelectableDay(new Date(2025, 8, 1), today)).toBe(false);
  });
});
