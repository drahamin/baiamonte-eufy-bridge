import { getLoggingLevel, setLoggingLevel, LoggingCategories, InternalLogger, rootMainLogger } from "../logging";
import { LogLevel } from "typescript-logging";

describe("Logging index file", () => {
  afterEach(() => {
    setLoggingLevel("all", LogLevel.Off);
  });

  test("Set all logger to be Debug and assert it is set", () => {
    setLoggingLevel("all", LogLevel.Debug);
    const logger = getLoggingLevel("all");
    expect(logger).toBe(LogLevel.Debug);
  });

  test("Set all to Debug and mqtt to be info", () => {
    setLoggingLevel("all", LogLevel.Debug);
    setLoggingLevel("mqtt", LogLevel.Info);
    const loggerAll = getLoggingLevel("all");
    expect(loggerAll).toBe(LogLevel.Debug);

    const loggerMQTT = getLoggingLevel("mqtt");
    expect(loggerMQTT).toBe(LogLevel.Info);
  });

  test.each(["main", "http", "p2p", "push", "mqtt"] as LoggingCategories[])(
    "Set %s category independently",
    (category) => {
      setLoggingLevel(category, LogLevel.Warn);
      expect(getLoggingLevel(category)).toBe(LogLevel.Warn);
    }
  );

  test("Default level should be Off", () => {
    expect(getLoggingLevel("all")).toBe(LogLevel.Off);
  });

  test("setLoggingLevel defaults to all/Off when called with no args", () => {
    setLoggingLevel("all", LogLevel.Debug);
    setLoggingLevel();
    expect(getLoggingLevel("all")).toBe(LogLevel.Off);
  });

  test("Category level overrides global level", () => {
    setLoggingLevel("all", LogLevel.Error);
    setLoggingLevel("p2p", LogLevel.Trace);

    expect(getLoggingLevel("all")).toBe(LogLevel.Error);
    expect(getLoggingLevel("p2p")).toBe(LogLevel.Trace);
  });

  test("Setting all level resets individually set categories", () => {
    setLoggingLevel("http", LogLevel.Fatal);
    setLoggingLevel("all", LogLevel.Debug);

    // Setting "all" overrides individual category levels
    expect(getLoggingLevel("http")).toBe(LogLevel.Debug);
  });

  test("Can cycle through all log levels", () => {
    const levels = [
      LogLevel.Trace,
      LogLevel.Debug,
      LogLevel.Info,
      LogLevel.Warn,
      LogLevel.Error,
      LogLevel.Fatal,
      LogLevel.Off,
    ];
    for (const level of levels) {
      setLoggingLevel("main", level);
      expect(getLoggingLevel("main")).toBe(level);
    }
  });

  test("Redacts identifiers and sensitive structured log fields", () => {
    const error = jest.fn();
    InternalLogger.logger = {
      trace: jest.fn(),
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error,
    };
    setLoggingLevel("all", LogLevel.Error);

    rootMainLogger.error("station T123456789012 at 192.168.1.20 fid cabcdefghijklmnopqrstu", {
      stationSN: "T123456789012",
      fid: "cabcdefghijklmnopqrstu",
      payload: "secret",
      count: 2,
    });

    expect(error).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(error.mock.calls[0]);
    expect(serialized).not.toContain("T123456789012");
    expect(serialized).not.toContain("192.168.1.20");
    expect(serialized).not.toContain("cabcdefghijklmnopqrstu");
    expect(serialized).not.toContain("secret");
    expect(serialized).toContain("[redacted]");
    InternalLogger.logger = undefined;
  });
});
