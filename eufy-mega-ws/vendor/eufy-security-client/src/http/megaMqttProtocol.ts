import { MegaMqttCommandEnvelope, MegaMqttPayload, MegaMqttProtocol } from "./megaInterfaces";

export interface MegaMqttCommandOptions {
  clientId: string;
  accountId: string;
  deviceSerial: string;
  data: Record<string, unknown>;
  protocol?: MegaMqttProtocol;
  timestamp?: number;
}

const requiredIdentifier = (name: string, value: string, max: number): string => {
  if (!value || value.length > max) throw new Error(`${name} must be 1-${max} characters`);
  return value;
};

/**
 * Build the exact AIoT MQTT command envelope modeled by the official Android app.
 * This function is transport-free: callers must still enforce a verified writable catalog before
 * publishing to `cmd/eufy_security/{productCode}/{deviceSerial}/req`.
 */
export const buildMegaMqttCommand = (options: MegaMqttCommandOptions): MegaMqttCommandEnvelope => {
  const timestamp = options.timestamp ?? Date.now();
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw new Error("timestamp must be a positive integer");
  const clientId = requiredIdentifier("clientId", options.clientId, 512);
  const payload: MegaMqttPayload = {
    protocol: options.protocol ?? MegaMqttProtocol.DataPointCommand,
    t: timestamp,
    account_id: requiredIdentifier("accountId", options.accountId, 256),
    device_sn: requiredIdentifier("deviceSerial", options.deviceSerial, 128),
    data: options.data,
  };

  return {
    head: {
      version: "1.0.0.1",
      client_id: clientId,
      sess_id: clientId,
      msg_seq: 1,
      cmd: 65537,
      cmd_status: 2,
      sign_code: 0,
      seed: "",
      timestamp,
    },
    payload: JSON.stringify(payload),
  };
};

/** Fill the official product/serial placeholders without accepting topic injection. */
export const megaMqttCommandTopic = (productCode: string, deviceSerial: string): string => {
  const product = requiredIdentifier("productCode", productCode, 64);
  const serial = requiredIdentifier("deviceSerial", deviceSerial, 128);
  if (product.includes("/") || serial.includes("/")) throw new Error("MQTT identifiers cannot contain slashes");
  return `cmd/eufy_security/${product}/${serial}/req`;
};
