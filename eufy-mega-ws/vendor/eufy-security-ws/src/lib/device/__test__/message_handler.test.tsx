import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const mockDumpDeviceProperties = jest
  .fn()
  .mockReturnValue({ prop1: "value1" });
const mockDumpDevicePropertiesMetadata = jest
  .fn()
  .mockReturnValue({ prop1: "metadata1" });

jest.unstable_mockModule("../properties.js", () => ({
  dumpDeviceProperties: mockDumpDeviceProperties,
  dumpDevicePropertiesMetadata: mockDumpDevicePropertiesMetadata,
}));

const { DeviceMessageHandler } = await import("../message_handler.js");
const { DeviceCommand } = await import("../command.js");
const { DeviceEvent } = await import("../event.js");
const {
  LivestreamAlreadyRunningError,
  LivestreamNotRunningError,
  DownloadAlreadyRunningError,
  DownloadNotRunningError,
  DownloadOnlyOneAtATimeError,
  TalkbackAlreadyRunningError,
  TalkbackNotRunningError,
  TalkbackOnlyOneAtATimeError,
  UnknownCommandError,
} = await import("../../error.js");

// --- Mock factories ---

function createMockDevice(
  serial = "DEVICE001",
  stationSerial = "STATION001",
) {
  return {
    getStationSerial: jest.fn().mockReturnValue(stationSerial),
    getSerial: jest.fn().mockReturnValue(serial),
    getPropertiesMetadata: jest
      .fn()
      .mockReturnValue({ prop1: "metadata_raw" }),
    getProperties: jest.fn().mockReturnValue({ prop1: "value_raw" }),
    hasProperty: jest.fn().mockReturnValue(true),
    hasCommand: jest.fn().mockReturnValue(true),
    getCommands: jest.fn().mockReturnValue(["devicePanAndTilt", "deviceOpen"]),
  };
}

function createMockStation(serial = "STATION001") {
  return {
    getSerial: jest.fn().mockReturnValue(serial),
    setStatusLed: jest.fn(),
    setAutoNightVision: jest.fn(),
    setMotionDetection: jest.fn(),
    setSoundDetection: jest.fn(),
    setPetDetection: jest.fn(),
    setRTSPStream: jest.fn(),
    setAntiTheftDetection: jest.fn(),
    setWatermark: jest.fn(),
    enableDevice: jest.fn(),
    lockDevice: jest.fn(),
    isLiveStreaming: jest.fn().mockReturnValue(false),
    startLivestream: jest.fn(),
    stopLivestream: jest.fn(),
    isDownloading: jest.fn().mockReturnValue(false),
    startDownload: jest.fn().mockResolvedValue(undefined),
    cancelDownload: jest.fn(),
    triggerDeviceAlarmSound: jest.fn(),
    resetDeviceAlarmSound: jest.fn(),
    panAndTilt: jest.fn(),
    quickResponse: jest.fn(),
    startRTSPStream: jest.fn(),
    stopRTSPStream: jest.fn(),
    isRTSPLiveStreaming: jest.fn().mockReturnValue(false),
    calibrateLock: jest.fn(),
    calibrate: jest.fn(),
    setDefaultAngle: jest.fn(),
    setPrivacyAngle: jest.fn(),
    unlock: jest.fn(),
    isTalkbackOngoing: jest.fn().mockReturnValue(false),
    startTalkback: jest.fn(),
    stopTalkback: jest.fn(),
    snooze: jest.fn(),
    verifyPIN: jest.fn(),
    presetPosition: jest.fn(),
    savePresetPosition: jest.fn(),
    deletePresetPosition: jest.fn(),
    open: jest.fn(),
  };
}

function createMockDriver(device: any, station: any) {
  return {
    getDevice: jest.fn().mockResolvedValue(device),
    getStation: jest.fn().mockResolvedValue(station),
    setDeviceProperty: jest.fn().mockResolvedValue(undefined),
    getApi: jest.fn().mockReturnValue({
      getVoices: jest.fn().mockResolvedValue([]),
      getUsers: jest.fn().mockResolvedValue([]),
    }),
    addUser: jest.fn().mockResolvedValue(undefined),
    deleteUser: jest.fn().mockResolvedValue(undefined),
    updateUser: jest.fn().mockResolvedValue(undefined),
    updateUserPasscode: jest.fn().mockResolvedValue(undefined),
    updateUserSchedule: jest.fn().mockResolvedValue(undefined),
  } as any;
}

function createMockClient(schemaVersion = 13) {
  return {
    schemaVersion,
    receiveLivestream: {} as Record<string, boolean>,
    receiveDownloadStream: {} as Record<string, boolean>,
    sendTalkbackStream: {} as Record<string, boolean>,
    sendEvent: jest.fn(),
  } as any;
}

// --- Tests ---

describe("DeviceMessageHandler", () => {
  let mockDevice: ReturnType<typeof createMockDevice>;
  let mockStation: ReturnType<typeof createMockStation>;
  let mockDriver: ReturnType<typeof createMockDriver>;
  let mockClient: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    // Reset static state
    (DeviceMessageHandler as any).streamingDevices = {};
    (DeviceMessageHandler as any).downloadingDevices = {};
    (DeviceMessageHandler as any).talkbackingDevices = {};
    DeviceMessageHandler.talkbackStream = undefined;

    mockDevice = createMockDevice();
    mockStation = createMockStation();
    mockDriver = createMockDriver(mockDevice, mockStation);
    mockClient = createMockClient();

    mockDumpDeviceProperties.mockClear();
    mockDumpDevicePropertiesMetadata.mockClear();
  });

  // --- Static device management ---

  describe("streaming device management", () => {
    it("returns empty array for unknown station", () => {
      expect(DeviceMessageHandler.getStreamingDevices("UNKNOWN")).toEqual([]);
    });

    it("adds and retrieves a streaming device", () => {
      DeviceMessageHandler.addStreamingDevice("ST1", mockClient);
      expect(DeviceMessageHandler.getStreamingDevices("ST1")).toEqual([
        mockClient,
      ]);
    });

    it("does not add the same client twice", () => {
      DeviceMessageHandler.addStreamingDevice("ST1", mockClient);
      DeviceMessageHandler.addStreamingDevice("ST1", mockClient);
      expect(DeviceMessageHandler.getStreamingDevices("ST1")).toHaveLength(1);
    });

    it("adds multiple different clients", () => {
      const client2 = createMockClient();
      DeviceMessageHandler.addStreamingDevice("ST1", mockClient);
      DeviceMessageHandler.addStreamingDevice("ST1", client2);
      expect(DeviceMessageHandler.getStreamingDevices("ST1")).toHaveLength(2);
    });

    it("removes a streaming device", () => {
      DeviceMessageHandler.addStreamingDevice("ST1", mockClient);
      DeviceMessageHandler.removeStreamingDevice("ST1", mockClient);
      expect(DeviceMessageHandler.getStreamingDevices("ST1")).toEqual([]);
    });

    it("remove is no-op for unknown station", () => {
      DeviceMessageHandler.removeStreamingDevice("UNKNOWN", mockClient);
      expect(DeviceMessageHandler.getStreamingDevices("UNKNOWN")).toEqual([]);
    });
  });

  describe("downloading device management", () => {
    it("returns empty array for unknown station", () => {
      expect(DeviceMessageHandler.getDownloadingDevices("UNKNOWN")).toEqual([]);
    });

    it("adds and retrieves a downloading device", () => {
      DeviceMessageHandler.addDownloadingDevice("ST1", mockClient);
      expect(DeviceMessageHandler.getDownloadingDevices("ST1")).toEqual([
        mockClient,
      ]);
    });

    it("does not add the same client twice", () => {
      DeviceMessageHandler.addDownloadingDevice("ST1", mockClient);
      DeviceMessageHandler.addDownloadingDevice("ST1", mockClient);
      expect(DeviceMessageHandler.getDownloadingDevices("ST1")).toHaveLength(1);
    });

    it("removes a downloading device", () => {
      DeviceMessageHandler.addDownloadingDevice("ST1", mockClient);
      DeviceMessageHandler.removeDownloadingDevice("ST1", mockClient);
      expect(DeviceMessageHandler.getDownloadingDevices("ST1")).toEqual([]);
    });
  });

  describe("talkbacking device management", () => {
    it("returns empty array for unknown station", () => {
      expect(DeviceMessageHandler.getTalkbackingDevices("UNKNOWN")).toEqual([]);
    });

    it("adds and retrieves a talkbacking device", () => {
      DeviceMessageHandler.addTalkbackingDevice("ST1", mockClient);
      expect(DeviceMessageHandler.getTalkbackingDevices("ST1")).toEqual([
        mockClient,
      ]);
    });

    it("does not add the same client twice", () => {
      DeviceMessageHandler.addTalkbackingDevice("ST1", mockClient);
      DeviceMessageHandler.addTalkbackingDevice("ST1", mockClient);
      expect(DeviceMessageHandler.getTalkbackingDevices("ST1")).toHaveLength(1);
    });

    it("removes a talkbacking device", () => {
      DeviceMessageHandler.addTalkbackingDevice("ST1", mockClient);
      DeviceMessageHandler.removeTalkbackingDevice("ST1", mockClient);
      expect(DeviceMessageHandler.getTalkbackingDevices("ST1")).toEqual([]);
    });
  });

  // --- Deprecated commands (schema <= 12) ---

  describe("deprecated commands (schema <= 12)", () => {
    beforeEach(() => {
      mockClient = createMockClient(12);
    });

    it.each([
      {
        cmd: DeviceCommand.setStatusLed,
        method: "setStatusLed",
        extra: { value: true },
      },
      {
        cmd: DeviceCommand.setAutoNightVision,
        method: "setAutoNightVision",
        extra: { value: true },
      },
      {
        cmd: DeviceCommand.setMotionDetection,
        method: "setMotionDetection",
        extra: { value: true },
      },
      {
        cmd: DeviceCommand.setSoundDetection,
        method: "setSoundDetection",
        extra: { value: true },
      },
      {
        cmd: DeviceCommand.setPetDetection,
        method: "setPetDetection",
        extra: { value: true },
      },
      {
        cmd: DeviceCommand.setRTSPStream,
        method: "setRTSPStream",
        extra: { value: true },
      },
      {
        cmd: DeviceCommand.setAntiTheftDetection,
        method: "setAntiTheftDetection",
        extra: { value: true },
      },
      {
        cmd: DeviceCommand.setWatermark,
        method: "setWatermark",
        extra: { value: 1 },
      },
      {
        cmd: DeviceCommand.enableDevice,
        method: "enableDevice",
        extra: { value: true },
      },
      {
        cmd: DeviceCommand.lockDevice,
        method: "lockDevice",
        extra: { value: true },
      },
    ])(
      "$cmd calls station.$method and returns empty object",
      async ({ cmd, method, extra }) => {
        const message = {
          command: cmd,
          serialNumber: "DEVICE001",
          messageId: "msg1",
          ...extra,
        } as any;

        const result = await DeviceMessageHandler.handle(
          message,
          mockDriver,
          mockClient,
        );

        expect(mockStation[method as keyof typeof mockStation]).toHaveBeenCalled();
        expect(result).toEqual({});
      },
    );

    it.each([
      DeviceCommand.setStatusLed,
      DeviceCommand.setAutoNightVision,
      DeviceCommand.setMotionDetection,
      DeviceCommand.setSoundDetection,
      DeviceCommand.setPetDetection,
      DeviceCommand.setRTSPStream,
      DeviceCommand.setAntiTheftDetection,
      DeviceCommand.setWatermark,
      DeviceCommand.enableDevice,
      DeviceCommand.lockDevice,
    ])(
      "%s throws UnknownCommandError for schema >= 13",
      async (cmd) => {
        mockClient = createMockClient(13);
        const message = {
          command: cmd,
          serialNumber: "DEVICE001",
          messageId: "msg1",
          value: true,
        } as any;

        await expect(
          DeviceMessageHandler.handle(message, mockDriver, mockClient),
        ).rejects.toThrow(UnknownCommandError);
      },
    );
  });

  // --- getPropertiesMetadata ---

  describe("getPropertiesMetadata", () => {
    const message = {
      command: DeviceCommand.getPropertiesMetadata,
      serialNumber: "DEVICE001",
      messageId: "msg1",
    } as any;

    it("schema <= 3: returns properties without serialNumber", async () => {
      mockClient = createMockClient(3);
      const result = await DeviceMessageHandler.handle(
        message,
        mockDriver,
        mockClient,
      );
      expect(result).toEqual({ properties: { prop1: "metadata_raw" } });
    });

    it("schema 4-12: returns properties with serialNumber", async () => {
      mockClient = createMockClient(8);
      const result = await DeviceMessageHandler.handle(
        message,
        mockDriver,
        mockClient,
      );
      expect(result).toEqual({
        serialNumber: "DEVICE001",
        properties: { prop1: "metadata_raw" },
      });
    });

    it("schema >= 13: returns dumped properties with serialNumber", async () => {
      mockClient = createMockClient(13);
      const result = await DeviceMessageHandler.handle(
        message,
        mockDriver,
        mockClient,
      );
      expect(mockDumpDevicePropertiesMetadata).toHaveBeenCalledWith(
        mockDevice,
        13,
      );
      expect(result).toEqual({
        serialNumber: "DEVICE001",
        properties: { prop1: "metadata1" },
      });
    });
  });

  // --- getProperties ---

  describe("getProperties", () => {
    const message = {
      command: DeviceCommand.getProperties,
      serialNumber: "DEVICE001",
      messageId: "msg1",
    } as any;

    it("schema <= 3: returns properties without serialNumber", async () => {
      mockClient = createMockClient(3);
      const result = await DeviceMessageHandler.handle(
        message,
        mockDriver,
        mockClient,
      );
      expect(result).toEqual({ properties: { prop1: "value_raw" } });
    });

    it("schema 4-12: returns properties with serialNumber", async () => {
      mockClient = createMockClient(6);
      const result = await DeviceMessageHandler.handle(
        message,
        mockDriver,
        mockClient,
      );
      expect(result).toEqual({
        serialNumber: "DEVICE001",
        properties: { prop1: "value_raw" },
      });
    });

    it("schema >= 13: returns dumped properties with serialNumber", async () => {
      mockClient = createMockClient(13);
      const result = await DeviceMessageHandler.handle(
        message,
        mockDriver,
        mockClient,
      );
      expect(mockDumpDeviceProperties).toHaveBeenCalledWith(mockDevice, 13);
      expect(result).toEqual({
        serialNumber: "DEVICE001",
        properties: { prop1: "value1" },
      });
    });
  });

  // --- setProperty ---

  describe("setProperty", () => {
    it("calls driver.setDeviceProperty and returns {} for schema <= 12", async () => {
      mockClient = createMockClient(12);
      const message = {
        command: DeviceCommand.setProperty,
        serialNumber: "DEVICE001",
        messageId: "msg1",
        name: "motionDetection",
        value: true,
      } as any;

      const result = await DeviceMessageHandler.handle(
        message,
        mockDriver,
        mockClient,
      );
      expect(mockDriver.setDeviceProperty).toHaveBeenCalledWith(
        "DEVICE001",
        "motionDetection",
        true,
      );
      expect(result).toEqual({});
    });

    it("returns { async: true } for schema >= 13", async () => {
      mockClient = createMockClient(13);
      const message = {
        command: DeviceCommand.setProperty,
        serialNumber: "DEVICE001",
        messageId: "msg1",
        name: "motionDetection",
        value: false,
      } as any;

      const result = await DeviceMessageHandler.handle(
        message,
        mockDriver,
        mockClient,
      );
      expect(result).toEqual({ async: true });
    });
  });

  // --- Livestream ---

  describe("startLivestream", () => {
    const message = {
      command: DeviceCommand.startLivestream,
      serialNumber: "DEVICE001",
      messageId: "msg1",
    } as any;

    it("throws UnknownCommandError for schema < 2", async () => {
      mockClient = createMockClient(1);
      await expect(
        DeviceMessageHandler.handle(message, mockDriver, mockClient),
      ).rejects.toThrow(UnknownCommandError);
    });

    it("starts livestream when not already streaming", async () => {
      mockClient = createMockClient(13);
      mockStation.isLiveStreaming.mockReturnValue(false);

      const result = await DeviceMessageHandler.handle(
        message,
        mockDriver,
        mockClient,
      );

      expect(mockStation.startLivestream).toHaveBeenCalledWith(mockDevice);
      expect(mockClient.receiveLivestream["DEVICE001"]).toBe(true);
      expect(
        DeviceMessageHandler.getStreamingDevices("STATION001"),
      ).toContain(mockClient);
      expect(result).toEqual({ async: true });
    });

    it("sends event when another client joins existing livestream", async () => {
      mockClient = createMockClient(13);
      mockStation.isLiveStreaming.mockReturnValue(true);
      // client has not yet requested the stream
      mockClient.receiveLivestream["DEVICE001"] = undefined as any;

      const result = await DeviceMessageHandler.handle(
        message,
        mockDriver,
        mockClient,
      );

      expect(mockStation.startLivestream).not.toHaveBeenCalled();
      expect(mockClient.sendEvent).toHaveBeenCalledWith({
        source: "device",
        event: DeviceEvent.livestreamStarted,
        serialNumber: "DEVICE001",
      });
      expect(mockClient.receiveLivestream["DEVICE001"]).toBe(true);
      expect(result).toEqual({ async: true });
    });

    it("throws LivestreamAlreadyRunningError when same client requests again", async () => {
      mockClient = createMockClient(13);
      mockStation.isLiveStreaming.mockReturnValue(true);
      mockClient.receiveLivestream["DEVICE001"] = true;

      await expect(
        DeviceMessageHandler.handle(message, mockDriver, mockClient),
      ).rejects.toThrow(LivestreamAlreadyRunningError);
    });

    it("returns {} for schema 2-12", async () => {
      mockClient = createMockClient(10);
      mockStation.isLiveStreaming.mockReturnValue(false);

      const result = await DeviceMessageHandler.handle(
        message,
        mockDriver,
        mockClient,
      );
      expect(result).toEqual({});
    });
  });

  describe("stopLivestream", () => {
    const message = {
      command: DeviceCommand.stopLivestream,
      serialNumber: "DEVICE001",
      messageId: "msg1",
    } as any;

    it("throws UnknownCommandError for schema < 2", async () => {
      mockClient = createMockClient(1);
      await expect(
        DeviceMessageHandler.handle(message, mockDriver, mockClient),
      ).rejects.toThrow(UnknownCommandError);
    });

    it("throws LivestreamNotRunningError when not streaming", async () => {
      mockClient = createMockClient(13);
      mockStation.isLiveStreaming.mockReturnValue(false);

      await expect(
        DeviceMessageHandler.handle(message, mockDriver, mockClient),
      ).rejects.toThrow(LivestreamNotRunningError);
    });

    it("throws LivestreamNotRunningError when client did not start stream", async () => {
      mockClient = createMockClient(13);
      mockStation.isLiveStreaming.mockReturnValue(true);
      mockClient.receiveLivestream["DEVICE001"] = false;

      await expect(
        DeviceMessageHandler.handle(message, mockDriver, mockClient),
      ).rejects.toThrow(LivestreamNotRunningError);
    });

    it("stops station livestream when last client disconnects", async () => {
      mockClient = createMockClient(13);
      mockStation.isLiveStreaming.mockReturnValue(true);
      mockClient.receiveLivestream["DEVICE001"] = true;
      DeviceMessageHandler.addStreamingDevice("STATION001", mockClient);

      const result = await DeviceMessageHandler.handle(
        message,
        mockDriver,
        mockClient,
      );

      expect(mockStation.stopLivestream).toHaveBeenCalledWith(mockDevice);
      expect(
        DeviceMessageHandler.getStreamingDevices("STATION001"),
      ).not.toContain(mockClient);
      expect(result).toEqual({ async: true });
    });

    it("sends stop event but does not stop station when other clients remain", async () => {
      const client2 = createMockClient(13);
      mockClient = createMockClient(13);
      mockStation.isLiveStreaming.mockReturnValue(true);
      mockClient.receiveLivestream["DEVICE001"] = true;
      DeviceMessageHandler.addStreamingDevice("STATION001", client2);
      DeviceMessageHandler.addStreamingDevice("STATION001", mockClient);

      const result = await DeviceMessageHandler.handle(
        message,
        mockDriver,
        mockClient,
      );

      expect(mockStation.stopLivestream).not.toHaveBeenCalled();
      expect(mockClient.receiveLivestream["DEVICE001"]).toBe(false);
      expect(mockClient.sendEvent).toHaveBeenCalledWith({
        source: "device",
        event: DeviceEvent.livestreamStopped,
        serialNumber: "DEVICE001",
      });
      expect(result).toEqual({ async: true });
    });
  });

  describe("isLiveStreaming", () => {
    const message = {
      command: DeviceCommand.isLiveStreaming,
      serialNumber: "DEVICE001",
      messageId: "msg1",
    } as any;

    it("throws UnknownCommandError for schema < 2", async () => {
      mockClient = createMockClient(1);
      await expect(
        DeviceMessageHandler.handle(message, mockDriver, mockClient),
      ).rejects.toThrow(UnknownCommandError);
    });

    it("schema 2-3: returns livestreaming without serialNumber", async () => {
      mockClient = createMockClient(3);
      mockStation.isLiveStreaming.mockReturnValue(true);

      const result = await DeviceMessageHandler.handle(
        message,
        mockDriver,
        mockClient,
      );
      expect(result).toEqual({ livestreaming: true });
    });

    it("schema >= 4: returns livestreaming with serialNumber", async () => {
      mockClient = createMockClient(13);
      mockStation.isLiveStreaming.mockReturnValue(false);

      const result = await DeviceMessageHandler.handle(
        message,
        mockDriver,
        mockClient,
      );
      expect(result).toEqual({
        serialNumber: "DEVICE001",
        livestreaming: false,
      });
    });
  });

  // --- Download ---

  describe("startDownload", () => {
    const message = {
      command: DeviceCommand.startDownload,
      serialNumber: "DEVICE001",
      messageId: "msg1",
      path: "/media/video.mp4",
      cipherId: 1,
    } as any;

    it("throws UnknownCommandError for schema < 3", async () => {
      mockClient = createMockClient(2);
      await expect(
        DeviceMessageHandler.handle(message, mockDriver, mockClient),
      ).rejects.toThrow(UnknownCommandError);
    });

    it("starts download when not already downloading", async () => {
      mockClient = createMockClient(13);
      mockStation.isDownloading.mockReturnValue(false);

      const result = await DeviceMessageHandler.handle(
        message,
        mockDriver,
        mockClient,
      );

      expect(mockStation.startDownload).toHaveBeenCalledWith(
        mockDevice,
        "/media/video.mp4",
        1,
      );
      expect(mockClient.receiveDownloadStream["DEVICE001"]).toBe(true);
      expect(
        DeviceMessageHandler.getDownloadingDevices("STATION001"),
      ).toContain(mockClient);
      expect(result).toEqual({ async: true });
    });

    it("throws DownloadOnlyOneAtATimeError when another client is downloading", async () => {
      mockClient = createMockClient(13);
      mockStation.isDownloading.mockReturnValue(true);
      mockClient.receiveDownloadStream["DEVICE001"] = undefined as any;

      await expect(
        DeviceMessageHandler.handle(message, mockDriver, mockClient),
      ).rejects.toThrow(DownloadOnlyOneAtATimeError);
    });

    it("throws DownloadAlreadyRunningError when same client requests again", async () => {
      mockClient = createMockClient(13);
      mockStation.isDownloading.mockReturnValue(true);
      mockClient.receiveDownloadStream["DEVICE001"] = true;

      await expect(
        DeviceMessageHandler.handle(message, mockDriver, mockClient),
      ).rejects.toThrow(DownloadAlreadyRunningError);
    });
  });

  describe("cancelDownload", () => {
    const message = {
      command: DeviceCommand.cancelDownload,
      serialNumber: "DEVICE001",
      messageId: "msg1",
    } as any;

    it("throws UnknownCommandError for schema < 3", async () => {
      mockClient = createMockClient(2);
      await expect(
        DeviceMessageHandler.handle(message, mockDriver, mockClient),
      ).rejects.toThrow(UnknownCommandError);
    });

    it("throws DownloadNotRunningError when not downloading", async () => {
      mockClient = createMockClient(13);
      mockStation.isDownloading.mockReturnValue(false);

      await expect(
        DeviceMessageHandler.handle(message, mockDriver, mockClient),
      ).rejects.toThrow(DownloadNotRunningError);
    });

    it("throws DownloadNotRunningError when client did not start download", async () => {
      mockClient = createMockClient(13);
      mockStation.isDownloading.mockReturnValue(true);
      mockClient.receiveDownloadStream["DEVICE001"] = false;

      await expect(
        DeviceMessageHandler.handle(message, mockDriver, mockClient),
      ).rejects.toThrow(DownloadNotRunningError);
    });

    it("cancels download when the only client", async () => {
      mockClient = createMockClient(13);
      mockStation.isDownloading.mockReturnValue(true);
      mockClient.receiveDownloadStream["DEVICE001"] = true;
      DeviceMessageHandler.addDownloadingDevice("STATION001", mockClient);

      const result = await DeviceMessageHandler.handle(
        message,
        mockDriver,
        mockClient,
      );

      expect(mockStation.cancelDownload).toHaveBeenCalledWith(mockDevice);
      expect(
        DeviceMessageHandler.getDownloadingDevices("STATION001"),
      ).not.toContain(mockClient);
      expect(result).toEqual({ async: true });
    });
  });

  describe("isDownloading", () => {
    const message = {
      command: DeviceCommand.isDownloading,
      serialNumber: "DEVICE001",
      messageId: "msg1",
    } as any;

    it("throws UnknownCommandError for schema < 13", async () => {
      mockClient = createMockClient(12);
      await expect(
        DeviceMessageHandler.handle(message, mockDriver, mockClient),
      ).rejects.toThrow(UnknownCommandError);
    });

    it("returns downloading state for schema >= 13", async () => {
      mockClient = createMockClient(13);
      mockStation.isDownloading.mockReturnValue(true);

      const result = await DeviceMessageHandler.handle(
        message,
        mockDriver,
        mockClient,
      );
      expect(result).toEqual({
        serialNumber: "DEVICE001",
        downloading: true,
      });
    });
  });

  // --- Talkback ---

  describe("startTalkback", () => {
    const message = {
      command: DeviceCommand.startTalkback,
      serialNumber: "DEVICE001",
      messageId: "msg1",
    } as any;

    it("throws UnknownCommandError for schema < 13", async () => {
      mockClient = createMockClient(12);
      await expect(
        DeviceMessageHandler.handle(message, mockDriver, mockClient),
      ).rejects.toThrow(UnknownCommandError);
    });

    it("starts talkback when not already ongoing", async () => {
      mockClient = createMockClient(13);
      mockStation.isTalkbackOngoing.mockReturnValue(false);

      const result = await DeviceMessageHandler.handle(
        message,
        mockDriver,
        mockClient,
      );

      expect(mockStation.startTalkback).toHaveBeenCalledWith(mockDevice);
      expect(mockClient.sendTalkbackStream["DEVICE001"]).toBe(true);
      expect(
        DeviceMessageHandler.getTalkbackingDevices("STATION001"),
      ).toContain(mockClient);
      expect(result).toEqual({ async: true });
    });

    it("throws TalkbackOnlyOneAtATimeError when another client has talkback", async () => {
      mockClient = createMockClient(13);
      mockStation.isTalkbackOngoing.mockReturnValue(true);
      mockClient.sendTalkbackStream["DEVICE001"] = undefined as any;

      await expect(
        DeviceMessageHandler.handle(message, mockDriver, mockClient),
      ).rejects.toThrow(TalkbackOnlyOneAtATimeError);
    });

    it("throws TalkbackAlreadyRunningError when same client requests again", async () => {
      mockClient = createMockClient(13);
      mockStation.isTalkbackOngoing.mockReturnValue(true);
      mockClient.sendTalkbackStream["DEVICE001"] = true;

      await expect(
        DeviceMessageHandler.handle(message, mockDriver, mockClient),
      ).rejects.toThrow(TalkbackAlreadyRunningError);
    });
  });

  describe("stopTalkback", () => {
    const message = {
      command: DeviceCommand.stopTalkback,
      serialNumber: "DEVICE001",
      messageId: "msg1",
    } as any;

    it("throws UnknownCommandError for schema < 13", async () => {
      mockClient = createMockClient(12);
      await expect(
        DeviceMessageHandler.handle(message, mockDriver, mockClient),
      ).rejects.toThrow(UnknownCommandError);
    });

    it("throws TalkbackNotRunningError when not ongoing", async () => {
      mockClient = createMockClient(13);
      mockStation.isTalkbackOngoing.mockReturnValue(false);

      await expect(
        DeviceMessageHandler.handle(message, mockDriver, mockClient),
      ).rejects.toThrow(TalkbackNotRunningError);
    });

    it("throws TalkbackNotRunningError when client did not start talkback", async () => {
      mockClient = createMockClient(13);
      mockStation.isTalkbackOngoing.mockReturnValue(true);
      mockClient.sendTalkbackStream["DEVICE001"] = false;

      await expect(
        DeviceMessageHandler.handle(message, mockDriver, mockClient),
      ).rejects.toThrow(TalkbackNotRunningError);
    });

    it("stops talkback when the only client", async () => {
      mockClient = createMockClient(13);
      mockStation.isTalkbackOngoing.mockReturnValue(true);
      mockClient.sendTalkbackStream["DEVICE001"] = true;
      DeviceMessageHandler.addTalkbackingDevice("STATION001", mockClient);

      const mockEnd = jest.fn();
      DeviceMessageHandler.talkbackStream = { end: mockEnd } as any;

      const result = await DeviceMessageHandler.handle(
        message,
        mockDriver,
        mockClient,
      );

      expect(mockEnd).toHaveBeenCalled();
      expect(DeviceMessageHandler.talkbackStream).toBeUndefined();
      expect(mockStation.stopTalkback).toHaveBeenCalledWith(mockDevice);
      expect(
        DeviceMessageHandler.getTalkbackingDevices("STATION001"),
      ).not.toContain(mockClient);
      expect(result).toEqual({ async: true });
    });
  });

  describe("isTalkbackOngoing", () => {
    const message = {
      command: DeviceCommand.isTalkbackOngoing,
      serialNumber: "DEVICE001",
      messageId: "msg1",
    } as any;

    it("throws UnknownCommandError for schema < 13", async () => {
      mockClient = createMockClient(12);
      await expect(
        DeviceMessageHandler.handle(message, mockDriver, mockClient),
      ).rejects.toThrow(UnknownCommandError);
    });

    it("returns talkback state for schema >= 13", async () => {
      mockClient = createMockClient(13);
      mockStation.isTalkbackOngoing.mockReturnValue(true);

      const result = await DeviceMessageHandler.handle(
        message,
        mockDriver,
        mockClient,
      );
      expect(result).toEqual({
        serialNumber: "DEVICE001",
        talkbackOngoing: true,
      });
    });
  });

  describe("talkbackAudioData", () => {
    it("throws TalkbackNotRunningError when talkback not ongoing", async () => {
      mockClient = createMockClient(13);
      mockStation.isTalkbackOngoing.mockReturnValue(false);

      const message = {
        command: DeviceCommand.talkbackAudioData,
        serialNumber: "DEVICE001",
        messageId: "msg1",
        buffer: Buffer.from("audio"),
      } as any;

      await expect(
        DeviceMessageHandler.handle(message, mockDriver, mockClient),
      ).rejects.toThrow(TalkbackNotRunningError);
    });

    it("throws TalkbackNotRunningError when client did not start talkback", async () => {
      mockClient = createMockClient(13);
      mockStation.isTalkbackOngoing.mockReturnValue(true);
      mockClient.sendTalkbackStream["DEVICE001"] = false;

      const message = {
        command: DeviceCommand.talkbackAudioData,
        serialNumber: "DEVICE001",
        messageId: "msg1",
        buffer: Buffer.from("audio"),
      } as any;

      await expect(
        DeviceMessageHandler.handle(message, mockDriver, mockClient),
      ).rejects.toThrow(TalkbackNotRunningError);
    });

    it("writes audio data to talkback stream", async () => {
      mockClient = createMockClient(13);
      mockStation.isTalkbackOngoing.mockReturnValue(true);
      mockClient.sendTalkbackStream["DEVICE001"] = true;
      DeviceMessageHandler.addTalkbackingDevice("STATION001", mockClient);

      const mockWrite = jest.fn();
      DeviceMessageHandler.talkbackStream = { write: mockWrite } as any;

      const message = {
        command: DeviceCommand.talkbackAudioData,
        serialNumber: "DEVICE001",
        messageId: "msg1",
        buffer: Buffer.from("audio"),
      } as any;

      const result = await DeviceMessageHandler.handle(
        message,
        mockDriver,
        mockClient,
      );

      expect(mockWrite).toHaveBeenCalled();
      expect(result).toEqual({});
    });

    it("throws UnknownCommandError for schema < 13", async () => {
      mockClient = createMockClient(12);
      const message = {
        command: DeviceCommand.talkbackAudioData,
        serialNumber: "DEVICE001",
        messageId: "msg1",
        buffer: Buffer.from("audio"),
      } as any;

      await expect(
        DeviceMessageHandler.handle(message, mockDriver, mockClient),
      ).rejects.toThrow(UnknownCommandError);
    });
  });

  // --- Simple commands with schema version gating ---

  describe("triggerAlarm", () => {
    it("triggers alarm for schema >= 3", async () => {
      mockClient = createMockClient(13);
      const message = {
        command: DeviceCommand.triggerAlarm,
        serialNumber: "DEVICE001",
        messageId: "msg1",
        seconds: 30,
      } as any;

      const result = await DeviceMessageHandler.handle(
        message,
        mockDriver,
        mockClient,
      );

      expect(mockStation.triggerDeviceAlarmSound).toHaveBeenCalledWith(
        mockDevice,
        30,
      );
      expect(result).toEqual({ async: true });
    });

    it("throws UnknownCommandError for schema < 3", async () => {
      mockClient = createMockClient(2);
      const message = {
        command: DeviceCommand.triggerAlarm,
        serialNumber: "DEVICE001",
        messageId: "msg1",
        seconds: 30,
      } as any;

      await expect(
        DeviceMessageHandler.handle(message, mockDriver, mockClient),
      ).rejects.toThrow(UnknownCommandError);
    });
  });

  describe("resetAlarm", () => {
    it("resets alarm for schema >= 3", async () => {
      mockClient = createMockClient(13);
      const message = {
        command: DeviceCommand.resetAlarm,
        serialNumber: "DEVICE001",
        messageId: "msg1",
      } as any;

      const result = await DeviceMessageHandler.handle(
        message,
        mockDriver,
        mockClient,
      );

      expect(mockStation.resetDeviceAlarmSound).toHaveBeenCalledWith(
        mockDevice,
      );
      expect(result).toEqual({ async: true });
    });
  });

  describe("panAndTilt", () => {
    it("calls panAndTilt for schema >= 3", async () => {
      mockClient = createMockClient(13);
      const message = {
        command: DeviceCommand.panAndTilt,
        serialNumber: "DEVICE001",
        messageId: "msg1",
        direction: 0,
      } as any;

      const result = await DeviceMessageHandler.handle(
        message,
        mockDriver,
        mockClient,
      );

      expect(mockStation.panAndTilt).toHaveBeenCalledWith(mockDevice, 0);
      expect(result).toEqual({ async: true });
    });
  });

  describe("quickResponse", () => {
    it("calls quickResponse for schema >= 3", async () => {
      mockClient = createMockClient(13);
      const message = {
        command: DeviceCommand.quickResponse,
        serialNumber: "DEVICE001",
        messageId: "msg1",
        voiceId: 5,
      } as any;

      const result = await DeviceMessageHandler.handle(
        message,
        mockDriver,
        mockClient,
      );

      expect(mockStation.quickResponse).toHaveBeenCalledWith(mockDevice, 5);
      expect(result).toEqual({ async: true });
    });
  });

  // --- getVoices ---

  describe("getVoices", () => {
    const message = {
      command: DeviceCommand.getVoices,
      serialNumber: "DEVICE001",
      messageId: "msg1",
    } as any;

    it("throws UnknownCommandError for schema < 3", async () => {
      mockClient = createMockClient(2);
      await expect(
        DeviceMessageHandler.handle(message, mockDriver, mockClient),
      ).rejects.toThrow(UnknownCommandError);
    });

    it("returns voices with serialNumber for schema >= 3", async () => {
      mockClient = createMockClient(13);
      const mockVoices = [{ voice_id: 1, desc: "Hello" }];
      mockDriver.getApi().getVoices.mockResolvedValue(mockVoices);

      const result = await DeviceMessageHandler.handle(
        message,
        mockDriver,
        mockClient,
      );
      expect(result).toEqual({
        serialNumber: "DEVICE001",
        voices: mockVoices,
      });
    });
  });

  // --- hasProperty ---

  describe("hasProperty", () => {
    const message = {
      command: DeviceCommand.hasProperty,
      serialNumber: "DEVICE001",
      messageId: "msg1",
      propertyName: "motionDetection",
    } as any;

    it("schema === 3: returns exists without serialNumber", async () => {
      mockClient = createMockClient(3);
      mockDevice.hasProperty.mockReturnValue(true);

      const result = await DeviceMessageHandler.handle(
        message,
        mockDriver,
        mockClient,
      );
      expect(result).toEqual({ exists: true });
    });

    it("schema >= 4: returns exists with serialNumber", async () => {
      mockClient = createMockClient(13);
      mockDevice.hasProperty.mockReturnValue(false);

      const result = await DeviceMessageHandler.handle(
        message,
        mockDriver,
        mockClient,
      );
      expect(result).toEqual({ serialNumber: "DEVICE001", exists: false });
    });

    it("throws UnknownCommandError for schema < 3", async () => {
      mockClient = createMockClient(2);
      await expect(
        DeviceMessageHandler.handle(message, mockDriver, mockClient),
      ).rejects.toThrow(UnknownCommandError);
    });
  });

  // --- hasCommand ---

  describe("hasCommand", () => {
    it("schema >= 4: returns exists with serialNumber", async () => {
      mockClient = createMockClient(13);
      mockDevice.hasCommand.mockReturnValue(true);

      const message = {
        command: DeviceCommand.hasCommand,
        serialNumber: "DEVICE001",
        messageId: "msg1",
        commandName: "device.start_livestream",
      } as any;

      const result = await DeviceMessageHandler.handle(
        message,
        mockDriver,
        mockClient,
      );
      expect(result).toEqual({ serialNumber: "DEVICE001", exists: true });
    });
  });

  // --- getCommands ---

  describe("getCommands", () => {
    const message = {
      command: DeviceCommand.getCommands,
      serialNumber: "DEVICE001",
      messageId: "msg1",
    } as any;

    it("schema === 3: returns raw commands", async () => {
      mockClient = createMockClient(3);
      const result = await DeviceMessageHandler.handle(
        message,
        mockDriver,
        mockClient,
      );
      expect(result).toEqual({
        commands: ["devicePanAndTilt", "deviceOpen"],
      });
    });

    it("schema >= 4: returns converted commands with serialNumber", async () => {
      mockClient = createMockClient(13);
      const result = await DeviceMessageHandler.handle(
        message,
        mockDriver,
        mockClient,
      );
      expect(result).toEqual({
        serialNumber: "DEVICE001",
        commands: ["pan_and_tilt", "open"],
      });
    });
  });

  // --- RTSP ---

  describe("RTSP livestream commands", () => {
    it("startRTSPLivestream works for schema >= 6", async () => {
      mockClient = createMockClient(6);
      const message = {
        command: DeviceCommand.startRTSPLivestream,
        serialNumber: "DEVICE001",
        messageId: "msg1",
      } as any;

      const result = await DeviceMessageHandler.handle(
        message,
        mockDriver,
        mockClient,
      );
      expect(mockStation.startRTSPStream).toHaveBeenCalledWith(mockDevice);
      expect(result).toEqual({});
    });

    it("stopRTSPLivestream works for schema >= 6", async () => {
      mockClient = createMockClient(6);
      const message = {
        command: DeviceCommand.stopRTSPLivestream,
        serialNumber: "DEVICE001",
        messageId: "msg1",
      } as any;

      const result = await DeviceMessageHandler.handle(
        message,
        mockDriver,
        mockClient,
      );
      expect(mockStation.stopRTSPStream).toHaveBeenCalledWith(mockDevice);
      expect(result).toEqual({});
    });

    it("isRTSPLiveStreaming returns state for schema >= 6", async () => {
      mockClient = createMockClient(6);
      mockStation.isRTSPLiveStreaming.mockReturnValue(true);
      const message = {
        command: DeviceCommand.isRTSPLiveStreaming,
        serialNumber: "DEVICE001",
        messageId: "msg1",
      } as any;

      const result = await DeviceMessageHandler.handle(
        message,
        mockDriver,
        mockClient,
      );
      expect(result).toEqual({
        serialNumber: "DEVICE001",
        livestreaming: true,
      });
    });

    it("RTSP commands throw UnknownCommandError for schema < 6", async () => {
      mockClient = createMockClient(5);
      const message = {
        command: DeviceCommand.startRTSPLivestream,
        serialNumber: "DEVICE001",
        messageId: "msg1",
      } as any;

      await expect(
        DeviceMessageHandler.handle(message, mockDriver, mockClient),
      ).rejects.toThrow(UnknownCommandError);
    });
  });

  // --- Lock/Calibrate commands (schema >= 9/10) ---

  describe("calibrateLock", () => {
    it("works for schema >= 9", async () => {
      mockClient = createMockClient(13);
      const message = {
        command: DeviceCommand.calibrateLock,
        serialNumber: "DEVICE001",
        messageId: "msg1",
      } as any;

      const result = await DeviceMessageHandler.handle(
        message,
        mockDriver,
        mockClient,
      );
      expect(mockStation.calibrateLock).toHaveBeenCalledWith(mockDevice);
      expect(result).toEqual({ async: true });
    });

    it("throws UnknownCommandError for schema < 9", async () => {
      mockClient = createMockClient(8);
      const message = {
        command: DeviceCommand.calibrateLock,
        serialNumber: "DEVICE001",
        messageId: "msg1",
      } as any;

      await expect(
        DeviceMessageHandler.handle(message, mockDriver, mockClient),
      ).rejects.toThrow(UnknownCommandError);
    });
  });

  describe("calibrate", () => {
    it("works for schema >= 10", async () => {
      mockClient = createMockClient(13);
      const message = {
        command: DeviceCommand.calibrate,
        serialNumber: "DEVICE001",
        messageId: "msg1",
      } as any;

      const result = await DeviceMessageHandler.handle(
        message,
        mockDriver,
        mockClient,
      );
      expect(mockStation.calibrate).toHaveBeenCalledWith(mockDevice);
      expect(result).toEqual({ async: true });
    });
  });

  describe("setDefaultAngle", () => {
    it("works for schema >= 10", async () => {
      mockClient = createMockClient(10);
      const message = {
        command: DeviceCommand.setDefaultAngle,
        serialNumber: "DEVICE001",
        messageId: "msg1",
      } as any;

      const result = await DeviceMessageHandler.handle(
        message,
        mockDriver,
        mockClient,
      );
      expect(mockStation.setDefaultAngle).toHaveBeenCalledWith(mockDevice);
      expect(result).toEqual({});
    });
  });

  describe("setPrivacyAngle", () => {
    it("works for schema >= 10", async () => {
      mockClient = createMockClient(10);
      const message = {
        command: DeviceCommand.setPrivacyAngle,
        serialNumber: "DEVICE001",
        messageId: "msg1",
      } as any;

      const result = await DeviceMessageHandler.handle(
        message,
        mockDriver,
        mockClient,
      );
      expect(mockStation.setPrivacyAngle).toHaveBeenCalledWith(mockDevice);
      expect(result).toEqual({});
    });
  });

  // --- unlock (schema >= 13) ---

  describe("unlock", () => {
    it("works for schema >= 13", async () => {
      mockClient = createMockClient(13);
      const message = {
        command: DeviceCommand.unlock,
        serialNumber: "DEVICE001",
        messageId: "msg1",
      } as any;

      const result = await DeviceMessageHandler.handle(
        message,
        mockDriver,
        mockClient,
      );
      expect(mockStation.unlock).toHaveBeenCalledWith(mockDevice);
      expect(result).toEqual({ async: true });
    });

    it("throws UnknownCommandError for schema < 13", async () => {
      mockClient = createMockClient(12);
      const message = {
        command: DeviceCommand.unlock,
        serialNumber: "DEVICE001",
        messageId: "msg1",
      } as any;

      await expect(
        DeviceMessageHandler.handle(message, mockDriver, mockClient),
      ).rejects.toThrow(UnknownCommandError);
    });
  });

  // --- snooze ---

  describe("snooze", () => {
    it("calls station.snooze with correct params", async () => {
      mockClient = createMockClient(13);
      const message = {
        command: DeviceCommand.snooze,
        serialNumber: "DEVICE001",
        messageId: "msg1",
        snoozeTime: 60,
        snoozeChime: true,
        snoozeMotion: false,
        snoozeHomebase: true,
      } as any;

      const result = await DeviceMessageHandler.handle(
        message,
        mockDriver,
        mockClient,
      );

      expect(mockStation.snooze).toHaveBeenCalledWith(mockDevice, {
        snooze_time: 60,
        snooze_chime: true,
        snooze_motion: false,
        snooze_homebase: true,
      });
      expect(result).toEqual({ async: true });
    });

    it("throws UnknownCommandError for schema < 13", async () => {
      mockClient = createMockClient(12);
      const message = {
        command: DeviceCommand.snooze,
        serialNumber: "DEVICE001",
        messageId: "msg1",
        snoozeTime: 60,
      } as any;

      await expect(
        DeviceMessageHandler.handle(message, mockDriver, mockClient),
      ).rejects.toThrow(UnknownCommandError);
    });
  });

  // --- User management ---

  describe("addUser", () => {
    it("calls driver.addUser for schema >= 13", async () => {
      mockClient = createMockClient(13);
      const message = {
        command: DeviceCommand.addUser,
        serialNumber: "DEVICE001",
        messageId: "msg1",
        username: "john",
        passcode: "1234",
        schedule: { startDay: 1, endDay: 5 },
      } as any;

      const result = await DeviceMessageHandler.handle(
        message,
        mockDriver,
        mockClient,
      );

      expect(mockDriver.addUser).toHaveBeenCalledWith(
        "DEVICE001",
        "john",
        "1234",
        { startDay: 1, endDay: 5 },
      );
      expect(result).toEqual({ async: true });
    });
  });

  describe("deleteUser", () => {
    it("calls driver.deleteUser for schema >= 13", async () => {
      mockClient = createMockClient(13);
      const message = {
        command: DeviceCommand.deleteUser,
        serialNumber: "DEVICE001",
        messageId: "msg1",
        username: "john",
      } as any;

      const result = await DeviceMessageHandler.handle(
        message,
        mockDriver,
        mockClient,
      );

      expect(mockDriver.deleteUser).toHaveBeenCalledWith("DEVICE001", "john");
      expect(result).toEqual({ async: true });
    });
  });

  describe("getUsers", () => {
    it("returns users for schema >= 13", async () => {
      mockClient = createMockClient(13);
      const mockUsers = [{ username: "john" }];
      mockDriver.getApi().getUsers.mockResolvedValue(mockUsers);

      const message = {
        command: DeviceCommand.getUsers,
        serialNumber: "DEVICE001",
        messageId: "msg1",
      } as any;

      const result = await DeviceMessageHandler.handle(
        message,
        mockDriver,
        mockClient,
      );
      expect(result).toEqual({ users: mockUsers });
    });

    it("returns empty array when users is null", async () => {
      mockClient = createMockClient(13);
      mockDriver.getApi().getUsers.mockResolvedValue(null);

      const message = {
        command: DeviceCommand.getUsers,
        serialNumber: "DEVICE001",
        messageId: "msg1",
      } as any;

      const result = await DeviceMessageHandler.handle(
        message,
        mockDriver,
        mockClient,
      );
      expect(result).toEqual({ users: [] });
    });
  });

  describe("updateUser", () => {
    it("calls driver.updateUser for schema >= 13", async () => {
      mockClient = createMockClient(13);
      const message = {
        command: DeviceCommand.updateUser,
        serialNumber: "DEVICE001",
        messageId: "msg1",
        username: "john",
        newUsername: "jane",
      } as any;

      const result = await DeviceMessageHandler.handle(
        message,
        mockDriver,
        mockClient,
      );

      expect(mockDriver.updateUser).toHaveBeenCalledWith(
        "DEVICE001",
        "john",
        "jane",
      );
      expect(result).toEqual({ async: true });
    });
  });

  describe("updateUserPasscode", () => {
    it("calls driver.updateUserPasscode for schema >= 13", async () => {
      mockClient = createMockClient(13);
      const message = {
        command: DeviceCommand.updateUserPasscode,
        serialNumber: "DEVICE001",
        messageId: "msg1",
        username: "john",
        passcode: "5678",
      } as any;

      const result = await DeviceMessageHandler.handle(
        message,
        mockDriver,
        mockClient,
      );

      expect(mockDriver.updateUserPasscode).toHaveBeenCalledWith(
        "DEVICE001",
        "john",
        "5678",
      );
      expect(result).toEqual({ async: true });
    });
  });

  describe("updateUserSchedule", () => {
    it("calls driver.updateUserSchedule for schema >= 13", async () => {
      mockClient = createMockClient(13);
      const message = {
        command: DeviceCommand.updateUserSchedule,
        serialNumber: "DEVICE001",
        messageId: "msg1",
        username: "john",
        schedule: { startDay: 0, endDay: 6 },
      } as any;

      const result = await DeviceMessageHandler.handle(
        message,
        mockDriver,
        mockClient,
      );

      expect(mockDriver.updateUserSchedule).toHaveBeenCalledWith(
        "DEVICE001",
        "john",
        { startDay: 0, endDay: 6 },
      );
      expect(result).toEqual({ async: true });
    });
  });

  describe("verifyPIN", () => {
    it("calls station.verifyPIN for schema >= 13", async () => {
      mockClient = createMockClient(13);
      const message = {
        command: DeviceCommand.verifyPIN,
        serialNumber: "DEVICE001",
        messageId: "msg1",
        pin: "9999",
      } as any;

      const result = await DeviceMessageHandler.handle(
        message,
        mockDriver,
        mockClient,
      );

      expect(mockStation.verifyPIN).toHaveBeenCalledWith(mockDevice, "9999");
      expect(result).toEqual({ async: true });
    });
  });

  // --- Preset position commands (schema >= 21) ---

  describe("presetPosition", () => {
    it("works for schema >= 21", async () => {
      mockClient = createMockClient(21);
      const message = {
        command: DeviceCommand.presetPosition,
        serialNumber: "DEVICE001",
        messageId: "msg1",
        position: 1,
      } as any;

      const result = await DeviceMessageHandler.handle(
        message,
        mockDriver,
        mockClient,
      );

      expect(mockStation.presetPosition).toHaveBeenCalledWith(mockDevice, 1);
      expect(result).toEqual({ async: true });
    });

    it("throws UnknownCommandError for schema < 21", async () => {
      mockClient = createMockClient(20);
      const message = {
        command: DeviceCommand.presetPosition,
        serialNumber: "DEVICE001",
        messageId: "msg1",
        position: 1,
      } as any;

      await expect(
        DeviceMessageHandler.handle(message, mockDriver, mockClient),
      ).rejects.toThrow(UnknownCommandError);
    });
  });

  describe("savePresetPosition", () => {
    it("works for schema >= 21", async () => {
      mockClient = createMockClient(21);
      const message = {
        command: DeviceCommand.savePresetPosition,
        serialNumber: "DEVICE001",
        messageId: "msg1",
        position: 2,
      } as any;

      const result = await DeviceMessageHandler.handle(
        message,
        mockDriver,
        mockClient,
      );

      expect(mockStation.savePresetPosition).toHaveBeenCalledWith(
        mockDevice,
        2,
      );
      expect(result).toEqual({ async: true });
    });
  });

  describe("deletePresetPosition", () => {
    it("works for schema >= 21", async () => {
      mockClient = createMockClient(21);
      const message = {
        command: DeviceCommand.deletePresetPosition,
        serialNumber: "DEVICE001",
        messageId: "msg1",
        position: 3,
      } as any;

      const result = await DeviceMessageHandler.handle(
        message,
        mockDriver,
        mockClient,
      );

      expect(mockStation.deletePresetPosition).toHaveBeenCalledWith(
        mockDevice,
        3,
      );
      expect(result).toEqual({ async: true });
    });
  });

  // --- open (schema >= 21) ---

  describe("open", () => {
    it("works for schema >= 21", async () => {
      mockClient = createMockClient(21);
      const message = {
        command: DeviceCommand.open,
        serialNumber: "DEVICE001",
        messageId: "msg1",
      } as any;

      const result = await DeviceMessageHandler.handle(
        message,
        mockDriver,
        mockClient,
      );

      expect(mockStation.open).toHaveBeenCalledWith(mockDevice);
      expect(result).toEqual({ async: true });
    });

    it("throws UnknownCommandError for schema < 21", async () => {
      mockClient = createMockClient(20);
      const message = {
        command: DeviceCommand.open,
        serialNumber: "DEVICE001",
        messageId: "msg1",
      } as any;

      await expect(
        DeviceMessageHandler.handle(message, mockDriver, mockClient),
      ).rejects.toThrow(UnknownCommandError);
    });
  });

  // --- Unknown command ---

  describe("unknown command", () => {
    it("throws UnknownCommandError for unrecognized command", async () => {
      const message = {
        command: "device.nonexistent_command",
        serialNumber: "DEVICE001",
        messageId: "msg1",
      } as any;

      await expect(
        DeviceMessageHandler.handle(message, mockDriver, mockClient),
      ).rejects.toThrow(UnknownCommandError);
    });
  });
});