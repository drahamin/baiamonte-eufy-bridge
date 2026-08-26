import { createECDH, createHash } from "crypto";
import md5 from "crypto-js/md5";

import { rootHTTPLogger } from "../logging";
import { encryptAPIData } from "./utils";
import { HOMEBASE_PRO_LTE_STATUS_PARAM, ParamType, ResponseErrorCode } from "./types";
import { CommandType } from "../p2p/types";
import {
  MEGA_PRESET_KEY,
  buildKeyExchange,
  finalizeKeyExchange,
  xSignature,
  generateKeyIdent,
  sharedKeyToAesKey,
  sharedKeySigningKey,
  megaEncryptBody,
  megaDecryptBody,
  type MegaIdentity,
} from "./megaCrypto";
import {
  MegaResult,
  MegaCaptcha,
  MegaCaptchaAnswer,
  MegaUserMqttInfo,
  MegaMqttConnectConfig,
  MegaApiOptions,
  MegaSession,
  MegaHouseInventoryRequest,
  MegaHouseInventorySummary,
  MegaRomVersionRequest,
  MegaProductDataPointRequest,
  MegaDataPointDescriptor,
  MegaProductDataPointCatalog,
  MegaObservedDataPointDescriptor,
  MegaObservedProductCatalog,
  MegaDeviceRelationRequest,
  MegaDeviceParameter,
  MegaDeviceRelation,
  MegaDeviceRelationList,
  MegaDevicePointSwitchRequestItem,
  MegaDevicePointSwitchRequest,
  MegaDevicePointSwitch,
  MegaMqttHeader,
  MegaMqttPayload,
  MegaMqttCommandEnvelope,
} from "./megaInterfaces";

export type {
  MegaResult,
  MegaCaptcha,
  MegaCaptchaAnswer,
  MegaUserMqttInfo,
  MegaMqttConnectConfig,
  MegaApiOptions,
  MegaSession,
  MegaHouseInventoryRequest,
  MegaHouseInventorySummary,
  MegaRomVersionRequest,
  MegaProductDataPointRequest,
  MegaDataPointDescriptor,
  MegaProductDataPointCatalog,
  MegaObservedDataPointDescriptor,
  MegaObservedProductCatalog,
  MegaDeviceRelationRequest,
  MegaDeviceParameter,
  MegaDeviceRelation,
  MegaDeviceRelationList,
  MegaDevicePointSwitchRequestItem,
  MegaDevicePointSwitchRequest,
  MegaDevicePointSwitch,
  MegaMqttHeader,
  MegaMqttPayload,
  MegaMqttCommandEnvelope,
} from "./megaInterfaces";

export { MegaMqttProtocol } from "./megaInterfaces";

/**
 * Eufy "eufy_mega" v6 backend client.
 *
 * Talks to the new per-service `*.eufy.com` microservices (behind APISIX) that the
 * official app 6.0.50+ uses. Each cluster (us-pr, eu-pr, …) requires its own
 * key/exchange handshake → per-cluster {@link MegaIdentity} (keyIdent + sharedKey).
 * Bodies are ECDH-encrypted (`X-Encryption-Info: algo_ecdh`) and every request is
 * signed (`X-Signature`).
 *
 * This is intentionally a SEPARATE class from HTTPApi: the legacy backend still
 * works for not-yet-migrated devices, so we don't want to risk that path.
 *
 * Heavily rate-limited (1 request / ~3s) — the Eufy WAF rate-limits aggressive probing.
 */

/** Per-cluster server static public key (uncompressed hex) for the ECIES bootstrap. */
export const MEGA_SERVER_STATIC_PUBKEY =
  "04ebc77a23c7191f8c97fb2a7676710f64ddadfe5305fa80c8855476b024c6ad3d8c18d4be9d720c5a578167f899e0818d3a19de2e804407034b4a88cfdb7ae995";

/** Login password ECDH server key — same constant the legacy HTTPApi uses. */
const LOGIN_SERVER_PUBLIC_KEY =
  "04c5c00c4f8d1197cc7c3167c52bf7acb054d722f0ef08dcd7e0883236e0d72a3868d9750cb47fa4619248f3d83f0f662671dadc6e2d31c2f41db0161651c7c076";

/**
 * Salted change-detection hash for the persisted session: invalidate the cached mega session when
 * the credentials change. Salted with the stable device id so a leaked persistent file isn't an
 * offline-cracking aid the way a bare md5(user:pass) would be.
 */
export const megaLoginHash = (email: string, password: string, openudid: string): string =>
  createHash("sha256").update(`${openudid}:${email}:${password}`).digest("hex");

type ObservedMegaMetadata = {
  code: string;
  name: string;
  confidence: "verified" | "classified";
  classification: string;
};

/**
 * Additions recovered outside the legacy enum. Every entry remains read-only. "verified" requires
 * either an existing parser or an unambiguous typed payload; broad numeric coincidences are not
 * accepted as evidence.
 */
const observedMegaMetadata = new Map<number, ObservedMegaMetadata>([
  [
    HOMEBASE_PRO_LTE_STATUS_PARAM,
    {
      code: "HOMEBASE_PRO_LTE_DIAGNOSTICS",
      name: "HomeBase Pro LTE diagnostics",
      confidence: "verified",
      classification: "homebase_pro_cellular",
    },
  ],
  [
    6226,
    {
      code: "HOMEBASE_PRO_CELLULAR_MODEM_FIRMWARE",
      name: "HomeBase Pro cellular modem firmware",
      confidence: "verified",
      classification: "homebase_pro_cellular",
    },
  ],
  [
    61400,
    {
      code: "HOMEBASE_PRO_SIM_SLOT_1_STATUS",
      name: "HomeBase Pro SIM slot 1 status",
      confidence: "verified",
      classification: "homebase_pro_cellular",
    },
  ],
  [
    61401,
    {
      code: "HOMEBASE_PRO_SIM_SLOT_2_STATUS",
      name: "HomeBase Pro SIM slot 2 status",
      confidence: "verified",
      classification: "homebase_pro_cellular",
    },
  ],
  [
    7013,
    {
      code: "CAMERA_AUXILIARY_FIRMWARE_VERSION",
      name: "Camera auxiliary firmware version",
      confidence: "classified",
      classification: "camera_firmware",
    },
  ],
  [
    6445,
    {
      code: "DEVICE_POWER_SOURCE_MODE",
      name: "Device power source mode",
      confidence: "verified",
      classification: "device_power",
    },
  ],
]);

const crossProductPlatformIds = new Set([1418, 1419, 1420, 1509, 1510, 1511, 1512, 1513]);
const commonCameraPlatformIds = new Set([1067, 1154, 1197, 1198, 1299, 1309, 3103]);
const stationPlatformIds = new Set([1062, 1155, 1284, 1285, 1296, 6287]);
const deviceTelemetryIds = new Set([6252, 6254, 6458, 6482]);
const homeBaseProPlatformIds = new Set([1299, 1313, 1314, 1315, 1663]);
const wiredCameraSettingIds = new Set([1416, 6036, 6037, 6082, 6084, 6110, 6111, 6112, 6113, 6114]);
const megaCapabilityIds = new Set([9201, 9202, 9235, 9236, 9237, 9238, 9257, 9258, 9273]);
const homeBaseProCellularReservedIds = new Set([5006, 5007, 5008, 5009, 5010, 5011, 5012, 6224, 6225]);

const classifyObservedMegaParameter = (type: number, productCode?: string): ObservedMegaMetadata | undefined => {
  const exact = observedMegaMetadata.get(type);
  if (exact && (type === 7013 || type === 6445 || productCode === "T9000")) return exact;
  if (crossProductPlatformIds.has(type))
    return {
      code: `MEGA_CROSS_PRODUCT_PLATFORM_${type}`,
      name: `Mega cross-product platform field ${type}`,
      confidence: "classified",
      classification: "cross_product_platform",
    };
  if (megaCapabilityIds.has(type))
    return {
      code: `MEGA_CAPABILITY_${type}`,
      name: `Mega capability field ${type}`,
      confidence: "classified",
      classification: "mega_capability",
    };
  if (productCode !== "T9000" && commonCameraPlatformIds.has(type))
    return {
      code: `CAMERA_PLATFORM_${type}`,
      name: `Camera platform field ${type}`,
      confidence: "classified",
      classification: "camera_platform",
    };
  if (stationPlatformIds.has(type))
    return {
      code: `STATION_PLATFORM_${type}`,
      name: `Station platform field ${type}`,
      confidence: "classified",
      classification: "station_platform",
    };
  if (deviceTelemetryIds.has(type))
    return {
      code: `DEVICE_TELEMETRY_${type}`,
      name: `Device telemetry field ${type}`,
      confidence: "classified",
      classification: "device_telemetry",
    };
  if (productCode === "T9000" && homeBaseProPlatformIds.has(type))
    return {
      code: `HOMEBASE_PRO_PLATFORM_${type}`,
      name: `HomeBase Pro platform field ${type}`,
      confidence: "classified",
      classification: "homebase_pro_platform",
    };
  if (productCode === "T8423" && wiredCameraSettingIds.has(type))
    return {
      code: `WIRED_FLOODLIGHT_SETTING_${type}`,
      name: `Wired floodlight setting field ${type}`,
      confidence: "classified",
      classification: "wired_floodlight_setting",
    };
  if (productCode === "T9000" && homeBaseProCellularReservedIds.has(type))
    return {
      code: `HOMEBASE_PRO_CELLULAR_RESERVED_${type}`,
      name: `HomeBase Pro cellular reserved field ${type}`,
      confidence: "classified",
      classification: "homebase_pro_cellular_reserved",
    };
  if (type >= 40003 && type <= 40012)
    return {
      code: `WIRED_CAMERA_PLATFORM_${type}`,
      name: `Wired camera platform field ${type}`,
      confidence: "classified",
      classification: "wired_camera_platform",
    };
  return undefined;
};

const knownMegaParameterTypes = new Set(
  [...Object.values(ParamType), ...Object.values(CommandType)]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .map(String)
);

const megaParameterName = (type: number): string | undefined => {
  const paramName = ParamType[type];
  if (typeof paramName === "string") return paramName;
  const commandName = CommandType[type];
  return typeof commandName === "string" ? commandName : undefined;
};

const safeValueProfile = (value: unknown): string => {
  if (value === undefined || value === null || value === "") return "empty";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "decimal";
  if (typeof value !== "string") return Array.isArray(value) ? "array" : "object";
  if (/^-?\d+$/.test(value)) return "integer";
  if (/^-?(?:\d+\.\d*|\d*\.\d+)$/.test(value)) return "decimal";
  if (/^\d+(?:\.\d+){2,}(?:[-_][A-Za-z0-9.]+)?$/.test(value)) return "version";
  if (/^https?:\/\//i.test(value)) return "url";
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? "json_array" : parsed && typeof parsed === "object" ? "json_object" : "json_scalar";
  } catch {
    // Continue with a bounded Base64 shape check. Decoded contents are never retained.
  }
  if (value.length >= 4 && value.length <= 65536 && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    try {
      const decoded = Buffer.from(value, "base64").toString("utf8");
      const parsed = JSON.parse(decoded);
      return Array.isArray(parsed)
        ? "base64_json_array"
        : parsed && typeof parsed === "object"
          ? "base64_json_object"
          : "base64";
    } catch {
      return "base64_or_text";
    }
  }
  return "text";
};

/**
 * Build identifier/value-free, read-only catalogs from the native parameters actually reported by
 * each product. This is the fallback for accounts where Eufy's catalog endpoint succeeds but
 * returns an empty list. Unknown IDs remain explicit and can never be mistaken for writable DPs.
 */
export const buildObservedMegaProductCatalogs = (value: unknown): Record<string, MegaObservedProductCatalog> => {
  const inventory = value as { devices?: Array<Record<string, unknown>> };
  const byProduct = new Map<string, Set<number>>();
  const profilesByProduct = new Map<string, Map<number, Set<string>>>();
  for (const device of Array.isArray(inventory?.devices) ? inventory.devices : []) {
    const product = device.device_model ?? device.device_new_pn;
    if (typeof product !== "string" || !product || product.length > 64) continue;
    const types = byProduct.get(product) ?? new Set<number>();
    const profiles = profilesByProduct.get(product) ?? new Map<number, Set<string>>();
    for (const param of Array.isArray(device.params) ? (device.params as Array<Record<string, unknown>>) : []) {
      const candidate = typeof param.param_type === "string" ? Number(param.param_type) : param.param_type;
      if (typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0) {
        types.add(candidate);
        const valueProfiles = profiles.get(candidate) ?? new Set<string>();
        valueProfiles.add(safeValueProfile(param.param_value));
        profiles.set(candidate, valueProfiles);
      }
    }
    byProduct.set(product, types);
    profilesByProduct.set(product, profiles);
  }

  return Object.fromEntries(
    Array.from(byProduct.entries()).map(([productCode, types]) => [
      productCode,
      {
        productCode,
        data_point_list: Array.from(types)
          .sort((a, b) => a - b)
          .map((dp_id) => {
            const knownName = megaParameterName(dp_id);
            const metadata = classifyObservedMegaParameter(dp_id, productCode);
            const verified = knownName !== undefined || metadata?.confidence === "verified";
            return {
              code: knownName ?? metadata?.code ?? `param_${dp_id}`,
              dp_id,
              name: knownName ?? metadata?.name ?? `Unresolved parameter ${dp_id}`,
              mode: "ro" as const,
              data_type: "observed" as const,
              source: "native_inventory" as const,
              known: verified,
              confidence: verified
                ? ("verified" as const)
                : metadata
                  ? ("classified" as const)
                  : ("unresolved" as const),
              classification: knownName ? "legacy_enum" : (metadata?.classification ?? "unresolved"),
              value_profiles: Array.from(profilesByProduct.get(productCode)?.get(dp_id) ?? []).sort(),
            };
          }),
      },
    ])
  );
};

/** Build an identifier-free summary from one already-decrypted native inventory response. */
export const summarizeMegaHouseInventory = (value: unknown): MegaHouseInventorySummary => {
  const inventory = value as { devices?: Array<Record<string, unknown>>; groups?: unknown[] };
  const devices = Array.isArray(inventory?.devices) ? inventory.devices : [];
  const groups = Array.isArray(inventory?.groups) ? inventory.groups : [];
  const models: Record<string, number> = {};
  const categories: Record<string, number> = {};
  const parameterCounts: number[] = [];
  const parameterTypes = new Set<string>();
  const verifiedObservedTypes = new Set<string>();
  const classifiedObservedTypes = new Set<string>();

  const addCount = (target: Record<string, number>, candidate: unknown): void => {
    if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > 64) return;
    target[candidate] = (target[candidate] ?? 0) + 1;
  };

  for (const device of devices) {
    const product = device.device_model ?? device.device_new_pn;
    addCount(models, product);
    addCount(categories, device.category);
    const params = Array.isArray(device.params) ? (device.params as Array<Record<string, unknown>>) : [];
    parameterCounts.push(params.length);
    for (const param of params) {
      const type = param?.param_type;
      if ((typeof type === "number" && Number.isFinite(type)) || (typeof type === "string" && type.length <= 64)) {
        const serializedType = String(type);
        parameterTypes.add(serializedType);
        const numericType = Number(type);
        const metadata = Number.isSafeInteger(numericType)
          ? classifyObservedMegaParameter(numericType, typeof product === "string" ? product : undefined)
          : undefined;
        if (metadata?.confidence === "verified") verifiedObservedTypes.add(serializedType);
        else if (metadata?.confidence === "classified") classifiedObservedTypes.add(serializedType);
      }
    }
  }

  const types = Array.from(parameterTypes).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return {
    deviceCount: devices.length,
    groupCount: groups.length,
    models,
    categories,
    parameters: {
      total: parameterCounts.reduce((sum, count) => sum + count, 0),
      minPerDevice: parameterCounts.length > 0 ? Math.min(...parameterCounts) : 0,
      maxPerDevice: parameterCounts.length > 0 ? Math.max(...parameterCounts) : 0,
      types,
      knownTypes: types.filter((type) => knownMegaParameterTypes.has(type) || verifiedObservedTypes.has(type)),
      classifiedTypes: types.filter(
        (type) =>
          !knownMegaParameterTypes.has(type) && !verifiedObservedTypes.has(type) && classifiedObservedTypes.has(type)
      ),
      unknownTypes: types.filter(
        (type) =>
          !knownMegaParameterTypes.has(type) && !verifiedObservedTypes.has(type) && !classifiedObservedTypes.has(type)
      ),
    },
  };
};

export class MegaHTTPApi {
  private readonly ab: string;
  private readonly osType: string;
  private readonly appName: string;
  private readonly appVersion: string;
  private readonly osVersion: string;
  private readonly phoneModel: string;
  private readonly minIntervalMs: number;

  private got!: any;
  private throttle!: <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => (...a: A) => Promise<R>;

  /** Resolved domains from estimate_domain (eufy_security, etc). */
  private domains: Record<string, string> = {};
  private megaDomain = "";

  /** One identity per cluster host (e.g. app-openapi-eu-pr.eufy.com). */
  private identities = new Map<string, MegaIdentity>();

  /** eufy.com auth token (from passport/login on the new backend). */
  private authToken?: string;
  /** Unix seconds when authToken expires (from login `token_expires_at`). */
  private tokenExpiresAt?: number;
  private userId?: string;

  constructor(opts: MegaApiOptions) {
    this.ab = opts.ab.toLowerCase();
    this.osType = opts.osType ?? "android";
    this.appName = opts.appName ?? "eufy_mega";
    this.appVersion = opts.appVersion ?? (this.osType === "android" ? "6.0.80_28612" : "6.0.50_260612140706");
    this.osVersion = opts.osVersion ?? (this.osType === "android" ? "14" : "26.5.1");
    this.phoneModel = opts.phoneModel ?? (this.osType === "android" ? "Pixel 8" : "iPhone 17 Pro");
    if (opts.openudid) this.openudid = opts.openudid;
    this.minIntervalMs = opts.minRequestIntervalMs ?? 3000;
  }

  public async init(): Promise<void> {
    const { default: pThrottle } = await import("p-throttle");
    const { default: got } = await import("got");
    this.got = got;
    this.throttle = pThrottle({ limit: 1, interval: this.minIntervalMs });
  }

  private get gtoken(): string | undefined {
    return this.userId ? md5(this.userId).toString() : undefined;
  }

  /** Stable per-install device id (uuid-ish, 32 hex). Restored from a persisted session. */
  private openudid = generateKeyIdent();

  /**
   * Low-level signed/encrypted POST to a v6 host.
   *
   * X-Signature covers the ENCRYPTED VALUE (the base64 ciphertext), not the JSON wrapper: for
   * key/exchange the body is `{"client_public_key":"<b64>"}` but only `<b64>` is signed; for
   * regular requests the body IS the ciphertext, so signed value == body.
   *
   * No got-level retry: the timestamp/nonce/signature are computed once per call and the backend
   * enforces a replay/timestamp window, so a got retry would resend a frozen signature and be
   * rejected. Retry above this method (recomputing the signature) if needed.
   *
   * @param host    full host (e.g. app-passport-eu-pr.eufy.com)
   * @param path    request path
   * @param payload plaintext object (encrypted with the cluster identity sharedKey)
   * @param identity cluster identity; if omitted, bootstrap mode (presetKey) is used
   */
  private async signedPost(
    host: string,
    path: string,
    payload: unknown,
    identity?: MegaIdentity,
    bootstrap?: { keyIdent: string; encryptedValue: string }
  ): Promise<MegaResult> {
    const ts = `${Math.floor(Date.now() / 1000)}`;
    const nonce = generateKeyIdent();

    let body: string;
    let signedValue: string;
    let signingKey: string;
    let keyIdent: string;

    if (bootstrap !== undefined) {
      body = JSON.stringify({ client_public_key: bootstrap.encryptedValue });
      signedValue = bootstrap.encryptedValue;
      signingKey = MEGA_PRESET_KEY;
      keyIdent = bootstrap.keyIdent;
    } else {
      if (!identity) throw new Error("signedPost: identity required for non-bootstrap request");
      const aesKey = sharedKeyToAesKey(identity.sharedKey);
      body = megaEncryptBody(JSON.stringify(payload), aesKey);
      signedValue = body;
      signingKey = sharedKeySigningKey(identity.sharedKey);
      keyIdent = identity.keyIdent;
    }

    const headers: Record<string, string> = {
      accept: "application/json",
      "accept-charset": "UTF-8",
      "accept-language": `${this.ab}-${this.ab.toUpperCase()},${this.ab};q=0.9`,
      "app-name": this.appName,
      "app-version": this.appVersion,
      app_version: this.appVersion,
      "os-type": this.osType,
      os_type: this.osType,
      "os-version": this.osVersion,
      os_version: this.osVersion,
      "model-type": "PHONE",
      "phone-model": this.phoneModel,
      phone_model: this.phoneModel,
      openudid: this.openudid,
      "test-flag": "false",
      priority: "u=3, i",
      "user-agent": "ktor-client",
      "content-type": "application/json",
      "x-encryption-info": "algo_ecdh",
      "x-key-ident": keyIdent,
      "x-request-ts": ts,
      "x-request-once": nonce,
      "x-replay-info": "replay",
      "x-signature": xSignature(signingKey, ts, nonce, signedValue),
      country: this.ab.toUpperCase(),
      language: this.ab,
      ab_code: this.ab,
    };
    if (this.gtoken) headers.gtoken = this.gtoken;
    if (this.authToken) {
      headers["x-auth-token"] = this.authToken;
      headers.authorization = this.authToken;
    }

    rootHTTPLogger.debug("MegaApi request", { host, path, osType: this.osType, keyIdent });

    const send = this.throttle(async () => {
      return await this.got(`https://${host}${path}`, {
        method: "POST",
        headers,
        body,
        responseType: "text",
        throwHttpErrors: false,
        retry: { limit: 0 },
      });
    });
    const resp = await send();
    const responseText: string = resp.body ?? "";
    let parsed: MegaResult;
    try {
      parsed = JSON.parse(responseText) as MegaResult;
    } catch {
      throw new Error(`${host}${path} → HTTP ${resp.statusCode}, non-JSON body (${responseText.length} bytes)`);
    }
    rootHTTPLogger.debug("MegaApi response", { host, path, status: resp.statusCode, code: parsed.code });

    if (
      parsed.code === ResponseErrorCode.CODE_NEED_NEGOTIATE_KEY ||
      parsed.code === ResponseErrorCode.CODE_SIGNATURE_ERROR
    ) {
      rootHTTPLogger.info("MegaApi identity rejected — evicting cached identities to force re-handshake", {
        code: parsed.code,
      });
      this.identities.clear();
    }
    return parsed;
  }

  /** Decrypt a v6 response `data` field with a cluster identity sharedKey. */
  public decryptForCluster(identity: MegaIdentity, dataB64: string): string {
    return megaDecryptBody(dataB64, sharedKeyToAesKey(identity.sharedKey));
  }

  /** Resolve the region's mega domain + product domains. Body is cleartext JSON. */
  public async estimateDomain(): Promise<Record<string, string>> {
    const host = `mega-${this.ab === "us" ? "us" : "eu"}-pr.eufy.com`;
    const send = this.throttle(async () =>
      this.got(`https://${host}/passport/estimate_domain`, {
        method: "POST",
        headers: {
          "app-name": this.appName,
          "app-version": this.appVersion,
          "os-type": this.osType,
          "content-type": "application/json",
        },
        json: { ab: this.ab, mode: 1 },
        responseType: "json",
        throwHttpErrors: false,
      })
    );
    const resp = await send();
    const result = resp.body as MegaResult;
    if (result.code !== 0) throw new Error(`estimate_domain failed: ${result.code} ${result.msg}`);
    const data = result.data as { domain: string; product_domains: Record<string, string> };
    this.megaDomain = data.domain;
    this.domains = data.product_domains;
    rootHTTPLogger.info("MegaApi estimate_domain", { megaDomain: this.megaDomain, domains: this.domains });
    return this.domains;
  }

  /**
   * Perform a key/exchange against a cluster's openapi host and cache the identity.
   * @param openapiHost e.g. app-openapi-eu-pr.eufy.com
   */
  public async keyExchange(openapiHost: string): Promise<MegaIdentity> {
    const cached = this.identities.get(openapiHost);
    if (cached) return cached;

    const { ecdh, clientPublicKeyBody, clientPublicKey, keyIdent } = buildKeyExchange();

    const result = await this.signedPost(openapiHost, "/openapi/oauth/key/exchange", undefined, undefined, {
      keyIdent,
      encryptedValue: clientPublicKeyBody,
    });
    if (result.code !== 0) throw new Error(`key/exchange failed on ${openapiHost}: ${result.code} ${result.msg}`);

    const serverPubEnc = (result.data as { server_public_key: string }).server_public_key;
    const identity = finalizeKeyExchange(ecdh, serverPubEnc, keyIdent, clientPublicKey);
    this.identities.set(openapiHost, identity);
    rootHTTPLogger.info("MegaApi key/exchange ok", { openapiHost, keyIdent });
    return identity;
  }

  /**
   * Region cluster host for a service, e.g. "passport" → app-passport-eu-pr.eufy.com.
   *
   * Derived from the `domain` returned by {@link estimateDomain} (the server decides the region,
   * the client does not guess it) by replacing the `mega` prefix with `app-{service}` — the same
   * transform the app does in MegaAppDomain.createByMega. Falls back to a us/eu guess only when
   * estimate_domain has not run yet (e.g. the bootstrap key/exchange before login).
   */
  public clusterHost(service: string): string {
    if (this.megaDomain && this.megaDomain.startsWith("mega-")) {
      return this.megaDomain.replace(/^mega-/, `app-${service}-`);
    }
    const region = this.ab === "us" ? "us" : "eu";
    return `app-${service}-${region}-pr.eufy.com`;
  }

  public getDomains(): Record<string, string> {
    return this.domains;
  }
  public getIdentity(host: string): MegaIdentity | undefined {
    return this.identities.get(host);
  }
  public setAuth(authToken: string, userId: string): void {
    this.authToken = authToken;
    this.userId = userId;
  }

  /**
   * Export the full session so a later run can resume WITHOUT a fresh login/2FA.
   *
   * Mirrors the legacy HTTPApi's `persistentData`: once authenticated you ARE authenticated —
   * persist the token + user_id + the per-cluster ECDH identities (keyIdent/sharedKey) + the
   * stable device id. As long as the token hasn't expired, `restoreSession()` lets every signed
   * call go straight through (no estimate_domain / key/exchange / login replay).
   */
  public exportSession(loginHash?: string): MegaSession {
    return {
      ab: this.ab,
      openudid: this.openudid,
      login_hash: loginHash,
      cloud_token: this.authToken,
      cloud_token_expiration: this.tokenExpiresAt,
      user_id: this.userId,
      domains: this.domains,
      megaDomain: this.megaDomain,
      identities: Object.fromEntries(this.identities),
    };
  }

  /** Restore a session previously produced by {@link exportSession}. */
  public restoreSession(s: MegaSession): void {
    if (s.openudid) this.openudid = s.openudid;
    this.authToken = s.cloud_token;
    this.userId = s.user_id;
    this.tokenExpiresAt = s.cloud_token_expiration;
    this.domains = s.domains ?? {};
    this.megaDomain = s.megaDomain ?? "";
    this.identities = new Map(Object.entries(s.identities ?? {}));
  }

  /**
   * True if we hold a non-expired auth token (60s safety margin) → no login replay needed.
   * An unknown expiry is treated as invalid (forces a relogin) rather than valid-forever.
   */
  public hasValidSession(): boolean {
    if (!this.authToken || !this.userId) return false;
    if (!this.tokenExpiresAt) return false;
    if (Date.now() / 1000 >= this.tokenExpiresAt - 60) return false;
    return true;
  }

  /** Generic signed/encrypted call once an identity exists for the host's cluster. */
  public async call(host: string, path: string, payload: unknown): Promise<MegaResult> {
    return (await this.callWithIdentity(host, path, payload)).result;
  }

  /**
   * Run one v6 call and repair a rejected cached identity exactly once.
   *
   * Eufy's v6 gateway can invalidate a previously persisted ECDH identity while the auth token is
   * still valid. The gateway then answers with 4404/4416. `signedPost()` evicts the rejected
   * identity; this helper completes a fresh key exchange and resends the request with a new
   * timestamp, nonce and signature. Retrying more than once would only increase the risk of WAF
   * throttling and cannot repair a genuinely invalid account session.
   */
  private async callWithIdentity(
    host: string,
    path: string,
    payload: unknown
  ): Promise<{ result: MegaResult; identity: MegaIdentity }> {
    const openapiHost = this.clusterHost("openapi");

    for (let attempt = 0; attempt < 2; attempt++) {
      const identity = await this.keyExchange(openapiHost);
      const result = await this.signedPost(host, path, payload, identity);
      const identityRejected =
        result.code === ResponseErrorCode.CODE_NEED_NEGOTIATE_KEY ||
        result.code === ResponseErrorCode.CODE_SIGNATURE_ERROR;

      if (!identityRejected || attempt === 1) return { result, identity };

      rootHTTPLogger.info("MegaApi retrying request after fresh key exchange", {
        host,
        path,
        code: result.code,
      });
      // signedPost() has already evicted the rejected identity. The next loop performs a fresh
      // key/exchange and, importantly, recomputes the request timestamp/nonce/signature.
    }

    throw new Error("MegaApi identity recovery exhausted unexpectedly");
  }

  /** {@link call} + decrypt the `data` field. Throws on non-zero code. */
  public async callDecrypted(service: string, path: string, payload: unknown = {}): Promise<unknown> {
    const { result, identity } = await this.callWithIdentity(this.clusterHost(service), path, payload);
    if (result.code !== 0) throw new Error(`${path} failed: ${result.code} ${result.msg}`);
    if (typeof result.data !== "string") {
      rootHTTPLogger.warn("MegaApi response data is not an encrypted string (protocol drift?)", { path });
      return result.data;
    }
    return JSON.parse(this.decryptForCluster(identity, result.data));
  }

  /**
   * MQTT connection info for the v6 backend (`devicemanage/get_user_mqtt_info`).
   * This is how events are pushed in v6 — broker endpoint + credentials + topics, returned
   * dynamically (unlike the legacy static `security-mqtt-eu.eufylife.com`). Decrypted.
   */
  public async getUserMqttInfo(): Promise<MegaUserMqttInfo> {
    return (await this.callDecrypted("devicemanage", "/app/devicemanage/get_user_mqtt_info", {})) as MegaUserMqttInfo;
  }

  /**
   * Build the full AWS IoT MQTT connection config for the v6 event channel. Fetches the per-user
   * certificate/credentials and combines them with the client identity so a consumer can connect
   * without touching MegaHTTPApi internals.
   *
   * NOTE: SCAFFOLDING — there is no MQTT subscriber consuming this yet. The v6 AWS IoT channel
   * only serves devices flagged `is_support_mqtt`; ordinary cameras/sensors are delivered over
   * FCM ({@link registerPushToken}). This builder is shipped ahead of a follow-up MQTT-consumer
   * change so that change won't need to touch MegaHTTPApi. It is NOT a live event path today.
   *
   * The `clientId` format is mandatory for the AWS IoT policy (decompiled `createClientId`):
   * `android-{app_name}-{user_id}-{openudid}`. Topics carry `PN`/`SN` placeholders to fill per
   * device. Requires a valid session.
   */
  public async getMqttConnectConfig(): Promise<MegaMqttConnectConfig> {
    const info = await this.getUserMqttInfo();
    return {
      endpoint: info.endpoint_addr,
      port: 8883,
      clientId: `android-${this.appName}-${info.user_id}-${this.openudid}`,
      thingName: info.thing_name,
      userId: info.user_id,
      certificatePem: info.certificate_pem,
      privateKey: info.private_key,
      awsRootCaPem: info.aws_root_ca1_pem,
      topics: {
        subCmd: "cmd/eufy_security/PN/SN/res",
        stateInfo: "synq/eufy_life/PN/SN/state_info",
        pubCmd: "cmd/eufy_security/PN/SN/req",
      },
    };
  }

  /**
   * Register an FCM push token on the v6 backend (`push/register_push_token`).
   *
   * Body (decompiled `PushManager.uploadToken`): `{token, is_notification_enable, voip_token}`.
   * There is NO platform/type field in the body — the backend routes FCM vs APNs purely by the
   * `os-type` header + the `x-key-ident` identity this request is signed under. So this MUST run
   * on an `os-type: android` identity (the default here) for events to be delivered over FCM.
   */
  public async registerPushToken(fcmToken: string): Promise<MegaResult> {
    return this.call(this.clusterHost("push"), "/app/push/register_push_token", {
      token: fcmToken,
      is_notification_enable: true,
      voip_token: fcmToken,
    });
  }

  /** Encrypt the login password exactly like the legacy HTTPApi (ECDH vs LOGIN_SERVER_PUBLIC_KEY). */
  private encryptLoginPassword(password: string): { encrypted: string; clientSecretPub: string } {
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    const secret = ecdh.computeSecret(Buffer.from(LOGIN_SERVER_PUBLIC_KEY, "hex"));
    return {
      encrypted: encryptAPIData(password, secret),
      clientSecretPub: ecdh.getPublicKey("hex"),
    };
  }

  /** Validate the email exists on the new backend (the app does this before login). */
  public async validateEmail(email: string): Promise<MegaResult> {
    return this.call(this.clusterHost("passport"), "/passport/validate_email", { email, ab: this.ab });
  }

  /** The 2FA session id, shared between login (which triggers 2FA) and loginAfterTFA. */
  private loginId?: string;

  /**
   * Obtain a `login_id` (2FA session id). The app calls `passport/get_login_id` before login and
   * passes the SAME login_id to both the initial login and the post-2FA login. (Decompiled flow.)
   */
  public async getLoginId(): Promise<string> {
    const result = await this.call(this.clusterHost("passport"), "/passport/get_login_id", {});
    if (result.code !== 0) throw new Error(`get_login_id failed: ${result.code} ${result.msg}`);
    const openapiHost = this.clusterHost("openapi");
    const identity = this.identities.get(openapiHost)!;
    const decoded = JSON.parse(this.decryptForCluster(identity, result.data as string)) as { login_id: string };
    this.loginId = decoded.login_id;
    rootHTTPLogger.info("MegaApi get_login_id", { loginId: this.loginId });
    return this.loginId;
  }

  /**
   * Login against the v6 passport backend.
   *
   * The body sends `login_id: ""`: `get_login_id`/`getTouchId` is for biometric (TouchID) login
   * only and must not be called in the email+2FA flow. On success the backend returns code:0 even
   * when 2FA is still pending — the real state is in `fa_info.step` (26052), and the returned token
   * is provisional but still used to authenticate the subsequent sendVerifyCode + final login.
   *
   * @param verifyCode email 2FA code (omit on first call; pass it on retry after code 26052)
   * @param captcha    picture-captcha answer (pass it after code 100032/100033 — see {@link generateCaptcha})
   * @returns the full MegaResult. Codes the caller acts on: 26052 = email 2FA required;
   *          100032 = captcha required, 100033 = captcha answer incorrect. On success, token+user stored.
   */
  public async login(
    email: string,
    password: string,
    verifyCode?: string,
    captcha?: MegaCaptchaAnswer
  ): Promise<MegaResult> {
    const { encrypted, clientSecretPub } = this.encryptLoginPassword(password);
    const payload: Record<string, unknown> = {
      email,
      password: encrypted,
      ab: this.ab,
      client_secret_info: { public_key: clientSecretPub },
      answer: captcha?.answer ?? "",
      captcha_id: captcha?.captchaId ?? "",
      verify_code: verifyCode ?? "",
      login_id: "",
    };

    const result = await this.call(this.clusterHost("passport"), "/passport/login", payload);

    if (result.code === ResponseErrorCode.LOGIN_NEED_CAPTCHA || result.code === ResponseErrorCode.LOGIN_CAPTCHA_ERROR) {
      rootHTTPLogger.info("MegaApi login needs a captcha", { code: result.code });
      return result;
    }

    if (result.code === 0 && result.data) {
      const openapiHost = this.clusterHost("openapi");
      const identity = this.identities.get(openapiHost)!;
      const decoded = JSON.parse(this.decryptForCluster(identity, result.data as string)) as Record<string, unknown>;

      const authToken = (decoded.auth_token ?? decoded.token) as string;
      const userId = (decoded.user_id ?? decoded.userId) as string;
      this.setAuth(authToken, userId);
      if (typeof decoded.token_expires_at === "number") this.tokenExpiresAt = decoded.token_expires_at;

      const faInfo = decoded.fa_info as { step?: number } | undefined;
      if (faInfo?.step === ResponseErrorCode.CODE_NEED_VERIFY_CODE) {
        rootHTTPLogger.info("MegaApi login needs 2FA (token stored for verify_code)", { step: faInfo.step });
        return { ...result, code: ResponseErrorCode.CODE_NEED_VERIFY_CODE, msg: "2FA verify code required" };
      }
      rootHTTPLogger.info("MegaApi login ok", { userId, keys: Object.keys(decoded) });
    }
    return result;
  }

  /**
   * Request the email 2FA code (after login indicates fa_info.step 26052).
   *
   * Exact payload confirmed by decompiling the Ijiami-packed `SendVerifyCodeRequest`
   * (dumped from process memory): the 2FA-login send is `{message_type, biz_type, transaction}`
   * with `biz_type = 1004` (BIZ_TYPE_TFA) and `message_type = 2` (TYPE_EMAIL). No captcha for send.
   */
  public async sendVerifyCode(_email?: string): Promise<MegaResult> {
    return this.call(this.clusterHost("push"), "/app/sendmsg/verify_code", {
      message_type: 2, // TYPE_EMAIL
      biz_type: 1004, // BIZ_TYPE_TFA
      transaction: `${Date.now()}`,
    });
  }

  /**
   * Fetch a picture captcha (after login returns 100032/100033). Body
   * `{captcha_type, biz_type}` (decompiled CaptchaManager.getCaptcha); the response `item` is a
   * base64 image the user must solve, then pass the answer + captcha_id back into {@link login}.
   */
  public async generateCaptcha(): Promise<MegaCaptcha> {
    const result = await this.call(this.clusterHost("passport"), "/passport/generate/captcha", {
      captcha_type: "PIC",
      biz_type: 0,
    });
    if (result.code !== 0) throw new Error(`generate/captcha failed: ${result.code} ${result.msg}`);
    const openapiHost = this.clusterHost("openapi");
    const identity = this.identities.get(openapiHost)!;
    const data =
      typeof result.data === "string" ? JSON.parse(this.decryptForCluster(identity, result.data)) : result.data;
    return data as MegaCaptcha;
  }

  /**
   * Fetch the Tuya/Thingclips device list (`get_things_list`) and DECRYPT it.
   * This is the probe to see whether a given device (e.g. Kitchen sensor) has been
   * migrated server-side onto the Tuya backend.
   */
  public async getThingsListDecrypted(productCodes: string[] = []): Promise<unknown> {
    const host = this.clusterHost("things");
    const openapiHost = this.clusterHost("openapi");
    const identity = await this.keyExchange(openapiHost);
    const result = await this.signedPost(
      host,
      "/app/things/get_things_list",
      { product_codes: productCodes },
      identity
    );
    if (result.code !== 0) throw new Error(`get_things_list failed: ${result.code} ${result.msg}`);
    return JSON.parse(this.decryptForCluster(identity, result.data as string));
  }

  /**
   * Official AIoT/device-relation inventory. App 6.0.80 sends attribute=7 on Mega accounts
   * (the request model's older default is 3). This complements the security house inventory with
   * other current product families such as cleaning devices.
   */
  public async getDeviceRelationsDecrypted(houseId = "", attribute = 7): Promise<unknown> {
    if (!Number.isInteger(attribute) || attribute < 0 || attribute > 255) throw new Error("invalid attribute");
    if (houseId.length > 128) throw new Error("houseId is too long");
    return this.callDecrypted("devicerelation", "/app/devicerelation/get_device_list", {
      house_id: houseId,
      attribute,
    });
  }

  /** Rich per-device descriptors used by the v6 app to decide which properties/actions exist. */
  public async getDeviceDetailsDecrypted(houseId = "", attribute = 7): Promise<unknown> {
    if (!Number.isInteger(attribute) || attribute < 0 || attribute > 255) throw new Error("invalid attribute");
    if (houseId.length > 128) throw new Error("houseId is too long");
    return this.callDecrypted("devicerelation", "/app/devicerelation/get_devices_info", {
      house_id: houseId,
      attribute,
    });
  }

  /** Batch-query current OTA metadata without starting an upgrade. */
  public async getRomVersionsDecrypted(devices: MegaRomVersionRequest[]): Promise<unknown> {
    if (devices.length > 64) throw new Error("too many devices");
    const get_roms_param = devices.map((device) => {
      if (!device.device_type || device.device_type.length > 128) throw new Error("invalid device_type");
      if (!device.device_sn || device.device_sn.length > 128) throw new Error("invalid device_sn");
      if (!device.category || device.category.length > 128) throw new Error("invalid category");
      return device;
    });
    return this.callDecrypted("ota", "/app/ota/get_rom_versions", { get_roms_param });
  }

  /** Query one model's ROM metadata. This is read-only and never invokes `ota_upgrade_net`. */
  public async getRomVersionDecrypted(device: MegaRomVersionRequest): Promise<unknown> {
    if (!device.device_type || device.device_type.length > 128) throw new Error("invalid device_type");
    if (!device.device_sn || device.device_sn.length > 128) throw new Error("invalid device_sn");
    if (!device.category || device.category.length > 128) throw new Error("invalid category");
    return this.callDecrypted("ota", "/app/ota/get_rom_version", device);
  }

  /**
   * Eufy-side native inventory (`house/get_devs_list`), decrypted.
   *
   * The official 6.0.80 app sends `house_id`, `categories`, and `add_pns`. The previous probe used
   * the legacy-shaped `{device_sn,num,orderby}` body, which is accepted inconsistently and cannot
   * express v6 category/product filtering. Empty arrays return the account's generally supported
   * security inventory; special accessories may require app-supplied category/PN allowlists.
   */
  public async getHouseInventoryDecrypted(request: MegaHouseInventoryRequest = {}): Promise<unknown> {
    return this.callDecrypted("house", "/app/house/get_devs_list", {
      house_id: request.house_id ?? "",
      categories: request.categories ?? [],
      add_pns: request.add_pns ?? [],
    });
  }

  /** Backward-compatible name retained for downstream probes. */
  public async getDevsListDecrypted(request: MegaHouseInventoryRequest = {}): Promise<unknown> {
    return this.getHouseInventoryDecrypted(request);
  }

  /**
   * Return only non-sensitive inventory aggregates. Never includes names, serials, network data,
   * member/account fields, P2P credentials, device keys, or parameter values.
   */
  public async getHouseInventorySummary(request: MegaHouseInventoryRequest = {}): Promise<MegaHouseInventorySummary> {
    return summarizeMegaHouseInventory(await this.getHouseInventoryDecrypted(request));
  }

  /** Official product data-point catalog request (`{code: productCode}`). */
  public async getProductDataPointsDecrypted(productCode: string): Promise<unknown> {
    if (!productCode || productCode.length > 64) throw new Error("productCode must be 1-64 characters");
    return this.callDecrypted("things", "/app/things/get_product_data_point", { code: productCode });
  }

  /**
   * HomeBase Professional event-data view used by the current Security app.
   *
   * The app routes `security.edge.event.t9000.event_data` through the Mega event cluster and sends
   * the database query as a JSON string beside the station serial. This supplies `recordList`,
   * `recordPictureList`, and the related AI collections used for dashboard camera covers.
   */
  public async getT9000EventDataDecrypted(
    stationSerial: string,
    payload: Record<string, unknown>
  ): Promise<unknown> {
    if (!stationSerial || stationSerial.length > 128) throw new Error("invalid station serial");
    return this.callDecrypted("event", "/app/event/t9000/event_data", {
      station_sn: stationSerial,
      payload: JSON.stringify(payload),
    });
  }
}
