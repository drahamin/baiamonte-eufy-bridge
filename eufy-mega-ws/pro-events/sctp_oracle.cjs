"use strict";

// Minimal Node wrapper around Eufy's public WebRTC SCTP framing module. The
// bridge downloads and hash-verifies the exact public 0.0.2 module at build
// time. Only command frames are accepted; this helper has no live-video path.
const fs = require("fs");
const path = require("path");

const workerDirectory = path.join(__dirname, "worker");
const gluePath = path.join(workerDirectory, "libsctp_0_0_2.js");
const wasmPath = path.join(workerDirectory, "libsctp_0_0_2.wasm");

const linkToChannel = (link) => ({ 1: 0, 2: 3, 3: 2, 4: 4, 5: 5, 6: 5 }[link] ?? 6);
const channelToLink = (channel) => ({ 0: 1, 1: 5, 2: 3, 3: 2, 4: 4, 5: 5, 6: 99 }[channel] ?? 0);

function loadFactory() {
  const source = fs.readFileSync(gluePath, "utf8");
  const moduleObject = { exports: {} };
  const factory = new Function(
    "module",
    "exports",
    "require",
    "__dirname",
    `${source}\n;module.exports=libsctp;`,
  );
  factory(moduleObject, moduleObject.exports, require, workerDirectory);
  return moduleObject.exports;
}

async function createModule() {
  const factory = loadFactory();
  const wasm = fs.readFileSync(wasmPath);
  return factory({ wasmBinary: new Uint8Array(wasm) });
}

function createManager(moduleObject, mode, dataChannelId, callbacks) {
  moduleObject._set_mxlog_level(5);
  const manager = moduleObject._sctp_frame_manager_create(
    mode,
    dataChannelId,
    15000,
    mode === 1 ? 1000 : 5000,
    1000,
    10,
  );
  const packetCallback = moduleObject.addFunction((id, pointer, size) => {
    const bytes = Buffer.from(moduleObject.HEAPU8.slice(pointer, pointer + size));
    callbacks.onPacket?.(id, bytes);
    return 0;
  }, "iiii");
  moduleObject._sctp_frame_manager_set_send_packet_callback(manager, packetCallback);
  if (mode === 0) {
    const frameCallback = moduleObject.addFunction((id, channel, pointer, size) => {
      const bytes = Buffer.from(moduleObject.HEAPU8.slice(pointer, pointer + size));
      callbacks.onFrame?.(id, channelToLink(channel), bytes);
      return 0;
    }, "iiiii");
    moduleObject._sctp_frame_manager_set_recv_frame_callback(manager, frameCallback);
  }
  return manager;
}

function pushFrame(moduleObject, manager, link, bytes) {
  const frame = moduleObject._sctp_frame_manager_get_frame_buffer(manager, bytes.length);
  if (!frame) throw new Error("Unable to allocate SCTP command frame");
  const pointer = moduleObject._sctp_frame_buffer_get_data(frame);
  moduleObject.HEAPU8.set(bytes, pointer);
  moduleObject._sctp_frame_buffer_set_size(frame, bytes.length);
  const result = moduleObject._sctp_frame_manager_push_frame_data(manager, frame, linkToChannel(link));
  if (result) throw new Error(`SCTP command frame rejected (${result})`);
}

function pushPacket(moduleObject, manager, bytes) {
  const packet = moduleObject._sctp_frame_manager_get_packet_buffer(manager, bytes.length);
  if (!packet) throw new Error("Unable to allocate SCTP receive packet");
  const pointer = moduleObject._sctp_packet_get_data(packet);
  moduleObject.HEAPU8.set(bytes, pointer);
  const result = moduleObject._sctp_frame_manager_push_packet_data(manager, packet);
  if (result) throw new Error(`SCTP receive packet rejected (${result})`);
}

async function serve() {
  const moduleObject = await createModule();
  const emit = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const sender = createManager(moduleObject, 1, 0, {
    onPacket: (_id, bytes) => emit({ event: "packet", source: "sender", data: bytes.toString("base64") }),
  });
  const receiver = createManager(moduleObject, 0, 1, {
    // Receiver-generated repair packets are intentionally not transmitted; this
    // matches the current official web client and keeps the path read-only.
    onFrame: (_id, link, bytes) => emit({ event: "frame", link, data: bytes.toString("base64") }),
  });
  setInterval(() => {
    try { moduleObject._sctp_frame_manager_on_100ms_timer(receiver, Date.now()); } catch {}
  }, 100).unref();

  let buffered = "";
  process.stdin.on("data", (chunk) => {
    buffered += chunk.toString("utf8");
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line);
        const bytes = Buffer.from(message.data || "", "base64");
        if (message.operation === "send") pushFrame(moduleObject, sender, 1, bytes);
        else if (message.operation === "receive") pushPacket(moduleObject, receiver, bytes);
      } catch (error) {
        emit({ event: "error", message: String(error) });
      }
    }
  });
  process.stdin.on("end", () => process.exit(0));
  emit({ event: "ready" });
}

serve().catch((error) => {
  process.stderr.write(`SCTP helper failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
