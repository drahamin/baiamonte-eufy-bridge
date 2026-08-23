import { jest, describe, it, expect } from "@jest/globals";

const { dumpStation } = await import("../state.js");

// PropertyName string values used by station state
const PropertyName = {
  Name: "name",
  Model: "model",
  SerialNumber: "serialNumber",
  HardwareVersion: "hardwareVersion",
  SoftwareVersion: "softwareVersion",
  StationLANIpAddress: "lanIpAddress",
  StationMacAddress: "macAddress",
  StationCurrentMode: "currentMode",
  StationGuardMode: "guardMode",
  Type: "type",
  StationTimeFormat: "timeFormat",
  StationAlarmVolume: "alarmVolume",
  StationAlarmTone: "alarmTone",
  StationPromptVolume: "promptVolume",
  StationNotificationSwitchModeSchedule: "notificationSwitchModeSchedule",
  StationNotificationSwitchModeGeofence: "notificationSwitchModeGeofence",
  StationNotificationSwitchModeApp: "notificationSwitchModeApp",
  StationNotificationSwitchModeKeypad: "notificationSwitchModeKeypad",
  StationNotificationStartAlarmDelay: "notificationStartAlarmDelay",
  StationSwitchModeWithAccessCode: "switchModeWithAccessCode",
  StationAutoEndAlarm: "autoEndAlarm",
  StationTurnOffAlarmWithButton: "turnOffAlarmWithButton",
} as const;

const defaultPropertyValues: Record<string, unknown> = {
  [PropertyName.Name]: "Home Base",
  [PropertyName.Model]: "T8010",
  [PropertyName.SerialNumber]: "T8010ABC1234",
  [PropertyName.HardwareVersion]: "2.2",
  [PropertyName.SoftwareVersion]: "2.1.7.6",
  [PropertyName.StationLANIpAddress]: "192.168.1.100",
  [PropertyName.StationMacAddress]: "AA:BB:CC:DD:EE:FF",
  [PropertyName.StationCurrentMode]: 1,
  [PropertyName.StationGuardMode]: 2,
  [PropertyName.Type]: 0,
  [PropertyName.StationTimeFormat]: 0,
  [PropertyName.StationAlarmVolume]: 80,
  [PropertyName.StationAlarmTone]: 1,
  [PropertyName.StationPromptVolume]: 60,
  [PropertyName.StationNotificationSwitchModeSchedule]: true,
  [PropertyName.StationNotificationSwitchModeGeofence]: false,
  [PropertyName.StationNotificationSwitchModeApp]: true,
  [PropertyName.StationNotificationSwitchModeKeypad]: false,
  [PropertyName.StationNotificationStartAlarmDelay]: true,
  [PropertyName.StationSwitchModeWithAccessCode]: true,
  [PropertyName.StationAutoEndAlarm]: false,
  [PropertyName.StationTurnOffAlarmWithButton]: true,
};

function createMockStation(overrides: Record<string, unknown> = {}) {
  const values = { ...defaultPropertyValues, ...overrides };
  return {
    getPropertyValue: jest.fn((prop: string) => values[prop]),
    isConnected: jest.fn().mockReturnValue(true),
  } as any;
}

describe("dumpStation", () => {
  describe("schema 0", () => {
    it("returns base fields only", () => {
      const station = createMockStation();
      const result = dumpStation(station, 0);

      expect(result).toEqual({
        name: "Home Base",
        model: "T8010",
        serialNumber: "T8010ABC1234",
        hardwareVersion: "2.2",
        softwareVersion: "2.1.7.6",
        lanIpAddress: "192.168.1.100",
        macAddress: "AA:BB:CC:DD:EE:FF",
        currentMode: 1,
        guardMode: 2,
        connected: true,
      });
    });

    it("does not include type field", () => {
      const station = createMockStation();
      const result = dumpStation(station, 0);
      expect(result).not.toHaveProperty("type");
    });

    it("reflects disconnected state", () => {
      const station = createMockStation();
      station.isConnected.mockReturnValue(false);
      const result = dumpStation(station, 0);
      expect(result).toHaveProperty("connected", false);
    });
  });

  describe("schema 1-2", () => {
    it("adds type field", () => {
      const station = createMockStation();
      const result = dumpStation(station, 1);

      expect(result).toHaveProperty("type", 0);
      expect(result).toHaveProperty("name", "Home Base");
    });

    it("does not include schema 3 fields", () => {
      const station = createMockStation();
      const result = dumpStation(station, 2);

      expect(result).not.toHaveProperty("timeFormat");
      expect(result).not.toHaveProperty("alarmVolume");
      expect(result).not.toHaveProperty("alarmTone");
    });
  });

  describe("schema 3-4", () => {
    it("includes notification and alarm fields", () => {
      const station = createMockStation();
      const result = dumpStation(station, 3);

      expect(result).toHaveProperty("type", 0);
      expect(result).toHaveProperty("timeFormat", 0);
      expect(result).toHaveProperty("alarmVolume", 80);
      expect(result).toHaveProperty("alarmTone", 1);
      expect(result).toHaveProperty("promptVolume", 60);
      expect(result).toHaveProperty(
        "notificationSwitchModeSchedule",
        true,
      );
      expect(result).toHaveProperty(
        "notificationSwitchModeGeofence",
        false,
      );
      expect(result).toHaveProperty("notificationSwitchModeApp", true);
      expect(result).toHaveProperty(
        "notificationSwitchModeKeypad",
        false,
      );
      expect(result).toHaveProperty("notificationStartAlarmDelay", true);
    });

    it("does not include schema 5 fields", () => {
      const station = createMockStation();
      const result = dumpStation(station, 4);

      expect(result).not.toHaveProperty("switchModeWithAccessCode");
      expect(result).not.toHaveProperty("autoEndAlarm");
      expect(result).not.toHaveProperty("turnOffAlarmWithButton");
    });
  });

  describe("schema >= 5", () => {
    it("includes all fields", () => {
      const station = createMockStation();
      const result = dumpStation(station, 5);

      expect(result).toHaveProperty("name", "Home Base");
      expect(result).toHaveProperty("type", 0);
      expect(result).toHaveProperty("timeFormat", 0);
      expect(result).toHaveProperty("switchModeWithAccessCode", true);
      expect(result).toHaveProperty("autoEndAlarm", false);
      expect(result).toHaveProperty("turnOffAlarmWithButton", true);
    });

    it("works for high schema versions", () => {
      const station = createMockStation();
      const result = dumpStation(station, 21);

      expect(result).toHaveProperty("switchModeWithAccessCode");
      expect(result).toHaveProperty("autoEndAlarm");
      expect(result).toHaveProperty("turnOffAlarmWithButton");
      expect(result).toHaveProperty("type");
      expect(result).toHaveProperty("alarmVolume");
    });
  });

  describe("property values", () => {
    it("passes correct PropertyName values to getPropertyValue", () => {
      const station = createMockStation();
      dumpStation(station, 5);

      expect(station.getPropertyValue).toHaveBeenCalledWith("name");
      expect(station.getPropertyValue).toHaveBeenCalledWith("model");
      expect(station.getPropertyValue).toHaveBeenCalledWith("serialNumber");
      expect(station.getPropertyValue).toHaveBeenCalledWith("lanIpAddress");
      expect(station.getPropertyValue).toHaveBeenCalledWith("macAddress");
      expect(station.getPropertyValue).toHaveBeenCalledWith("currentMode");
      expect(station.getPropertyValue).toHaveBeenCalledWith("guardMode");
      expect(station.getPropertyValue).toHaveBeenCalledWith("type");
      expect(station.getPropertyValue).toHaveBeenCalledWith("alarmVolume");
      expect(station.getPropertyValue).toHaveBeenCalledWith(
        "switchModeWithAccessCode",
      );
    });

    it("uses custom property values", () => {
      const station = createMockStation({
        [PropertyName.Name]: "Garage Base",
        [PropertyName.StationCurrentMode]: 3,
        [PropertyName.StationGuardMode]: 0,
      });
      const result = dumpStation(station, 0);

      expect(result).toHaveProperty("name", "Garage Base");
      expect(result).toHaveProperty("currentMode", 3);
      expect(result).toHaveProperty("guardMode", 0);
    });
  });

  describe("schema boundary checks", () => {
    it.each([0])(
      "schema %i excludes type",
      (schema) => {
        const result = dumpStation(createMockStation(), schema);
        expect(result).not.toHaveProperty("type");
      },
    );

    it.each([1, 2])(
      "schema %i includes type but excludes timeFormat",
      (schema) => {
        const result = dumpStation(createMockStation(), schema);
        expect(result).toHaveProperty("type");
        expect(result).not.toHaveProperty("timeFormat");
      },
    );

    it.each([3, 4])(
      "schema %i includes timeFormat but excludes switchModeWithAccessCode",
      (schema) => {
        const result = dumpStation(createMockStation(), schema);
        expect(result).toHaveProperty("timeFormat");
        expect(result).not.toHaveProperty("switchModeWithAccessCode");
      },
    );

    it.each([5, 6, 9, 13, 21])(
      "schema %i includes switchModeWithAccessCode",
      (schema) => {
        const result = dumpStation(createMockStation(), schema);
        expect(result).toHaveProperty("switchModeWithAccessCode");
      },
    );
  });
});