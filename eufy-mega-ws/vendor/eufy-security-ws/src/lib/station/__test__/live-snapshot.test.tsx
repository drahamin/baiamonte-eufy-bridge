import { describe, expect, it, jest } from "@jest/globals";
import { EufySecurity } from "eufy-security-client";
import { Client } from "../../server.js";
import { StationMessageHandler } from "../message_handler.js";
import { StationCommand } from "../command.js";
import { IncomingMessageStation } from "../incoming_message.js";
function setup(schemaVersion = 21) {
  const picture = {
    data: "jpeg",
    mimeType: "image/jpeg",
    capturedAt: new Date().toISOString(),
  };
  const station = {
    getSerial: () => "pro",
    captureLiveSnapshot: jest.fn().mockResolvedValue(picture),
  };
  const device = { getStationSerial: jest.fn(() => "pro") };
  const driver = {
    getStation: jest.fn().mockResolvedValue(station),
    getDevice: jest.fn().mockResolvedValue(device),
  };
  const message = {
    messageId: "test",
    command: StationCommand.captureLiveSnapshot,
    serialNumber: "pro",
    deviceSN: "camera",
  } as IncomingMessageStation;
  const run = () =>
    StationMessageHandler.handle(
      message,
      driver as unknown as EufySecurity,
      { schemaVersion } as Client,
    );
  return { station, device, driver, picture, run };
}
describe("explicit station RTC snapshot command", () => {
  it("resolves the actual camera and returns only the still result", async () => {
    const { station, device, driver, picture, run } = setup();
    await expect(run()).resolves.toEqual(picture);
    expect(driver.getDevice).toHaveBeenCalledWith("camera");
    expect(station.captureLiveSnapshot).toHaveBeenCalledWith(device);
  });
  it("refuses a camera belonging to another station before capture", async () => {
    const { station, device, run } = setup();
    device.getStationSerial.mockReturnValue("other");
    await expect(run()).rejects.toThrow("not attached");
    expect(station.captureLiveSnapshot).not.toHaveBeenCalled();
  });
  it("does not expose the extension to older schemas", async () => {
    const { station, driver, run } = setup(20);
    await expect(run()).rejects.toThrow();
    expect(driver.getDevice).not.toHaveBeenCalled();
    expect(station.captureLiveSnapshot).not.toHaveBeenCalled();
  });
});
