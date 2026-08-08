export type ReviewedAggregateTransformOperation =
  | "running_total"
  | "rank"
  | "lag_absolute_change"
  | "lag_percentage_change"
  | "moving_average"
  | "share_of_released_total";

export type ReviewedAggregateTransform = {
  operation: ReviewedAggregateTransformOperation;
  input_field: string;
  output_field: string;
  partition_fields: string[];
  time_field?: string;
  direction?: "asc" | "desc";
  window_size?: number;
};

/**
 * Apply fixed reviewed calculations to groups that already passed cohort
 * suppression. Suppressed groups must never be passed to this function.
 */
export function applyReviewedAggregateTransforms(input: {
  groups: Array<Record<string, unknown>>;
  transforms: ReviewedAggregateTransform[];
}): Array<Record<string, unknown>> {
  const groups = input.groups.map((group) => ({ ...group }));
  const source = input.groups.map((group) => ({ ...group }));
  for (const transform of input.transforms) {
    assertTransform(transform);
    const partitions = partitionIndexes(source, transform.partition_fields);
    for (const indexes of partitions.values()) {
      const ordered = transform.time_field
        ? [...indexes].sort((left, right) => compareTime(
          source[left]![transform.time_field!],
          source[right]![transform.time_field!],
        ))
        : indexes;
      if (transform.operation === "rank") {
        applyRank(groups, source, ordered, transform);
      } else if (transform.operation === "share_of_released_total") {
        applyShare(groups, source, ordered, transform);
      } else if (transform.operation === "running_total") {
        applyRunningTotal(groups, source, ordered, transform);
      } else if (transform.operation === "moving_average") {
        applyMovingAverage(groups, source, ordered, transform);
      } else {
        applyLagChange(groups, source, ordered, transform);
      }
    }
  }
  return groups;
}

function assertTransform(transform: ReviewedAggregateTransform): void {
  if (!transform.input_field || !transform.output_field) {
    throw new TypeError("Reviewed aggregate transforms require input and output fields.");
  }
  const sequential = transform.operation === "running_total"
    || transform.operation === "lag_absolute_change"
    || transform.operation === "lag_percentage_change"
    || transform.operation === "moving_average";
  if (sequential !== Boolean(transform.time_field)) {
    throw new TypeError("Sequential reviewed aggregate transforms require exactly one reviewed time field.");
  }
  if (transform.operation === "moving_average"
    && (!Number.isSafeInteger(transform.window_size)
      || transform.window_size! < 2
      || transform.window_size! > 12)) {
    throw new TypeError("Reviewed moving averages require a fixed window from 2 through 12.");
  }
  if (transform.operation === "rank"
    && transform.direction !== "asc"
    && transform.direction !== "desc") {
    throw new TypeError("Reviewed ranks require a fixed ascending or descending direction.");
  }
}

function partitionIndexes(
  groups: Array<Record<string, unknown>>,
  fields: string[],
): Map<string, number[]> {
  const partitions = new Map<string, number[]>();
  groups.forEach((group, index) => {
    const key = JSON.stringify(fields.map((field) => group[field] ?? null));
    const indexes = partitions.get(key) ?? [];
    indexes.push(index);
    partitions.set(key, indexes);
  });
  return partitions;
}

function compareTime(left: unknown, right: unknown): number {
  const leftValue = typeof left === "string" || typeof left === "number" ? String(left) : "";
  const rightValue = typeof right === "string" || typeof right === "number" ? String(right) : "";
  return leftValue.localeCompare(rightValue);
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function applyRank(
  output: Array<Record<string, unknown>>,
  source: Array<Record<string, unknown>>,
  indexes: number[],
  transform: ReviewedAggregateTransform,
): void {
  const direction = transform.direction === "asc" ? 1 : -1;
  const ranked = indexes
    .map((index) => ({ index, value: finite(source[index]![transform.input_field]) }))
    .filter((item): item is { index: number; value: number } => item.value !== null)
    .sort((left, right) => direction * (left.value - right.value) || left.index - right.index);
  let previous: number | undefined;
  let rank = 0;
  ranked.forEach((item, index) => {
    if (previous === undefined || item.value !== previous) rank = index + 1;
    output[item.index]![transform.output_field] = rank;
    previous = item.value;
  });
  indexes.filter((index) => finite(source[index]![transform.input_field]) === null)
    .forEach((index) => { output[index]![transform.output_field] = null; });
}

function applyShare(
  output: Array<Record<string, unknown>>,
  source: Array<Record<string, unknown>>,
  indexes: number[],
  transform: ReviewedAggregateTransform,
): void {
  const values = indexes.map((index) => finite(source[index]![transform.input_field]));
  const total = values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  indexes.forEach((index, position) => {
    const value = values[position];
    output[index]![transform.output_field] = value == null || total === 0
      ? null
      : (value / total) * 100;
  });
}

function applyRunningTotal(
  output: Array<Record<string, unknown>>,
  source: Array<Record<string, unknown>>,
  indexes: number[],
  transform: ReviewedAggregateTransform,
): void {
  let total = 0;
  indexes.forEach((index) => {
    const value = finite(source[index]![transform.input_field]);
    if (value === null) {
      output[index]![transform.output_field] = null;
      return;
    }
    total += value;
    output[index]![transform.output_field] = total;
  });
}

function applyMovingAverage(
  output: Array<Record<string, unknown>>,
  source: Array<Record<string, unknown>>,
  indexes: number[],
  transform: ReviewedAggregateTransform,
): void {
  const windowSize = transform.window_size!;
  indexes.forEach((index, position) => {
    const values = indexes.slice(Math.max(0, position - windowSize + 1), position + 1)
      .map((candidate) => finite(source[candidate]![transform.input_field]))
      .filter((value): value is number => value !== null);
    output[index]![transform.output_field] = values.length
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : null;
  });
}

function applyLagChange(
  output: Array<Record<string, unknown>>,
  source: Array<Record<string, unknown>>,
  indexes: number[],
  transform: ReviewedAggregateTransform,
): void {
  indexes.forEach((index, position) => {
    const current = finite(source[index]![transform.input_field]);
    const previous = position > 0
      ? finite(source[indexes[position - 1]!]![transform.input_field])
      : null;
    if (current === null || previous === null) {
      output[index]![transform.output_field] = null;
      return;
    }
    const change = current - previous;
    output[index]![transform.output_field] = transform.operation === "lag_percentage_change"
      ? previous === 0 ? null : (change / Math.abs(previous)) * 100
      : change;
  });
}
