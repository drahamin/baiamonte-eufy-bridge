import { MegaIdentity } from "./megaCrypto";

export interface MegaResult {
  code: number;
  msg: string;
  data?: unknown;
  trace_id?: string;
}

/** Picture-captcha challenge returned by `passport/generate/captcha`. `item` is a base64 image. */
export interface MegaCaptcha {
  captcha_id: string;
  item: string;
}

/** Caller's captcha answer, passed back into the login call. */
export interface MegaCaptchaAnswer {
  captchaId: string;
  answer: string;
}

/** Raw `devicemanage/get_user_mqtt_info` payload (AWS IoT mutual-TLS credentials). */
export interface MegaUserMqttInfo {
  endpoint_addr: string;
  certificate_pem: string;
  private_key: string;
  aws_root_ca1_pem: string;
  thing_name: string;
  certificate_id: string;
  user_id: string;
  app_name: string;
}

/**
 * Everything needed to open the v6 AWS IoT (mutual-TLS) MQTT connection, assembled so a consumer
 * never has to reach into MegaHTTPApi internals. Topics use `PN`/`SN` placeholders to fill per
 * device (`cmd/eufy_security/PN/SN/res`, …) — see SecurityMqttConstant in the v6 app.
 */
export interface MegaMqttConnectConfig {
  endpoint: string;
  port: number;
  clientId: string;
  thingName: string;
  userId: string;
  certificatePem: string;
  privateKey: string;
  awsRootCaPem: string;
  topics: { subCmd: string; stateInfo: string; pubCmd: string };
}

export interface MegaApiOptions {
  /** Region/AB code, e.g. "fr", "us". Drives estimate_domain. */
  ab: string;
  /** os-type — MUST be "android" for the identity to route events via FCM. */
  osType?: "android" | "iOS";
  appName?: string;
  appVersion?: string;
  osVersion?: string;
  phoneModel?: string;
  /** Stable per-install device id. Seed it from the existing persisted openudid so the v6 client
   *  presents the same device as the legacy path instead of a fresh id each run. */
  openudid?: string;
  /** Min delay between requests in ms (WAF-friendly). Default 3000. */
  minRequestIntervalMs?: number;
}

/** Exact request shape used by the official v6 app for `house/get_devs_list`. */
export interface MegaHouseInventoryRequest {
  house_id?: string;
  categories?: string[];
  add_pns?: string[];
}

/** One device descriptor accepted by the official batch ROM-version endpoint. */
export interface MegaRomVersionRequest {
  /** Official app sends the product model suffixed with `_ota`, e.g. `T87A0_ota`. */
  device_type: string;
  device_sn: string;
  category: string;
}

/** Request used by the official app's native product data-point catalog endpoint. */
export interface MegaProductDataPointRequest {
  code: string;
}

/** One native product data-point descriptor as modeled by app 6.0.80. */
export interface MegaDataPointDescriptor {
  code: string;
  dp_id: number;
  name: string;
  mode: string;
  data_type: string;
  desc: string;
  property: string;
  create_time: number;
  update_time: number;
}

/** Inner data object returned by `things/get_product_data_point`. */
export interface MegaProductDataPointCatalog {
  data_point_list: MegaDataPointDescriptor[];
}

/** Request used by both native device-relation inventory endpoints. */
export interface MegaDeviceRelationRequest {
  attribute: number;
  house_id: string;
}

/** Device parameter shape used by the native relation/device-detail model. */
export interface MegaDeviceParameter {
  param_name: string;
  param_value: string;
  create_time: number;
  update_time: number;
}

/** Verified common fields in the app's AIOT device relation model. */
export interface MegaDeviceRelation {
  device_sn?: string;
  device_name?: string;
  device_model?: string;
  device_new_pn?: string;
  category?: string;
  params?: MegaDeviceParameter[];
  [key: string]: unknown;
}

export interface MegaDeviceRelationList {
  devices: MegaDeviceRelation[];
}

/** One requested privacy/consent data-point switch. This is not a general command request. */
export interface MegaDevicePointSwitchRequestItem {
  destination: string;
  param_names: string[];
  device_sn: string;
  categories: string[];
}

export interface MegaDevicePointSwitchRequest {
  batch_get_device_params: MegaDevicePointSwitchRequestItem[];
}

export interface MegaDevicePointSwitch {
  param_name: string;
  param_value: string;
  destination: string;
  device_sn: string;
  category: string;
  account: string;
}

/** Protocol numbers used inside the native AIoT MQTT payload. */
export enum MegaMqttProtocol {
  State = 1,
  DataPointCommand = 2,
  Online = 4,
  Offline = 5,
  OtaCommand = 9,
  OtaState = 10,
  AutoUpgradeCommand = 11,
  AutoUpgradeState = 12,
  PhotoCommand = 42,
  PhotoState = 43,
}

export interface MegaMqttHeader {
  version: "1.0.0.1";
  client_id: string;
  sess_id: string;
  msg_seq: number;
  cmd: number;
  cmd_status: number;
  sign_code: number;
  seed: string;
  timestamp: number;
}

export interface MegaMqttPayload {
  protocol: MegaMqttProtocol;
  t: number;
  account_id: string;
  device_sn: string;
  data: Record<string, unknown>;
}

/** Wire representation: the inner payload is JSON encoded as a string. */
export interface MegaMqttCommandEnvelope {
  head: MegaMqttHeader;
  payload: string;
}

/** Identifier-free aggregate suitable for diagnostics and logs. */
export interface MegaHouseInventorySummary {
  deviceCount: number;
  groupCount: number;
  models: Record<string, number>;
  categories: Record<string, number>;
  parameters: {
    total: number;
    minPerDevice: number;
    maxPerDevice: number;
    types: string[];
    knownTypes: string[];
    unknownTypes: string[];
  };
}

/**
 * Serializable session for resume-without-relogin (see {@link MegaHTTPApi.exportSession}).
 *
 * Field names intentionally mirror the legacy `EufySecurityPersistentData` / `HTTPApiPersistentData`
 * conventions (`openudid`, `cloud_token`, `cloud_token_expiration`, `login_hash`, `user_id`) so this
 * can slot into the existing persistence layer. `login_hash = md5(user:pass)` lets the consumer
 * invalidate the cached session when credentials change — exactly like HTTPApi does.
 */
export interface MegaSession {
  ab: string;
  openudid: string;
  login_hash?: string;
  cloud_token?: string;
  cloud_token_expiration?: number;
  user_id?: string;
  domains?: Record<string, string>;
  megaDomain?: string;
  /** Per-cluster ECDH identities (keyIdent + sharedKey + clientPublicKey). */
  identities?: Record<string, MegaIdentity>;
}
