"use strict";

const { zstdDecompressSync } = require("node:zlib");
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** Large Pro table/image replies compress the whole portal frame, including its header. */
function decodePortalFrame(bytes) {
  try {
    if (bytes.length > MAX_FRAME_BYTES) return undefined;
    const frame = bytes.length >= 4 && bytes.readUInt32LE(0) === 0xfd2fb528
      ? zstdDecompressSync(bytes, { maxOutputLength: MAX_FRAME_BYTES }) : bytes;
    if (frame.length < 16 || frame.toString("ascii", 0, 4) !== "XZYH") return undefined;
    const size = frame.readUInt32LE(6);
    if (size > MAX_FRAME_BYTES - 16 || frame.length !== size + 16) return undefined;
    return frame;
  } catch {
    return undefined;
  }
}

module.exports = { decodePortalFrame };
