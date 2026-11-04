import { VideoUnitAssembler } from "../video";

const first = (): Buffer => {
  const bytes = Buffer.alloc(64000, 0x11);
  bytes.set([0, 0, 0, 1, 0x65]);
  return bytes;
};

describe("bounded video access units", () => {
  it("joins later-stamped two- and three-chunk units without delaying complete frames", () => {
    const a = new VideoUnitAssembler();
    const start = first(),
      middle = Buffer.alloc(64000, 0x11),
      tail = Buffer.alloc(20, 0x22);
    expect(a.push(start, 0, 1000, true)).toBeUndefined();
    expect(a.push(middle, 0, 1030, false)).toBeUndefined();
    expect(a.push(tail, 0, 1051, false)).toEqual({ data: Buffer.concat([start, middle, tail]), keyframe: true });
    const small = start.subarray(0, 30);
    expect(a.push(small, 1, 2000, false)?.data).toEqual(small);
  });
  it("allows the 32-bit timestamp wrap but discards earlier, foreign and orphan continuations", () => {
    const a = new VideoUnitAssembler(),
      tail = Buffer.alloc(10, 0x11);
    a.push(first(), 0, 0xfffffffa, true);
    expect(a.push(tail, 0, 4, false)).toBeDefined();
    for (const [seq, stamp] of [
      [0, 999],
      [0, 1101],
      [1, 1005],
    ]) {
      a.push(first(), 0, 1000, true);
      expect(a.push(tail, seq, stamp, false)).toBeUndefined();
      expect(a.push(tail, 0, 1006, false)).toBeUndefined();
    }
  });
  it("drops incomplete units on reset/new start and bounds retained bytes", () => {
    const a = new VideoUnitAssembler();
    a.push(first(), 0, 1000, true);
    a.reset();
    expect(a.push(Buffer.alloc(10, 0x11), 0, 1001, false)).toBeUndefined();
    a.push(first(), 0, 1000, true);
    for (let i = 0; i < 11; i++) expect(a.push(Buffer.alloc(64000, 0x11), 0, 1001, false)).toBeUndefined();
    expect(a.push(Buffer.alloc(10, 0x11), 0, 1001, false)).toBeUndefined();
    expect(a.push(first().subarray(0, 20), 0, 2000, true)?.data.length).toBe(20);
  });
});
