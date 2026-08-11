import { describe, expect, it } from "vitest";
import {
  resolveRelativeTimeComparison,
  resolveRelativeTimeWindow,
} from "./relative-time-window.js";

const NOW = Date.parse("2026-08-10T15:30:45.123Z");

describe("reviewed UTC relative time windows", () => {
  it.each([
    ["today", "2026-08-10T00:00:00.000Z", "2026-08-11T00:00:00.000Z"],
    ["yesterday", "2026-08-09T00:00:00.000Z", "2026-08-10T00:00:00.000Z"],
    ["last_7_days", "2026-08-03T15:30:45.123Z", "2026-08-10T15:30:45.123Z"],
    ["last_30_days", "2026-07-11T15:30:45.123Z", "2026-08-10T15:30:45.123Z"],
    ["last_90_days", "2026-05-12T15:30:45.123Z", "2026-08-10T15:30:45.123Z"],
    ["this_week", "2026-08-10T00:00:00.000Z", "2026-08-17T00:00:00.000Z"],
    ["previous_week", "2026-08-03T00:00:00.000Z", "2026-08-10T00:00:00.000Z"],
    ["this_month", "2026-08-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z"],
    ["previous_month", "2026-07-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z"],
    ["this_quarter", "2026-07-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z"],
    ["previous_quarter", "2026-04-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z"],
    ["this_year", "2026-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z"],
    ["day_to_date", "2026-08-10T00:00:00.000Z", "2026-08-10T15:30:45.123Z"],
    ["week_to_date", "2026-08-10T00:00:00.000Z", "2026-08-10T15:30:45.123Z"],
    ["month_to_date", "2026-08-01T00:00:00.000Z", "2026-08-10T15:30:45.123Z"],
    ["quarter_to_date", "2026-07-01T00:00:00.000Z", "2026-08-10T15:30:45.123Z"],
    ["year_to_date", "2026-01-01T00:00:00.000Z", "2026-08-10T15:30:45.123Z"],
  ] as const)("resolves %s as one half-open UTC range", (window, start, end) => {
    expect(resolveRelativeTimeWindow(window, NOW)).toEqual({ start, end });
  });

  it("uses Monday as the fixed ISO week boundary", () => {
    expect(resolveRelativeTimeWindow(
      "this_week",
      Date.parse("2026-08-16T23:59:59.999Z"),
    )).toEqual({
      start: "2026-08-10T00:00:00.000Z",
      end: "2026-08-17T00:00:00.000Z",
    });
  });

  it("compares calendar months to the prior complete calendar month", () => {
    expect(resolveRelativeTimeComparison("previous_month", "preceding_period", NOW)).toEqual([
      { start: "2026-06-01T00:00:00.000Z", end: "2026-07-01T00:00:00.000Z" },
      { start: "2026-07-01T00:00:00.000Z", end: "2026-08-01T00:00:00.000Z" },
    ]);
  });

  it("compares rolling and to-date windows to the immediately preceding equal duration", () => {
    expect(resolveRelativeTimeComparison("last_7_days", "preceding_period", NOW)).toEqual([
      { start: "2026-07-27T15:30:45.123Z", end: "2026-08-03T15:30:45.123Z" },
      { start: "2026-08-03T15:30:45.123Z", end: "2026-08-10T15:30:45.123Z" },
    ]);
    expect(resolveRelativeTimeComparison("day_to_date", "preceding_period", NOW)).toEqual([
      { start: "2026-08-09T08:29:14.877Z", end: "2026-08-10T00:00:00.000Z" },
      { start: "2026-08-10T00:00:00.000Z", end: "2026-08-10T15:30:45.123Z" },
    ]);
  });

  it("clamps same-period-last-year leap-day endpoints deterministically", () => {
    const leapNow = Date.parse("2028-02-29T12:00:00.000Z");
    expect(resolveRelativeTimeComparison("day_to_date", "same_period_last_year", leapNow)).toEqual([
      { start: "2027-02-28T00:00:00.000Z", end: "2027-02-28T12:00:00.000Z" },
      { start: "2028-02-29T00:00:00.000Z", end: "2028-02-29T12:00:00.000Z" },
    ]);
  });

  it("refuses a zero-length to-date window at an exact UTC period boundary", () => {
    expect(() => resolveRelativeTimeWindow(
      "month_to_date",
      Date.parse("2026-08-01T00:00:00.000Z"),
    )).toThrow(/no elapsed UTC time/i);
  });
});
