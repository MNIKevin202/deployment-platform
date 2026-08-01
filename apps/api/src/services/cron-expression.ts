/**
 * A small, dependency-free parser/matcher/describer for standard 5-field
 * cron expressions:
 *
 *   ┌───────────── minute        (0–59)
 *   │ ┌─────────── hour          (0–23)
 *   │ │ ┌───────── day of month  (1–31)
 *   │ │ │ ┌─────── month         (1–12)
 *   │ │ │ │ ┌───── day of week    (0–6, Sunday = 0)
 *   * * * * *
 *
 * Each field supports `*`, a number, `a-b` ranges, `a,b,c` lists, and step
 * values `*​/n` or `a-b/n`. This is deliberately the classic cron subset —
 * no `@hourly` macros, no seconds, no names — so its behaviour is
 * predictable and fully testable, and matches what an operator who has
 * written a crontab already expects.
 */

export interface ParsedCronField {
  /** The set of matching values for this field. */
  values: Set<number>;
  /** True when the field was a bare `*` — used only for the describer. */
  wildcard: boolean;
}

export interface ParsedCron {
  minute: ParsedCronField;
  hour: ParsedCronField;
  dayOfMonth: ParsedCronField;
  month: ParsedCronField;
  dayOfWeek: ParsedCronField;
}

export interface CronParseError {
  ok: false;
  error: string;
}

export interface CronParseSuccess {
  ok: true;
  parsed: ParsedCron;
}

export type CronParseResult = CronParseSuccess | CronParseError;

interface FieldSpec {
  name: string;
  min: number;
  max: number;
}

const FIELD_SPECS: FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day-of-week", min: 0, max: 6 }
];

/**
 * Parses one field into the exact set of integers it matches. Returns a
 * string error message on any malformed input rather than throwing, so the
 * caller can surface it verbatim.
 */
function parseField(raw: string, spec: FieldSpec): ParsedCronField | string {
  const field = raw.trim();

  if (field === "") {
    return `The ${spec.name} field is empty.`;
  }

  const values = new Set<number>();
  const wildcard = field === "*";

  // A field is a comma-separated list of terms; each term is a range (or a
  // single value, or `*`) optionally followed by a `/step`.
  for (const term of field.split(",")) {
    const [rangePart, stepPart, ...rest] = term.split("/");

    if (rest.length > 0) {
      return `"${term}" in the ${spec.name} field has more than one "/".`;
    }

    let step = 1;
    if (stepPart !== undefined) {
      const parsedStep = Number(stepPart);
      if (!Number.isInteger(parsedStep) || parsedStep <= 0) {
        return `"${stepPart}" is not a valid step in the ${spec.name} field.`;
      }
      step = parsedStep;
    }

    let start: number;
    let end: number;

    if (rangePart === "*") {
      start = spec.min;
      end = spec.max;
    } else if (rangePart.includes("-")) {
      const [a, b, ...extra] = rangePart.split("-");
      if (extra.length > 0) {
        return `"${rangePart}" in the ${spec.name} field is not a valid range.`;
      }
      start = Number(a);
      end = Number(b);
      if (!Number.isInteger(start) || !Number.isInteger(end)) {
        return `"${rangePart}" in the ${spec.name} field is not a valid range.`;
      }
      if (start > end) {
        return `"${rangePart}" in the ${spec.name} field has its start after its end.`;
      }
    } else {
      const single = Number(rangePart);
      if (!Number.isInteger(single)) {
        return `"${rangePart}" is not a valid ${spec.name} value.`;
      }
      // A bare number with a step (`5/10`) means "from 5 to the max, every
      // step" — matching common cron behaviour.
      start = single;
      end = stepPart !== undefined ? spec.max : single;
    }

    if (start < spec.min || end > spec.max) {
      return `The ${spec.name} field must be between ${spec.min} and ${spec.max}.`;
    }

    for (let value = start; value <= end; value += step) {
      values.add(value);
    }
  }

  if (values.size === 0) {
    return `The ${spec.name} field matches no values.`;
  }

  return { values, wildcard };
}

export function parseCronExpression(expression: string): CronParseResult {
  const fields = expression.trim().split(/\s+/);

  if (fields.length !== 5) {
    return {
      ok: false,
      error: `A cron expression needs exactly 5 fields (got ${fields.length}). Example: "0 3 * * *" = 3:00 AM every day.`
    };
  }

  const parsedFields: ParsedCronField[] = [];

  for (let i = 0; i < FIELD_SPECS.length; i += 1) {
    const result = parseField(fields[i], FIELD_SPECS[i]);
    if (typeof result === "string") {
      return { ok: false, error: result };
    }
    parsedFields.push(result);
  }

  return {
    ok: true,
    parsed: {
      minute: parsedFields[0],
      hour: parsedFields[1],
      dayOfMonth: parsedFields[2],
      month: parsedFields[3],
      dayOfWeek: parsedFields[4]
    }
  };
}

/**
 * Whether the given moment matches the parsed expression, to minute
 * granularity.
 *
 * Follows the classic cron day rule: when BOTH day-of-month and day-of-week
 * are restricted (neither is `*`), the job runs if EITHER matches — a
 * deliberate quirk of cron, preserved so `0 0 13 * 5` behaves as an
 * operator expects ("the 13th, and every Friday"). When only one of the two
 * is restricted, only that one applies.
 */
export function cronMatches(parsed: ParsedCron, date: Date): boolean {
  const minute = date.getMinutes();
  const hour = date.getHours();
  const dom = date.getDate();
  const month = date.getMonth() + 1;
  const dow = date.getDay();

  if (!parsed.minute.values.has(minute)) return false;
  if (!parsed.hour.values.has(hour)) return false;
  if (!parsed.month.values.has(month)) return false;

  const domRestricted = !parsed.dayOfMonth.wildcard;
  const dowRestricted = !parsed.dayOfWeek.wildcard;

  const domMatches = parsed.dayOfMonth.values.has(dom);
  const dowMatches = parsed.dayOfWeek.values.has(dow);

  if (domRestricted && dowRestricted) {
    return domMatches || dowMatches;
  }
  if (domRestricted) {
    return domMatches;
  }
  if (dowRestricted) {
    return dowMatches;
  }
  return true;
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];
const DAY_NAMES = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"
];

/** "3:05 AM" from an hour+minute. */
function formatTime(hour: number, minute: number): string {
  const period = hour < 12 ? "AM" : "PM";
  const displayHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${displayHour}:${String(minute).padStart(2, "0")} ${period}`;
}

/** A single value, or null if the field matches anything but one value. */
function soleValue(field: ParsedCronField): number | null {
  return field.values.size === 1 ? [...field.values][0] : null;
}

/** Detects a plain `*​/n` step field (every n, across the full range). */
function stepEvery(field: ParsedCronField, min: number, max: number): number | null {
  const sorted = [...field.values].sort((a, b) => a - b);
  if (sorted.length < 2 || sorted[0] !== min) {
    return null;
  }
  const step = sorted[1] - sorted[0];
  // A step of 1 spanning the whole range is just "every X", which the
  // wildcard branches describe better ("Every hour" not "Every 1 hours").
  if (step <= 1) {
    return null;
  }
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] - sorted[i - 1] !== step) {
      return null;
    }
  }
  // Must actually span the range in even steps.
  if (sorted[sorted.length - 1] + step <= max) {
    return null;
  }
  return step;
}

/**
 * A plain-English description of common schedules, with a safe generic
 * fallback for anything exotic. Purely for display — never parsed back.
 */
export function describeCron(parsed: ParsedCron): string {
  const { minute, hour, dayOfMonth, month, dayOfWeek } = parsed;

  const everyMinute = minute.wildcard;
  const everyHour = hour.wildcard;
  const everyDom = dayOfMonth.wildcard;
  const everyMonth = month.wildcard;
  const everyDow = dayOfWeek.wildcard;

  // Every minute.
  if (everyMinute && everyHour && everyDom && everyMonth && everyDow) {
    return "Every minute";
  }

  // Every N minutes.
  const minuteStep = stepEvery(minute, 0, 59);
  if (minuteStep && everyHour && everyDom && everyMonth && everyDow) {
    return `Every ${minuteStep} minutes`;
  }

  // Every N hours, on the minute.
  const soleMinute = soleValue(minute);
  const hourStep = stepEvery(hour, 0, 23);
  if (soleMinute !== null && hourStep && everyDom && everyMonth && everyDow) {
    return `Every ${hourStep} hours (at :${String(soleMinute).padStart(2, "0")})`;
  }

  // Hourly (at a fixed minute).
  if (soleMinute !== null && everyHour && everyDom && everyMonth && everyDow) {
    return `Every hour, at :${String(soleMinute).padStart(2, "0")}`;
  }

  const soleHour = soleValue(hour);

  // A specific time of day, on some day pattern.
  if (soleMinute !== null && soleHour !== null) {
    const time = formatTime(soleHour, soleMinute);

    // Daily.
    if (everyDom && everyMonth && everyDow) {
      return `Every day at ${time}`;
    }

    // Weekly on specific day(s).
    if (everyDom && everyMonth && !everyDow) {
      const days = [...dayOfWeek.values].sort((a, b) => a - b).map((d) => DAY_NAMES[d]);
      return `Every ${days.join(", ")} at ${time}`;
    }

    // Monthly on a specific day.
    const soleDom = soleValue(dayOfMonth);
    if (soleDom !== null && everyMonth && everyDow) {
      const ordinal =
        soleDom === 1 ? "1st" : soleDom === 2 ? "2nd" : soleDom === 3 ? "3rd" : `${soleDom}th`;
      return `On the ${ordinal} of every month at ${time}`;
    }

    // Specific month(s) + day.
    if (soleDom !== null && !everyMonth && everyDow) {
      const months = [...month.values].sort((a, b) => a - b).map((m) => MONTH_NAMES[m - 1]);
      return `On day ${soleDom} of ${months.join(", ")} at ${time}`;
    }
  }

  // Fallback: honest, generic, never wrong.
  return "Runs on a custom schedule (see the cron fields).";
}

/** Convenience: parse + describe in one call, for a preview endpoint. */
export function previewCron(
  expression: string
): { ok: true; description: string } | { ok: false; error: string } {
  const result = parseCronExpression(expression);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  return { ok: true, description: describeCron(result.parsed) };
}
