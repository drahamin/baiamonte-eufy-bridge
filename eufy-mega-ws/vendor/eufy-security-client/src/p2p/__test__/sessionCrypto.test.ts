import { createECDH, createCipheriv, createHmac, generateKeyPairSync, publicEncrypt, constants } from "crypto";
import { eufyKDF, buildCommandHeader, decryptP2PData } from "../utils";
import { unwrapGatewaySessionKey, unwrapRsaGatewaySessionKey, openSessionControl, sealSessionControl } from "../sessionCrypto";
import { P2PClientProtocol } from "../session";
import { CommandType, EncryptionType, InternalP2PCommandType, P2PDataType } from "../types";

const privateKey = Buffer.alloc(32, 1);
const key = Buffer.alloc(32, 9);
const gateway = (): Buffer => {
  const peer = createECDH("prime256v1"); peer.setPrivateKey(privateKey);
  const ephemeral = createECDH("prime256v1"); ephemeral.setPrivateKey(Buffer.alloc(32, 2));
  const derived = eufyKDF(ephemeral.computeSecret(peer.getPublicKey()));
  const iv = Buffer.alloc(16, 3);
  const cipher = createCipheriv("aes-128-cbc", derived.subarray(0, 16), iv);
  const ct = Buffer.concat([cipher.update(key), cipher.final()]);
  const tag = createHmac("sha256", derived.subarray(16, 48)).update(iv).update(ct).digest();
  return Buffer.concat([Buffer.from([7, 0, 0, 0]), ephemeral.getPublicKey(undefined, "compressed"), iv, ct, tag]);
};
const protocol = (): any => {
  const p = Object.create(P2PClientProtocol.prototype) as any;
  Object.assign(p, {
    rawStation: { station_sn: "T8171TEST", p2p_did: "p2p", member: { admin_user_id: "account" } },
    deviceSNs: { 0: { sn: "T8171TEST" } }, encryption: EncryptionType.LEVEL_1,
    p2pKey: Buffer.alloc(16, 7), sessionGcmSequence: 0, keyGeneration: 1, gatewayNegotiations: 0,
    messageStates: new Map(), p2pSeqMapping: new Map(), emit: jest.fn(),
    _clearTimeout: jest.fn(), sendQueuedMessage: jest.fn(),
  }); return p;
};
const message = (data: Buffer, commandId: number, signCode = 8): any => ({
  data, commandId, dataType: P2PDataType.CONTROL, channel: 0, signCode, type: 0, seqNo: 1,
});

describe("authenticated version-8 session control", () => {
  it("unwraps a full 32-byte session key and rejects tampered or truncated envelopes", () => {
    expect(unwrapGatewaySessionKey(gateway(), privateKey.toString("hex"))).toEqual(key);
    const changed = gateway(); changed[100] ^= 1;
    expect(unwrapGatewaySessionKey(changed, privateKey.toString("hex"))).toBeUndefined();
    expect(unwrapGatewaySessionKey(gateway().subarray(0, 100), privateKey.toString("hex"))).toBeUndefined();
    expect(unwrapGatewaySessionKey(gateway(), Buffer.alloc(32, 4).toString("hex"))).toBeUndefined();
  });
  it("uses protocol version and channel headers and authenticates both reply layouts", () => {
    const data = Buffer.from('{"cmd":10013,"data":[]}');
    const encoded = sealSessionControl(data, key, 5, 2);
    expect(encoded.subarray(4, 10)).toEqual(Buffer.from([8, 0, 2, 8, 0, 0]));
    expect(encoded.readUInt16LE()).toBe(encoded.length - 10);
    expect(encoded.readUInt32LE(38)).toBe(0x01020305);
    expect(openSessionControl(encoded.subarray(10), key, 8)).toEqual(data);
    const sign2 = Buffer.concat([encoded.subarray(10, 38), encoded.subarray(42)]);
    expect(openSessionControl(sign2, key, 2)).toEqual(data);
    const changed = Buffer.from(encoded.subarray(10)); changed[0] ^= 1;
    expect(openSessionControl(changed, key, 8)).toBeUndefined();
    expect(openSessionControl(encoded.subarray(10), Buffer.alloc(32, 4), 8)).toBeUndefined();
  });
  it("routes decrypted database DATA replies into normal parsing and ignores a forged tag", () => {
    const p = protocol(); p.sessionGcmKey = key;
    const payload = sealSessionControl(Buffer.from(JSON.stringify({cmd:CommandType.CMD_DATABASE_QUERY_LATEST_INFO,mIntRet:0,data:[]})), key, 0, 0).subarray(10);
    p.handleData({...message(payload, CommandType.CMD_DATABASE),dataType:P2PDataType.DATA});
    expect(p.emit).toHaveBeenCalledWith("database query latest", 0, []);
    p.emit.mockClear(); payload[0] ^= 1;
    p.handleData({...message(payload, CommandType.CMD_DATABASE),dataType:P2PDataType.DATA});
    expect(p.emit).not.toHaveBeenCalled();
  });
  it("opens RSA PEM/DER replies with binary zeros without accepting a wrong key", () => {
    const pair = generateKeyPairSync("rsa", {modulusLength:1024});
    const plain = Buffer.alloc(16, 4);
    const cipher = publicEncrypt({key:pair.publicKey,padding:constants.RSA_PKCS1_PADDING},plain);
    const packet = Buffer.concat([Buffer.alloc(4),cipher]);
    const pem = pair.privateKey.export({format:"pem",type:"pkcs8"}).toString();
    const der = pair.privateKey.export({format:"der",type:"pkcs8"}).toString("base64");
    expect(unwrapRsaGatewaySessionKey(packet,pem)).toEqual(plain);
    expect(unwrapRsaGatewaySessionKey(packet,der)).toEqual(plain);
    const wrong = generateKeyPairSync("rsa",{modulusLength:1024}).privateKey.export({format:"pem",type:"pkcs8"}).toString();
    expect(unwrapRsaGatewaySessionKey(packet,wrong)).toBeUndefined();
    expect(unwrapRsaGatewaySessionKey(packet.subarray(0,50),pem)).toBeUndefined();
  });
  it("a failed RSA branch cannot erase a concurrent ECC negotiation on T8171", async () => {
    const p = protocol(); let rejectRsa!: (reason: Error) => void;
    p.api = { getCipher: jest.fn((id: number) => id === 7 ? Promise.resolve({ecc_private_key:privateKey.toString("hex")}) : new Promise((_r,reject)=>{rejectRsa=reject;})) };
    p.handleDataControl({...message(Buffer.from([8,0,0,0,1]),CommandType.CMD_GATEWAYINFO,0),version:1});
    p.handleDataControl({...message(gateway(),CommandType.CMD_GATEWAYINFO,0),version:8});
    for(let i=0;i<8;i++) await Promise.resolve();
    expect(p.sessionGcmKey).toEqual(key);
    expect(p.sendQueuedMessage).not.toHaveBeenCalled();
    rejectRsa(new Error("unavailable"));
    for(let i=0;i<8;i++) await Promise.resolve();
    expect(p.sessionGcmKey).toEqual(key);
    expect(p.sendQueuedMessage).toHaveBeenCalledTimes(1);
  });
  it("late lookup completion from a retired connection cannot install a key", async () => {
    const p = protocol(); let resolve!: (value: any)=>void;
    p.api = {getCipher:()=>new Promise(r=>{resolve=r;})};
    p.handleDataControl({...message(gateway(),CommandType.CMD_GATEWAYINFO,0),version:8});
    p.keyGeneration++;
    resolve({ecc_private_key:privateKey.toString("hex")});
    for(let i=0;i<8;i++) await Promise.resolve();
    expect(p.sessionGcmKey).toBeUndefined();
    expect(p.sendQueuedMessage).not.toHaveBeenCalled();
  });
  it("seals outgoing database reads using the negotiated key", async () => {
    const p=protocol(); Object.assign(p,{sessionGcmKey:key,seqNumber:0,p2pDataSeqNumber:0,MAX_COMMAND_QUEUE_TIMEOUT:10000,MAX_SEQUENCE_NUMBER:65535,MAX_AKNOWLEDGE_TIMEOUT:10000,RESEND_NOT_ACKNOWLEDGED_COMMAND:10000,sendMessage:jest.fn().mockResolvedValue(undefined)});
    jest.useFakeTimers();
    try {
      const json=JSON.stringify({cmd:CommandType.CMD_DATABASE,payload:{}});
      await p._sendCommand({timestamp:Date.now(),p2pCommandType:InternalP2PCommandType.WithStringPayload,p2pCommand:{commandType:CommandType.CMD_SET_PAYLOAD,channel:0,value:json},nestedCommandType:CommandType.CMD_DATABASE});
      const packet=p.sendMessage.mock.calls[0][3] as Buffer;
      const header=buildCommandHeader(0,CommandType.CMD_SET_PAYLOAD).length;
      expect(openSessionControl(packet.subarray(header+10),key,8)?.toString()).toBe(json);
    } finally {jest.clearAllTimers();jest.useRealTimers();}
  });
  it.each([[false,"json"],[false,"integer"],[false,"set-payload"],[true,"json"],[true,"integer"],[true,"set-payload"]])("explicit own-session start/stop use matching wire forms (refused=%s, input=%s)", async (refused, form) => {
    const p=protocol(); Object.assign(p, {gatewayRefusedLevel2:refused,
      sessionGcmKey:refused?undefined:key,seqNumber:0,p2pDataSeqNumber:0,
      MAX_COMMAND_QUEUE_TIMEOUT:10000,MAX_SEQUENCE_NUMBER:65535,MAX_AKNOWLEDGE_TIMEOUT:10000,RESEND_NOT_ACKNOWLEDGED_COMMAND:10000,
      sendMessage:jest.fn().mockResolvedValue(undefined),
      currentMessageState:{[P2PDataType.VIDEO]:{p2pStreaming:false}},waitForStreamData:jest.fn(),endStream:jest.fn()});
    jest.useFakeTimers();
    try {
      const startCommand = form === "integer" ? {
        p2pCommandType:InternalP2PCommandType.WithInt,p2pCommand:{commandType:CommandType.CMD_START_REALTIME_MEDIA,channel:0,value:0,strValue:"modulus"}
      } : form === "set-payload" ? {
        p2pCommandType:InternalP2PCommandType.WithStringPayload,p2pCommand:{commandType:CommandType.CMD_SET_PAYLOAD,channel:0,value:JSON.stringify({cmd:1003,payload:{key:"modulus"}})},nestedCommandType:1003
      } : {p2pCommandType:InternalP2PCommandType.WithStringPayload,
        p2pCommand:{commandType:CommandType.CMD_DOORBELL_SET_PAYLOAD,channel:0,value:JSON.stringify({commandType:1000,data:{encryptkey:"modulus"}})},nestedCommandType:1000};
      await p._sendCommand({timestamp:Date.now(),...startCommand});
      const start=p.sendMessage.mock.calls[0][3] as Buffer;
      const h=buildCommandHeader(0,CommandType.CMD_SET_PAYLOAD).length;
      expect(start[h+8]).toBe(refused?11:10);
      const json=JSON.parse((refused?start.subarray(h+10):openSessionControl(start.subarray(h+10),key,8))!.toString());
      if(refused) {expect(json.cmd).toBe(1003);expect(json.payload.key).toBe("modulus");expect(start[h+7]).toBe(0);}
      else {expect(json.data.encryptkey).toBe("modulus");expect(json.data.video_type).toBe(12);expect(json.data.streamtype).toBe(2);}
      await p._sendCommand({timestamp:Date.now(),p2pCommandType:InternalP2PCommandType.WithInt,
        p2pCommand:{commandType:CommandType.CMD_STOP_REALTIME_MEDIA,channel:0,value:0}});
      const stop=p.sendMessage.mock.calls[1][3] as Buffer;
      expect(refused?stop.subarray(h+10):openSessionControl(stop.subarray(h+10),key,8)).toEqual(Buffer.alloc(4));
    } finally {jest.clearAllTimers();jest.useRealTimers();}
  });

  it("uses full app fields and frame 11 for level-1 own-session start", async () => {
    const p=protocol();Object.assign(p,{gatewayCipherId:7,seqNumber:0,p2pDataSeqNumber:0,
      MAX_COMMAND_QUEUE_TIMEOUT:10000,MAX_SEQUENCE_NUMBER:65535,MAX_AKNOWLEDGE_TIMEOUT:10000,
      RESEND_NOT_ACKNOWLEDGED_COMMAND:10000,sendMessage:jest.fn().mockResolvedValue(undefined),
      currentMessageState:{[P2PDataType.VIDEO]:{p2pStreaming:false}},waitForStreamData:jest.fn(),endStream:jest.fn()});
    jest.useFakeTimers();
    try {
      await p._sendCommand({timestamp:Date.now(),p2pCommandType:InternalP2PCommandType.WithStringPayload,
        p2pCommand:{commandType:CommandType.CMD_DOORBELL_SET_PAYLOAD,channel:0,value:JSON.stringify({commandType:1000,data:{encryptkey:"modulus"}})},nestedCommandType:1000});
      const packet=p.sendMessage.mock.calls[0][3] as Buffer,h=buildCommandHeader(0,CommandType.CMD_DOORBELL_SET_PAYLOAD).length;
      expect(packet[h+7]).toBe(EncryptionType.LEVEL_1);expect(packet[h+8]).toBe(11);
      const body=JSON.parse(decryptP2PData(packet.subarray(h+10),p.p2pKey).toString().replace(/\0+$/, ""));
      expect(body.commandType).toBe(1000);expect(body.data.encryptkey).toBe("modulus");
      expect(body.data.video_type).toBe(12);expect(body.data.streamtype).toBe(2);
      expect(body.data.accountId).toBe("account");expect(body.data.msg_id).toBe(1);
    } finally {jest.clearAllTimers();jest.useRealTimers();}
  });

});
