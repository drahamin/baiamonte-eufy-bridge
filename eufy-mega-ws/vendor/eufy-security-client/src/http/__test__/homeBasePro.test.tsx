import { DeviceType, GenericTypeProperty, PropertyName, StationCommands, StationProperties } from "../types";

describe("HomeBase Professional S1 catalog", () => {
  it("identifies T9000 and exposes only verified properties and read-only image commands", () => {
    const properties = StationProperties[DeviceType.HOMEBASE_PRO];

    expect(GenericTypeProperty.states?.[DeviceType.HOMEBASE_PRO]).toContain("T9000");
    expect(properties[PropertyName.StationBattery]?.writeable).toBe(false);
    expect(properties[PropertyName.StationLteSignal]?.writeable).toBe(false);
    expect(properties[PropertyName.StationLteBand]?.writeable).toBe(false);
    expect(properties[PropertyName.StationLteRegistrationState]?.writeable).toBe(false);
    expect(properties[PropertyName.StationPromptVolume]?.writeable).toBe(true);
    expect(properties[PropertyName.StationGuardMode]?.writeable).toBe(true);
    expect(StationCommands[DeviceType.HOMEBASE_PRO]).toEqual([
      "stationDownloadImage",
      "stationDatabaseQueryLatestInfo",
    ]);
    expect(StationCommands[DeviceType.HOMEBASE_PRO]).not.toContain("stationDatabaseDelete");
    expect(StationCommands[DeviceType.HOMEBASE_PRO]).not.toContain("stationReboot");
  });
});
