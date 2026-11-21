import { PushClient } from "../client";
import { MessageTag } from "../models";

const client = (): any => {
  const c = Object.create(PushClient.prototype) as any;
  Object.assign(c, {
    loggedIn: true, lastRxAt: Date.now(), streamId: 0, lastStreamIdReported: 0,
    HEARTBEAT_INTERVAL: 300000, client: { write: jest.fn(), destroy: jest.fn() },
    buildHeartbeatPingRequest: jest.fn().mockReturnValue(Buffer.from([0])),
    scheduleReconnect: jest.fn(), resetCurrentDelay: jest.fn(),
  });
  return c;
};

describe("MCS receive silence watchdog", () => {
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(1000000); });
  afterEach(() => jest.useRealTimers());
  it("does not confuse a quiet camera with a dead connection, then retires an unanswered ping", () => {
    const c = client();
    expect(c.sendHeartbeat()).toBe(true);
    jest.advanceTimersByTime(300000);
    expect(c.sendHeartbeat()).toBe(false);
    expect(c.client.write).toHaveBeenCalledTimes(1);
    expect(c.client.destroy).toHaveBeenCalledTimes(1);
    expect(c.scheduleReconnect).toHaveBeenCalledTimes(1);
    expect(c.loggedIn).toBe(false);
  });
  it("an inbound acknowledgement keeps the socket alive even without camera detections", () => {
    const c = client();
    c.sendHeartbeat();
    jest.advanceTimersByTime(1000);
    c.handleParsedMessage({ tag: MessageTag.HeartbeatAck, object: {} });
    jest.advanceTimersByTime(300000);
    expect(c.sendHeartbeat()).toBe(true);
    expect(c.client.destroy).not.toHaveBeenCalled();
  });
  it("explicit close clears the heartbeat and its reconnect attempt", () => {
    const c = client();
    c.pushClientParser = { resetState: jest.fn() };
    c.client.removeAllListeners = jest.fn();
    c.heartbeatTimeout = setTimeout(() => c.sendHeartbeat(), 300000);
    c.reconnectTimeout = setTimeout(() => c.connect(), 5000);
    c.initialize();
    jest.advanceTimersByTime(600000);
    expect(c.client).toBeUndefined();
    expect(c.scheduleReconnect).not.toHaveBeenCalled();
  });
});
