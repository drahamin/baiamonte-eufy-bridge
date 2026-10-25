const mockLogger = { error: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), trace: jest.fn() };
jest.mock("../../logging", () => ({ rootMainLogger: mockLogger }));

import { findMegaArray, MegaTransition, MegaTransitionHost, translateNativeMegaDevice } from "../megaTransition";
import { summarizeE10OtaRecords } from "../otaDiagnostics";
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
    (transition as any).writeMegaStatus = jest.fn();
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
      requests: 3,
      available: 1,
      empty: 1,
      failed: 1,
      dataPoints: 2,
      synthesized: 1,
      observedDataPoints: 1,
      knownDataPoints: 1,
      classifiedDataPoints: 0,
      unknownDataPoints: 0,
      effectiveAvailable: 2,
      effectiveDataPoints: 3,
    });
    expect((transition as any).writeMegaStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        observedSchemas: expect.objectContaining({
          models: expect.objectContaining({
            T8600: expect.objectContaining({ knownIds: [60001], unknownIds: [] }),
          }),
        }),
      })
    );
  });

  it("tries a distinct new-PN catalog alias before falling back to the model", async () => {
    const transition = new MegaTransition(host);
    const getProductDataPointsDecrypted = jest
      .fn()
      .mockResolvedValueOnce({ data_point_list: [] })
      .mockResolvedValueOnce({ data_point_list: [{ code: "motion", dp_id: 1 }] });
    (transition as any).megaLoggedIn = true;
    (transition as any).loadNativeInventory = jest.fn(async () => ({
      devices: [{ device_model: "T9999", device_new_pn: "T9999_NEW", params: [] }],
    }));
    (transition as any).getMegaApi = jest.fn(async () => ({
      getProductDataPointsDecrypted,
      getDeviceRelationsDecrypted: jest.fn(async () => ({ devices: [] })),
      getDeviceDetailsDecrypted: jest.fn(async () => ({ devices: [] })),
      getRomVersionsDecrypted: jest.fn(async () => []),
    }));
    (transition as any).writeMegaStatus = jest.fn();

    await transition.refreshProductDataPointCatalogs();

    expect(getProductDataPointsDecrypted.mock.calls.map(([code]: [string]) => code)).toEqual(["T9999_NEW", "T9999"]);
  });
});

describe("E10 OTA diagnostics", () => {
  it("prefers the targeted response and retains only safe package metadata", () => {
    const result = summarizeE10OtaRecords(
      [
        {
          rom_version_name: "V2.12.04",
          device_sn: "T87A0-SECRET",
          access_token: "secret",
          full_package: {
            file_name: "T87A0-update.zip",
            file_size: 123456,
            file_md5: "0123456789abcdef0123456789ABCDEF",
            file_path: "https://updates.eufy.com/private/file.zip?token=secret",
          },
          delta_package: {
            file_name: "delta.bin",
            file_size: 42,
            file_path: "https://cdn.example.invalid/delta.bin?signature=secret",
          },
        },
      ],
      [{ device_type: "T87A0_ota", rom_version_name: "WRONG" }]
    );

    expect(result).toEqual({
      recordFound: true,
      returnedFieldNames: ["access_token", "delta_package", "device_sn", "full_package", "rom_version_name"],
      packageObjects: [
        {
          name: "delta_package",
          returnedFieldNames: ["file_name", "file_path", "file_size"],
          filename: "delta.bin",
          size: 42,
          md5: null,
          filePathPresent: true,
          urlHostname: "cdn.example.invalid",
        },
        {
          name: "full_package",
          returnedFieldNames: ["file_md5", "file_name", "file_path", "file_size"],
          filename: "T87A0-update.zip",
          size: 123456,
          md5: "0123456789abcdef0123456789abcdef",
          filePathPresent: true,
          urlHostname: "updates.eufy.com",
        },
      ],
      rom_version_name: "V2.12.04",
    });
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(JSON.stringify(result)).not.toContain("token=");
    expect(JSON.stringify(result)).not.toContain("signature=");
  });

  it("matches a batch E10 record and rejects unsafe values", () => {
    expect(
      summarizeE10OtaRecords(
        [],
        [
          { device_type: "T8400_ota", rom_version_name: "wrong" },
          {
            device_type: "T87A0_ota",
            rom_version_name: "V2.12.04?token=secret",
            full_package: {
              file_name: "../unsafe.zip",
              file_size: -1,
              file_md5: "not-an-md5",
              file_path: "http://updates.eufy.com/file.zip?token=secret",
            },
          },
        ]
      )
    ).toMatchObject({
      recordFound: true,
      rom_version_name: null,
      packageObjects: [
        {
          filename: null,
          size: null,
          md5: null,
          filePathPresent: true,
          urlHostname: null,
        },
      ],
    });
  });

  it("reports no record without leaking batch data", () => {
    expect(summarizeE10OtaRecords([], [{ device_type: "T8400_ota", full_package: { file_path: "secret" } }])).toEqual({
      recordFound: false,
      returnedFieldNames: [],
      packageObjects: [],
    });
  });
});
