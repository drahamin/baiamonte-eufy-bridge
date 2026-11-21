/** Authenticated version-8 control wire, adapted from mega-yfue SDK #650/#654/#680. */
import { createECDH, createHmac, createCipheriv, createDecipheriv, randomBytes, timingSafeEqual, createPrivateKey, privateDecrypt, constants } from "crypto";
import { eufyKDF } from "./utils";

export function unwrapGatewaySessionKey(payload: Buffer, privateKeyHex: string): Buffer | undefined {
  if (!/^[a-f0-9]{64}$/i.test(privateKeyHex) || payload.length < 133) return undefined;
  const envelope = payload.subarray(4, 133);
  try {
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(Buffer.from(privateKeyHex, "hex"));
    const kdf = eufyKDF(ecdh.computeSecret(envelope.subarray(0, 33)));
    const expected = createHmac("sha256", kdf.subarray(16, 48)).update(envelope.subarray(33, 97)).digest();
    if (!timingSafeEqual(expected, envelope.subarray(97, 129))) return undefined;
    const decipher = createDecipheriv("aes-128-cbc", kdf.subarray(0, 16), envelope.subarray(33, 49));
    const key = Buffer.concat([decipher.update(envelope.subarray(49, 97)), decipher.final()]);
    return key.length === 32 ? key : undefined;
  } catch { return undefined; }
}

export function openSessionControl(payload: Buffer, key: Buffer, signCode: number): Buffer | undefined {
  const offset = signCode === 8 ? 32 : 28;
  if (key.length !== 32 || ![2, 8].includes(signCode) || payload.length < offset) return undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, payload.subarray(16, 28));
    decipher.setAAD(Buffer.from("eufy security"));
    decipher.setAuthTag(payload.subarray(0, 16));
    return Buffer.concat([decipher.update(payload.subarray(offset)), decipher.final()]);
  } catch { return undefined; }
}

export function sealSessionControl(value: Buffer, key: Buffer, sequence: number, channel: number): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from("eufy security"));
  const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
  const sub = Buffer.alloc(4);
  sub.writeUInt32LE((0x01020300 + sequence) >>> 0);
  const body = Buffer.concat([cipher.getAuthTag(), nonce, sub, ciphertext]);
  const header = Buffer.from([0, 0, 0, 0, 8, 0, channel, 8, 0, 0]);
  header.writeUInt16LE(body.length);
  return Buffer.concat([header, body]);
}


export function unwrapRsaGatewaySessionKey(payload: Buffer, privateKey: string): Buffer | undefined {
  try {
    const key = privateKey.includes("-----BEGIN") ? createPrivateKey(privateKey) :
      createPrivateKey({ key: Buffer.from(privateKey, "base64"), format: "der", type: "pkcs8" });
    const size = (key.asymmetricKeyDetails?.modulusLength ?? 0) / 8;
    if (size < 128 || payload.length < size + 4) return undefined;
    const plain = privateDecrypt({ key, padding: constants.RSA_NO_PADDING }, payload.subarray(4, size + 4));
    // Explicit PKCS#1 v1.5 validation avoids OpenSSL implicit-rejection noise.
    if (plain[0] !== 0 || plain[1] !== 2) return undefined;
    const separator = plain.indexOf(0, 2);
    if (separator < 10 || plain.length - separator - 1 !== 16) return undefined;
    return Buffer.from(plain.subarray(separator + 1));
  } catch { return undefined; }
}
