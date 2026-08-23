import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { EufySecurity } from "../eufysecurity";
import { PropertyName } from "../http/types";

jest.mock("../logging", () => ({
  rootHTTPLogger: { error: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), trace: jest.fn() },
  rootMainLogger: { error: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), trace: jest.fn() },
  rootPushLogger: { error: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), trace: jest.fn() },
  rootP2PLogger: { error: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), trace: jest.fn() },
  rootMQTTLogger: { error: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), trace: jest.fn() },
  InternalLogger: {},
}));

describe("EufySecurity snapshot cache", () => {
  let cacheRoot: string;
  let security: EufySecurity;

  beforeEach(() => {
    cacheRoot = mkdtempSync(join(tmpdir(), "eufy-snapshot-test-"));
    security = Object.create(EufySecurity.prototype) as EufySecurity;
    Object.assign(security as unknown as Record<string, unknown>, {
      config: { snapshotCache: true, persistentDir: cacheRoot },
      SNAPSHOT_CACHE_MAX_BYTES: 10 * 1024 * 1024,
    });
  });

  afterEach(() => {
    rmSync(cacheRoot, { recursive: true, force: true });
  });

  it("persists and restores the last JPEG snapshot", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0xff, 0xd9]);
    const sourceDevice = { getSerial: () => "T8210/unsafe" };

    (security as any).cacheSnapshot(sourceDevice, {
      data: jpeg,
      type: { ext: "jpg", mime: "image/jpeg" },
    });

    const cacheFile = join(cacheRoot, "snapshots", "T8210_unsafe.img");
    expect(readFileSync(cacheFile)).toEqual(jpeg);

    const restoredDevice = {
      getSerial: () => "T8210/unsafe",
      hasProperty: jest.fn().mockReturnValue(true),
      updateProperty: jest.fn(),
    };
    (security as any).restoreCachedSnapshot(restoredDevice);

    expect(restoredDevice.updateProperty).toHaveBeenCalledWith(
      PropertyName.DevicePicture,
      { data: jpeg, type: { ext: "jpg", mime: "image/jpeg" } },
      true
    );
  });

  it("does not restore a cache when the feature is disabled", () => {
    (security as any).config.snapshotCache = false;
    const device = {
      getSerial: () => "T8210",
      hasProperty: jest.fn(),
      updateProperty: jest.fn(),
    };

    (security as any).restoreCachedSnapshot(device);

    expect(device.hasProperty).not.toHaveBeenCalled();
    expect(device.updateProperty).not.toHaveBeenCalled();
  });

  it("does not persist non-image bytes", () => {
    const sourceDevice = { getSerial: () => "T8210" };

    (security as any).cacheSnapshot(sourceDevice, {
      data: Buffer.from("not an image"),
      type: { ext: "unknown", mime: "application/octet-stream" },
    });

    expect(existsSync(join(cacheRoot, "snapshots", "T8210.img"))).toBe(false);
  });
});
