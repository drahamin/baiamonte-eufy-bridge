/** S380 recording paths confirmed by upstream SDK #599 on T8030 firmware 1.2.0.1. */
export function homeBase3RecordingPath(channel: number, value: string): string | undefined {
  if (!Number.isInteger(channel) || channel < 0 || channel > 99) return undefined;
  const stamp = /^\d{14}$/.test(value) ? value : value.match(/\/(\d{14})\.zxvideo$/)?.[1];
  if (!stamp) return undefined;
  const expected = `/zx/emmcdata/Camera${String(channel).padStart(2, "0")}/${stamp.slice(0, 6)}/${stamp}/${stamp}.zxvideo`;
  return value === stamp || value === expected ? expected : undefined;
}

/** T8030 stored video is plaintext after its 22-byte header, including split keyframes. */
export function homeBase3RecordingPayload(frame: Buffer): Buffer | undefined {
  if (frame.length < 22) return undefined;
  const size = frame.readUInt32LE(0);
  if (!size || size > 400_000 || frame.length !== 22 + size) return undefined;
  return frame.subarray(22);
}
