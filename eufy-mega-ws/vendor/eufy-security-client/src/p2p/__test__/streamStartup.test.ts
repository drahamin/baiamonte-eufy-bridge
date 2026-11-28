import { P2PClientProtocol } from "../session";
import { CommandType, P2PDataType } from "../types";

const protocol = (): any => {
 const p=Object.create(P2PClientProtocol.prototype) as any;
 Object.assign(p,{streamTimeouts:{streamDataWait:5000,streamStartupWait:20000},
   currentMessageState:{[P2PDataType.VIDEO]:{p2pStreamFirstVideoDataReceived:false},[P2PDataType.BINARY]:{}},endStream:jest.fn()});return p;
};
describe("bounded first-video startup",()=>{
 beforeEach(()=>{jest.useFakeTimers();jest.setSystemTime(0)});
 afterEach(()=>{jest.clearAllTimers();jest.useRealTimers()});
 it("survives the old five-second cutoff but stops at twenty seconds",()=>{
  const p=protocol();p.waitForStreamData(P2PDataType.VIDEO);
  jest.advanceTimersByTime(5000);expect(p.endStream).not.toHaveBeenCalled();
  jest.advanceTimersByTime(14999);expect(p.endStream).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1);expect(p.endStream).toHaveBeenCalledWith(P2PDataType.VIDEO,true);
 });
 it("partial traffic and command replies cannot keep extending startup",()=>{
  const p=protocol();p.waitForStreamData(P2PDataType.VIDEO);
  jest.advanceTimersByTime(12000);p.waitForStreamData(P2PDataType.VIDEO,true);
  jest.advanceTimersByTime(8000);expect(p.endStream).toHaveBeenCalledTimes(1);
 });
 it("a first frame restores the short stalled-stream timeout",()=>{
  const p=protocol();p.waitForStreamData(P2PDataType.VIDEO);
  jest.advanceTimersByTime(7000);p.currentMessageState[P2PDataType.VIDEO].p2pStreamFirstVideoDataReceived=true;
  p.waitForStreamData(P2PDataType.VIDEO,true);jest.advanceTimersByTime(4999);expect(p.endStream).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1);expect(p.endStream).toHaveBeenCalledTimes(1);
 });
 it("recording transfers keep their existing data timeout",()=>{
  const p=protocol();p.waitForStreamData(P2PDataType.BINARY,true);jest.advanceTimersByTime(5000);
  expect(p.endStream).toHaveBeenCalledWith(P2PDataType.BINARY,true);
 });
 it.each([100,19950])("starts the short stall window after the real first-frame handler at %sms",(firstAt)=>{
  const p=protocol();p.rawStation={station_sn:"T8410TEST"};p.videoUnits={push:()=>undefined};
  Object.assign(p.currentMessageState[P2PDataType.VIDEO],{invalidStream:false,p2pStreamMetadata:{},p2pStreamFirstAudioDataReceived:true,p2pStreamNotStarted:false});
  p.waitForStreamData(P2PDataType.VIDEO);jest.advanceTimersByTime(firstAt);
  const header=Buffer.alloc(22),payload=Buffer.from([0,0,0,1,0x65,1]);header.writeUInt32LE(payload.length);header[4]=1;header[5]=1;
  p.handleDataBinaryAndVideo({commandId:CommandType.CMD_VIDEO_FRAME,dataType:P2PDataType.VIDEO,channel:0,signCode:0,data:Buffer.concat([header,payload])});
  expect(p.currentMessageState[P2PDataType.VIDEO].p2pStreamFirstVideoDataReceived).toBe(true);
  jest.advanceTimersByTime(4999);expect(p.endStream).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1);expect(p.endStream).toHaveBeenCalledWith(P2PDataType.VIDEO,true);
 });

});
