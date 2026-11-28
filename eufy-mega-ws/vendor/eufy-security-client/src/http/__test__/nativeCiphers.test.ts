import { createECDH, createHmac } from "crypto";
import { MegaHTTPApi } from "../megaApi";
import { HTTPApi } from "../api";
import { MegaTransition } from "../megaTransition";
import {
  SECURITY_PRESET_KEY,
  MEGA_PRESET_KEY,
  presetDecrypt,
  presetEncrypt,
  megaEncryptBody,
  megaDecryptBody,
  sharedKeyToAesKey,
} from "../megaCrypto";

jest.mock("../../logging", () => ({
  rootHTTPLogger: { error: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));
const row = { cipher_id: 7, user_id: "owner", private_key: "test-rsa-material" };
function apiWith(handler: (url: string, opts: any) => Promise<any>) {
  const api = new MegaHTTPApi({ ab: "us", minRequestIntervalMs: 0 }) as any;
  api.setAuth("test-token", "signed-in-user");
  api.throttle = (fn: any) => fn;
  api.got = jest.fn(handler);
  return api;
}
function handshakeServer(seen: any[], region = "us") {
  const peer = createECDH("prime256v1");
  peer.setPrivateKey(Buffer.alloc(32, 2));
  let shared = "";
  return async (url: string, opts: any) => {
    seen.push({ url, opts });
    if (url.endsWith("/v3/openapi/oauth/key/exchange")) {
      const client = presetDecrypt(JSON.parse(opts.body).client_public_key, SECURITY_PRESET_KEY);
      expect(opts.headers["x-signature"]).toBe(
        createHmac("sha256", Buffer.from(SECURITY_PRESET_KEY, "utf8"))
          .update(
            [
              opts.headers["x-request-ts"],
              opts.headers["x-request-once"],
              JSON.parse(opts.body).client_public_key,
            ].join("+")
          )
          .digest("hex")
      );
      shared = peer.computeSecret(Buffer.from(client, "hex")).toString("hex");
      expect(opts.headers["content-type"]).toBe("application/json");
      return {
        statusCode: 200,
        body: JSON.stringify({
          code: 0,
          data: { server_public_key: presetEncrypt(peer.getPublicKey("hex"), SECURITY_PRESET_KEY) },
        }),
      };
    }
    expect(url).toBe(
      `https://security-app${region === "us" ? "" : "-" + region}.eufylife.com/v3/app/cipher/get_ciphers`
    );
    expect(opts.headers["x-signature"]).toBe(
      createHmac("sha256", Buffer.from(shared.slice(0, 32), "utf8"))
        .update([opts.headers["x-request-ts"], opts.headers["x-request-once"], opts.body].join("+"))
        .digest("hex")
    );
    expect(opts.headers["content-type"]).toBe("text/plain");
    expect(opts.headers.authorization).toBe("test-token");
    expect(opts.timeout.request).toBe(8000);
    expect(opts.retry.limit).toBe(0);
    expect(JSON.parse(megaDecryptBody(opts.body, sharedKeyToAesKey(shared)))).toEqual({
      cipher_ids: [7],
      user_id: "owner",
      station_sn: "T84A1TEST",
    });
    return {
      statusCode: 200,
      body: JSON.stringify({ code: 0, data: megaEncryptBody(JSON.stringify([row]), sharedKeyToAesKey(shared)) }),
    };
  };
}
describe("native security cipher transport", () => {
  it.each(["us", "eu", "ie"])("uses a separate authenticated identity and the correct %s host", async (region) => {
    const seen: any[] = [],
      api = apiWith(handshakeServer(seen, region));
    api.megaDomain = `mega-${region}-pr.eufy.com`;
    const main = { keyIdent: "main", sharedKey: "main-key", clientPublicKey: "main-public" };
    api.identities.set(api.clusterHost("openapi"), main);
    expect(await api.getSecurityCiphers([7], "owner", "T84A1TEST")).toEqual({
      7: { ...row, ecc_private_key: undefined },
    });
    expect(seen).toHaveLength(2);
    expect(api.identities.get(api.clusterHost("openapi"))).toBe(main);
    let wrong = "";
    try {
      wrong = presetDecrypt(JSON.parse(seen[0].opts.body).client_public_key, MEGA_PRESET_KEY);
    } catch {}
    expect(wrong).not.toBe(presetDecrypt(JSON.parse(seen[0].opts.body).client_public_key, SECURITY_PRESET_KEY));
  });
  it("joins concurrent security handshakes while preserving independent data requests", async () => {
    const seen: any[] = [],
      api = apiWith(handshakeServer(seen));
    await Promise.all([
      api.getSecurityCiphers([7], "owner", "T84A1TEST"),
      api.getSecurityCiphers([7], "owner", "T84A1TEST"),
    ]);
    expect(seen.filter((r) => r.url.includes("key/exchange"))).toHaveLength(1);
    expect(seen).toHaveLength(3);
    await api.getSecurityCiphers([7], "owner", "T84A1TEST");
    expect(seen).toHaveLength(3);
  });
  it("rejects an exchange that completes after authentication changes", async () => {
    let finish!: (v: any) => void;
    const api = apiWith(
      () =>
        new Promise((r) => {
          finish = r;
        })
    );
    const pending = api.keyExchange("security-app.eufylife.com");
    api.setAuth("changed-token", "different-user");
    finish({ statusCode: 200, body: JSON.stringify({ code: 0, data: { server_public_key: "unused" } }) });
    await expect(pending).rejects.toThrow("authentication changed");
    expect(api.getIdentity("security-app.eufylife.com")).toBeUndefined();
  });
  it("security signature recovery cannot evict the Mega login identity", async () => {
    const api = apiWith(async () => ({ statusCode: 200, body: JSON.stringify({ code: 4416 }) }));
    const main = { keyIdent: "main", sharedKey: "x", clientPublicKey: "y" };
    api.identities.set(api.clusterHost("openapi"), main);
    await api.signedPost("security-app.eufylife.com", "/v3/openapi/oauth/key/exchange", undefined, undefined, {
      keyIdent: "k",
      encryptedValue: "body",
      presetKey: SECURITY_PRESET_KEY,
    });
    expect(api.getIdentity(api.clusterHost("openapi"))).toBe(main);
  });
  it("bounds a queued or silent native lookup and does not cache its failure", async () => {
    jest.useFakeTimers();
    const api = apiWith(() => new Promise(() => {}));
    try {
      const request = api.getSecurityCiphers([7], "owner", "T84A1TEST");
      const check = expect(request).rejects.toThrow("timed out");
      await jest.advanceTimersByTimeAsync(15000);
      await check;
      expect(api.nativeCipherCache.size).toBe(0);
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });
  it("recovers a rejected security identity once without changing the Mega identity", async () => {
    const seen: any[] = [],
      serve = handshakeServer(seen);
    let rejectFirst = true;
    const api = apiWith(async (url, opts) => {
      const result = await serve(url, opts);
      if (url.endsWith("get_ciphers") && rejectFirst) {
        rejectFirst = false;
        return { statusCode: 200, body: JSON.stringify({ code: 4416 }) };
      }
      return result;
    });
    const main = { keyIdent: "main", sharedKey: "x", clientPublicKey: "y" };
    api.identities.set(api.clusterHost("openapi"), main);
    expect((await api.getSecurityCiphers([7], "owner", "T84A1TEST"))[7].private_key).toBe(row.private_key);
    expect(seen).toHaveLength(4);
    expect(api.getIdentity(api.clusterHost("openapi"))).toBe(main);
  });
  it("scopes successful cached keys to token, station and owner, and expires them", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    const api = new MegaHTTPApi({ ab: "us" }) as any;
    api.setAuth("token-a", "u");
    api.callWithIdentity = jest.fn().mockResolvedValue({ result: { code: 0, data: [row] }, identity: {} });
    try {
      await api.getSecurityCiphers([7], "owner", "T84A1A");
      await api.getSecurityCiphers([7], "owner", "T84A1A");
      expect(api.callWithIdentity).toHaveBeenCalledTimes(1);
      await api.getSecurityCiphers([7], "owner", "T84A1B");
      await api.getSecurityCiphers([7], "other", "T84A1A");
      expect(api.callWithIdentity).toHaveBeenCalledTimes(3);
      api.setAuth("token-b", "u");
      await api.getSecurityCiphers([7], "owner", "T84A1A");
      expect(api.callWithIdentity).toHaveBeenCalledTimes(4);
      await jest.advanceTimersByTimeAsync(900001);
      await api.getSecurityCiphers([7], "owner", "T84A1A");
      expect(api.callWithIdentity).toHaveBeenCalledTimes(5);
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });
  it("rejects a native data result received after authentication changes", async () => {
    const api = new MegaHTTPApi({ ab: "us" }) as any;
    api.setAuth("token-a", "u");
    let finish!: (value: any) => void;
    api.callWithIdentity = jest.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const request = api.getSecurityCiphers([7], "owner", "T84A1TEST");
    api.setAuth("token-b", "other-user");
    finish({ result: { code: 0, data: [row] }, identity: {} });
    await expect(request).rejects.toThrow("authentication changed");
    expect(api.nativeCipherCache.size).toBe(0);
  });
  it("ignores unsolicited cipher IDs and empty or malformed key records", async () => {
    const api = new MegaHTTPApi({ ab: "us" }) as any;
    api.setAuth("t", "u");
    api.callWithIdentity = jest.fn().mockResolvedValue({
      result: {
        code: 0,
        data: {
          ciphers: [
            { ...row, cipher_id: 8 },
            { cipher_id: 7, private_key: "", ecc_private_key: "invalid" },
          ],
        },
      },
      identity: {},
    });
    expect(await api.getSecurityCiphers([7], "owner", "T84A1TEST")).toEqual({});
  });
});
function compatibilityApi() {
  const api = Object.create(HTTPApi.prototype) as any;
  api.nativeCipherRequests = new Map();
  api.getLegacyCiphers = jest.fn().mockResolvedValue({ 7: { ...row, private_key: "legacy" } });
  return api;
}
describe("native cipher compatibility boundary", () => {
  it("uses a native result without a legacy request", async () => {
    const api = compatibilityApi();
    api.setNativeCipherProvider(jest.fn().mockResolvedValue({ 7: row }));
    expect(await api.getCipher(7, "owner", "T84A1TEST")).toEqual(row);
    expect(api.getLegacyCiphers).not.toHaveBeenCalled();
  });
  it.each(["empty", "failed"])("retains legacy fallback for a %s native lookup", async (mode) => {
    const api = compatibilityApi();
    api.setNativeCipherProvider(
      mode === "failed"
        ? jest.fn().mockRejectedValue(new Error("unavailable"))
        : jest.fn().mockResolvedValue({ 7: { ...row, private_key: "" } })
    );
    expect((await api.getCipher(7, "owner", "T84A1TEST")).private_key).toBe("legacy");
    expect(api.getLegacyCiphers).toHaveBeenCalledWith([7], "owner");
  });
  it("fills a missing required RSA key without discarding native ECC", async () => {
    const api = compatibilityApi(),
      ecc = "01".repeat(32);
    api.setNativeCipherProvider(jest.fn().mockResolvedValue({ 7: { ...row, private_key: "", ecc_private_key: ecc } }));
    const result = await api.getCipher(7, "owner", "T84A1TEST", "rsa");
    expect(result.private_key).toBe("legacy");
    expect(result.ecc_private_key).toBe(ecc);
    expect(api.getLegacyCiphers).toHaveBeenCalledTimes(1);
  });
  it("fills a missing required ECC key without discarding native RSA", async () => {
    const api = compatibilityApi(),
      ecc = "02".repeat(32);
    api.setNativeCipherProvider(jest.fn().mockResolvedValue({ 7: row }));
    api.getLegacyCiphers.mockResolvedValue({ 7: { ...row, private_key: "legacy", ecc_private_key: ecc } });
    const result = await api.getCipher(7, "owner", "T84A1TEST", "ecc");
    expect(result.private_key).toBe(row.private_key);
    expect(result.ecc_private_key).toBe(ecc);
  });
  it("fetches only missing IDs from compatibility and preserves the native record", async () => {
    const api = compatibilityApi();
    api.setNativeCipherProvider(jest.fn().mockResolvedValue({ 7: row }));
    api.getLegacyCiphers.mockResolvedValue({ 8: { ...row, cipher_id: 8 } });
    expect(Object.keys(await api.getCiphers([7, 8], "owner", "T84A1TEST"))).toEqual(["7", "8"]);
    expect(api.getLegacyCiphers).toHaveBeenCalledWith([8], "owner");
  });
  it("coalesces concurrent lookups only within the same station and owner", async () => {
    const api = compatibilityApi(),
      finishers: Array<(v: any) => void> = [];
    const provider = jest.fn(
      () =>
        new Promise((r) => {
          finishers.push(r);
        })
    );
    api.setNativeCipherProvider(provider);
    const a = api.getCipher(7, "owner", "T84A1TEST"),
      b = api.getCipher(7, "owner", "T84A1TEST"),
      c = api.getCipher(7, "owner", "T8441TEST"),
      d = api.getCipher(7, "other-owner", "T84A1TEST");
    expect(provider).toHaveBeenCalledTimes(3);
    finishers.forEach((f) => f({ 7: row }));
    await Promise.all([a, b, c, d]);
    expect(api.nativeCipherRequests.size).toBe(0);
  });
  it("retains the original path for callers without station context", async () => {
    const api = compatibilityApi(),
      provider = jest.fn();
    api.setNativeCipherProvider(provider);
    await api.getCipher(7, "owner");
    expect(provider).not.toHaveBeenCalled();
    expect(api.getLegacyCiphers).toHaveBeenCalledTimes(1);
  });
});

it("registers native reads without replaying login when the Mega session is expired", async () => {
  const transport = { setNativeCipherProvider: jest.fn() },
    initialize = jest.spyOn(HTTPApi, "initialize").mockResolvedValue(transport as any);
  const transition = Object.create(MegaTransition.prototype) as any;
  transition.host = { config: { country: "US", username: "test", password: "test" } };
  const mega = {
    hasValidSession: jest.fn().mockReturnValue(false),
    getSecurityCiphers: jest.fn().mockResolvedValue({ 7: row }),
    login: jest.fn(),
  };
  transition.getMegaApi = jest.fn().mockResolvedValue(mega);
  try {
    await transition.createTransport(undefined);
    const provider = transport.setNativeCipherProvider.mock.calls[0][0];
    expect(await provider([7], "owner", "T84A1TEST")).toEqual({});
    expect(mega.getSecurityCiphers).not.toHaveBeenCalled();
    expect(mega.login).not.toHaveBeenCalled();
    mega.hasValidSession.mockReturnValue(true);
    expect(await provider([7], "owner", "T84A1TEST")).toEqual({ 7: row });
    expect(mega.getSecurityCiphers).toHaveBeenCalledWith([7], "owner", "T84A1TEST");
  } finally {
    initialize.mockRestore();
  }
});
