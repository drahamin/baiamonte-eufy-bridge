import { P2PClientProtocol } from "../session";
import { homeBase3RecordingPath, homeBase3RecordingPayload } from "../recording";
import { CommandType, P2PDataType } from "../types";
import { DeviceType } from "../../http/types";

const packet = (payload: Buffer): Buffer => {
  const header = Buffer.alloc(22);
  header.writeUInt32LE(payload.length);
  header[4] = 1;
  header[5] = 1;
  header.writeUInt16LE(15, 8);
  header.writeUInt16LE(1920, 10);
  header.writeUInt16LE(1080, 12);
  return Buffer.concat([header, payload]);
};

describe("S380 stored recording transport", () => {
  it("restricts paths to the requested camera channel, stamp and month", () => {
    const path = "/zx/emmcdata/Camera02/202611/20261101120000/20261101120000.zxvideo";
    expect(homeBase3RecordingPath(2, "20261101120000")).toBe(path);
    expect(homeBase3RecordingPath(2, path)).toBe(path);
    for (const input of [
      path.replace("Camera02", "Camera03"),
      path.replace("/202611/", "/202610/"),
      path + "/../x",
      "h265_20261101120000",
      "/etc/passwd",
    ])
      expect(homeBase3RecordingPath(2, input)).toBeUndefined();
    for (const channel of [-1, 100, 1.5]) expect(homeBase3RecordingPath(channel, "20261101120000")).toBeUndefined();
  });
  it("preserves both parts of a 462076-byte stored keyframe without an RSA/ECC unwrap", () => {
    const chunks = [Buffer.alloc(400000, 7), Buffer.alloc(62076, 8)];
    chunks[0].set([0, 0, 0, 1, 0x65]);
    const pushed: Buffer[] = [];
    const p = Object.create(P2PClientProtocol.prototype) as any;
    p.rawStation = { station_sn: "T8030TEST", device_type: DeviceType.HB3 };
    p.currentMessageState = {
      [P2PDataType.BINARY]: {
        invalidStream: false,
        p2pStreamChannel: 2,
        p2pStreamMetadata: {},
        p2pStreamFirstVideoDataReceived: true,
        p2pStreamFirstAudioDataReceived: true,
        p2pStreamNotStarted: false,
        videoStream: { push: (data: Buffer) => pushed.push(data) },
      },
    };
    p.mediaFrameDecoder = {
      decode: jest.fn(() => {
        throw new Error("must not decrypt clear stored frames");
      }),
    };
    p.waitForStreamData = jest.fn();
    for (const part of chunks)
      p.handleDataBinaryAndVideo({
        commandId: CommandType.CMD_VIDEO_FRAME,
        dataType: P2PDataType.BINARY,
        channel: 2,
        signCode: 1,
        data: packet(part),
      });
    expect(Buffer.concat(pushed)).toEqual(Buffer.concat(chunks));
    expect(p.mediaFrameDecoder.decode).not.toHaveBeenCalled();
    p.handleDataBinaryAndVideo({
      commandId: CommandType.CMD_VIDEO_FRAME,
      dataType: P2PDataType.BINARY,
      channel: 3,
      signCode: 1,
      data: packet(chunks[1]),
    });
    expect(pushed).toHaveLength(2);
  });
  it("refuses encrypted-layout, truncated and oversized clear frames", () => {
    const valid = packet(Buffer.alloc(100));
    expect(homeBase3RecordingPayload(valid)).toHaveLength(100);
    expect(homeBase3RecordingPayload(valid.subarray(0, -1))).toBeUndefined();
    expect(homeBase3RecordingPayload(Buffer.concat([valid, Buffer.alloc(129)]))).toBeUndefined();
    expect(homeBase3RecordingPayload(packet(Buffer.alloc(400001)))).toBeUndefined();
    expect(homeBase3RecordingPayload(Buffer.alloc(22))).toBeUndefined();
  });
  it("accepts S380 finish channel255 and its active camera, but not another camera", () => {
    const p = Object.create(P2PClientProtocol.prototype) as any;
    p.rawStation = { station_sn: "T8030TEST", device_type: DeviceType.HB3 };
    p.currentMessageState = { [P2PDataType.BINARY]: { p2pStreamChannel: 2 } };
    p.endStream = jest.fn();
    for (const channel of [3, 0, 255, 2])
      p.handleDataControl({
        commandId: CommandType.CMD_DOWNLOAD_FINISH,
        dataType: P2PDataType.CONTROL,
        channel,
        signCode: 0,
        data: Buffer.alloc(0),
      });
    expect(p.endStream).toHaveBeenCalledTimes(2);
  });
  it("releases a transfer that times out before its first picture", () => {
    const p = Object.create(P2PClientProtocol.prototype) as any;
    p.rawStation = { station_sn: "T8030TEST" };
    p.currentMessageState = {
      [P2PDataType.BINARY]: {
        p2pStreaming: true,
        p2pStreamNotStarted: true,
        p2pStreamChannel: 2,
        queuedData: new Map(),
        videoStream: { push: jest.fn() },
        audioStream: { push: jest.fn() },
      },
    };
    p.initializeMessageBuilder = jest.fn();
    p.initializeMessageState = jest.fn();
    p.initializeStream = jest.fn();
    p.closeEnergySavingDevice = jest.fn();
    p.emit = jest.fn();
    p.endStream(P2PDataType.BINARY);
    expect(p.emit).toHaveBeenCalledWith("download finished", 2);
  });
});
