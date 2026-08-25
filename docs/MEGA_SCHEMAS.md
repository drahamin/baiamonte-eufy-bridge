# Mega schema audit

This audit is derived from the official Android app `6.0.80_28612` and is intentionally limited to
data structures needed by the bridge. Account identifiers, device serials, credentials, parameter
values, and firmware URLs are not recorded.

## Verified read schemas

| Service | Path | Request | Relevant response data |
| --- | --- | --- | --- |
| house | `/app/house/get_devs_list` | `house_id`, `categories[]`, `add_pns[]` | `devices[]`, `groups[]`; security inventory devices contain numeric `params[].param_type` values |
| devicerelation | `/app/devicerelation/get_device_list` | `attribute`, `house_id` | `data.devices[]` AIOT relation records |
| devicerelation | `/app/devicerelation/get_devices_info` | `attribute`, `house_id` | `data.devices[]` richer AIOT device records |
| things | `/app/things/get_product_data_point` | `code` | `data.data_point_list[]` |
| ota | `/app/ota/get_rom_version` | `device_type`, `device_sn`, `category` | one ROM metadata record |
| ota | `/app/ota/get_rom_versions` | `get_roms_param[]` containing the single-ROM request fields | ROM metadata records |

Current Mega modules do not all unwrap the encrypted response to the same depth. Catalogs and
device relations can retain one or more `data` wrappers. The bridge therefore resolves only an
exact expected array name through a bounded set of known wrappers (`data`, `result`, `payload`).

One catalog descriptor contains `code`, `dp_id`, `name`, `mode`, `data_type`, `desc`, `property`,
`create_time`, and `update_time`. One AIOT named parameter contains `param_name`, `param_value`,
`create_time`, and `update_time`.

## Verified writable transport schema

General AIOT data-point commands are published over the account's mutual-TLS MQTT connection to:

`cmd/eufy_security/{productCode}/{deviceSerial}/req`

The JSON message contains `head` and a string-encoded JSON `payload`. The payload fields are
`protocol`, `t`, `account_id`, `device_sn`, and `data`. Protocol `2` is a normal data-point command;
protocols `9` and `11` are OTA-start and automatic-upgrade commands. The bridge now models and
tests this wire format but does not publish commands until a live product catalog marks the target
data point writable.

The HTTP route `/app/devicemanage/update_device_params` is present in the app's Retrofit service,
but the interface declares no body and the examined app path does not use it for normal data-point
commands. It is not treated as a safe command API.

## Consent switches are separate

`/app/agreement/get_device_point_switch` and `/app/agreement/set_device_point_switch` operate on
privacy/consent switches. Their records use `param_name`, `param_value`, `destination`, `device_sn`,
`category`, and `account`. They must not be confused with the general device control catalog.

## Remaining live-verification gates

- Continue monitoring which connected products return non-empty `data_point_list` catalogs with the
  current app identity. The scanner now tries the inventory's `device_new_pn` and `device_model`
  aliases once each when they differ.
- Correlate catalog `dp_id`/`code` with each device's native state without exposing values.
- Enable MQTT writes only for a device/data-point pair whose catalog mode explicitly permits writes.
- Treat unknown product codes and undocumented HTTP routes as read-only diagnostics.

## Live coverage snapshot

After deploying the current identity and nested-envelope parser on 2026-08-25, both tested US
accounts still returned successful but empty product catalogs, and the richer descriptor route was
unavailable. Native house inventory was not empty: the larger account exposed 305 distinct numeric
parameter IDs, 207 already present in the legacy command/parameter enums and 98 unmapped; the
second exposed 217 IDs, 146 mapped and 71 unmapped. The dashboard calculates these sets on every
scan so later server-side catalog rollouts are visible without recording parameter values.

When a server catalog is empty, the bridge now synthesizes a per-product catalog from the native
inventory: known numeric IDs receive their existing enum names, unknown IDs receive stable
`param_<id>` names, and every synthesized point is forced to `ro`/`observed`. These catalogs make
native state coverage usable immediately but cannot authorize a write. A real server descriptor or
separately verified device protocol is still required before changing a point.

The dashboard calls the union of populated official descriptors and synthesized signed-inventory
catalogs **effective native read catalogs**. This is a coverage statement, not a write claim. Native
MQTT publishing remains gated on an official descriptor whose mode explicitly authorizes the exact
device/data-point pair.
