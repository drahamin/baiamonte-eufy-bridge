# Baiamonte eufy Bridge

`pro_session_compatibility` is off by default. It selects the earlier portal session
message envelope for Pro firmware comparison while retaining Mega authentication,
WEB service discovery, bounded table reads and graceful peer cleanup. Enable it
only when comparison against the default envelope demonstrates a better result.

Home Assistant add-on providing the schema-21 Eufy WebSocket service with Mega v6 login/push fixes,
native-only E10 inventory, HomeBase Pro support, read-only OTA discovery, an ingress status
dashboard, push-thumbnail retries, v2 thumbnail decoding, and a persistent last-event image cache.

See the [full repository README](../README.md) and the **Documentation** tab after installation. The
distinct Baiamonte slug prevents this add-on from overwriting either upstream add-on.
