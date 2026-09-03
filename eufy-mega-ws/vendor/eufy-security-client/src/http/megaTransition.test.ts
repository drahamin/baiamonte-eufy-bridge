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
});
