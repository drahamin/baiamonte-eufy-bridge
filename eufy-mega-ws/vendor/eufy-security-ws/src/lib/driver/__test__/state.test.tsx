import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const { dumpDriver } = await import("../state.js");

function createMockDriver(
  overrides: {
    version?: string;
    connected?: boolean;
    pushConnected?: boolean;
    mqttConnected?: boolean;
  } = {},
) {
  return {
    getVersion: jest.fn().mockReturnValue(overrides.version ?? "2.0.0"),
    isConnected: jest.fn().mockReturnValue(overrides.connected ?? true),
    isPushConnected: jest
      .fn()
      .mockReturnValue(overrides.pushConnected ?? true),
    isMQTTConnected: jest
      .fn()
      .mockReturnValue(overrides.mqttConnected ?? false),
  } as any;
}

describe("dumpDriver", () => {
  it("returns version, connected, and pushConnected for schema <= 8", () => {
    const driver = createMockDriver({
      version: "1.5.0",
      connected: true,
      pushConnected: false,
    });

    const result = dumpDriver(driver, 8);

    expect(result).toEqual({
      version: "1.5.0",
      connected: true,
      pushConnected: false,
    });
    expect(driver.isMQTTConnected).not.toHaveBeenCalled();
  });

  it("does not include mqttConnected for schema <= 8", () => {
    const driver = createMockDriver();
    const result = dumpDriver(driver, 1);

    expect(result).not.toHaveProperty("mqttConnected");
  });

  it("includes mqttConnected for schema >= 9", () => {
    const driver = createMockDriver({ mqttConnected: true });

    const result = dumpDriver(driver, 9);

    expect(result).toEqual({
      version: "2.0.0",
      connected: true,
      pushConnected: true,
      mqttConnected: true,
    });
    expect(driver.isMQTTConnected).toHaveBeenCalled();
  });

  it("includes mqttConnected for high schema versions", () => {
    const driver = createMockDriver({ mqttConnected: false });

    const result = dumpDriver(driver, 21);

    expect(result).toEqual({
      version: "2.0.0",
      connected: true,
      pushConnected: true,
      mqttConnected: false,
    });
  });

  it("returns all false when driver is disconnected", () => {
    const driver = createMockDriver({
      connected: false,
      pushConnected: false,
      mqttConnected: false,
    });

    const result = dumpDriver(driver, 13);

    expect(result).toEqual({
      version: "2.0.0",
      connected: false,
      pushConnected: false,
      mqttConnected: false,
    });
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])(
    "schema %i does not include mqttConnected",
    (schema) => {
      const driver = createMockDriver();
      const result = dumpDriver(driver, schema);
      expect(result).not.toHaveProperty("mqttConnected");
    },
  );

  it.each([9, 10, 11, 12, 13, 20, 21])(
    "schema %i includes mqttConnected",
    (schema) => {
      const driver = createMockDriver();
      const result = dumpDriver(driver, schema);
      expect(result).toHaveProperty("mqttConnected");
    },
  );
});