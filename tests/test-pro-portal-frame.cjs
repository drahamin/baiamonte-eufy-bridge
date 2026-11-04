const { test } = require("node:test");
const assert = require("node:assert/strict");
const { zstdCompressSync } = require("node:zlib");
const { decodePortalFrame } = require("../eufy-mega-ws/pro-events/portal_frame.cjs");

function packet() {
  const body = Buffer.from(JSON.stringify({ transaction: "42", data: [] }));
  const header = Buffer.alloc(16);
  header.write("XZYH");
  header.writeUInt16LE(1306, 4);
  header.writeUInt32LE(body.length, 6);
  return Buffer.concat([header, body]);
}

test("plain and compressed Pro replies retain their full header and transaction", () => {
  const frame = packet();
  assert.deepEqual(decodePortalFrame(frame), frame);
  assert.deepEqual(decodePortalFrame(zstdCompressSync(frame)), frame);
});
test("bad, truncated and oversized compressed replies never enter the collector", () => {
  assert.equal(decodePortalFrame(Buffer.from([0x28, 0xb5, 0x2f, 0xfd])), undefined);
  assert.equal(decodePortalFrame(packet().subarray(0, 18)), undefined);
  assert.equal(decodePortalFrame(zstdCompressSync(Buffer.alloc(17 * 1024 * 1024))), undefined);
});
