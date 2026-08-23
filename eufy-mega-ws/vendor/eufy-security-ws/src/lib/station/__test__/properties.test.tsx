import { jest, describe, it, expect } from "@jest/globals";

const { dumpStationProperties, dumpStationPropertiesMetadata } = await import(
  "../properties.js"
);

// PropertyName string values used by station properties
const PN = {
  Name: "name",
  Model: "model",
  SerialNumber: "serialNumber",
  HardwareVersion: "hardwareVersion",
  SoftwareVersion: "softwareVersion",
  Type: "type",
  StationLANIpAddress: "lanIpAddress",
  StationMacAddress: "macAddress",
  StationGuardMode: "guardMode",
  StationCurrentMode: "currentMode",
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
  StationHomeSecuritySettings: "hidden-stationHomeSecuritySettings",
  StationAwaySecuritySettings: "hidden-stationAwaySecuritySettings",
  StationCustom1SecuritySettings: "hidden-stationCustom1SecuritySettings",
  StationCustom2SecuritySettings: "hidden-stationCustom2SecuritySettings",
  StationCustom3SecuritySettings: "hidden-stationCustom3SecuritySettings",
  StationOffSecuritySettings: "hidden-stationOffSecuritySettings",
  // Schema 1 (schema > 13)
  StationAlarm: "alarm",
  StationAlarmType: "alarmType",
  StationAlarmArmed: "alarmArmed",
  StationAlarmArmDelay: "alarmArmDelay",
  StationAlarmDelay: "alarmDelay",
  StationAlarmDelayType: "alarmDelayType",
  // Schema 2 (schema >= 21)
  StationStorageInfoEmmc: "storageInfoEmmc",
  StationStorageInfoHdd: "storageInfoHdd",
  StationCrossCameraTracking: "crossCameraTracking",
  StationContinuousTrackingTime: "continuousTrackingTime",
  StationTrackingAssistance: "trackingAssistance",
  StationCrossTrackingCameraList: "crossTrackingCameraList",
  StationCrossTrackingGroupList: "crossTrackingGroupList",
} as const;

// Default property values for getPropertyValue mock
const defaultPropertyValues: Record<string, unknown> = {
  [PN.Name]: "Home Base",
  [PN.Model]: "T8010",
  [PN.SerialNumber]: "T8010ABC1234",
  [PN.HardwareVersion]: "2.2",
  [PN.SoftwareVersion]: "2.1.7.6",
  [PN.Type]: 0,
  [PN.StationLANIpAddress]: "192.168.1.100",
  [PN.StationMacAddress]: "AA:BB:CC:DD:EE:FF",
  [PN.StationGuardMode]: 2,
  [PN.StationCurrentMode]: 1,
  [PN.StationTimeFormat]: 0,
  [PN.StationAlarmVolume]: 80,
  [PN.StationAlarmTone]: 1,
  [PN.StationPromptVolume]: 60,
  [PN.StationNotificationSwitchModeSchedule]: true,
  [PN.StationNotificationSwitchModeGeofence]: false,
  [PN.StationNotificationSwitchModeApp]: true,
  [PN.StationNotificationSwitchModeKeypad]: false,
  [PN.StationNotificationStartAlarmDelay]: true,
  [PN.StationSwitchModeWithAccessCode]: true,
  [PN.StationAutoEndAlarm]: false,
  [PN.StationTurnOffAlarmWithButton]: true,
  [PN.StationHomeSecuritySettings]: '{"mode":1}',
  [PN.StationAwaySecuritySettings]: '{"mode":2}',
  [PN.StationCustom1SecuritySettings]: '{"mode":3}',
  [PN.StationCustom2SecuritySettings]: '{"mode":4}',
  [PN.StationCustom3SecuritySettings]: '{"mode":5}',
  [PN.StationOffSecuritySettings]: '{"mode":0}',
  [PN.StationAlarm]: true,
  [PN.StationAlarmType]: 2,
  [PN.StationAlarmArmed]: true,
  [PN.StationAlarmArmDelay]: 30,
  [PN.StationAlarmDelay]: 10,
  [PN.StationAlarmDelayType]: 1,
  [PN.StationStorageInfoEmmc]: { size: 1024 },
  [PN.StationStorageInfoHdd]: { size: 4096 },
  [PN.StationCrossCameraTracking]: true,
  [PN.StationContinuousTrackingTime]: 60,
  [PN.StationTrackingAssistance]: false,
  [PN.StationCrossTrackingCameraList]: { cameras: [] },
  [PN.StationCrossTrackingGroupList]: { groups: [] },
};

// Default metadata entries for getPropertiesMetadata mock
const defaultMetadataValues: Record<string, object> = {};
for (const [, propName] of Object.entries(PN)) {
  defaultMetadataValues[propName] = {
    key: propName,
    type: "string",
    label: propName,
  };
}

function createMockStation() {
  const values = { ...defaultPropertyValues };
  return {
    getPropertyValue: jest.fn((prop: string) => values[prop]),
    getPropertiesMetadata: jest
      .fn()
      .mockReturnValue({ ...defaultMetadataValues }),
  } as any;
}

// --- dumpStationProperties ---

describe("dumpStationProperties", () => {
  const baseKeys = [
    "name",
    "model",
    "serialNumber",
    "hardwareVersion",
    "softwareVersion",
    "type",
    "lanIpAddress",
    "macAddress",
    "guardMode",
    "currentMode",
    "timeFormat",
    "alarmVolume",
    "alarmTone",
    "promptVolume",
    "notificationSwitchModeSchedule",
    "notificationSwitchModeGeofence",
    "notificationSwitchModeApp",
    "notificationSwitchModeKeypad",
    "notificationStartAlarmDelay",
    "switchModeWithAccessCode",
    "autoEndAlarm",
    "turnOffAlarmWithButton",
    "stationHomeSecuritySettings",
    "stationAwaySecuritySettings",
    "stationCustom1SecuritySettings",
    "stationCustom2SecuritySettings",
    "stationCustom3SecuritySettings",
    "stationOffSecuritySettings",
  ];

  const schema1Keys = [
    "alarm",
    "alarmType",
    "alarmArmed",
    "alarmArmDelay",
    "alarmDelay",
    "alarmDelayType",
  ];

  const schema2Keys = [
    "storageInfoEmmc",
    "storageInfoHdd",
    "crossCameraTracking",
    "continuousTrackingTime",
    "trackingAssistance",
    "crossTrackingCameraList",
    "crossTrackingGroupList",
  ];

  describe("schema <= 13", () => {
    it("returns base fields with correct values", () => {
      const station = createMockStation();
      const result = dumpStationProperties(station, 13);

      expect(result).toHaveProperty("name", "Home Base");
      expect(result).toHaveProperty("model", "T8010");
      expect(result).toHaveProperty("serialNumber", "T8010ABC1234");
      expect(result).toHaveProperty("type", 0);
      expect(result).toHaveProperty("guardMode", 2);
      expect(result).toHaveProperty("currentMode", 1);
      expect(result).toHaveProperty("alarmVolume", 80);
      expect(result).toHaveProperty("switchModeWithAccessCode", true);
      expect(result).toHaveProperty(
        "stationHomeSecuritySettings",
        '{"mode":1}',
      );
    });

    it("contains all base keys", () => {
      const station = createMockStation();
      const result = dumpStationProperties(station, 13);

      for (const key of baseKeys) {
        expect(result).toHaveProperty(key);
      }
    });

    it("excludes schema 1 alarm fields", () => {
      const station = createMockStation();
      const result = dumpStationProperties(station, 13);

      for (const key of schema1Keys) {
        expect(result).not.toHaveProperty(key);
      }
    });

    it("excludes schema 2 storage/tracking fields", () => {
      const station = createMockStation();
      const result = dumpStationProperties(station, 13);

      for (const key of schema2Keys) {
        expect(result).not.toHaveProperty(key);
      }
    });

    it.each([1, 5, 10, 13])(
      "schema %i returns only base fields",
      (schema) => {
        const station = createMockStation();
        const result = dumpStationProperties(station, schema);

        for (const key of baseKeys) {
          expect(result).toHaveProperty(key);
        }
        for (const key of schema1Keys) {
          expect(result).not.toHaveProperty(key);
        }
      },
    );
  });

  describe("schema 14-20", () => {
    it("includes alarm fields", () => {
      const station = createMockStation();
      const result = dumpStationProperties(station, 14);

      expect(result).toHaveProperty("alarm", true);
      expect(result).toHaveProperty("alarmType", 2);
      expect(result).toHaveProperty("alarmArmed", true);
      expect(result).toHaveProperty("alarmArmDelay", 30);
      expect(result).toHaveProperty("alarmDelay", 10);
      expect(result).toHaveProperty("alarmDelayType", 1);
    });

    it("still includes base fields", () => {
      const station = createMockStation();
      const result = dumpStationProperties(station, 14);

      for (const key of baseKeys) {
        expect(result).toHaveProperty(key);
      }
    });

    it("excludes schema 2 storage/tracking fields", () => {
      const station = createMockStation();
      const result = dumpStationProperties(station, 20);

      for (const key of schema2Keys) {
        expect(result).not.toHaveProperty(key);
      }
    });
  });

  describe("schema >= 21", () => {
    it("includes storage and tracking fields", () => {
      const station = createMockStation();
      const result = dumpStationProperties(station, 21);

      expect(result).toHaveProperty("storageInfoEmmc", { size: 1024 });
      expect(result).toHaveProperty("storageInfoHdd", { size: 4096 });
      expect(result).toHaveProperty("crossCameraTracking", true);
      expect(result).toHaveProperty("continuousTrackingTime", 60);
      expect(result).toHaveProperty("trackingAssistance", false);
      expect(result).toHaveProperty("crossTrackingCameraList", {
        cameras: [],
      });
      expect(result).toHaveProperty("crossTrackingGroupList", { groups: [] });
    });

    it("includes all fields from all schemas", () => {
      const station = createMockStation();
      const result = dumpStationProperties(station, 21);

      for (const key of [...baseKeys, ...schema1Keys, ...schema2Keys]) {
        expect(result).toHaveProperty(key);
      }
    });

    it("works for high schema version", () => {
      const station = createMockStation();
      const result = dumpStationProperties(station, 30);

      for (const key of [...baseKeys, ...schema1Keys, ...schema2Keys]) {
        expect(result).toHaveProperty(key);
      }
    });
  });

  describe("boundary checks", () => {
    it.each([13, 10, 1])("schema %i excludes alarm fields", (schema) => {
      const result = dumpStationProperties(createMockStation(), schema);
      expect(result).not.toHaveProperty("alarm");
    });

    it.each([14, 15, 20])(
      "schema %i includes alarm but excludes storage",
      (schema) => {
        const result = dumpStationProperties(createMockStation(), schema);
        expect(result).toHaveProperty("alarm");
        expect(result).not.toHaveProperty("storageInfoEmmc");
      },
    );

    it.each([21, 25, 30])(
      "schema %i includes storage fields",
      (schema) => {
        const result = dumpStationProperties(createMockStation(), schema);
        expect(result).toHaveProperty("storageInfoEmmc");
        expect(result).toHaveProperty("crossCameraTracking");
      },
    );
  });
});

// --- dumpStationPropertiesMetadata ---

describe("dumpStationPropertiesMetadata", () => {
  const baseMetaKeys = [
    "name",
    "model",
    "serialNumber",
    "hardwareVersion",
    "softwareVersion",
    "type",
    "lanIpAddress",
    "macAddress",
    "guardMode",
    "currentMode",
    "timeFormat",
    "alarmVolume",
    "alarmTone",
    "promptVolume",
    "notificationSwitchModeSchedule",
    "notificationSwitchModeGeofence",
    "notificationSwitchModeApp",
    "notificationSwitchModeKeypad",
    "notificationStartAlarmDelay",
    "switchModeWithAccessCode",
    "autoEndAlarm",
    "turnOffAlarmWithButton",
    "homeSecuritySettings",
    "awaySecuritySettings",
    "custom1SecuritySettings",
    "custom2SecuritySettings",
    "custom3SecuritySettings",
    "offSecuritySettings",
  ];

  const schema1MetaKeys = [
    "alarm",
    "alarmType",
    "alarmArmed",
    "alarmArmDelay",
    "alarmDelay",
    "alarmDelayType",
  ];

  const schema2MetaKeys = [
    "storageInfoEmmc",
    "storageInfoHdd",
    "crossCameraTracking",
    "continuousTrackingTime",
    "trackingAssistance",
    "crossTrackingCameraList",
    "crossTrackingGroupList",
  ];

  describe("schema <= 13", () => {
    it("returns base metadata keys", () => {
      const station = createMockStation();
      const result = dumpStationPropertiesMetadata(station, 13);

      for (const key of baseMetaKeys) {
        expect(result).toHaveProperty(key);
      }
    });

    it("calls getPropertiesMetadata with true", () => {
      const station = createMockStation();
      dumpStationPropertiesMetadata(station, 13);

      expect(station.getPropertiesMetadata).toHaveBeenCalledWith(true);
    });

    it("excludes alarm metadata keys", () => {
      const station = createMockStation();
      const result = dumpStationPropertiesMetadata(station, 13);

      for (const key of schema1MetaKeys) {
        expect(result).not.toHaveProperty(key);
      }
    });

    it("excludes storage/tracking metadata keys", () => {
      const station = createMockStation();
      const result = dumpStationPropertiesMetadata(station, 13);

      for (const key of schema2MetaKeys) {
        expect(result).not.toHaveProperty(key);
      }
    });

    it("maps metadata values from property names", () => {
      const station = createMockStation();
      const result = dumpStationPropertiesMetadata(station, 13);

      expect(result["name"]).toEqual({
        key: PN.Name,
        type: "string",
        label: PN.Name,
      });
      expect(result["guardMode"]).toEqual({
        key: PN.StationGuardMode,
        type: "string",
        label: PN.StationGuardMode,
      });
    });
  });

  describe("schema 14-20", () => {
    it("includes alarm metadata keys", () => {
      const station = createMockStation();
      const result = dumpStationPropertiesMetadata(station, 14);

      for (const key of schema1MetaKeys) {
        expect(result).toHaveProperty(key);
      }
    });

    it("still includes base metadata keys", () => {
      const station = createMockStation();
      const result = dumpStationPropertiesMetadata(station, 20);

      for (const key of baseMetaKeys) {
        expect(result).toHaveProperty(key);
      }
    });

    it("excludes storage/tracking metadata keys", () => {
      const station = createMockStation();
      const result = dumpStationPropertiesMetadata(station, 20);

      for (const key of schema2MetaKeys) {
        expect(result).not.toHaveProperty(key);
      }
    });
  });

  describe("schema >= 21", () => {
    it("includes all metadata keys", () => {
      const station = createMockStation();
      const result = dumpStationPropertiesMetadata(station, 21);

      for (const key of [
        ...baseMetaKeys,
        ...schema1MetaKeys,
        ...schema2MetaKeys,
      ]) {
        expect(result).toHaveProperty(key);
      }
    });

    it("works for high schema version", () => {
      const station = createMockStation();
      const result = dumpStationPropertiesMetadata(station, 30);

      for (const key of [
        ...baseMetaKeys,
        ...schema1MetaKeys,
        ...schema2MetaKeys,
      ]) {
        expect(result).toHaveProperty(key);
      }
    });
  });

  describe("boundary checks", () => {
    it.each([1, 10, 13])(
      "schema %i excludes alarm metadata",
      (schema) => {
        const result = dumpStationPropertiesMetadata(
          createMockStation(),
          schema,
        );
        expect(result).not.toHaveProperty("alarm");
      },
    );

    it.each([14, 15, 20])(
      "schema %i includes alarm but excludes storage metadata",
      (schema) => {
        const result = dumpStationPropertiesMetadata(
          createMockStation(),
          schema,
        );
        expect(result).toHaveProperty("alarm");
        expect(result).not.toHaveProperty("storageInfoEmmc");
      },
    );

    it.each([21, 25])(
      "schema %i includes storage metadata",
      (schema) => {
        const result = dumpStationPropertiesMetadata(
          createMockStation(),
          schema,
        );
        expect(result).toHaveProperty("storageInfoEmmc");
        expect(result).toHaveProperty("crossCameraTracking");
      },
    );
  });
});