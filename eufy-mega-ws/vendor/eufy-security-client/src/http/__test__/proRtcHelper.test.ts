import { EventEmitter } from "events";
import { spawn } from "child_process";
import { runProRtcHelper } from "../proRtcHelper";
jest.mock("child_process", () => ({ spawn: jest.fn() }));
function child() {
  const process = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: { end: jest.fn() },
    kill: jest.fn(() => true),
  });
  (spawn as jest.Mock).mockReturnValue(process);
  return process;
}
describe("bounded Pro worker lifetime", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });
  afterEach(() => {
    jest.useRealTimers();
  });
  it("does not finish on output until the worker closes its session", async () => {
    const p = child();
    const result = runProRtcHelper("python", "helper", { mode: "snapshot" });
    let settled = false;
    result.then(() => {
      settled = true;
    });
    p.stdout.emit("data", Buffer.from('{"data":{"snapshot":{}}}'));
    await Promise.resolve();
    expect(settled).toBe(false);
    p.emit("close", 0);
    await expect(result).resolves.toEqual({ data: { snapshot: {} } });
    expect(jest.getTimerCount()).toBe(0);
  });
  it("keeps the station owned during timeout cleanup and kills a stuck child", async () => {
    const p = child();
    const result = runProRtcHelper("python", "helper", {});
    let settled = false;
    result.catch(() => {
      settled = true;
    });
    jest.advanceTimersByTime(60_000);
    await Promise.resolve();
    expect(p.kill).toHaveBeenCalledWith("SIGTERM");
    expect(settled).toBe(false);
    jest.advanceTimersByTime(2_000);
    expect(p.kill).toHaveBeenCalledWith("SIGKILL");
    p.emit("close", null);
    await expect(result).rejects.toThrow("timed out");
    expect(jest.getTimerCount()).toBe(0);
  });
  it("bounds output and waits for teardown before reporting failure", async () => {
    const p = child();
    const result = runProRtcHelper("python", "helper", {});
    result.catch(() => undefined);
    p.stdout.emit("data", Buffer.alloc(16 * 1024 * 1024 + 1));
    expect(p.kill).toHaveBeenCalledWith("SIGTERM");
    p.emit("close", 1);
    await expect(result).rejects.toThrow("16 MB");
    expect(jest.getTimerCount()).toBe(0);
  });
  it("cleans up a broken stdin rather than leaking a waiting worker", async () => {
    const p = child();
    p.stdin.end.mockImplementation(() => {
      throw new Error("stdin closed");
    });
    const result = runProRtcHelper("python", "helper", {});
    result.catch(() => undefined);
    expect(p.kill).toHaveBeenCalledWith("SIGTERM");
    p.emit("close", 1);
    await expect(result).rejects.toThrow("stdin closed");
    expect(jest.getTimerCount()).toBe(0);
  });
});
