import { afterEach, describe, expect, it, vi } from "vitest";
import { checkThreshold, logSink, type MonitoringSink } from "./monitor";

describe("logSink", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("recordEvent logs a structured JSON line via lib/logger.ts, at console.error for alert level", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    logSink.recordEvent({
      name: "test.something_happened",
      level: "alert",
      message: "something happened",
      context: { foo: "bar", n: 42 },
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const line = spy.mock.calls[0][0] as string;
    const entry = JSON.parse(line);
    expect(entry.level).toBe("error");
    expect(entry.monitoringLevel).toBe("alert");
    expect(entry.message).toBe("monitoring.test.something_happened");
    expect(entry.foo).toBe("bar");
    expect(entry.n).toBe(42);
    expect(typeof entry.time).toBe("string");
  });

  it("recordEvent logs at console.log for info level", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    logSink.recordEvent({ name: "test.info_event", level: "info", message: "fine" });

    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledTimes(1);
    const entry = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(entry.level).toBe("info");
    expect(entry.monitoringLevel).toBe("info");
  });

  it("recordEvent logs at console.error for warn level", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    logSink.recordEvent({ name: "test.warn_event", level: "warn", message: "careful" });

    expect(spy).toHaveBeenCalledTimes(1);
    const entry = JSON.parse(spy.mock.calls[0][0] as string);
    expect(entry.level).toBe("warn");
  });

  it("recordMetric logs a structured metric line with value and tags", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    logSink.recordMetric({ name: "test.gauge", value: 7, tags: { region: "us" } });

    expect(spy).toHaveBeenCalledTimes(1);
    const entry = JSON.parse(spy.mock.calls[0][0] as string);
    expect(entry.message).toBe("monitoring.metric.test.gauge");
    expect(entry.value).toBe(7);
    expect(entry.region).toBe("us");
  });

  it("redacts sensitive-looking context keys the same way lib/logger.ts redacts everything else", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    logSink.recordEvent({
      name: "test.secret_event",
      level: "alert",
      message: "leaky?",
      context: { password: "hunter2" },
    });

    const entry = JSON.parse(spy.mock.calls[0][0] as string);
    expect(entry.password).not.toBe("hunter2");
  });
});

describe("checkThreshold", () => {
  function makeSpySink(): { sink: MonitoringSink; recordEvent: ReturnType<typeof vi.fn> } {
    const recordEvent = vi.fn();
    return { sink: { recordEvent, recordMetric: vi.fn() }, recordEvent };
  }

  it("does not emit an alert event when the value stays under the threshold", () => {
    const { sink, recordEvent } = makeSpySink();

    const result = checkThreshold({ name: "test.under", value: 2, threshold: 3, sink });

    expect(result.breached).toBe(false);
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it("does not emit when the value equals the threshold (default comparator is strictly-greater-than)", () => {
    const { sink, recordEvent } = makeSpySink();

    const result = checkThreshold({ name: "test.equal", value: 3, threshold: 3, sink });

    expect(result.breached).toBe(false);
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it("emits a distinct alert-level event when the value crosses the threshold", () => {
    const { sink, recordEvent } = makeSpySink();

    const result = checkThreshold({
      name: "test.over",
      value: 5,
      threshold: 3,
      context: { extra: "context" },
      sink,
    });

    expect(result.breached).toBe(true);
    expect(recordEvent).toHaveBeenCalledTimes(1);
    const event = recordEvent.mock.calls[0][0];
    expect(event.level).toBe("alert");
    expect(event.name).toBe("test.over");
    expect(event.context).toMatchObject({ value: 5, threshold: 3, extra: "context" });
  });

  it("supports a custom comparator", () => {
    const { sink, recordEvent } = makeSpySink();

    const result = checkThreshold({
      name: "test.custom",
      value: 1,
      threshold: 5,
      comparator: (value, threshold) => value < threshold,
      sink,
    });

    expect(result.breached).toBe(true);
    expect(recordEvent).toHaveBeenCalledTimes(1);
  });

  it("defaults to logSink when no sink is passed", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    checkThreshold({ name: "test.default_sink", value: 10, threshold: 1 });

    expect(spy).toHaveBeenCalledTimes(1);
  });
});
