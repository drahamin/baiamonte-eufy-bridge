import { Station } from "../station";
import { DeviceType } from "../types";
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
        setStreamTimeouts: jest.fn(),
        isLiveStreaming: () => false,
        isConnected: () => true,
        isConnecting: () => false,
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
});
