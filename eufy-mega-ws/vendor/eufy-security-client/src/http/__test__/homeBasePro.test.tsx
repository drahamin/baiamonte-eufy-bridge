import { DeviceType, GenericTypeProperty, PropertyName, StationCommands, StationProperties } from "../types";
import { buildAicEventQueryPayload } from "../station";

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
      "stationDatabaseQueryAicEvents",
    ]);
    expect(StationCommands[DeviceType.HOMEBASE_PRO]).not.toContain("stationDatabaseDelete");
    expect(StationCommands[DeviceType.HOMEBASE_PRO]).not.toContain("stationReboot");
  });

  it("builds the current app's descending AIC query payload", () => {
    expect(
      buildAicEventQueryPayload(
        new Date("2026-08-25T00:00:00.000Z"),
        new Date("2026-08-26T00:00:00.000Z"),
        500,
        "T9000-test"
      )
    ).toEqual({
      start_date: "1787702400",
      end_date: "1787616000",
      start_id: 0,
      end_id: 0,
      query: [],
      flag: 0,
      res_unzip: 1,
      count: 500,
      where: [],
      or: [],
      or_and: [],
    });
  });
});
