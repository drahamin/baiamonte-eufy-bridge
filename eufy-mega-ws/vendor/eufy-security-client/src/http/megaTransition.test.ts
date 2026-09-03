import { extractNativeMegaDashboardCovers } from "./megaTransition";

describe("native Mega dashboard covers", () => {
  it("maps app covers to stable camera serials across field-name variants", () => {
    const covers = extractNativeMegaDashboardCovers([
      {
        device_sn: "camera-snake",
        local_cover_path: "https://example.invalid/snake.jpg",
        local_cover_time: 20,
      },
      {
        deviceSn: "camera-camel",
        coverUrl: "https://example.invalid/camel.jpg",
        coverTime: "30",
      },
    ]);

    expect(covers.get("camera-snake")).toEqual({
      path: "https://example.invalid/snake.jpg",
      time: 20,
    });
    expect(covers.get("camera-camel")).toEqual({
      path: "https://example.invalid/camel.jpg",
      time: 30,
    });
  });

  it("ignores devices without a stable serial or app cover", () => {
    const covers = extractNativeMegaDashboardCovers([
      { device_sn: "camera-no-cover" },
      { cover_path: "https://example.invalid/no-serial.jpg" },
    ]);

    expect(covers.size).toBe(0);
  });

  it("finds current-app covers nested in Mega parameter JSON", () => {
    const covers = extractNativeMegaDashboardCovers([{
      device_sn: "camera-a",
      params: [{
        param_type: 3100,
        param_value: JSON.stringify({
          snapshotUrl: "https://example.invalid/nested.jpg",
          snapshotTime: 400,
        }),
      }],
    }]);

    expect(covers.get("camera-a")).toEqual({
      path: "https://example.invalid/nested.jpg",
      time: 400,
    });
  });

  it("finds current-app covers nested in Base64 Mega parameters", () => {
    const payload = Buffer.from(JSON.stringify({
      localCoverPath: "/mnt/data/latest.jpg",
      localCoverTime: 500,
    })).toString("base64");
    const covers = extractNativeMegaDashboardCovers([
      { device_sn: "camera-a", params: [{ param_value: payload }] },
    ]);

    expect(covers.get("camera-a")).toEqual({
      path: "/mnt/data/latest.jpg",
      time: 500,
    });
  });
});
