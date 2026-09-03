"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocket } = require(process.env.BAIAMONTE_WS_MODULE || "/usr/src/app/node_modules/eufy-security-ws/node_modules/ws");
const { summarizeHomeBaseTransition } = require("./homebase-transition.cjs");

const dashboardPort = Number(process.env.BAIAMONTE_DASHBOARD_PORT || 8099);
const bridgePort = Number(process.env.BAIAMONTE_BRIDGE_PORT || 3000);
const bridgeHost = process.env.BAIAMONTE_BRIDGE_HOST || "127.0.0.1";
const html = fs.readFileSync(path.join(__dirname, "index.html"));
const aiPattern = /(^ai[A-Z_]|person|human|face|familiar|vehicle|pet|animal|dog|cat|package|cry|sound|motion|detection|recognition|loiter|leaving|radar)/i;
const ptzPropertyPattern = /(pan|tilt|zoom|track|privacy|preset|calibrat|patrol|cruise|rotation|angle)/i;
let cache;
let cacheTime = 0;

// Return structure only: no names, IDs, coordinates, URLs, recognition results, or other values.
function safeValueShape(value) {
  if (value === undefined) return { kind: "missing", count: 0, keys: [], fieldTypes: {} };
  if (value === null) return { kind: "null", count: 0, keys: [], fieldTypes: {} };
  let parsed = value;
  if (typeof value === "string" && value.length <= 65536) {
    try { parsed = JSON.parse(value); } catch { return { kind: "string", count: value.length ? 1 : 0, keys: [], fieldTypes: {} }; }
  }
  if (Array.isArray(parsed)) {
    const objects = parsed.filter((item) => item && typeof item === "object" && !Array.isArray(item)).slice(0, 16);
    const keys = [...new Set(objects.flatMap((item) => Object.keys(item).slice(0, 32)))].sort().slice(0, 64);
    return {
      kind: "array",
      count: parsed.length,
      keys,
      fieldTypes: Object.fromEntries(keys.map((key) => [key, [...new Set(objects.map((item) => Array.isArray(item[key]) ? "array" : item[key] === null ? "null" : typeof item[key]))].sort()])),
    };
  }
  if (parsed && typeof parsed === "object") {
    const keys = Object.keys(parsed).sort().slice(0, 64);
    return {
      kind: "object",
      count: Object.keys(parsed).length,
      keys,
      fieldTypes: Object.fromEntries(keys.map((key) => [key, Array.isArray(parsed[key]) ? "array" : parsed[key] === null ? "null" : typeof parsed[key]])),
    };
  }
  return { kind: typeof parsed, count: 1, keys: [], fieldTypes: {} };
}

function bridgeSession(schemaVersion, onState) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://${bridgeHost}:${bridgePort}`, { handshakeTimeout: 8000 });
    const pending = new Map();
    const eventWaiters = [];
    let sequence = 0;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const waiter of eventWaiters.splice(0)) {
        clearTimeout(waiter.timeout);
        waiter.no(new Error("Bridge session closed"));
      }
      for (const waiter of pending.values()) waiter.no(new Error("Bridge session closed"));
      pending.clear();
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
      callback(value);
    };
    const timer = setTimeout(() => {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.terminate();
      finish(reject, new Error("Bridge query timed out"));
    }, 50000);
    const send = (command, body = {}) => new Promise((yes, no) => {
      const messageId = `dashboard-${++sequence}`;
      pending.set(messageId, { yes, no });
      socket.send(JSON.stringify({ messageId, command, ...body }));
    });
    const waitForEvent = (predicate) => new Promise((yes, no) => {
      const timeout = setTimeout(() => {
        const index = eventWaiters.findIndex((item) => item.yes === yes);
        if (index >= 0) eventWaiters.splice(index, 1);
        no(new Error("Bridge event timed out"));
      }, 40000);
      eventWaiters.push({ predicate, yes, timeout });
    });
    socket.on("open", () => {
      socket.send(JSON.stringify({ messageId: "schema", command: "set_api_schema", schemaVersion }));
      socket.send(JSON.stringify({ messageId: "state", command: "start_listening" }));
    });
    socket.on("message", async (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "event") {
        for (let index = eventWaiters.length - 1; index >= 0; index--) {
          const waiter = eventWaiters[index];
          if (!waiter.predicate(message)) continue;
          eventWaiters.splice(index, 1);
          clearTimeout(waiter.timeout);
          waiter.yes(message);
        }
        return;
      }
      if (message.type !== "result") return;
      if (message.messageId === "state") {
        try {
          const result = await onState(message.result.state, send, waitForEvent);
          finish(resolve, result);
        } catch (error) {
          finish(reject, error);
        }
        return;
      }
      const waiter = pending.get(message.messageId);
      if (!waiter) return;
      pending.delete(message.messageId);
      message.success ? waiter.yes(message.result) : waiter.no(new Error(message.errorCode || "Bridge error"));
    });
    socket.on("error", (error) => finish(reject, error));
    socket.on("close", () => {
      if (!settled) finish(reject, new Error("Bridge connection closed"));
    });
  });
}

async function refreshAicSummary() {
  return bridgeSession(21, async (state, send, waitForEvent) => {
    const stations = [];
    for (const station of state.stations || []) {
      const serialNumber = typeof station === "string" ? station : station.serialNumber;
      const properties = typeof station === "string"
        ? (await send("station.get_properties", { serialNumber })).properties || {}
        : station;
      if (properties.model === "T9000") stations.push({ serialNumber, model: properties.model });
    }
    const summaries = [];
    for (const station of stations) {
      const commands = (await send("station.get_commands", { serialNumber: station.serialNumber })).commands || [];
      const supported = commands.includes("stationDatabaseQueryAicEvents") || commands.includes("database_query_aic_events");
      if (!supported) {
        summaries.push({ model: station.model, supported: false });
        continue;
      }
      const end = new Date();
      const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
      let event;
      try {
        const eventPromise = waitForEvent((message) =>
          message.source === "station"
          && message.event === "database query aic events"
          && message.serialNumber === station.serialNumber
        );
        // Attach a rejection handler before sending so a command failure cannot
        // leave a later event-wait timeout as an unhandled rejection.
        const guardedEventPromise = eventPromise.then(
          (matchedEvent) => ({ matchedEvent }),
          () => ({ matchedEvent: undefined }),
        );
        await send("station.database_query_aic_events", {
          serialNumber: station.serialNumber,
          startDate: start.toISOString(),
          endDate: end.toISOString(),
          count: 100,
        });
        event = (await guardedEventPromise).matchedEvent;
        if (!event) throw new Error("AIC event unavailable");
      } catch (_error) {
        summaries.push({ model: station.model, supported: true, outcome: "timed_out_or_unavailable" });
        continue;
      }
      const data = event.data && typeof event.data === "object" ? event.data : {};
      const records = Array.isArray(data.record_list) ? data.record_list : [];
      const updates = Array.isArray(data.latest_updates) ? data.latest_updates : [];
      const hasAny = (record, keys) => keys.some((key) => record && record[key] !== undefined && record[key] !== null && record[key] !== "");
      summaries.push({
        model: station.model,
        supported: true,
        returnCode: event.returnCode,
        records: records.length,
        events: Array.isArray(data.eventRecordList) ? data.eventRecordList.length : 0,
        pictures: Array.isArray(data.recordPictureList) ? data.recordPictureList.length : 0,
        evidence: Array.isArray(data.evidenceRecordList) ? data.evidenceRecordList.length : 0,
        latestUpdates: updates.length,
        serialIdentified: records.filter((item) => hasAny(item, ["device_sn", "deviceSn", "device_serial", "deviceSerial"])).length,
        channelIdentified: records.filter((item) => hasAny(item, ["device_channel", "deviceChannel", "channel", "mChannel"])).length,
        thumbnails: records.filter((item) => hasAny(item, ["thumb_path", "thumbPath", "snapshot_cloud", "snapshotCloud"])).length,
        recordings: records.filter((item) => hasAny(item, ["storage_path", "storagePath", "cloud_path", "cloudPath", "mp4_cloud", "mp4Cloud"])).length,
        recordShape: safeValueShape(records),
        eventShape: safeValueShape(Array.isArray(data.eventRecordList) ? data.eventRecordList : []),
        pictureShape: safeValueShape(Array.isArray(data.recordPictureList) ? data.recordPictureList : []),
        evidenceShape: safeValueShape(Array.isArray(data.evidenceRecordList) ? data.evidenceRecordList : []),
      });
    }
    return { queriedAt: new Date().toISOString(), liveStreamsStarted: 0, stations: summaries };
  });
}

async function refreshSolarWallSnapshots() {
  return bridgeSession(21, async (state, send, waitForEvent) => {
    const targets = [];
    for (const station of state.stations || []) {
      const serialNumber = typeof station === "string" ? station : station.serialNumber;
      const properties = typeof station === "string"
        ? (await send("station.get_properties", { serialNumber })).properties || {}
        : station;
      if (properties.model !== "T81A0") continue;
      const commands = (await send("station.get_commands", { serialNumber })).commands || [];
      if (commands.includes("stationDatabaseQueryLatestInfo") || commands.includes("database_query_latest_info")) {
        targets.push(serialNumber);
      }
    }

    const outcomes = await Promise.all(targets.map(async (serialNumber) => {
      try {
        const eventPromise = waitForEvent((message) =>
          message.source === "station"
          && message.event === "database query latest"
          && message.serialNumber === serialNumber
        );
        const guardedEventPromise = eventPromise.then(
          (matchedEvent) => ({ matchedEvent }),
          () => ({ matchedEvent: undefined }),
        );
        await send("station.database_query_latest_info", { serialNumber });
        const event = (await guardedEventPromise).matchedEvent;
        return event ? "received" : "unavailable";
      } catch {
        return "unavailable";
      }
    }));
    return {
      queriedAt: new Date().toISOString(),
      liveStreamsStarted: 0,
      targets: targets.length,
      responses: outcomes.filter((outcome) => outcome === "received").length,
    };
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
  const inventory = await bridgeSession(21, async (state, send) => {
    const stations = [];
    for (const station of state.stations || []) {
      const serialNumber = typeof station === "string" ? station : station.serialNumber;
      if (typeof station === "string") {
        const result = await send("station.get_properties", { serialNumber });
        const properties = result.properties || {};
        stations.push({ serialNumber, model: properties.model, type: properties.type });
      } else {
        stations.push({ serialNumber, model: station.model, type: station.type });
      }
    }
    const devices = [];
    for (const device of state.devices || []) {
      const serialNumber = typeof device === "string" ? device : device.serialNumber;
      if (typeof device === "string") {
        const result = await send("device.get_properties", { serialNumber });
        const properties = result.properties || {};
        devices.push({ serialNumber, model: properties.model, type: properties.type });
      } else {
        devices.push({ serialNumber, model: device.model, type: device.type });
      }
    }
    return { stations, devices };
  });

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
      const commands = commandsResult.commands || [];
      const aiNames = Object.keys(metadata).filter((name) => aiPattern.test(name));
      const entityAiNames = aiNames.filter((name) => ["boolean", "number", "string"].includes(metadata[name]?.type));
      const complexAiProperties = aiNames
        .filter((name) => metadata[name]?.type === "object")
        .map((name) => ({
          name,
          type: "object",
          readable: metadata[name]?.readable !== false,
          writeable: Boolean(metadata[name]?.writeable),
          present: properties[name] !== undefined && properties[name] !== null,
          shape: safeValueShape(properties[name]),
        }));
      const writableAiNames = aiNames.filter((name) => metadata[name] && metadata[name].writeable);
      const ptzPropertyNames = Object.keys(metadata).filter((name) => ptzPropertyPattern.test(name));
      const writablePtzPropertyNames = ptzPropertyNames.filter((name) => metadata[name] && metadata[name].writeable);
      deviceRows.push({
        serialNumber: device.serialNumber,
        stationSerialNumber: properties.stationSerialNumber,
        model: device.model,
        type: device.type,
        snapshot: properties.picture !== undefined && properties.picture !== null && properties.picture !== "",
        aiProperties: aiNames.length,
        aiPropertyNames: aiNames,
        entityAiPropertyNames: entityAiNames,
        complexAiProperties,
        aiLiveValues: aiNames.filter((name) => properties[name] !== undefined && properties[name] !== null).length,
        writableAiProperties: writableAiNames,
        ptzProperties: writablePtzPropertyNames,
        writable: Object.values(metadata).filter((item) => item && item.writeable).length,
        streaming: commands.some((name) => /livestream/i.test(name)),
        panTilt: commands.includes("pan_and_tilt"),
        presets: ["preset_position", "save_preset_position", "delete_preset_position"].every((name) => commands.includes(name)),
        calibration: commands.includes("calibrate"),
        privacyPosition: commands.includes("set_privacy_angle") || commands.includes("set_default_angle"),
        zoom: commands.some((name) => /zoom/i.test(name)) || writablePtzPropertyNames.some((name) => /zoom/i.test(name)),
        tracking: writablePtzPropertyNames.some((name) => /track|cruise/i.test(name)),
        recordingDownload: commands.includes("start_download"),
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
        serialNumber: station.serialNumber,
        model: station.model,
        type: station.type,
        properties: Object.keys(metadata).length,
        writable: Object.values(metadata).filter((item) => item && item.writeable).length,
        commands: (commandsResult.commands || []).length,
        localRecordIndex: (commandsResult.commands || []).includes("stationDatabaseQueryLocal"),
        dateRecordIndex: (commandsResult.commands || []).includes("stationDatabaseQueryByDate"),
        recordCountIndex: (commandsResult.commands || []).includes("stationDatabaseCoundByDate"),
        thumbnailDownload: (commandsResult.commands || []).includes("stationDownloadImage"),
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
      aiPropertyNames: [],
      entityAiPropertyNames: [],
      complexAiProperties: [],
      writableAiProperties: [],
      writable: 0,
      panTilt: false,
      presets: false,
      calibration: false,
      privacyPosition: false,
      zoom: false,
      tracking: false,
      recordingDownload: false,
      ptzProperties: [],
    };
    row.count++;
    if (item.snapshot) row.snapshots++;
    if (item.streaming) row.streaming++;
    row.aiProperties = Math.max(row.aiProperties, item.aiProperties);
    row.aiPropertyNames = [...new Set([...row.aiPropertyNames, ...item.aiPropertyNames])].sort();
    row.entityAiPropertyNames = [...new Set([...row.entityAiPropertyNames, ...item.entityAiPropertyNames])].sort();
    for (const property of item.complexAiProperties) {
      const existing = row.complexAiProperties.find((candidate) => candidate.name === property.name);
      if (!existing) row.complexAiProperties.push(property);
      else {
        existing.present ||= property.present;
        existing.writeable ||= property.writeable;
        const shapes = [existing.shape, property.shape];
        existing.shape = shapes.find((shape) => shape.kind !== "missing" && shape.kind !== "null") ?? shapes[0];
      }
    }
    row.complexAiProperties.sort((a, b) => a.name.localeCompare(b.name));
    row.writableAiProperties = [...new Set([...row.writableAiProperties, ...item.writableAiProperties])].sort();
    row.writable = Math.max(row.writable, item.writable);
    row.panTilt ||= item.panTilt;
    row.presets ||= item.presets;
    row.calibration ||= item.calibration;
    row.privacyPosition ||= item.privacyPosition;
    row.zoom ||= item.zoom;
    row.tracking ||= item.tracking;
    row.recordingDownload ||= item.recordingDownload;
    row.ptzProperties = [...new Set([...row.ptzProperties, ...item.ptzProperties])].sort();
    modelCapabilities.set(key, row);
  }

  const homeBaseTransition = summarizeHomeBaseTransition(
    capabilities.deviceRows,
    capabilities.stationRows,
  );
  const safeStationRows = capabilities.stationRows.map(({ serialNumber: _serialNumber, ...row }) => row);

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
      camerasWithWritableAi: cameras.filter((item) => item.writableAiProperties.length > 0).length,
      panTiltCameras: cameras.filter((item) => item.panTilt).length,
      presetCameras: cameras.filter((item) => item.presets).length,
      streamCapableCameras: cameras.filter((item) => item.streaming).length,
      recordingDownloadCameras: cameras.filter((item) => item.recordingDownload).length,
      localRecordIndexStations: capabilities.stationRows.filter((item) => item.localRecordIndex).length,
      dateRecordIndexStations: capabilities.stationRows.filter((item) => item.dateRecordIndex).length,
      thumbnailDownloadStations: capabilities.stationRows.filter((item) => item.thumbnailDownload).length,
      writableDeviceProperties: capabilities.deviceRows.reduce((total, item) => total + item.writable, 0),
      writableStationProperties: capabilities.stationRows.reduce((total, item) => total + item.writable, 0),
    },
    models: [...modelCapabilities.values()].sort((a, b) => a.model.localeCompare(b.model)),
    stationModels: safeStationRows,
    inventoryModels: { stations: groupModels(inventory.stations), devices: groupModels(inventory.devices) },
    homeBaseTransition,
    snapshotCache: snapshotCacheStatus(),
    mega: megaStatus(),
    policy: {
      authentication: "Mega",
      push: "Mega + FCM",
      inventory: "Mega-native discovery with compatibility coverage for incomplete catalogs",
      commands: "P2P where supported",
      snapshots: "Push-event images with persistent local cache",
      recordings: "Authenticated account index plus local HomeBase database and encrypted P2P clip transport where advertised",
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
  if (pathname.endsWith("/api/aic-refresh-summary") && request.method === "POST") {
    try {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      response.end(JSON.stringify(await refreshAicSummary()));
    } catch (error) {
      response.writeHead(503, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : "AIC query unavailable" }));
    }
    return;
  }
  if (pathname.endsWith("/api/solar-wall-snapshot-refresh") && request.method === "POST") {
    try {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      response.end(JSON.stringify(await refreshSolarWallSnapshots()));
    } catch (error) {
      response.writeHead(503, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Snapshot query unavailable" }));
    }
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
  setTimeout(() => {
    refreshSolarWallSnapshots().catch(() => undefined);
  }, 30000);
});
