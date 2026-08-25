const mockLogger = { error: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), trace: jest.fn() };
jest.mock("../../logging", () => ({ rootMainLogger: mockLogger }));

import { findMegaArray, MegaTransition, MegaTransitionHost, translateNativeMegaDevice } from "../megaTransition";
import { DeviceType } from "../types";

const host = {
  config: {},
  persistentData: {},
  api: { isConnected: () => true },
  writePersistentData: jest.fn(),
  emitTfaRequest: jest.fn(),
  emitCaptchaRequest: jest.fn(),
  legacyConnect: jest.fn(),
  onAPIConnect: jest.fn(),
  onConnectionError: jest.fn(),
} as unknown as MegaTransitionHost;

describe("native Mega inventory augmentation", () => {
  afterEach(() => jest.clearAllMocks());

  it("finds modeled arrays through retained Mega response wrappers", () => {
    expect(findMegaArray({ data: { data: { data_point_list: [{ code: "a" }] } } }, "data_point_list")).toEqual([
      { code: "a" },
    ]);
    expect(findMegaArray({ data: { unrelated: [] } }, "devices")).toEqual([]);
  });

  it("translates the E10 to a non-camera read-only device without sensitive native fields", () => {
    const translated = translateNativeMegaDevice({
      device_sn: "display-serial",
      device_name: "Hall Display",
      device_model: "T87A0",
      category: "eufy_mega",
      device_type: 1,
      mqtt_info: { host: "broker", port: 8883 },
      p2p_conn: "secret",
      app_conn: "secret",
      member: { email: "private@example.com" },
      params: [{ param_type: 8001, param_value: "private" }],
    });

    expect(translated).toBeDefined();
    expect(translated!.device_type).toBe(DeviceType.SMART_DISPLAY_E10);
    expect(translated!.device_type).not.toBe(DeviceType.CAMERA);
    expect(translated!.params).toEqual([]);
    expect(translated!.station_sn).toBe("");
    expect(translated!.baiamonte_native_source).toBe("mega");
    expect(translated!.baiamonte_connected).toBe("true");
    expect(JSON.stringify(translated)).not.toContain("broker");
    expect(JSON.stringify(translated)).not.toContain("private@example.com");
    expect(JSON.stringify(translated)).not.toContain("secret");
  });

  it("does not expose an unverified native product", () => {
    expect(translateNativeMegaDevice({ device_sn: "x", device_model: "T9999", category: "eufy_mega" })).toBeUndefined();
    expect(translateNativeMegaDevice({ device_sn: "x", device_model: "T87A0", category: "security" })).toBeUndefined();
  });

  it("fetches a catalog once for every distinct account product code and tolerates failures", async () => {
    const transition = new MegaTransition(host);
    const getProductDataPointsDecrypted = jest
      .fn()
      .mockResolvedValueOnce({ data_point_list: [{ code: "a" }, { code: "b" }] })
      .mockResolvedValueOnce({ data_point_list: [] })
      .mockRejectedValueOnce(new Error("not supported"));
    const getDeviceDetailsDecrypted = jest.fn().mockResolvedValue({ devices: [{ actions: [] }] });
    const getRomVersionsDecrypted = jest.fn().mockResolvedValue({ rom_versions: [] });
    (transition as any).megaLoggedIn = true;
    (transition as any).nativeInventory = {
      devices: [
        { device_model: "T87A0", device_type: 119, device_sn: "display", category: "eufy_mega" },
        { device_model: "T87A0" },
        { device_new_pn: "T8600", params: [{ param_type: 60001, param_value: "private" }] },
        { device_model: "T9999" },
      ],
    };
    (transition as any).getMegaApi = jest.fn(async () => ({
      getProductDataPointsDecrypted,
      getDeviceDetailsDecrypted,
      getRomVersionsDecrypted,
    }));

    await transition.refreshProductDataPointCatalogs();

    expect(getProductDataPointsDecrypted).toHaveBeenCalledTimes(3);
    expect(getProductDataPointsDecrypted.mock.calls.map(([code]) => code).sort()).toEqual(["T8600", "T87A0", "T9999"]);
    expect(getDeviceDetailsDecrypted).toHaveBeenCalledWith("", 7);
    expect(getRomVersionsDecrypted).toHaveBeenCalledWith([
      { device_type: "T87A0_ota", device_sn: "display", category: "eufy_home" },
    ]);
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining("catalog scan complete"), {
      attempted: 3,
      available: 1,
      empty: 1,
      failed: 1,
      dataPoints: 2,
      synthesized: 1,
      observedDataPoints: 1,
      knownDataPoints: 0,
      unknownDataPoints: 1,
    });
  });
});
