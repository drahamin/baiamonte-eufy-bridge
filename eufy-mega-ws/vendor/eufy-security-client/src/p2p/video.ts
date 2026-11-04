/** Reassemble the 64,000-byte video chunks used by current Eufy doorbells. */
export class VideoUnitAssembler {
  private open?: { sequence: number; timestamp: number; chunks: Buffer[]; bytes: number; keyframe: boolean };

  public reset(): void {
    this.open = undefined;
  }

  public push(
    data: Buffer,
    sequence: number,
    timestamp: number,
    keyframe: boolean
  ): { data: Buffer; keyframe: boolean } | undefined {
    const startsUnit =
      data.length >= 4 && data[0] === 0 && data[1] === 0 && (data[2] === 1 || (data[2] === 0 && data[3] === 1));
    if (startsUnit) {
      this.open = { sequence, timestamp, chunks: [], bytes: 0, keyframe };
    } else if (!this.open || this.open.sequence !== sequence || (timestamp - this.open.timestamp) >>> 0 > 100) {
      this.reset();
      return undefined;
    }
    const unit = this.open!;
    unit.bytes += data.length;
    if (unit.bytes > 655360 || !data.length) {
      this.reset();
      return undefined;
    }
    unit.chunks.push(data);
    // A full chunk alone does not prove the end of an access unit.
    if (data.length === 64000) return undefined;
    this.reset();
    return { data: Buffer.concat(unit.chunks, unit.bytes), keyframe: unit.keyframe };
  }
}
