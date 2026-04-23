// Minimal 5-field cron expression parser.
// Fields: minute hour day-of-month month day-of-week
// Supports: numbers, ranges (1-5), steps (star/5), lists (1,3,5), wildcards (star).
// Does not support 6-field (seconds) expressions.

export interface CronField {
  values: Set<number>;
}

export interface ParsedCron {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

export function parseCronExpression(expression: string): ParsedCron {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      `Invalid cron expression: expected 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}. ` +
      `6-field (seconds) expressions are not supported.`
    );
  }

  return {
    minute: parseField(parts[0]!, 0, 59),
    hour: parseField(parts[1]!, 0, 23),
    dayOfMonth: parseField(parts[2]!, 1, 31),
    month: parseField(parts[3]!, 1, 12),
    dayOfWeek: parseField(parts[4]!, 0, 6)
  };
}

export function nextCronFire(expression: string, after: Date, timezone: string): Date {
  const cron = parseCronExpression(expression);
  const resolvedTz = timezone === "system" ? Intl.DateTimeFormat().resolvedOptions().timeZone : timezone;

  // Start from the next minute after `after`
  let candidate = new Date(after.getTime());
  candidate.setSeconds(0, 0);
  candidate.setTime(candidate.getTime() + 60_000);

  // Safety limit: scan at most 2 years ahead
  const maxIterations = 366 * 24 * 60;

  for (let i = 0; i < maxIterations; i++) {
    const parts = getDatePartsInTimezone(candidate, resolvedTz);

    if (!cron.month.values.has(parts.month)) {
      // Skip to next month
      candidate = advanceToNextMonth(candidate, resolvedTz);
      continue;
    }

    if (!cron.dayOfMonth.values.has(parts.day) || !cron.dayOfWeek.values.has(parts.dow)) {
      // Skip to next day
      candidate = advanceToNextDay(candidate, resolvedTz);
      continue;
    }

    if (!cron.hour.values.has(parts.hour)) {
      // Skip to next hour
      candidate = advanceToNextHour(candidate, resolvedTz);
      continue;
    }

    if (!cron.minute.values.has(parts.minute)) {
      candidate.setTime(candidate.getTime() + 60_000);
      continue;
    }

    return candidate;
  }

  throw new Error("Could not compute next cron fire within 2 years");
}

function parseField(field: string, min: number, max: number): CronField {
  const values = new Set<number>();

  for (const part of field.split(",")) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    if (stepMatch) {
      const range = stepMatch[1]!;
      const step = parseInt(stepMatch[2]!, 10);
      const [rangeMin, rangeMax] = range === "*"
        ? [min, max]
        : parseRange(range, min, max);

      for (let v = rangeMin; v <= rangeMax; v += step) {
        values.add(v);
      }
      continue;
    }

    if (part === "*") {
      for (let v = min; v <= max; v++) {
        values.add(v);
      }
      continue;
    }

    if (part.includes("-")) {
      const [rangeMin, rangeMax] = parseRange(part, min, max);
      for (let v = rangeMin; v <= rangeMax; v++) {
        values.add(v);
      }
      continue;
    }

    const num = parseInt(part, 10);
    if (isNaN(num) || num < min || num > max) {
      throw new Error(`Invalid cron field value: ${part} (valid range: ${min}-${max})`);
    }
    values.add(num);
  }

  return { values };
}

function parseRange(range: string, min: number, max: number): [number, number] {
  const parts = range.split("-");
  if (parts.length !== 2) {
    throw new Error(`Invalid cron range: ${range}`);
  }

  const lo = parseInt(parts[0]!, 10);
  const hi = parseInt(parts[1]!, 10);
  if (isNaN(lo) || isNaN(hi) || lo < min || hi > max || lo > hi) {
    throw new Error(`Invalid cron range: ${range} (valid range: ${min}-${max})`);
  }

  return [lo, hi];
}

interface DateParts {
  minute: number;
  hour: number;
  day: number;
  month: number;
  dow: number;
}

function getDatePartsInTimezone(date: Date, timezone: string): DateParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hour12: false
  });

  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((p) => [p.type, p.value])
  );

  // day of week (0 = Sunday)
  const dow = new Date(
    parseInt(parts.year ?? "0", 10),
    parseInt(parts.month ?? "1", 10) - 1,
    parseInt(parts.day ?? "1", 10)
  ).getDay();

  return {
    minute: parseInt(parts.minute ?? "0", 10),
    hour: parseInt(parts.hour ?? "0", 10) % 24,
    day: parseInt(parts.day ?? "1", 10),
    month: parseInt(parts.month ?? "1", 10),
    dow
  };
}

function advanceToNextMonth(date: Date, _timezone: string): Date {
  const next = new Date(date.getTime());
  next.setDate(1);
  next.setHours(0, 0, 0, 0);
  next.setMonth(next.getMonth() + 1);
  return next;
}

function advanceToNextDay(date: Date, _timezone: string): Date {
  const next = new Date(date.getTime());
  next.setHours(0, 0, 0, 0);
  next.setTime(next.getTime() + 24 * 60 * 60_000);
  return next;
}

function advanceToNextHour(date: Date, _timezone: string): Date {
  const next = new Date(date.getTime());
  next.setMinutes(0, 0, 0);
  next.setTime(next.getTime() + 60 * 60_000);
  return next;
}
