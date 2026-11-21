import { Camera, Device } from "../device";
import { Station } from "../station";
const validPicture = () => ({
  data: {
    snapshot: {
      data: Buffer.from([255, 216, 255, 1, 2, 3]).toString("base64"),
      mimeType: "image/jpeg",
      capturedAt: new Date().toISOString(),
    },
  },
});
function setup() {
  const camera = Object.create(Camera.prototype) as Camera;
  jest.spyOn(camera, "getStationSerial").mockReturnValue("pro");
  jest.spyOn(camera, "getChannel").mockReturnValue(7);
  const station = {
    getSerial: () => "pro",
    isStationHomeBasePro: () => true,
    isLiveStreaming: jest.fn(() => false),
    mediaStations: new Map(),
    proEventQueryRunning: false,
    runProRequest: jest.fn(async () => validPicture()),
  };
  const capture = (device: Device = camera) =>
    Station.prototype.captureLiveSnapshot.call(station as unknown as Station, device);
  return { camera, station, capture };
}
describe("explicit Pro RTC still", () => {
  const previous = process.env.BAIAMONTE_PRO_EVENT_HELPER;
  beforeEach(() => {
    process.env.BAIAMONTE_PRO_EVENT_HELPER = "/test/helper.py";
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.BAIAMONTE_PRO_EVENT_HELPER;
    else process.env.BAIAMONTE_PRO_EVENT_HELPER = previous;
  });
  it("uses snapshot mode on the camera's station channel and returns the real capture time", async () => {
    const { station, capture } = setup();
    const result = await capture();
    expect(Buffer.from(result.data, "base64").subarray(0, 3)).toEqual(Buffer.from([255, 216, 255]));
    expect(station.runProRequest).toHaveBeenCalledWith("/test/helper.py", expect.any(Date), expect.any(Date), 1, {
      mode: "snapshot",
      cameraChannel: 7,
    });
    expect(station.proEventQueryRunning).toBe(false);
  });
  it("refuses a wrong station and a non-camera before starting a worker", async () => {
    const { camera, station, capture } = setup();
    jest.spyOn(camera, "getStationSerial").mockReturnValue("other");
    await expect(capture()).rejects.toThrow("attached");
    await expect(capture(Object.create(Device.prototype) as Device)).rejects.toThrow("attached");
    expect(station.runProRequest).not.toHaveBeenCalled();
  });
  it("refuses a watched or busy station without ending its operation", async () => {
    const { station, capture } = setup();
    station.isLiveStreaming.mockReturnValue(true);
    await expect(capture()).rejects.toThrow("busy");
    station.isLiveStreaming.mockReturnValue(false);
    station.proEventQueryRunning = true;
    await expect(capture()).rejects.toThrow("busy");
    expect(station.proEventQueryRunning).toBe(true);
    expect(station.runProRequest).not.toHaveBeenCalled();
  });
  it("serializes captures until the first worker finishes", async () => {
    const { station, capture } = setup();
    let finish!: (value: ReturnType<typeof validPicture>) => void;
    station.runProRequest.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const first = capture();
    await expect(capture()).rejects.toThrow("busy");
    finish(validPicture());
    await first;
    expect(station.runProRequest).toHaveBeenCalledTimes(1);
    expect(station.proEventQueryRunning).toBe(false);
  });
  it("releases the station after failed workers and rejects old or non-image output", async () => {
    const { station, capture } = setup();
    station.runProRequest.mockRejectedValueOnce(new Error("worker failed"));
    await expect(capture()).rejects.toThrow("worker failed");
    expect(station.proEventQueryRunning).toBe(false);
    const old = validPicture();
    old.data.snapshot.capturedAt = "2024-01-01T00:00:00Z";
    station.runProRequest.mockResolvedValueOnce(old);
    await expect(capture()).rejects.toThrow("validation");
    const bad = validPicture();
    bad.data.snapshot.data = Buffer.from("not jpeg").toString("base64");
    station.runProRequest.mockResolvedValueOnce(bad);
    await expect(capture()).rejects.toThrow("validation");
    expect(station.proEventQueryRunning).toBe(false);
  });
});
