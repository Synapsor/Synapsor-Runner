export const RELATIVE_TIME_WINDOWS = [
  "today",
  "yesterday",
  "last_7_days",
  "last_30_days",
  "last_90_days",
  "this_week",
  "previous_week",
  "this_month",
  "previous_month",
  "this_quarter",
  "previous_quarter",
  "this_year",
  "day_to_date",
  "week_to_date",
  "month_to_date",
  "quarter_to_date",
  "year_to_date",
] as const;

export type RelativeTimeWindow = typeof RELATIVE_TIME_WINDOWS[number];

export const RELATIVE_TIME_COMPARISONS = [
  "preceding_period",
  "same_period_last_year",
] as const;

export type RelativeTimeComparison = typeof RELATIVE_TIME_COMPARISONS[number];

export type ResolvedUtcRange = {
  start: string;
  end: string;
};

export type ResolvedRelativeTimeWindow = {
  source: "reviewed_relative_time";
  location: "time_window" | "comparison";
  field: string;
  relationship?: string;
  window: RelativeTimeWindow;
  compare_to?: RelativeTimeComparison;
  reporting_timezone: "UTC";
  resolved_at: string;
  ranges: Array<{
    id: "window" | "period_1" | "period_2";
    start_inclusive: string;
    end_exclusive: string;
  }>;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function isRelativeTimeWindow(value: string): value is RelativeTimeWindow {
  return (RELATIVE_TIME_WINDOWS as readonly string[]).includes(value);
}

export function isRelativeTimeComparison(value: string): value is RelativeTimeComparison {
  return (RELATIVE_TIME_COMPARISONS as readonly string[]).includes(value);
}

export function resolveRelativeTimeWindow(
  window: RelativeTimeWindow,
  nowMs: number,
): ResolvedUtcRange {
  assertFiniteClock(nowMs);
  const now = new Date(nowMs);
  const day = startOfUtcDay(now);
  const week = startOfUtcWeek(now);
  const month = startOfUtcMonth(now);
  const quarter = startOfUtcQuarter(now);
  const year = startOfUtcYear(now);

  switch (window) {
    case "today":
      return range(day, addUtcDays(day, 1));
    case "yesterday":
      return range(addUtcDays(day, -1), day);
    case "last_7_days":
      return range(new Date(nowMs - 7 * DAY_MS), now);
    case "last_30_days":
      return range(new Date(nowMs - 30 * DAY_MS), now);
    case "last_90_days":
      return range(new Date(nowMs - 90 * DAY_MS), now);
    case "this_week":
      return range(week, addUtcDays(week, 7));
    case "previous_week":
      return range(addUtcDays(week, -7), week);
    case "this_month":
      return range(month, addUtcMonths(month, 1));
    case "previous_month":
      return range(addUtcMonths(month, -1), month);
    case "this_quarter":
      return range(quarter, addUtcMonths(quarter, 3));
    case "previous_quarter":
      return range(addUtcMonths(quarter, -3), quarter);
    case "this_year":
      return range(year, addUtcYears(year, 1));
    case "day_to_date":
      return nonEmptyToDateRange(day, now, window);
    case "week_to_date":
      return nonEmptyToDateRange(week, now, window);
    case "month_to_date":
      return nonEmptyToDateRange(month, now, window);
    case "quarter_to_date":
      return nonEmptyToDateRange(quarter, now, window);
    case "year_to_date":
      return nonEmptyToDateRange(year, now, window);
  }
}

export function resolveRelativeTimeComparison(
  window: RelativeTimeWindow,
  compareTo: RelativeTimeComparison,
  nowMs: number,
): [ResolvedUtcRange, ResolvedUtcRange] {
  const selected = resolveRelativeTimeWindow(window, nowMs);
  const baseline = compareTo === "same_period_last_year"
    ? {
        start: shiftIsoUtcYears(selected.start, -1),
        end: shiftIsoUtcYears(selected.end, -1),
      }
    : precedingRange(window, selected);
  if (Date.parse(baseline.end) > Date.parse(selected.start)) {
    throw new Error("Relative comparison periods must be ordered and non-overlapping.");
  }
  return [baseline, selected];
}

function precedingRange(window: RelativeTimeWindow, selected: ResolvedUtcRange): ResolvedUtcRange {
  const start = new Date(selected.start);
  const end = new Date(selected.end);
  switch (window) {
    case "today":
    case "yesterday":
      return range(addUtcDays(start, -1), addUtcDays(end, -1));
    case "this_week":
    case "previous_week":
      return range(addUtcDays(start, -7), addUtcDays(end, -7));
    case "this_month":
    case "previous_month":
      return range(addUtcMonths(start, -1), addUtcMonths(end, -1));
    case "this_quarter":
    case "previous_quarter":
      return range(addUtcMonths(start, -3), addUtcMonths(end, -3));
    case "this_year":
      return range(addUtcYears(start, -1), addUtcYears(end, -1));
    case "last_7_days":
    case "last_30_days":
    case "last_90_days":
    case "day_to_date":
    case "week_to_date":
    case "month_to_date":
    case "quarter_to_date":
    case "year_to_date": {
      const duration = end.getTime() - start.getTime();
      return range(new Date(start.getTime() - duration), start);
    }
  }
}

function startOfUtcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function startOfUtcWeek(value: Date): Date {
  const day = startOfUtcDay(value);
  const isoDay = day.getUTCDay() === 0 ? 7 : day.getUTCDay();
  return addUtcDays(day, 1 - isoDay);
}

function startOfUtcMonth(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1));
}

function startOfUtcQuarter(value: Date): Date {
  const month = Math.floor(value.getUTCMonth() / 3) * 3;
  return new Date(Date.UTC(value.getUTCFullYear(), month, 1));
}

function startOfUtcYear(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), 0, 1));
}

function addUtcDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * DAY_MS);
}

function addUtcMonths(value: Date, months: number): Date {
  return new Date(Date.UTC(
    value.getUTCFullYear(),
    value.getUTCMonth() + months,
    value.getUTCDate(),
    value.getUTCHours(),
    value.getUTCMinutes(),
    value.getUTCSeconds(),
    value.getUTCMilliseconds(),
  ));
}

function addUtcYears(value: Date, years: number): Date {
  return shiftUtcYears(value, years);
}

function shiftIsoUtcYears(value: string, years: number): string {
  return shiftUtcYears(new Date(value), years).toISOString();
}

function shiftUtcYears(value: Date, years: number): Date {
  const targetYear = value.getUTCFullYear() + years;
  const month = value.getUTCMonth();
  const day = Math.min(value.getUTCDate(), daysInUtcMonth(targetYear, month));
  return new Date(Date.UTC(
    targetYear,
    month,
    day,
    value.getUTCHours(),
    value.getUTCMinutes(),
    value.getUTCSeconds(),
    value.getUTCMilliseconds(),
  ));
}

function daysInUtcMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function nonEmptyToDateRange(
  start: Date,
  end: Date,
  window: RelativeTimeWindow,
): ResolvedUtcRange {
  if (start.getTime() >= end.getTime()) {
    throw new Error(
      `${window} has no elapsed UTC time at the captured query instant; retry after the period begins.`,
    );
  }
  return range(start, end);
}

function range(start: Date, end: Date): ResolvedUtcRange {
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) {
    throw new Error("Relative time window resolution produced an invalid UTC range.");
  }
  return { start: start.toISOString(), end: end.toISOString() };
}

function assertFiniteClock(nowMs: number): void {
  if (!Number.isFinite(nowMs)) throw new Error("Relative time window resolution requires a valid Runner clock.");
}
