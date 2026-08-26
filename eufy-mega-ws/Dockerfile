FROM ghcr.io/home-assistant/base:3.23 AS client-builder

RUN apk add --no-cache nodejs npm

WORKDIR /build/eufy-security-client
COPY vendor/eufy-security-client/ ./

# Build the reviewed, vendored client and package only its runtime output.
RUN \
    set -eux \
    && node --version \
    && case "$(node --version)" in v24.*) ;; *) echo "Expected Node 24" >&2; exit 1 ;; esac \
    && npm ci \
    && npm run build \
    && npm pack --ignore-scripts --pack-destination /tmp \
    && test -s /tmp/eufy-security-client-4.1.1-mega.23.tgz

FROM ghcr.io/home-assistant/base:3.23 AS server-builder

RUN apk add --no-cache nodejs npm

WORKDIR /build/eufy-security-ws
COPY vendor/eufy-security-ws/ ./
COPY --from=client-builder /tmp/eufy-security-client-4.1.1-mega.23.tgz /tmp/eufy-security-client-4.1.1-mega.23.tgz

# Compile the exact schema-21 server source and retain only its locked runtime dependencies.
RUN \
    set -eux \
    && node --version \
    && case "$(node --version)" in v24.*) ;; *) echo "Expected Node 24" >&2; exit 1 ;; esac \
    && npm ci \
    && rm -rf node_modules/eufy-security-client \
    && mkdir -p node_modules/eufy-security-client \
    && tar -xzf /tmp/eufy-security-client-4.1.1-mega.23.tgz \
        --strip-components=1 \
        -C node_modules/eufy-security-client \
    && npm run build \
    && npm prune --omit=dev \
    && test "$(node -p "require('./package.json').version")" = "3.1.0" \
    && grep -q "maxSchemaVersion = 21" dist/lib/const.js

FROM ghcr.io/home-assistant/base:3.23

ARG BUILD_ARCH
ARG BUILD_VERSION

LABEL \
    io.hass.version="${BUILD_VERSION}" \
    io.hass.type="app" \
    io.hass.arch="${BUILD_ARCH}" \
    org.opencontainers.image.title="Baiamonte eufy Bridge" \
    org.opencontainers.image.description="Baiamonte Home Assistant bridge and dashboard for eufy Mega, legacy fallback, and P2P" \
    org.opencontainers.image.licenses="MIT" \
    org.opencontainers.image.source="https://github.com/drahamin/baiamonte-eufy-bridge" \
    org.opencontainers.image.version="${BUILD_VERSION}"

RUN apk add --no-cache jq nodejs python3 py3-pip curl

WORKDIR /usr/src/app/node_modules/eufy-security-ws
COPY --from=server-builder /build/eufy-security-ws/dist ./dist
COPY --from=server-builder /build/eufy-security-ws/node_modules ./node_modules
COPY --from=server-builder /build/eufy-security-ws/package.json ./package.json
COPY --from=server-builder /build/eufy-security-ws/LICENSE ./LICENSE

COPY --from=client-builder /tmp/eufy-security-client-4.1.1-mega.23.tgz /tmp/eufy-security-client-4.1.1-mega.23.tgz

# eufy-security-ws 3.1.0 pins client 4.1.0 exactly. Replace that package with the compatible
# 4.1.1-mega.23 source build carrying native HomeBase Pro event evidence,
# evidence-ranked native catalogs, safe value profiles, T9000, and snapshot fixes.
RUN \
    set -eux \
    && node --version \
    && case "$(node --version)" in v24.*) ;; *) echo "Expected Node 24" >&2; exit 1 ;; esac \
    && rm -rf node_modules/eufy-security-client \
    && mkdir -p node_modules/eufy-security-client \
    && tar -xzf /tmp/eufy-security-client-4.1.1-mega.23.tgz \
        --strip-components=1 \
        -C node_modules/eufy-security-client \
    && package_tmp="$(mktemp)" \
    && jq '.dependencies["eufy-security-client"] = "4.1.1-mega.23"' \
        package.json > "${package_tmp}" \
    && mv "${package_tmp}" package.json \
    && test "$(node -p "require('./node_modules/eufy-security-client/package.json').version")" = "4.1.1-mega.23" \
    && grep -q "retrying request after fresh key exchange" \
        node_modules/eufy-security-client/build/http/megaApi.js \
    && grep -q "snapshotCache" node_modules/eufy-security-client/build/eufysecurity.js \
    && grep -q "or_and" node_modules/eufy-security-client/build/http/station.js \
    && rm /tmp/eufy-security-client-4.1.1-mega.23.tgz

COPY dashboard/ /opt/baiamonte-eufy-dashboard/
COPY pro-events/ /opt/baiamonte-pro-events/
RUN \
    set -eux \
    && python3 -m venv /opt/baiamonte-pro-events/venv \
    && /opt/baiamonte-pro-events/venv/bin/pip install --no-cache-dir \
        aiortc==1.15.0 websockets==17.0.1 aiohttp==3.14.3 truststore==0.10.4 \
    && mkdir -p /opt/baiamonte-pro-events/worker \
    && curl -fsSL https://security.eufy.com/plugin/libsctp_0_0_2.js \
        -o /opt/baiamonte-pro-events/worker/libsctp_0_0_2.js \
    && curl -fsSL https://security.eufy.com/plugin/libsctp_0_0_2.wasm \
        -o /opt/baiamonte-pro-events/worker/libsctp_0_0_2.wasm \
    && echo "423f2f6314c15984886320d1b3c71f268f0ce6449d6c4e02d6c4898ad9e510fd  /opt/baiamonte-pro-events/worker/libsctp_0_0_2.js" | sha256sum -c - \
    && echo "52c12617f8b87c08d967402f3ff749e1e8913d5be878fa88940e11f5ccdd2421  /opt/baiamonte-pro-events/worker/libsctp_0_0_2.wasm" | sha256sum -c - \
    && chmod 0755 /opt/baiamonte-pro-events/pro_event_helper.py \
    && (node /opt/baiamonte-pro-events/sctp_oracle.cjs </dev/null >/tmp/sctp-selftest.out 2>/tmp/sctp-selftest.err & \
        oracle_pid=$!; sleep 1; kill "${oracle_pid}"; wait "${oracle_pid}" || true) \
    && grep -q '"event":"ready"' /tmp/sctp-selftest.out \
    && rm -f /tmp/sctp-selftest.out /tmp/sctp-selftest.err
COPY run.sh /
RUN chmod 0755 /run.sh

WORKDIR /data
CMD ["/run.sh"]
