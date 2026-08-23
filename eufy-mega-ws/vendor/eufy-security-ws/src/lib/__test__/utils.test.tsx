import { jest, describe, it, expect } from "@jest/globals";
import { EventEmitter } from "events";
import { inspect } from "util";

const { convertCamelCaseToSnakeCase, waitForEvent, initializeInspectStyles } =
  await import("../utils.js");

describe("convertCamelCaseToSnakeCase", () => {
  it("converts simple camelCase to snake_case", () => {
    expect(convertCamelCaseToSnakeCase("panAndTilt")).toBe("pan_and_tilt");
  });

  it("lowercases leading uppercase letter", () => {
    expect(convertCamelCaseToSnakeCase("PanAndTilt")).toBe("pan_and_tilt");
  });

  it("returns empty string for undefined", () => {
    expect(convertCamelCaseToSnakeCase(undefined as unknown as string)).toBe(
      "",
    );
  });

  it("returns the same string when already snake_case", () => {
    expect(convertCamelCaseToSnakeCase("already_snake")).toBe("already_snake");
  });

  it("returns the same string when all lowercase", () => {
    expect(convertCamelCaseToSnakeCase("lowercase")).toBe("lowercase");
  });

  it("handles single word", () => {
    expect(convertCamelCaseToSnakeCase("open")).toBe("open");
  });

  it("handles multiple consecutive conversions", () => {
    expect(convertCamelCaseToSnakeCase("setAutoNightVision")).toBe(
      "set_auto_night_vision",
    );
  });

  it("handles empty string", () => {
    expect(convertCamelCaseToSnakeCase("")).toBe("");
  });

  it("handles single uppercase letter", () => {
    expect(convertCamelCaseToSnakeCase("A")).toBe("a");
  });

  it("handles string with numbers", () => {
    expect(convertCamelCaseToSnakeCase("device2Name")).toBe("device2_name");
  });
});

describe("waitForEvent", () => {
  it("resolves when the event is emitted", async () => {
    const emitter = new EventEmitter();
    const promise = waitForEvent<string>(emitter, "data");

    emitter.emit("data", "hello");

    await expect(promise).resolves.toBe("hello");
  });

  it("rejects when error event is emitted", async () => {
    const emitter = new EventEmitter();
    const promise = waitForEvent(emitter, "data");
    const error = new Error("something went wrong");

    emitter.emit("error", error);

    await expect(promise).rejects.toThrow("something went wrong");
  });

  it("removes error listener after success", async () => {
    const emitter = new EventEmitter();
    const promise = waitForEvent(emitter, "data");

    emitter.emit("data", "value");
    await promise;

    expect(emitter.listenerCount("error")).toBe(0);
  });

  it("removes event listener after error", async () => {
    const emitter = new EventEmitter();
    const promise = waitForEvent(emitter, "data");

    emitter.emit("error", new Error("fail"));
    await promise.catch(() => {});

    expect(emitter.listenerCount("data")).toBe(0);
  });

  it("rejects with timeout when timeout is provided and event not emitted", async () => {
    const emitter = new EventEmitter();
    const promise = waitForEvent(emitter, "data", 50);

    await expect(promise).rejects.toThrow("Timeout reached");
  });

  it("cleans up listeners after timeout", async () => {
    const emitter = new EventEmitter();
    const promise = waitForEvent(emitter, "data", 50);

    await promise.catch(() => {});

    expect(emitter.listenerCount("data")).toBe(0);
    expect(emitter.listenerCount("error")).toBe(0);
  });

  it("resolves before timeout if event fires in time", async () => {
    jest.useFakeTimers();
    try {
      const emitter = new EventEmitter();
      const promise = waitForEvent<number>(emitter, "data", 5000);

      emitter.emit("data", 42);
      jest.runAllTimers();

      await expect(promise).resolves.toBe(42);
    } finally {
      jest.useRealTimers();
    }
  });

  it("does not timeout when no timeout is provided", async () => {
    const emitter = new EventEmitter();
    const promise = waitForEvent<string>(emitter, "done");

    // Emit after a short delay to prove it waits
    setTimeout(() => emitter.emit("done", "ok"), 20);

    await expect(promise).resolves.toBe("ok");
  });
});

describe("initializeInspectStyles", () => {
  it("sets all expected inspect styles", () => {
    initializeInspectStyles();

    expect(inspect.styles.special).toBe("cyan");
    expect(inspect.styles.number).toBe("green");
    expect(inspect.styles.bigint).toBe("green");
    expect(inspect.styles.boolean).toBe("yellow");
    expect(inspect.styles.undefined).toBe("grey");
    expect(inspect.styles.null).toBe("bold");
    expect(inspect.styles.string).toBe("red");
    expect(inspect.styles.symbol).toBe("green");
    expect(inspect.styles.date).toBe("magenta");
    expect(inspect.styles.regexp).toBe("red");
    expect(inspect.styles.module).toBe("underline");
  });
});