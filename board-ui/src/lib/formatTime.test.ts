import { describe, expect, it } from "vitest";
import { formatWhen, formatWhenShort, localDay } from "./formatTime";

const now = new Date(2026, 10, 12, 18, 0);

describe("formatWhen", () => {
  it("formatWhen_today_reads_Today_HH_MM", () => {
    expect(formatWhen(new Date(2026, 10, 12, 10, 42).toISOString(), now)).toBe("Today 10:42");
  });

  it("formatWhen_yesterday_reads_Yesterday_HH_MM", () => {
    expect(formatWhen(new Date(2026, 10, 11, 17, 5).toISOString(), now)).toBe("Yesterday 17:05");
  });

  it("formatWhen_older_reads_day_month_time", () => {
    expect(formatWhen(new Date(2026, 10, 10, 9, 3).toISOString(), now)).toBe("10 Nov 09:03");
    expect(formatWhen(new Date(2026, 0, 2, 23, 59).toISOString(), now)).toBe("2 Jan 23:59");
  });

  it("formatWhen_yesterday_across_a_month_boundary", () => {
    expect(formatWhen(new Date(2026, 10, 30, 22, 0).toISOString(), new Date(2026, 11, 1, 8, 0))).toBe("Yesterday 22:00");
  });

  it("formatWhen_unparseable_is_shown_as_given", () => {
    expect(formatWhen("nope", now)).toBe("nope");
  });
});

describe("formatWhenShort", () => {
  it("formatWhenShort_today_reads_HH_MM", () => {
    expect(formatWhenShort(new Date(2026, 10, 12, 10, 42).toISOString(), now)).toBe("10:42");
  });

  it("formatWhenShort_yesterday_reads_Yesterday_HH_MM", () => {
    expect(formatWhenShort(new Date(2026, 10, 11, 17, 5).toISOString(), now)).toBe("Yesterday 17:05");
  });

  it("formatWhenShort_older_reads_day_month_time", () => {
    expect(formatWhenShort(new Date(2026, 10, 10, 9, 3).toISOString(), now)).toBe("10 Nov 09:03");
  });

  it("formatWhenShort_unparseable_is_shown_as_given", () => {
    expect(formatWhenShort("nope", now)).toBe("nope");
  });
});

describe("localDay", () => {
  it("localDay_reads_the_local_calendar_date", () => {
    expect(localDay(new Date(2026, 0, 5, 23, 30))).toBe("2026-01-05");
  });
});
