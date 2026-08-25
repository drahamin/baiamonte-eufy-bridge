# Home Assistant eufy_security compatibility patch

`eufy-security-8.2.4-websocket-recovery.patch` is a narrow recovery patch for the
separate `fuatakgun/eufy_security` Home Assistant integration. It is not part of the
Baiamonte bridge container.

It rejects non-text WebSocket frames before JSON parsing, bounds bridge-response waits
at 30 seconds, and suppresses pre-inventory event payloads that can contain sensitive
camera URLs. The original files should be backed up before applying it. Remove the
patch when an upstream release contains the equivalent fixes.

The upstream 8.2.4 WebSocket client uses CRLF line endings. Normalize that one file,
then apply from the integration repository root:

```sh
sed -i.bak 's/\r$//' custom_components/eufy_security/eufy_security_api/web_socket_client.py
git apply eufy-security-8.2.4-websocket-recovery.patch
```
