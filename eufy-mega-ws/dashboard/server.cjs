"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocket } = require("/usr/src/app/node_modules/eufy-security-ws/node_modules/ws");

const dashboardPort = Number(process.env.BAIAMONTE_DASHBOARD_PORT || 8099);
const bridgePort = Number(process.env.BAIAMONTE_BRIDGE_PORT || 3000);
const html = fs.readFileSync(path.join(__dirname, "index.html"));
const aiPattern = /(ai|person|human|face|familiar|vehicle|pet|animal|package|cry|sound|motion|detection|recognition)/i;
let cache;
let cacheTime = 0;

function bridgeSession(schemaVersion, onState) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${bridgePort}`, { handshakeTimeout: 8000 });
    const pending = new Map();
    let sequence = 0;
    const timer = setTimeout(() => { socket.terminate(); reject(new Error("Bridge query timed out")); }, 45000);
    const send = (command, body = {}) => new Promise((yes, no) => {
      const messageId = `dashboard-${++sequence}`;
      pending.set(messageId, { yes, no });
      socket.send(JSON.stringify({ messageId, command, ...body }));
    });
    socket.on("open", () => {
      socket.send(JSON.stringify({ messageId: "schema", command: "set_api_schema", schemaVersion }));
      socket.send(JSON.stringify({ messageId: "state", command: "start_listening" }));
    });
    socket.on("message", async (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== "result") return;
      if (message.messageId === "state") {
        try {
          const result = await onState(message.result.state, send);
          clearTimeout(timer);
          socket.close();
          resolve(result);
        } catch (error) {
          clearTimeout(timer);
          socket.close();
          reject(error);
        }
        return;
      }
      const waiter = pending.get(message.messageId);
      if (!waiter) return;
      pending.delete(message.messageId);
      message.success ? waiter.yes(message.result) : waiter.no(new Error(message.errorCode || "Bridge error"));
    });
    socket.on("error", reject);
  });
}

function groupModels(items) {
  const models = new Map();
  for (const item of items) {
    const key = `${item.model || "Unknown"}:${item.type ?? "Unknown"}`;
    const entry = models.get(key) || { model: item.model || "Unknown", type: item.type ?? "Unknown", count: 0 };
    entry.count++;
    models.set(key, entry);
  }
  return [...models.values()].sort((a, b) => a.model.localeCompare(b.model));
}

function snapshotCacheStatus() {
  const directory = "/data/snapshots";
  try {
    const stats = fs.readdirSync(directory)
      .filter((name) => name.endsWith(".img"))
      .map((name) => fs.statSync(path.join(directory, name)))
      .filter((item) => item.isFile());
    const modified = stats.map((item) => item.mtimeMs);
    return {
      files: stats.length,
      bytes: stats.reduce((total, item) => total + item.size, 0),
      newestAt: modified.length ? new Date(Math.max(...modified)).toISOString() : null,
      oldestAt: modified.length ? new Date(Math.min(...modified)).toISOString() : null,
    };
  } catch {
    return { files: 0, bytes: 0, newestAt: null, oldestAt: null };
  }
}

function megaStatus() {
  try {
    return JSON.parse(fs.readFileSync("/data/baiamonte-mega-status.json", "utf8"));
  } catch {
    return { megaAuthenticated: false, legacyFallbackRequired: true };
  }
}

async function buildStatus() {
  const inventory = await bridgeSession(12, async (state) => ({
    stations: (state.stations || []).map(({ serialNumber, model, type }) => ({ serialNumber, model, type })),
    devices: (state.devices || []).map(({ serialNumber, model, type }) => ({ serialNumber, model, type })),
  }));

  const capabilities = await bridgeSession(21, async (_state, send) => {
    const deviceRows = [];
    for (const device of inventory.devices) {
      const [propertiesResult, metadataResult, commandsResult] = await Promise.all([
        send("device.get_properties", { serialNumber: device.serialNumber }),
        send("device.get_properties_metadata", { serialNumber: device.serialNumber }),
        send("device.get_commands", { serialNumber: device.serialNumber }),
      ]);
      const properties = propertiesResult.properties || {};
      const metadata = metadataResult.properties || {};
      const aiNames = Object.keys(metadata).filter((name) => aiPattern.test(name));
      deviceRows.push({
        model: device.model,
        type: device.type,
        snapshot: properties.picture !== undefined && properties.picture !== null && properties.picture !== "",
        aiProperties: aiNames.length,
        aiLiveValues: aiNames.filter((name) => properties[name] !== undefined && properties[name] !== null).length,
        writable: Object.values(metadata).filter((item) => item && item.writeable).length,
        streaming: (commandsResult.commands || []).some((name) => /livestream/i.test(name)),
      });
    }
    const stationRows = [];
    for (const station of inventory.stations) {
      const [metadataResult, commandsResult] = await Promise.all([
        send("station.get_properties_metadata", { serialNumber: station.serialNumber }),
        send("station.get_commands", { serialNumber: station.serialNumber }),
      ]);
      const metadata = metadataResult.properties || {};
      stationRows.push({
        model: station.model,
        type: station.type,
        properties: Object.keys(metadata).length,
        writable: Object.values(metadata).filter((item) => item && item.writeable).length,
        commands: (commandsResult.commands || []).length,
      });
    }
    return { deviceRows, stationRows };
  });

  const cameras = capabilities.deviceRows.filter((item) => item.model !== "T87A0");
  const modelCapabilities = new Map();
  for (const item of capabilities.deviceRows) {
    const key = `${item.model}:${item.type}`;
    const row = modelCapabilities.get(key) || {
      model: item.model,
      type: item.type,
      count: 0,
      snapshots: 0,
      streaming: 0,
      aiProperties: 0,
      writable: 0,
    };
    row.count++;
    if (item.snapshot) row.snapshots++;
    if (item.streaming) row.streaming++;
    row.aiProperties = Math.max(row.aiProperties, item.aiProperties);
    row.writable = Math.max(row.writable, item.writable);
    modelCapabilities.set(key, row);
  }

  return {
    brand: "Baiamonte eufy Bridge",
    generatedAt: new Date().toISOString(),
    bridge: { available: true, port: bridgePort, schema: 21 },
    totals: {
      stations: inventory.stations.length,
      devices: inventory.devices.length,
      cameras: cameras.length,
      camerasWithSnapshots: cameras.filter((item) => item.snapshot).length,
      camerasWithAi: cameras.filter((item) => item.aiProperties > 0).length,
      streamCapableCameras: cameras.filter((item) => item.streaming).length,
      writableDeviceProperties: capabilities.deviceRows.reduce((total, item) => total + item.writable, 0),
      writableStationProperties: capabilities.stationRows.reduce((total, item) => total + item.writable, 0),
    },
    models: [...modelCapabilities.values()].sort((a, b) => a.model.localeCompare(b.model)),
    stationModels: capabilities.stationRows,
    inventoryModels: { stations: groupModels(inventory.stations), devices: groupModels(inventory.devices) },
    snapshotCache: snapshotCacheStatus(),
    mega: megaStatus(),
    policy: {
      authentication: "Mega",
      push: "Mega + FCM",
      inventory: "Mega augmented; legacy fallback while catalogs are incomplete",
      commands: "P2P where supported",
      snapshots: "Push-event images with persistent local cache",
    },
  };
}

async function currentStatus() {
  if (cache && Date.now() - cacheTime < 30000) return cache;
  try {
    cache = await buildStatus();
  } catch (error) {
    cache = {
      brand: "Baiamonte eufy Bridge",
      generatedAt: new Date().toISOString(),
      bridge: { available: false, port: bridgePort, schema: 21 },
      error: error instanceof Error ? error.message : "Bridge unavailable",
      mega: megaStatus(),
      snapshotCache: snapshotCacheStatus(),
    };
  }
  cacheTime = Date.now();
  return cache;
}

http.createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  if (pathname.endsWith("/api/status")) {
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(JSON.stringify(await currentStatus()));
    return;
  }
  if (pathname.endsWith("/health")) {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end('{"ok":true}');
    return;
  }
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(html);
}).listen(dashboardPort, "0.0.0.0", () => {
  console.log(`Baiamonte eufy Bridge dashboard listening on ${dashboardPort}`);
});
