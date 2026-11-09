import { buildCommandHeader } from "../utils";
import { P2PClientProtocol } from "../session";
import { CommandType, EncryptionType, InternalP2PCommandType, P2PDataType } from "../types";

const protocol = (): any => {
  const p = Object.create(P2PClientProtocol.prototype) as any;
  Object.assign(p, {
    rawStation: { station_sn: "T8171TEST", p2p_did: "p2p", member: { admin_user_id: "account" } },
    deviceSNs: { 0: { sn: "T8171TEST" }, 2: { sn: "attached-camera" } },
    gatewayCipherId: 0,
    encryption: EncryptionType.LEVEL_1,
    p2pKey: Buffer.alloc(16, 7),
    clearCommandCount: 0,
    seqNumber: 0,
    p2pDataSeqNumber: 0,
    MAX_COMMAND_QUEUE_TIMEOUT: 10000,
    MAX_SEQUENCE_NUMBER: 65535,
    MAX_AKNOWLEDGE_TIMEOUT: 10000,
    RESEND_NOT_ACKNOWLEDGED_COMMAND: 10000,
    messageStates: new Map(),
    p2pSeqMapping: new Map(),
    sendMessage: jest.fn().mockResolvedValue(undefined),
    emit: jest.fn(),
  });
  return p;
};

const send = (p: any, command: number, channel = 0) =>
  p._sendCommand({
    timestamp: Date.now(),
    p2pCommandType: InternalP2PCommandType.WithStringPayload,
    p2pCommand: {
      commandType: CommandType.CMD_SET_PAYLOAD,
      channel,
      value: JSON.stringify({ cmd: command, payload: {} }),
    },
    nestedCommandType: command,
  });

describe("negotiated cipher-0 stored-image reads", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });
  it("sends database and image reads in clear using one increasing connection counter", async () => {
    const p = protocol();
    for (const cmd of [CommandType.CMD_DATABASE, CommandType.CMD_DATABASE_IMAGE]) await send(p, cmd);
    const packets = p.sendMessage.mock.calls.map((args: any[]) => args[3] as Buffer);
    expect(packets).toHaveLength(2);
    for (let i = 0; i < packets.length; i++) {
      // Command header precedes the ten-byte payload header.
      const body = packets[i].subarray(buildCommandHeader(0, CommandType.CMD_SET_PAYLOAD).length);
      expect(body.subarray(4, 8)).toEqual(Buffer.from([1, i + 1, 0, 0]));
      expect(JSON.parse(body.subarray(10).toString()).cmd).toBe(
        [CommandType.CMD_DATABASE, CommandType.CMD_DATABASE_IMAGE][i]
      );
    }
  });
  it.each(["unknown cipher", "nonzero cipher", "level2", "attached camera", "property write"])(
    "preserves encrypted framing for %s",
    async (kind) => {
      const p = protocol();
      if (kind === "unknown cipher") p.gatewayCipherId = undefined;
      if (kind === "nonzero cipher") p.gatewayCipherId = 1;
      if (kind === "level2") p.encryption = EncryptionType.LEVEL_2;
      await send(p, kind === "property write" ? 1234 : CommandType.CMD_DATABASE, kind === "attached camera" ? 2 : 0);
      expect(p.clearCommandCount).toBe(0);
      const packet = p.sendMessage.mock.calls[0][3] as Buffer;
      expect(() =>
        JSON.parse(packet.subarray(buildCommandHeader(0, CommandType.CMD_SET_PAYLOAD).length + 10).toString())
      ).toThrow();
    }
  );
  it("routes a clear DATA database body to normal normalization without confusing its ack", () => {
    const p = protocol();
    const handled = jest.spyOn(p, "handleDataControl");
    p.handleData({
      dataType: P2PDataType.DATA,
      commandId: CommandType.CMD_DATABASE,
      channel: 0,
      signCode: 0,
      type: 0,
      data: Buffer.from(JSON.stringify({ cmd: CommandType.CMD_DATABASE_QUERY_LATEST_INFO, mIntRet: 0, data: [] })),
    });
    expect(handled).toHaveBeenCalledTimes(1);
    expect(p.emit).toHaveBeenCalledWith("database query latest", 0, []);
  });
  it.each(["", "[]", null])(
    "completes empty local/date tables without throwing or waiting for more data (%p)",
    (value) => {
      const p = protocol();
      for (const [cmd, event] of [
        [CommandType.CMD_DATABASE_QUERY_LOCAL, "database query local"],
        [CommandType.CMD_DATABASE_QUERY_BY_DATE, "database query by date"],
      ] as const) {
        p.handleDataControl({
          commandId: CommandType.CMD_DATABASE,
          dataType: P2PDataType.CONTROL,
          channel: 0,
          signCode: 0,
          data: Buffer.from(JSON.stringify({ cmd, mIntRet: 0, data: value })),
        });
        expect(p.emit).toHaveBeenCalledWith(event, 0, []);
      }
    }
  );
});
