import { MegaMqttProtocol } from "../megaInterfaces";
import { buildMegaMqttCommand, megaMqttCommandTopic } from "../megaMqttProtocol";

describe("native Mega MQTT schema", () => {
  it("builds the official string-wrapped data-point protocol", () => {
    const command = buildMegaMqttCommand({
      clientId: "android-eufy_security-user-install",
      accountId: "user",
      deviceSerial: "display",
      data: { 101: true },
      timestamp: 123456,
    });

    expect(command.head).toEqual({
      version: "1.0.0.1",
      client_id: "android-eufy_security-user-install",
      sess_id: "android-eufy_security-user-install",
      msg_seq: 1,
      cmd: 65537,
      cmd_status: 2,
      sign_code: 0,
      seed: "",
      timestamp: 123456,
    });
    expect(JSON.parse(command.payload)).toEqual({
      protocol: MegaMqttProtocol.DataPointCommand,
      t: 123456,
      account_id: "user",
      device_sn: "display",
      data: { 101: true },
    });
  });

  it("builds and validates the security command topic", () => {
    expect(megaMqttCommandTopic("T87A0", "display")).toBe("cmd/eufy_security/T87A0/display/req");
    expect(() => megaMqttCommandTopic("T87A0/other", "display")).toThrow("cannot contain slashes");
  });
});
