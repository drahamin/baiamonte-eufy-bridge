import { P2PClientProtocol } from "../session";
import { CommandType, P2PDataType } from "../types";

describe("untrusted camera frame boundaries", () => {
  it("ignores truncated datagrams before UDP handlers read their fields", () => {
    const p = Object.create(P2PClientProtocol.prototype) as any;
    p.disposed = false;
    for (const kind of [0x40, 0x41, 0xd0, 0xd1]) {
      for (let size = 0; size < 8; size++) {
        const packet = Buffer.alloc(size);
        if (size) packet[0] = 0xf1;
        if (size > 1) packet[1] = kind;
        expect(() => p.handleMsg(packet, {})).not.toThrow();
      }
    }
    const ack = Buffer.from([0xf1, 0xd1, 0, 4, 0, 1, 0, 2]);
    expect(() => p.handleMsg(ack, {})).not.toThrow();
  });

  it("never starts or emits a stream for header-only audio or truncated video", () => {
    const p = Object.create(P2PClientProtocol.prototype) as any;
    p.currentMessageState = { [P2PDataType.VIDEO]: { invalidStream: false } };
    p.waitForStreamData = jest.fn();
    for (const [commandId, sizes] of [
      [CommandType.CMD_AUDIO_FRAME, [0, 8, 16]],
      [CommandType.CMD_VIDEO_FRAME, [0, 8, 21]],
    ] as const) {
      for (const size of sizes)
        expect(() =>
          p.handleDataBinaryAndVideo({
            commandId,
            dataType: P2PDataType.VIDEO,
            data: Buffer.alloc(size),
          })
        ).not.toThrow();
    }
    expect(p.waitForStreamData).not.toHaveBeenCalled();
  });
});
