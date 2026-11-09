import { Station } from "../station";
import { DeviceType } from "../types";
import { PanTiltDirection } from "../../p2p/types";
import { P2PClientProtocol } from "../../p2p/session";
import { Readable } from "stream";

jest.mock("../../p2p/session", () => {
  const { EventEmitter } = require("events");
  return {
    P2PClientProtocol: jest.fn().mockImplementation(() => {
      const p = new EventEmitter();
      Object.assign(p, {
        getRSAPrivateKey: jest.fn(),
        getAttachedMediaStartKey: () => ({ kind: "ecc", key: "test" }),
        sendCommandWithStringPayload: jest.fn(),
        sendCommandWithString: jest.fn(),
        setStreamTimeouts: jest.fn(),
        isLiveStreaming: () => false,
        isConnected: () => true,
        connect: jest.fn().mockResolvedValue(undefined),
        isConnecting: () => false,
        isEnergySavingDevice: () => false,
        close: jest.fn(),
        dispose: jest.fn().mockResolvedValue(undefined),
      });
      return p;
    }),
  };
});

describe("S380 independent camera sessions", () => {
  const raw = { station_sn: "T8030TEST", device_type: DeviceType.HB3, member: { admin_user_id: "account" } };
  const camera = (channel: number) => ({
    getStationSerial: () => raw.station_sn,
    getChannel: () => channel,
    getSerial: () => `cam-${channel}`,
    hasCommand: () => true,
  });
  const sessions = () => (P2PClientProtocol as unknown as jest.Mock).mock.results.map((r) => r.value);
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("coalesces duplicate starts and stopping one camera leaves its sibling and control connection alone", async () => {
    const station = await Station.getInstance({} as never, raw as never);
    station.startLivestream(camera(0) as never);
    station.startLivestream(camera(0) as never);
    station.startLivestream(camera(2) as never);
    const [control, a, b] = sessions();
    expect(sessions()).toHaveLength(3);
    expect(a.sendCommandWithStringPayload).toHaveBeenCalledTimes(1);
    expect(b.sendCommandWithStringPayload).toHaveBeenCalledTimes(1);
    expect(control.sendCommandWithStringPayload).not.toHaveBeenCalled();
    station.stopLivestream(camera(0) as never);
    expect(a.dispose).toHaveBeenCalledTimes(1);
    expect(b.dispose).not.toHaveBeenCalled();
    expect(control.close).not.toHaveBeenCalled();
    expect(station.isLiveStreaming(camera(2) as never)).toBe(true);
    station.close();
    expect(b.dispose).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("releases failed starts and forwards media events with the original station identity", async () => {
    const station = await Station.getInstance({} as never, raw as never);
    const errors = jest.fn(),
      started = jest.fn();
    station.on("livestream error", errors);
    station.on("livestream start", started);
    station.startLivestream(camera(0) as never);
    jest.advanceTimersByTime(30_000);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(station.isLiveStreaming(camera(0) as never)).toBe(false);
    expect(sessions()[1].dispose).toHaveBeenCalledTimes(1);
    station.startLivestream(camera(0) as never);
    const p = sessions()[2],
      video = new Readable({ read() {} }),
      audio = new Readable({ read() {} });
    p.emit("livestream started", 0, {}, video, audio);
    expect(started).toHaveBeenCalledWith(station, 0, {}, video, audio);
    expect(jest.getTimerCount()).toBe(0);
    station.close();
  });

  it("keeps standalone/non-S380 cameras on their existing session", async () => {
    const station = await Station.getInstance({} as never, { ...raw, device_type: DeviceType.STATION } as never);
    // Only the connection selection is relevant: capture the ordinary dispatch.
    jest.spyOn(station as any, "isLiveStreaming").mockReturnValue(true);
    expect(() => station.startLivestream(camera(0) as never)).toThrow();
    expect(sessions()).toHaveLength(1);
    station.close();
  });

  it("routes PTZ through the active camera session and returns to control after stop", async () => {
    const station = await Station.getInstance({} as never, raw as never);
    const cam = { ...camera(0), getDeviceType: () => DeviceType.FLOODLIGHT_CAMERA_8423 };
    station.startLivestream(cam as never);
    const [control, media] = sessions();
    media.isLiveStreaming = () => true;
    media.sendCommandWithStringPayload.mockClear();
    station.panAndTilt(cam as never, PanTiltDirection.LEFT);
    expect(media.sendCommandWithStringPayload).toHaveBeenCalledTimes(1);
    expect(control.sendCommandWithStringPayload).not.toHaveBeenCalled();
    station.stopLivestream(cam as never);
    station.panAndTilt(cam as never, PanTiltDirection.RIGHT);
    expect(control.sendCommandWithStringPayload).toHaveBeenCalledTimes(1);
    station.close();
  });
});

describe("HomeBase Pro RTC-only connection policy", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });
  it("does not dial or schedule P2P reconnects for a Pro, including an older inventory type", async () => {
    for (const type of [DeviceType.HOMEBASE_PRO, DeviceType.STATION]) {
      const station = await Station.getInstance(
        {} as never,
        { station_sn: "T9000TEST", device_type: type, member: { admin_user_id: "account" } } as never
      );
      const p = (station as any).p2pSession;
      expect(station.isP2PConnectableDevice()).toBe(false);
      await station.connect();
      (station as any).onTimeout();
      (station as any).onDisconnect();
      expect(p.connect).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
      station.close();
    }
  });
});

describe("S380 stored download command", () => {
  beforeEach(() => jest.clearAllMocks());
  it("uses the native string-pair command and no legacy cipher lookup", async () => {
    const api = {
      getCipher: jest.fn(() => {
        throw new Error("no cipher required");
      }),
    };
    const station = await Station.getInstance(
      api as never,
      { station_sn: "T8030TEST", device_type: DeviceType.HB3, member: { admin_user_id: "account" } } as never
    );
    const cam = {
      getStationSerial: () => "T8030TEST",
      getSerial: () => "camera",
      getChannel: () => 2,
      hasCommand: () => true,
    };
    await station.startDownload(cam as never, "20261101120000", 999);
    expect((station as any).p2pSession.sendCommandWithString).toHaveBeenCalledWith(
      {
        commandType: 1024,
        strValue: "/zx/emmcdata/Camera02/202611/20261101120000/20261101120000.zxvideo",
        strValueSub: "account",
        channel: 2,
      },
      expect.anything()
    );
    expect((station as any).p2pSession.sendCommandWithStringPayload).not.toHaveBeenCalled();
    expect(api.getCipher).not.toHaveBeenCalled();
    await expect(
      station.startDownload(cam as never, "/zx/emmcdata/Camera03/202611/20261101120000/20261101120000.zxvideo")
    ).rejects.toThrow("Invalid S380 recording path");
    station.close();
  });
});

describe("stored image command routing", () => {
  beforeEach(() => jest.clearAllMocks());
  it.each([
    [DeviceType.SOLO_CAMERA_E30, "T8171TEST", 0],
    [DeviceType.HB3, "T8030TEST", 255],
  ])("uses the proper standalone or HomeBase channel", async (device_type, station_sn, channel) => {
    const station = await Station.getInstance(
      {} as never,
      { station_sn, device_type, member: { admin_user_id: "account" } } as never
    );
    station.downloadImage("/stored-image.jpg");
    const command = (station as any).p2pSession.sendCommandWithStringPayload.mock.calls[0][0];
    expect(command.channel).toBe(channel);
    expect(JSON.parse(command.value)).toMatchObject({
      cmd: 1308,
      mChannel: channel,
      payload: [{ file: "/stored-image.jpg" }],
    });
    station.close();
  });
  it("fails unsupported Pro local-file fallback without opening a P2P session", async () => {
    const station = await Station.getInstance(
      {} as never,
      { station_sn: "T9000TEST", device_type: DeviceType.HOMEBASE_PRO, member: { admin_user_id: "account" } } as never
    );
    expect(() => station.downloadImage("/stored-image.jpg")).toThrow("authenticated RTC evidence response");
    expect((station as any).p2pSession.sendCommandWithStringPayload).not.toHaveBeenCalled();
    station.close();
  });
});
