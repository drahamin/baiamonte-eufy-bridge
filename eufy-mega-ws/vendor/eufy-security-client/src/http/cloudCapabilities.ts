/**
 * Cloud/P2P ownership for the Baiamonte transitional bridge.
 *
 * Keep this table honest: it is the migration checklist for replacing legacy cloud calls with
 * native Mega implementations. A capability moves to `mega` only when its native implementation
 * is shipped and covered by tests. P2P is device transport, not a legacy cloud dependency.
 */
export type CapabilityProvider = "mega" | "legacy" | "p2p";

export const CLOUD_CAPABILITIES = {
  authentication: "mega",
  pushRegistration: "mega",
  inventory: "legacy",
  nativeInventoryAugmentation: "mega",
  productDataPointCatalogs: "mega",
  cloudProperties: "legacy",
  cloudCommands: "legacy",
  invitations: "legacy",
  livestream: "p2p",
  directDeviceCommands: "p2p",
} as const satisfies Record<string, CapabilityProvider>;

export const getCapabilitiesForProvider = (provider: CapabilityProvider): string[] =>
  Object.entries(CLOUD_CAPABILITIES)
    .filter(([, owner]) => owner === provider)
    .map(([capability]) => capability);

export const formatCapabilitySummary = (): string =>
  (["mega", "legacy", "p2p"] as const)
    .map((provider) => `${provider}=[${getCapabilitiesForProvider(provider).join(",")}]`)
    .join(" ");
