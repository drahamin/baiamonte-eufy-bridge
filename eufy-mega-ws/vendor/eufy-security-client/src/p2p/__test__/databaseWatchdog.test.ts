import { Station } from "../../http/station";
import { DatabaseReadWatchdog } from "../databaseWatchdog";
describe("bounded station history recovery", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  const silent = (guard: DatabaseReadWatchdog) => { guard.begin(); jest.advanceTimersByTime(35000); };
  it("never reconnects a station that has never answered", () => {
    const reopen=jest.fn(); const g=new DatabaseReadWatchdog(()=>true,reopen);
    for(let i=0;i<8;i++) silent(g);
    expect(reopen).not.toHaveBeenCalled();
  });
  it("reconnects once after three silent windows and requires a new answer before repeating", () => {
    const reopen=jest.fn(); const g=new DatabaseReadWatchdog(()=>true,reopen); g.reply();
    silent(g); silent(g); expect(reopen).not.toHaveBeenCalled(); silent(g);
    expect(reopen).toHaveBeenCalledTimes(1);
    for(let i=0;i<8;i++) silent(g);
    expect(reopen).toHaveBeenCalledTimes(1);
  });
  it("empty/rejected replies reset silence; concurrent requests share one window", () => {
    const reopen=jest.fn(); const g=new DatabaseReadWatchdog(()=>true,reopen);g.reply();
    silent(g);silent(g);g.begin();g.begin();g.reply();jest.advanceTimersByTime(35000);
    silent(g);silent(g);expect(reopen).not.toHaveBeenCalled();
  });
  it("does not count reads while live video or a recording is active", () => {
    const reopen=jest.fn(); const g=new DatabaseReadWatchdog(()=>false,reopen);g.reply();
    for(let i=0;i<8;i++) silent(g);
    expect(reopen).not.toHaveBeenCalled();
  });
  it("disconnect/unload cancels its timer", () => {
    const reopen=jest.fn(); const g=new DatabaseReadWatchdog(()=>true,reopen);g.reply();
    silent(g);silent(g);g.begin();g.reset();jest.advanceTimersByTime(70000);
    expect(reopen).not.toHaveBeenCalled();
  });
  it("station latest-history requests and replies are wired to the guard", () => {
    const station = Object.create(Station.prototype) as any;
    Object.assign(station,{databaseReadWatchdog:{begin:jest.fn(),reply:jest.fn()},
      rawStation:{station_sn:"T8030TEST",member:{admin_user_id:"account"}},
      hasCommand:()=>true, p2pSession:{sendCommandWithStringPayload:jest.fn()}, emit:jest.fn()});
    station.databaseQueryLatestInfo();
    expect(station.databaseReadWatchdog.begin).toHaveBeenCalledTimes(1);
    station.onDatabaseQueryLatest(0,[]);
    expect(station.databaseReadWatchdog.reply).toHaveBeenCalledTimes(1);
  });

});
