import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  daysAgoStart,
  formatDayMonth,
  formatShortWeekday,
  lastNDayKeys,
  lastNSaoPauloDayKeys,
  localDayKey,
  saoPauloDayKey,
  saoPauloDayStartIso,
  startOfLocalDay,
} from "./date-utils";

describe("startOfLocalDay", () => {
  it("zeroes out the time of a given date", () => {
    const d = new Date("2026-05-18T13:45:22.500");
    const out = startOfLocalDay(d);
    expect(out.getHours()).toBe(0);
    expect(out.getMinutes()).toBe(0);
    expect(out.getSeconds()).toBe(0);
    expect(out.getMilliseconds()).toBe(0);
    expect(out.getFullYear()).toBe(d.getFullYear());
    expect(out.getMonth()).toBe(d.getMonth());
    expect(out.getDate()).toBe(d.getDate());
  });

  it("does not mutate the input", () => {
    const d = new Date("2026-05-18T13:45:22.500");
    const before = d.getTime();
    startOfLocalDay(d);
    expect(d.getTime()).toBe(before);
  });
});

describe("daysAgoStart", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T13:45:22"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns midnight N days before today", () => {
    const out = daysAgoStart(3);
    expect(out.getHours()).toBe(0);
    expect(out.getDate()).toBe(15);
    expect(out.getMonth()).toBe(4); // May
    expect(out.getFullYear()).toBe(2026);
  });

  it("daysAgoStart(0) is today at midnight", () => {
    const out = daysAgoStart(0);
    expect(out.getDate()).toBe(18);
    expect(out.getHours()).toBe(0);
  });

  it("crosses month boundaries cleanly", () => {
    vi.setSystemTime(new Date("2026-05-02T08:00:00"));
    const out = daysAgoStart(5);
    expect(out.getMonth()).toBe(3); // April (0-indexed)
    expect(out.getDate()).toBe(27);
  });
});

describe("localDayKey", () => {
  it("emits YYYY-MM-DD in local components", () => {
    const d = new Date(2026, 0, 9, 23, 59); // Jan 9, locally
    expect(localDayKey(d)).toBe("2026-01-09");
  });

  it("zero-pads month and day", () => {
    const d = new Date(2026, 8, 5); // Sep 5
    expect(localDayKey(d)).toBe("2026-09-05");
  });

  it("accepts ISO strings as input", () => {
    expect(localDayKey("2026-12-31T23:00:00")).toBe("2026-12-31");
  });
});

describe("lastNDayKeys", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T08:30:00"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns n consecutive chronological keys ending today", () => {
    expect(lastNDayKeys(3)).toEqual(["2026-05-16", "2026-05-17", "2026-05-18"]);
  });

  it("returns just today for n=1", () => {
    expect(lastNDayKeys(1)).toEqual(["2026-05-18"]);
  });

  it("rolls back across a month boundary", () => {
    vi.setSystemTime(new Date("2026-05-02T08:00:00"));
    expect(lastNDayKeys(4)).toEqual([
      "2026-04-29",
      "2026-04-30",
      "2026-05-01",
      "2026-05-02",
    ]);
  });
});

describe("America/Sao_Paulo dashboard helpers", () => {
  it("buckets late-evening Sao Paulo timestamps into the SP calendar day rather than next UTC day", () => {
    // 2026-11-22 22:30 BRT (-03:00) == 2026-11-23 01:30:00Z
    expect(saoPauloDayKey("2026-11-23T01:30:00.000Z")).toBe("2026-11-22");
    // 2026-11-23 00:05 BRT (-03:00) == 2026-11-23 03:05:00Z
    expect(saoPauloDayKey("2026-11-23T03:05:00.000Z")).toBe("2026-11-23");
  });

  it("computes consecutive Sao Paulo day keys across month boundaries", () => {
    const now = new Date("2026-05-02T01:00:00.000Z"); // 2026-05-01 22:00 BRT
    expect(lastNSaoPauloDayKeys(3, now)).toEqual([
      "2026-04-29",
      "2026-04-30",
      "2026-05-01",
    ]);
  });

  it("computes exact UTC ISO start for a Sao Paulo calendar day", () => {
    expect(saoPauloDayStartIso("2026-11-22")).toBe("2026-11-22T03:00:00.000Z");
  });

  it("formats weekday and dd/MM labels cleanly", () => {
    expect(formatShortWeekday("2026-11-23", "pt-BR")).toBe("Seg");
    expect(formatShortWeekday("2026-11-22", "pt-BR")).toBe("Dom");
    expect(formatDayMonth("2026-11-22")).toBe("22/11");
  });
});
