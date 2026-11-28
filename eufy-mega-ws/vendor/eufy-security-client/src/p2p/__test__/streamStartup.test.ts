import { P2PClientProtocol } from "../session";
import { P2PDataType } from "../types";

const protocol = (): any => {
 const p=Object.create(P2PClientProtocol.prototype) as any;
 Object.assign(p,{streamTimeouts:{streamDataWait:5000,streamStartupWait:20000},
   currentMessageState:{[P2PDataType.VIDEO]:{p2pStreamFirstVideoDataReceived:false},[P2PDataType.BINARY]:{}},endStream:jest.fn()});return p;
};
describe("bounded first-video startup",()=>{
 beforeEach(()=>{jest.useFakeTimers();jest.setSystemTime(0)});
 afterEach(()=>{jest.clearAllTimers();jest.useRealTimers()});
 it("survives the old five-second cutoff but stops at twenty seconds",()=>{
  const p=protocol();p.waitForStreamData(P2PDataType.VIDEO,true);
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
});
