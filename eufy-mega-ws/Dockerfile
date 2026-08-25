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
    && test -s /tmp/eufy-security-client-4.1.1-mega.13.tgz

FROM ghcr.io/home-assistant/base:3.23 AS server-builder

RUN apk add --no-cache nodejs npm

WORKDIR /build/eufy-security-ws
COPY vendor/eufy-security-ws/ ./

# Compile the exact schema-21 server source and retain only its locked runtime dependencies.
RUN \
    set -eux \
    && node --version \
    && case "$(node --version)" in v24.*) ;; *) echo "Expected Node 24" >&2; exit 1 ;; esac \
    && npm ci \
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

RUN apk add --no-cache jq nodejs

WORKDIR /usr/src/app/node_modules/eufy-security-ws
COPY --from=server-builder /build/eufy-security-ws/dist ./dist
COPY --from=server-builder /build/eufy-security-ws/node_modules ./node_modules
COPY --from=server-builder /build/eufy-security-ws/package.json ./package.json
COPY --from=server-builder /build/eufy-security-ws/LICENSE ./LICENSE

COPY --from=client-builder /tmp/eufy-security-client-4.1.1-mega.13.tgz /tmp/eufy-security-client-4.1.1-mega.13.tgz

# eufy-security-ws 3.1.0 pins client 4.1.0 exactly. Replace that package with the compatible
# 4.1.1-mega.13 source build carrying evidence-ranked native catalogs, safe value profiles, T9000,
# and snapshot fixes.
RUN \
    set -eux \
    && node --version \
    && case "$(node --version)" in v24.*) ;; *) echo "Expected Node 24" >&2; exit 1 ;; esac \
    && rm -rf node_modules/eufy-security-client \
    && mkdir -p node_modules/eufy-security-client \
    && tar -xzf /tmp/eufy-security-client-4.1.1-mega.13.tgz \
        --strip-components=1 \
        -C node_modules/eufy-security-client \
    && package_tmp="$(mktemp)" \
    && jq '.dependencies["eufy-security-client"] = "4.1.1-mega.13"' \
        package.json > "${package_tmp}" \
    && mv "${package_tmp}" package.json \
    && test "$(node -p "require('./node_modules/eufy-security-client/package.json').version")" = "4.1.1-mega.13" \
    && grep -q "retrying request after fresh key exchange" \
        node_modules/eufy-security-client/build/http/megaApi.js \
    && grep -q "snapshotCache" node_modules/eufy-security-client/build/eufysecurity.js \
    && rm /tmp/eufy-security-client-4.1.1-mega.13.tgz

COPY dashboard/ /opt/baiamonte-eufy-dashboard/
COPY run.sh /
RUN chmod 0755 /run.sh

WORKDIR /data
CMD ["/run.sh"]
