import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  cronMatches,
  describeCron,
  parseCronExpression,
  previewCron
} from "../services/cron-expression.js";

/** Parses, asserting success, and returns the ParsedCron. */
function parse(expression: string) {
  const result = parseCronExpression(expression);
  assert.ok(result.ok, `expected "${expression}" to parse: ${result.ok ? "" : result.error}`);
  return result.parsed;
}

/** Local Date for a given wall-clock moment. */
function at(y: number, mo: number, d: number, h: number, mi: number): Date {
  return new Date(y, mo - 1, d, h, mi, 0, 0);
}

describe("parseCronExpression — validation", () => {
  test("rejects the wrong number of fields", () => {
    for (const expr of ["", "* * * *", "* * * * * *", "0 0"]) {
      const result = parseCronExpression(expr);
      assert.equal(result.ok, false, `"${expr}" should not parse`);
    }
  });

  test("rejects out-of-range values with a field-specific message", () => {
    assert.match((parseCronExpression("60 * * * *") as { error: string }).error, /minute/);
    assert.match((parseCronExpression("* 24 * * *") as { error: string }).error, /hour/);
    assert.match((parseCronExpression("* * 0 * *") as { error: string }).error, /day-of-month/);
    assert.match((parseCronExpression("* * * 13 *") as { error: string }).error, /month/);
    assert.match((parseCronExpression("* * * * 7") as { error: string }).error, /day-of-week/);
  });

  test("rejects malformed ranges, steps, and garbage", () => {
    for (const expr of ["5-2 * * * *", "* */0 * * *", "a * * * *", "1-2-3 * * * *", "*/x * * * *"]) {
      assert.equal(parseCronExpression(expr).ok, false, `"${expr}" should not parse`);
    }
  });

  test("accepts the standard forms", () => {
    for (const expr of [
      "* * * * *",
      "0 3 * * *",
      "*/15 * * * *",
      "0 */6 * * *",
      "30 9 1 * *",
      "0 0 * * 1-5",
      "0 9,17 * * *",
      "15 14 1 1 *",
      "5/10 * * * *"
    ]) {
      assert.equal(parseCronExpression(expr).ok, true, `"${expr}" should parse`);
    }
  });
});

describe("parseCronExpression — expansion", () => {
  test("* expands to the whole range", () => {
    assert.equal(parse("* * * * *").minute.values.size, 60);
    assert.equal(parse("* * * * *").hour.values.size, 24);
  });

  test("*/15 expands to 0,15,30,45", () => {
    assert.deepEqual([...parse("*/15 * * * *").minute.values].sort((a, b) => a - b), [0, 15, 30, 45]);
  });

  test("ranges and lists expand correctly", () => {
    assert.deepEqual([...parse("0 0 * * 1-5").dayOfWeek.values].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
    assert.deepEqual([...parse("0 9,12,17 * * *").hour.values].sort((a, b) => a - b), [9, 12, 17]);
  });

  test("a stepped range expands to just its members", () => {
    assert.deepEqual([...parse("0-30/10 * * * *").minute.values].sort((a, b) => a - b), [0, 10, 20, 30]);
  });
});

describe("cronMatches", () => {
  test("every minute matches any time", () => {
    assert.equal(cronMatches(parse("* * * * *"), at(2026, 8, 1, 13, 37)), true);
  });

  test("a daily time matches only that minute", () => {
    const daily = parse("0 3 * * *");
    assert.equal(cronMatches(daily, at(2026, 8, 1, 3, 0)), true);
    assert.equal(cronMatches(daily, at(2026, 8, 1, 3, 1)), false);
    assert.equal(cronMatches(daily, at(2026, 8, 1, 4, 0)), false);
  });

  test("*/15 matches only the quarter-hours", () => {
    const q = parse("*/15 * * * *");
    assert.equal(cronMatches(q, at(2026, 8, 1, 10, 0)), true);
    assert.equal(cronMatches(q, at(2026, 8, 1, 10, 15)), true);
    assert.equal(cronMatches(q, at(2026, 8, 1, 10, 7)), false);
  });

  test("weekday range matches Mon–Fri only", () => {
    const weekdays = parse("0 9 * * 1-5");
    // 2026-08-03 is a Monday, 2026-08-01 is a Saturday.
    assert.equal(cronMatches(weekdays, at(2026, 8, 3, 9, 0)), true);
    assert.equal(cronMatches(weekdays, at(2026, 8, 1, 9, 0)), false);
  });

  test("classic OR rule: both DOM and DOW restricted matches EITHER", () => {
    // "0 0 13 * 5" = midnight on the 13th, OR any Friday.
    const job = parse("0 0 13 * 5");
    // 2026-08-13 is a Thursday — matches by day-of-month.
    assert.equal(cronMatches(job, at(2026, 8, 13, 0, 0)), true);
    // 2026-08-07 is a Friday — matches by day-of-week.
    assert.equal(cronMatches(job, at(2026, 8, 7, 0, 0)), true);
    // 2026-08-06 is a Thursday, not the 13th — no match.
    assert.equal(cronMatches(job, at(2026, 8, 6, 0, 0)), false);
  });

  test("month restriction is honoured", () => {
    const jan = parse("0 0 1 1 *");
    assert.equal(cronMatches(jan, at(2026, 1, 1, 0, 0)), true);
    assert.equal(cronMatches(jan, at(2026, 2, 1, 0, 0)), false);
  });

  test("Sunday is 0", () => {
    const sun = parse("0 12 * * 0");
    // 2026-08-02 is a Sunday.
    assert.equal(cronMatches(sun, at(2026, 8, 2, 12, 0)), true);
    assert.equal(cronMatches(sun, at(2026, 8, 3, 12, 0)), false);
  });
});

describe("describeCron", () => {
  const cases: Array<[string, string]> = [
    ["* * * * *", "Every minute"],
    ["*/5 * * * *", "Every 5 minutes"],
    ["*/15 * * * *", "Every 15 minutes"],
    ["0 * * * *", "Every hour, at :00"],
    ["30 * * * *", "Every hour, at :30"],
    ["0 */6 * * *", "Every 6 hours (at :00)"],
    ["0 3 * * *", "Every day at 3:00 AM"],
    ["30 14 * * *", "Every day at 2:30 PM"],
    ["0 0 * * *", "Every day at 12:00 AM"],
    ["0 9 * * 1-5", "Every Monday, Tuesday, Wednesday, Thursday, Friday at 9:00 AM"],
    ["0 0 1 * *", "On the 1st of every month at 12:00 AM"],
    ["0 12 15 * *", "On the 15th of every month at 12:00 PM"]
  ];

  for (const [expr, expected] of cases) {
    test(`"${expr}" → "${expected}"`, () => {
      assert.equal(describeCron(parse(expr)), expected);
    });
  }

  test("an exotic schedule falls back to a safe generic description", () => {
    const description = describeCron(parse("7 */3 1,15 * 2"));
    assert.match(description, /custom schedule/i);
  });
});

describe("previewCron", () => {
  test("returns a description for a valid expression", () => {
    assert.deepEqual(previewCron("0 3 * * *"), { ok: true, description: "Every day at 3:00 AM" });
  });

  test("returns the parse error for an invalid one", () => {
    const result = previewCron("99 * * * *");
    assert.equal(result.ok, false);
    assert.match((result as { error: string }).error, /minute/);
  });
});
