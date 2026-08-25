import { createHash } from "crypto";
import { createReadStream, createWriteStream, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import path from "path";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";

import { HTTPApi } from "./api";
import { MegaHTTPApi, megaLoginHash, summarizeMegaHouseInventory } from "./megaApi";
import { rootMainLogger } from "../logging";
import type { HTTPApiPersistentData, LoginOptions } from "./interfaces";
import type { EufySecurityConfig, EufySecurityPersistentData } from "../interfaces";
import type { DeviceListResponse } from "./models";
import { DeviceType, ResponseErrorCode } from "./types";
import { ensureError } from "../error";
import { getError } from "../utils";
import { formatCapabilitySummary } from "./cloudCapabilities";

/**
 * Everything specific to the transitional v6 "eufy_mega" backend lives in this single file so it can
 * be removed in one block once a native v6 data layer (the new library) takes over.
 *
 * {@link MegaTransition} is the connect coordinator: v6-first login, legacy as best-effort
 * afterwards, the app-ready signal fired exactly once at the end. It owns all the v6 state (mega
 * client, pending challenge, serialisation) and talks to {@link EufySecurity} only through the
 * narrow {@link MegaTransitionHost} surface, so neither file leaks the other's internals.
 *
 * Mega is used for login, FCM registration, native inventory augmentation, product data-point
 * catalogs, per-device descriptors and read-only OTA discovery. The mature data layer still uses
 * the legacy transport for properties and commands that Mega does not yet describe completely.
 *
 * Nothing here modifies {@link MegaHTTPApi}: this layer only consumes its public API.
 */

/** The result of one v6 login attempt. */
export type MegaLoginResult = "ok" | "tfa_required" | "captcha_required" | "locked" | "failed";

/** Which backend a submitted 2FA code / captcha must be routed to. */
export type ChallengeSource = "mega" | "legacy";

interface NativeMegaDevice extends Record<string, unknown> {
  device_sn?: unknown;
  device_name?: unknown;
  device_model?: unknown;
  device_new_pn?: unknown;
  category?: unknown;
  device_id?: unknown;
  main_sw_version?: unknown;
  main_hw_version?: unknown;
  software_version?: unknown;
  hardware_version?: unknown;
  status?: unknown;
  device_type?: unknown;
}

interface NativeMegaInventory extends Record<string, unknown> {
  devices?: NativeMegaDevice[];
  groups?: unknown[];
}

export interface MegaProductCatalogSummary {
  attempted: number;
  available: number;
  empty: number;
  failed: number;
  dataPoints: number;
}

const safeString = (value: unknown, fallback = ""): string =>
  typeof value === "string" && value.length <= 256 ? value : fallback;

const recordOf = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

/** Resolve an exact named array through the response wrappers used by different Mega modules. */
export const findMegaArray = (value: unknown, key: string, depth = 0): unknown[] => {
  if (depth > 4 || !value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  if (Array.isArray(record[key])) return record[key] as unknown[];
  for (const wrapper of ["data", "result", "payload"]) {
    const found = findMegaArray(record[wrapper], key, depth + 1);
    if (found.length > 0) return found;
  }
  return [];
};

const romRecords = (value: unknown): Record<string, unknown>[] => {
  const response = recordOf(value);
  const candidates = Array.isArray(response.rom_versions)
    ? response.rom_versions
    : Array.isArray(response.devices)
      ? response.devices
      : Array.isArray(value)
        ? value
        : Object.keys(response).some((key) => key === "rom_version" || key === "rom_version_name")
          ? [response]
          : [];
  return candidates.map(recordOf);
};

const firmwareHostAllowed = (hostname: string): boolean =>
  ["eufy.com", "eufylife.com", "anker.com", "amazonaws.com", "amazonaws.com.cn", "cloudfront.net"].some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`)
  );

const md5File = async (file: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash("md5");
    const stream = createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });

/**
 * Translate only explicitly supported native-only products into the legacy-shaped in-memory model.
 * Unknown Mega products stay diagnostic-only until their semantics are verified. Parameter values,
 * broker details, account/member data, P2P material and network addresses are never copied.
 */
export const translateNativeMegaDevice = (device: NativeMegaDevice): DeviceListResponse | undefined => {
  const model = safeString(device.device_model ?? device.device_new_pn);
  const serial = safeString(device.device_sn);
  if (model !== "T87A0" || device.category !== "eufy_mega" || serial.length === 0) return undefined;

  return {
    device_id: typeof device.device_id === "number" ? device.device_id : 0,
    is_init_complete: false,
    device_sn: serial,
    device_name: safeString(device.device_name, "eufy Smart Display E10"),
    device_model: model,
    time_zone: "",
    device_type: DeviceType.SMART_DISPLAY_E10,
    device_channel: 0,
    station_sn: "",
    schedule: "",
    schedulex: "",
    wifi_mac: "",
    sub1g_mac: "",
    main_sw_version: safeString(device.main_sw_version ?? device.software_version),
    main_hw_version: safeString(device.main_hw_version ?? device.hardware_version),
    sec_sw_version: "",
    sec_hw_version: "",
    sector_id: 0,
    event_num: 0,
    wifi_ssid: "",
    ip_addr: "",
    volume: "",
    main_sw_time: 0,
    sec_sw_time: 0,
    bind_time: 0,
    bt_mac: "",
    cover_path: "",
    cover_time: 0,
    local_ip: "",
    language: "",
    sku_number: model,
    lot_number: "",
    cpu_id: "",
    create_time: 0,
    update_time: 0,
    status: typeof device.status === "number" ? device.status : 1,
    svr_domain: "",
    svr_port: 0,
    station_conn: {
      station_sn: "",
      station_name: "",
      station_model: "",
      main_sw_version: "",
      main_hw_version: "",
      p2p_did: "",
      push_did: "",
      ndt_did: "",
      p2p_conn: "",
      app_conn: "",
      binded: false,
      setup_code: "",
      setup_id: "",
      bt_mac: "",
      wifi_mac: "",
      dsk_key: "",
      expiration: 0,
    },
    family_num: 0,
    member: {} as DeviceListResponse["member"],
    permission: {},
    params: [],
    pir_total: 0,
    pir_none: 0,
    pir_missing: 0,
    week_pir_total: 0,
    week_pir_none: 0,
    month_pir_total: 0,
    month_pir_none: 0,
    charging_days: 0,
    charing_total: 0,
    charging_reserve: 0,
    charging_missing: 0,
    battery_usage_last_week: 0,
    virtual_version: "",
    relate_devices: [],
    baiamonte_native_source: "mega",
    baiamonte_read_only: true,
    // Device's legacy raw boolean converter consumes cloud values as strings.
    baiamonte_connected: "true",
  };
};

/**
 * The narrow surface {@link MegaTransition} needs from {@link EufySecurity}. It is satisfied with a
 * small closure object (not `this`) so neither side has to expose private members nor import the
 * other — keeping the transition layer self-contained and removable.
 */
export interface MegaTransitionHost {
  readonly config: EufySecurityConfig;
  readonly persistentData: EufySecurityPersistentData;
  /** The live (legacy) transport, set once by {@link MegaTransition.createTransport}. */
  readonly api: HTTPApi;
  writePersistentData(): void;
  /** Re-emit the 2FA prompt to the consumer (ws / plugin). */
  emitTfaRequest(): void;
  /** Re-emit the captcha prompt to the consumer (ws / plugin). */
  emitCaptchaRequest(id: string, captcha: string): void;
  /** The original upstream `connect()` (login + trust device), unchanged. */
  legacyConnect(options?: LoginOptions): Promise<void>;
  /** Signal the app as connected (refresh + push + mqtt). Fired once at the end of the sequence. */
  onAPIConnect(): Promise<void>;
  onConnectionError(error: Error): void;
}

/**
 * Coordinates the v6-first login sequence. The v6 "eufy_mega" backend is the primary login (it
 * carries push and is where the account is heading); the legacy login runs afterwards as
 * best-effort and never blocks. Each backend has its OWN 2FA email + captcha; whichever asks
 * records itself in {@link pendingChallenge} so the code/captcha from the next connect() is routed
 * to the backend that asked for it. The app-ready signal fires ONCE, at the very end, and only if a
 * login succeeded.
 */
export class MegaTransition {
  private readonly host: MegaTransitionHost;
  private megaApi?: MegaHTTPApi;
  /**
   * Which backend a submitted 2FA code / captcha must be routed to. Set when WE emit the challenge,
   * so the next connect({verifyCode|captcha}) goes to the backend that asked for it — no guessing.
   * `undefined` = no challenge outstanding (start a fresh sequence).
   */
  private pendingChallenge?: ChallengeSource;
  /** Whether the v6 login succeeded this sequence (gates signalling the app as connected). */
  private megaLoggedIn = false;
  /** A native inventory diagnostic is bounded to one attempt per process. */
  private inventoryDiagnosticAttempted = false;
  private nativeInventory?: NativeMegaInventory;
  private nativeInventoryInProgress?: Promise<NativeMegaInventory>;
  private nativeDeviceRelations?: unknown;
  private nativeDeviceDetails?: unknown;
  private nativeRomVersions?: unknown;
  private productCatalogRefresh?: Promise<void>;
  private readonly productDataPointCatalogs = new Map<string, unknown>();
  /** Serialises connect(): concurrent calls await the in-flight one instead of racing the sequence. */
  private connectInProgress?: Promise<void>;

  constructor(host: MegaTransitionHost) {
    this.host = host;
    rootMainLogger.info(`Baiamonte cloud policy: hybrid ${formatCapabilitySummary()}`);
    rootMainLogger.warn(
      "Baiamonte migration status: Mega augments supported native-only devices and catalogs; legacy remains required for the main inventory/properties/commands"
    );
  }

  private writeMegaStatus(status: Record<string, unknown>): void {
    const persistentDir = this.host.config.persistentDir;
    if (!persistentDir) return;
    const file = path.join(persistentDir, "baiamonte-mega-status.json");
    const temporary = `${file}.tmp`;
    try {
      writeFileSync(
        temporary,
        JSON.stringify({ updatedAt: new Date().toISOString(), megaAuthenticated: this.megaLoggedIn, ...status }),
        { mode: 0o600 }
      );
      renameSync(temporary, file);
    } catch (err) {
      rootMainLogger.debug("Unable to write redacted Baiamonte Mega status", {
        error: getError(ensureError(err)),
      });
    }
  }

  private async saveE10Firmware(records: Record<string, unknown>[]): Promise<Record<string, unknown>> {
    if (!this.host.config.firmwareResearch || !this.host.config.firmwareResearchDir)
      return { enabled: false, packageAvailable: false };
    const record = records.find((item) => safeString(item.device_type).toUpperCase().startsWith("T87A0"));
    const fullPackage = recordOf(record?.full_package);
    const source = safeString(fullPackage.file_path);
    if (!record || !source) return { enabled: true, packageAvailable: false };

    const sourceUrl = new URL(source);
    if (sourceUrl.protocol !== "https:" || !firmwareHostAllowed(sourceUrl.hostname))
      throw new Error("firmware package host is not allowlisted");
    const expectedSize = typeof fullPackage.file_size === "number" ? fullPackage.file_size : 0;
    const expectedMd5 = safeString(fullPackage.file_md5).toLowerCase();
    const version = safeString(record.rom_version_name, "unknown").replace(/[^A-Za-z0-9_.-]/g, "_");
    const sourceName = safeString(fullPackage.file_name) || path.basename(sourceUrl.pathname) || "firmware.bin";
    const extension =
      path
        .extname(sourceName)
        .replace(/[^A-Za-z0-9.]/g, "")
        .slice(0, 12) || ".bin";
    const directory = path.join(this.host.config.firmwareResearchDir, "T87A0");
    const destination = path.join(directory, `T87A0-${version}${extension}`);
    const temporary = `${destination}.part`;
    const maxBytes = 2 * 1024 * 1024 * 1024;
    mkdirSync(directory, { recursive: true, mode: 0o700 });

    try {
      const existing = statSync(destination);
      if (existing.isFile() && existing.size > 0 && (!expectedMd5 || (await md5File(destination)) === expectedMd5)) {
        return { enabled: true, packageAvailable: true, downloaded: true, version, bytes: existing.size };
      }
    } catch {
      // Download below.
    }

    let bytes = 0;
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        callback(bytes <= maxBytes ? undefined : new Error("firmware package exceeds 2 GiB"), chunk);
      },
    });
    try {
      const response = await fetch(sourceUrl, { redirect: "follow", signal: AbortSignal.timeout(300_000) });
      const finalUrl = new URL(response.url);
      if (!response.ok || !response.body) throw new Error(`firmware download failed with HTTP ${response.status}`);
      if (finalUrl.protocol !== "https:" || !firmwareHostAllowed(finalUrl.hostname))
        throw new Error("firmware redirect host is not allowlisted");
      await pipeline(
        Readable.fromWeb(response.body as import("stream/web").ReadableStream),
        limiter,
        createWriteStream(temporary, { mode: 0o600 })
      );
      if (expectedSize > 0 && bytes !== expectedSize) throw new Error("firmware size verification failed");
      const actualMd5 = await md5File(temporary);
      if (/^[a-f0-9]{32}$/.test(expectedMd5) && actualMd5 !== expectedMd5)
        throw new Error("firmware MD5 verification failed");
      renameSync(temporary, destination);
      rootMainLogger.info("E10 research firmware downloaded and verified", { version, bytes });
      return { enabled: true, packageAvailable: true, downloaded: true, version, bytes };
    } catch (err) {
      try {
        unlinkSync(temporary);
      } catch {
        // No partial file to remove.
      }
      throw err;
    }
  }

  /** Record that the LEGACY login asked for a code/captcha (called from the host's api-event hooks). */
  public recordLegacyChallenge(): void {
    this.pendingChallenge = "legacy";
  }

  /**
   * Build the live transport. Today this is just the upstream legacy {@link HTTPApi}; the v6 mega
   * client is created lazily on demand (login / push) via {@link getMegaApi}. Kept as a single
   * factory so the transport can be swapped here if v6 ever needs to drive data requests too.
   */
  public async createTransport(persistentHttpApi: HTTPApiPersistentData | undefined): Promise<HTTPApi> {
    return HTTPApi.initialize(
      this.host.config.country!,
      this.host.config.username!,
      this.host.config.password!,
      persistentHttpApi
    );
  }

  private async runInventoryDiagnostic(): Promise<void> {
    if (!this.host.config.megaInventoryDiagnostics || this.inventoryDiagnosticAttempted) return;
    this.inventoryDiagnosticAttempted = true;
    try {
      const summary = summarizeMegaHouseInventory(await this.loadNativeInventory());
      rootMainLogger.info("v6 inventory diagnostic (identifiers redacted)", summary);
    } catch (err) {
      rootMainLogger.warn("v6 inventory diagnostic unavailable; legacy inventory remains active", {
        error: getError(ensureError(err)),
      });
    }
  }

  private async loadNativeInventory(): Promise<NativeMegaInventory> {
    if (this.nativeInventory) return this.nativeInventory;
    if (!this.nativeInventoryInProgress) {
      this.nativeInventoryInProgress = (async () => {
        const value = (await (await this.getMegaApi()).getHouseInventoryDecrypted()) as NativeMegaInventory;
        const inventory: NativeMegaInventory = {
          devices: Array.isArray(value?.devices) ? value.devices : [],
          groups: Array.isArray(value?.groups) ? value.groups : [],
        };
        this.nativeInventory = inventory;
        return inventory;
      })().finally(() => {
        this.nativeInventoryInProgress = undefined;
      });
    }
    return this.nativeInventoryInProgress;
  }

  /** Native-only products currently safe to expose to the legacy-shaped websocket model. */
  public async getSupportedNativeDevices(): Promise<DeviceListResponse[]> {
    if (!this.megaLoggedIn) return [];
    try {
      const inventory = await this.loadNativeInventory();
      return (inventory.devices ?? [])
        .map(translateNativeMegaDevice)
        .filter((device): device is DeviceListResponse => device !== undefined);
    } catch (err) {
      rootMainLogger.warn("v6 native inventory augmentation unavailable; legacy inventory remains active", {
        error: getError(ensureError(err)),
      });
      return [];
    }
  }

  /**
   * Read every distinct native product catalog reported by this account. This is deliberately
   * background, read-only, and bounded; startup and existing controls never wait for catalog scans.
   */
  public refreshProductDataPointCatalogs(): Promise<void> {
    if (!this.megaLoggedIn) return Promise.resolve();
    if (this.productCatalogRefresh) return this.productCatalogRefresh;
    this.productCatalogRefresh = (async () => {
      const summary: MegaProductCatalogSummary = { attempted: 0, available: 0, empty: 0, failed: 0, dataPoints: 0 };
      const discovery: Record<string, unknown> = {
        legacyFallbackRequired: true,
        descriptors: { available: false, devices: 0 },
        ota: { requested: 0, records: 0 },
        firmware: { enabled: Boolean(this.host.config.firmwareResearch), packageAvailable: false },
      };
      try {
        const inventory = await this.loadNativeInventory();
        discovery.inventory = summarizeMegaHouseInventory(inventory);
        let relationDevices: unknown[] = [];
        try {
          this.nativeDeviceRelations ??= await (await this.getMegaApi()).getDeviceRelationsDecrypted("", 7);
          relationDevices = findMegaArray(this.nativeDeviceRelations, "devices");
        } catch {
          // The house inventory is still enough to continue the product catalog scan.
        }
        const relationProductCodes = relationDevices.map((entry) => {
          const wrapper = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
          const detail =
            wrapper.device && typeof wrapper.device === "object"
              ? (wrapper.device as Record<string, unknown>)
              : wrapper;
          return safeString(detail.device_model ?? detail.device_new_pn);
        });
        const productCodes = Array.from(
          new Set(
            (inventory.devices ?? [])
              .map((device) => safeString(device.device_model ?? device.device_new_pn))
              .concat(relationProductCodes)
              .filter((code) => code.length > 0 && code.length <= 64)
          )
        ).slice(0, 64);
        const mega = await this.getMegaApi();
        try {
          this.nativeDeviceDetails ??= await mega.getDeviceDetailsDecrypted("", 7);
          const devices = findMegaArray(this.nativeDeviceDetails, "devices");
          rootMainLogger.info("v6 per-device capability descriptors loaded (contents redacted)", {
            devices: devices.length,
            available: devices.length > 0,
          });
          discovery.descriptors = { devices: devices.length, available: devices.length > 0 };
        } catch (err) {
          discovery.descriptors = { devices: 0, available: false, unavailable: true };
          // Catalog discovery remains useful even where this newer endpoint is unavailable.
        }

        const romRequests = (inventory.devices ?? [])
          .map((device) => ({
            device_type: `${safeString(device.device_model ?? device.device_new_pn)}_ota`,
            device_sn: safeString(device.device_sn),
            category: "eufy_home",
          }))
          .filter((device) => device.device_type.length > 4 && device.device_sn.length > 0)
          .slice(0, 64);
        if (romRequests.length > 0) {
          try {
            this.nativeRomVersions ??= await mega.getRomVersionsDecrypted(romRequests);
            const records = romRecords(this.nativeRomVersions);
            const e10Request = romRequests.find((request) => request.device_type === "T87A0_ota");
            if (e10Request) {
              try {
                records.push(...romRecords(await mega.getRomVersionDecrypted(e10Request)));
              } catch {
                // Batch results may still include the E10.
              }
            }
            rootMainLogger.info("v6 OTA metadata loaded without starting upgrades (contents redacted)", {
              requested: romRequests.length,
              records: records.length,
            });
            discovery.ota = {
              requested: romRequests.length,
              records: records.length,
              packages: records.filter((record) => safeString(recordOf(record.full_package).file_path).length > 0)
                .length,
            };
            try {
              discovery.firmware = await this.saveE10Firmware(records);
            } catch (err) {
              discovery.firmware = {
                enabled: true,
                packageAvailable: records.some(
                  (record) =>
                    safeString(record.device_type).toUpperCase().startsWith("T87A0") &&
                    safeString(recordOf(record.full_package).file_path).length > 0
                ),
                downloaded: false,
                verificationFailed: true,
              };
            }
          } catch (err) {
            discovery.ota = { requested: romRequests.length, records: 0, unavailable: true };
            // OTA discovery is optional and must never affect normal controls.
          }
        }
        for (const productCode of productCodes) {
          summary.attempted++;
          try {
            const catalog = await mega.getProductDataPointsDecrypted(productCode);
            this.productDataPointCatalogs.set(productCode, catalog);
            const points = Array.isArray(catalog) ? catalog : findMegaArray(catalog, "data_point_list");
            summary.dataPoints += points.length;
            if (points.length === 0) summary.empty++;
            else summary.available++;
          } catch {
            summary.failed++;
          }
        }
        rootMainLogger.info("v6 product data-point catalog scan complete (product codes and values redacted)", summary);
        discovery.catalogs = summary;
        this.writeMegaStatus(discovery);
      } catch (err) {
        rootMainLogger.warn("v6 product data-point catalog scan unavailable", { error: getError(ensureError(err)) });
        discovery.catalogs = summary;
        discovery.unavailable = true;
        this.writeMegaStatus(discovery);
      }
    })();
    return this.productCatalogRefresh;
  }

  /**
   * Lazily create (and restore) the v6 mega client. The persisted session (token ~30 days) is
   * reused so normal startups need no extra login/2FA; it is dropped if the credentials changed.
   */
  public async getMegaApi(): Promise<MegaHTTPApi> {
    if (!this.megaApi) {
      this.megaApi = new MegaHTTPApi({
        ab: this.host.config.country ?? "US",
        osType: "android",
        phoneModel: this.host.config.trustedDeviceName,
        openudid: this.host.persistentData.openudid || undefined,
      });
      await this.megaApi.init();
      const saved = this.host.persistentData.megaApi;
      if (saved) {
        const currentHash = megaLoginHash(
          this.host.config.username,
          this.host.config.password,
          this.host.persistentData.openudid
        );
        if (saved.login_hash && saved.login_hash !== currentHash) {
          rootMainLogger.debug("v6: credentials changed since last login, ignoring stored mega session");
        } else {
          this.megaApi.restoreSession(saved);
        }
      }
    }
    return this.megaApi;
  }

  /**
   * Register the FCM token on the v6 backend, best-effort. No-ops with a log when there is no valid
   * v6 session yet (not-yet-migrated account); a v6 failure is swallowed so legacy push is unaffected.
   */
  public async registerMegaPushToken(token: string): Promise<boolean> {
    try {
      const mega = await this.getMegaApi();
      if (!mega.hasValidSession()) {
        rootMainLogger.debug("v6 push: no valid mega session yet, skipping register (legacy still active)");
        return false;
      }
      const result = await mega.registerPushToken(token);
      if (result.code === 0) {
        // registerPushToken may have repaired a stale persisted ECDH identity. Save the refreshed
        // identity so the next add-on restart does not repeat the rejected-key handshake.
        this.host.persistentData.megaApi = mega.exportSession(
          megaLoginHash(this.host.config.username, this.host.config.password, this.host.persistentData.openudid)
        );
        this.host.writePersistentData();
        rootMainLogger.info("v6 push: FCM token registered on the eufy_mega backend");
        return true;
      }
      rootMainLogger.warn("v6 push: register_push_token returned a non-zero code", {
        code: result.code,
        msg: result.msg,
      });
      return false;
    } catch (err) {
      rootMainLogger.warn("v6 push: register failed (legacy push unaffected)", { error: getError(ensureError(err)) });
      return false;
    }
  }

  /**
   * Authenticate against the v6 backend.
   *  1. first call -> on `26052` triggers the email code and returns "tfa_required"; on a captcha
   *     challenge it emits "captcha request" and returns "captcha_required".
   *  2. with a code/captcha -> completes login; the session is persisted (token ~30 days) so later
   *     startups reuse it with no relogin/2FA.
   *
   * Backend-enforced lockout (too many incorrect / max login limit) is surfaced as "locked" so the
   * caller stops retrying instead of deepening the lockout.
   */
  public async loginMega(
    verifyCode?: string,
    captcha?: { captchaId: string; answer: string }
  ): Promise<MegaLoginResult> {
    try {
      const mega = await this.getMegaApi();
      if (mega.hasValidSession() && !verifyCode && !captcha) return "ok";

      await mega.estimateDomain();
      await mega.keyExchange(mega.clusterHost("openapi"));
      const result = await mega.login(this.host.config.username!, this.host.config.password!, verifyCode, captcha);

      if (result.code === ResponseErrorCode.CODE_NEED_VERIFY_CODE) {
        await mega.sendVerifyCode();
        this.pendingChallenge = "mega";
        this.host.emitTfaRequest();
        rootMainLogger.info("v6 login: email 2FA required — call loginMega(code) with the received code");
        return "tfa_required";
      }
      if (
        result.code === ResponseErrorCode.LOGIN_NEED_CAPTCHA ||
        result.code === ResponseErrorCode.LOGIN_CAPTCHA_ERROR
      ) {
        const c = await mega.generateCaptcha();
        this.pendingChallenge = "mega";
        this.host.emitCaptchaRequest(c.captcha_id, c.item);
        rootMainLogger.info("v6 login: captcha required — call loginMega(undefined, {captchaId, answer})");
        return "captcha_required";
      }
      if (
        result.code === ResponseErrorCode.CODE_PASSWORD_TOO_MANY_INCORRECT ||
        result.code === ResponseErrorCode.CODE_PASSWORD_WRONG_FIVE_TIMES ||
        result.code === ResponseErrorCode.CODE_MAX_LOGIN_LIMIT
      ) {
        rootMainLogger.warn("v6 login temporarily locked by the backend — stop retrying", {
          code: result.code,
          msg: result.msg,
        });
        return "locked";
      }
      if (result.code !== 0) {
        rootMainLogger.warn("v6 login failed", { code: result.code, msg: result.msg });
        return "failed";
      }
      this.host.persistentData.megaApi = mega.exportSession(
        megaLoginHash(this.host.config.username, this.host.config.password, this.host.persistentData.openudid)
      );
      this.host.writePersistentData();
      rootMainLogger.info("v6 login: success, mega session persisted");
      return "ok";
    } catch (err) {
      rootMainLogger.error("v6 login error", { error: getError(ensureError(err)) });
      return "failed";
    }
  }

  /** Serialised connect(): concurrent callers await the in-flight run instead of racing it. */
  public connect(options?: LoginOptions): Promise<void> {
    if (this.connectInProgress) return this.connectInProgress;
    this.connectInProgress = this.runConnect(options).finally(() => {
      this.connectInProgress = undefined;
    });
    return this.connectInProgress;
  }

  private async runConnect(options?: LoginOptions): Promise<void> {
    const megaCaptcha = options?.captcha
      ? { captchaId: options.captcha.captchaId, answer: options.captcha.captchaCode }
      : undefined;

    // PHASE 1 — v6 first. Run it unless a challenge is currently outstanding for the LEGACY side.
    if (this.pendingChallenge !== "legacy") {
      const megaResult = await this.loginMega(options?.verifyCode, megaCaptcha);
      if (megaResult === "tfa_required" || megaResult === "captcha_required") {
        // loginMega already recorded pendingChallenge="mega" and prompted the consumer.
        return;
      }
      this.megaLoggedIn = megaResult === "ok";
      this.pendingChallenge = undefined;
      if (this.megaLoggedIn) await this.runInventoryDiagnostic();
    }

    // PHASE 2 — legacy afterwards, best-effort. A code/captcha just used by mega is not valid here;
    // the legacy login emits its OWN tfa/captcha event (which records pendingChallenge="legacy" via
    // the host) and we wait for the next connect(). If legacy has been decommissioned, its login
    // simply fails and we carry on with v6 only.
    if (!this.host.api.isConnected()) {
      const legacyOptions =
        this.pendingChallenge === "legacy"
          ? options
          : ({ ...options, verifyCode: undefined, captcha: undefined } as LoginOptions);
      this.pendingChallenge = undefined;
      await this.host.legacyConnect(legacyOptions);
      // legacyConnect may have recorded pendingChallenge="legacy" via the host's api-event hooks.
      if (this.pendingChallenge === "legacy" && !this.host.api.isConnected()) return;
    }

    // PHASE 3 — both backends settled. Signal the app ONCE, only if a login actually succeeded.
    if (this.megaLoggedIn || this.host.api.isConnected()) {
      await this.host.onAPIConnect();
      void this.refreshProductDataPointCatalogs();
    } else {
      rootMainLogger.warn("connect: neither v6 nor legacy login succeeded — not signalling connected");
      this.host.onConnectionError(new Error("Login failed on both backends"));
    }
  }
}
