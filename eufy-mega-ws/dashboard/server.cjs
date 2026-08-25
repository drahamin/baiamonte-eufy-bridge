"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocket } = require(process.env.BAIAMONTE_WS_MODULE || "/usr/src/app/node_modules/eufy-security-ws/node_modules/ws");

const dashboardPort = Number(process.env.BAIAMONTE_DASHBOARD_PORT || 8099);
const bridgePort = Number(process.env.BAIAMONTE_BRIDGE_PORT || 3000);
const bridgeHost = process.env.BAIAMONTE_BRIDGE_HOST || "127.0.0.1";
const html = fs.readFileSync(path.join(__dirname, "index.html"));
const aiPattern = /(^ai[A-Z_]|person|human|face|familiar|vehicle|pet|animal|dog|cat|package|cry|sound|motion|detection|recognition|loiter|leaving|radar)/i;
const ptzPropertyPattern = /(pan|tilt|zoom|track|privacy|preset|calibrat|patrol|cruise|rotation|angle)/i;
const controlAuditRequestPath = "/share/baiamonte-eufy-control-audit.json";
const controlAuditResultPath = "/share/baiamonte-eufy-control-audit-result.json";
let controlAuditRunning = false;
const completedConfiguredAudits = new Set();
let cache;
let cacheTime = 0;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

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
    row.ptzProperties = [...new Set([...row.ptzProperties, ...item.ptzProperties])].sort();
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
      camerasWithWritableAi: cameras.filter((item) => item.writableAiProperties.length > 0).length,
      panTiltCameras: cameras.filter((item) => item.panTilt).length,
      presetCameras: cameras.filter((item) => item.presets).length,
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
      inventory: "Mega-native discovery with compatibility coverage for incomplete catalogs",
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

async function runRequestedControlAudit() {
  let request;
  let requestFromShare = false;
  if (fs.existsSync(controlAuditRequestPath)) {
    try {
      request = JSON.parse(fs.readFileSync(controlAuditRequestPath, "utf8"));
      requestFromShare = true;
    } catch {
      return;
    }
  } else {
    try {
      const options = JSON.parse(fs.readFileSync("/data/options.json", "utf8"));
      const configuredTarget = String(process.env.BAIAMONTE_CONTROL_AUDIT_TARGET || options.control_audit_target || "").trim();
      if (!configuredTarget || completedConfiguredAudits.has(configuredTarget)) return;
      request = { targetName: configuredTarget, active: true };
    } catch {
      const configuredTarget = String(process.env.BAIAMONTE_CONTROL_AUDIT_TARGET || "").trim();
      if (!configuredTarget || completedConfiguredAudits.has(configuredTarget)) return;
      request = { targetName: configuredTarget, active: true };
    }
  }
  const targetName = typeof request.targetName === "string" ? request.targetName.trim() : "";
  if (!targetName || request.active !== true) return;

  const result = await bridgeSession(21, async (state, send) => {
    let target;
    for (const item of state.devices || []) {
      const serialNumber = typeof item === "string" ? item : item.serialNumber;
      const propertyResult = await send("device.get_properties", { serialNumber });
      const properties = propertyResult.properties || {};
      if (String(properties.name || "").localeCompare(targetName, undefined, { sensitivity: "accent" }) === 0) {
        target = { serialNumber, properties };
        break;
      }
    }
    if (!target) return { targetFound: false, requestedName: targetName };

    const [metadataResult, commandsResult] = await Promise.all([
      send("device.get_properties_metadata", { serialNumber: target.serialNumber }),
      send("device.get_commands", { serialNumber: target.serialNumber }),
    ]);
    const metadata = metadataResult.properties || {};
    const commands = commandsResult.commands || [];
    const properties = target.properties;
    const propertyTests = [];

    for (const [name, descriptor] of Object.entries(metadata)) {
      if (!descriptor?.writeable) continue;
      const present = Object.prototype.hasOwnProperty.call(properties, name) && properties[name] !== undefined;
      const states = descriptor.states && typeof descriptor.states === "object" ? descriptor.states : null;
      const stateRecognized = !states || !present || Object.prototype.hasOwnProperty.call(states, String(properties[name]));
      let writeTest = present ? "pending" : "not_reported";
      if (present) {
        try {
          await send("device.set_property", { serialNumber: target.serialNumber, name, value: properties[name] });
          writeTest = "passed";
        } catch {
          writeTest = "failed";
        }
        await delay(125);
      }
      propertyTests.push({
        name,
        type: descriptor.type || "unknown",
        hasOptions: Boolean(states),
        optionCount: states ? Object.keys(states).length : 0,
        stateRecognized,
        writeTest,
      });
    }

    const commandTests = [];
    const has = (name) => commands.includes(name);
    const testCommand = async (name, body = {}) => {
      if (!has(name)) return;
      try {
        await send(`device.${name}`, { serialNumber: target.serialNumber, ...body });
        commandTests.push({ name, test: "passed" });
      } catch {
        commandTests.push({ name, test: "failed" });
      }
    };

    if (has("start_livestream") && has("stop_livestream")) {
      await testCommand("start_livestream");
      await delay(8000);
      await testCommand("stop_livestream");
    }
    if (has("pan_and_tilt")) {
      for (const direction of [1, 2, 3, 4]) {
        try {
          await send("device.pan_and_tilt", { serialNumber: target.serialNumber, direction });
          commandTests.push({ name: `pan_and_tilt_${direction}`, test: "passed" });
        } catch {
          commandTests.push({ name: `pan_and_tilt_${direction}`, test: "failed" });
        }
        await delay(500);
      }
    }
    await testCommand("calibrate");
    if (has("trigger_alarm") && has("reset_alarm")) {
      await testCommand("trigger_alarm", { seconds: 1 });
      await delay(1500);
      await testCommand("reset_alarm");
    }

    const testedCommandNames = new Set(commandTests.map((item) => item.name.replace(/_[1-4]$/, "")));
    const untestedCommands = commands.filter((name) => !testedCommandNames.has(name));
    return {
      targetFound: true,
      requestedName: targetName,
      model: properties.model || "Unknown",
      writableProperties: propertyTests,
      commandsAdvertised: commands.length,
      commandTests,
      untestedCommands,
      summary: {
        propertiesPassed: propertyTests.filter((item) => item.writeTest === "passed").length,
        propertiesFailed: propertyTests.filter((item) => item.writeTest === "failed").length,
        propertiesNotReported: propertyTests.filter((item) => item.writeTest === "not_reported").length,
        unrecognizedSelectStates: propertyTests.filter((item) => item.hasOptions && !item.stateRecognized).length,
        commandsPassed: commandTests.filter((item) => item.test === "passed").length,
        commandsFailed: commandTests.filter((item) => item.test === "failed").length,
      },
    };
  });

  fs.writeFileSync(controlAuditResultPath, JSON.stringify({ generatedAt: new Date().toISOString(), ...result }, null, 2), { mode: 0o600 });
  if (requestFromShare) fs.unlinkSync(controlAuditRequestPath);
  else completedConfiguredAudits.add(targetName);
  console.log(`BAIAMONTE_CONTROL_AUDIT_RESULT ${JSON.stringify(result)}`);
  console.log("Baiamonte eufy local control audit completed (identifiers and values omitted)");
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
  const pollControlAudit = () => {
    if (controlAuditRunning) return;
    controlAuditRunning = true;
    runRequestedControlAudit().catch(() => {
      console.error("Baiamonte eufy local control audit failed (details omitted)");
    }).finally(() => {
      controlAuditRunning = false;
    });
  };
  console.log("Baiamonte eufy local control audit watcher ready");
  setTimeout(pollControlAudit, 5000);
  setInterval(pollControlAudit, 15000).unref();
});
