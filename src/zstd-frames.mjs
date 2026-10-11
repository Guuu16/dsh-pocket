/**
 * Zstandard frame-level reader for dsh session logs.
 *
 * A dsh session log is a concatenation of independent zstd frames: the runtime
 * appends one complete, checksummed frame per durable batch. Node's streaming
 * decompressor stops at the first frame boundary, so frames are located
 * structurally (frame header + block headers) and decoded one at a time.
 *
 * The structural walk mirrors the writer in
 * `@deepseek-ai/dsh-session-persistence-jsonl` so the two agree on what a
 * complete frame is, including a torn tail from a concurrent append.
 */

import { zstdDecompressSync } from "node:zlib";

/** Little-endian uint32 of the zstd magic number 0xFD2FB528. */
const ZSTD_MAGIC_LE = 0xfd2fb528;

/**
 * Walk the frame structure of one log buffer.
 *
 * @param {Buffer} buffer - raw log bytes.
 * @param {number} [maxFrames] - stop after this many complete frames.
 * @returns {{ frames: Array<{start: number, end: number}>, tornStart?: number }}
 *   complete frames, plus the offset of a structurally incomplete tail frame.
 */
export function scanFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = [];
  let offset = 0;

  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC_LE) {
      // Not a frame boundary: the log is foreign or corrupt past this point.
      return frames.length === 0 ? { frames, tornStart: start } : { frames, tornStart: start };
    }
    offset += 4;

    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;

    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes =
      contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes =
      (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;

    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;

    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) return { frames, tornStart: start };
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }

    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }

    frames.push({ start, end: offset });
    if (frames.length === maxFrames) return { frames };
  }

  return { frames };
}

/**
 * Decode complete frames to text, in order.
 *
 * @param {Buffer} buffer - raw log bytes.
 * @param {{maxFrames?: number, maxBytes?: number, fromFrame?: number}} [options]
 *   `maxFrames` stops the walk early, `maxBytes` bounds decoded plaintext, and
 *   `fromFrame` skips already-consumed leading frames.
 * @returns {{ text: string, frameCount: number, tornStart?: number, truncated: boolean }}
 */
export function readFrames(buffer, options = {}) {
  const { maxFrames = Number.POSITIVE_INFINITY, maxBytes = Number.POSITIVE_INFINITY, fromFrame = 0 } = options;
  const { frames, tornStart } = scanFrames(buffer, maxFrames + fromFrame);
  const parts = [];
  let bytes = 0;
  let truncated = false;
  let frameCount = 0;

  for (const frame of frames.slice(fromFrame)) {
    let plain;
    try {
      plain = zstdDecompressSync(buffer.subarray(frame.start, frame.end));
    } catch {
      // A checksum-complete frame that will not decode means a foreign writer;
      // stop rather than emit half a transcript.
      break;
    }
    frameCount += 1;
    if (bytes + plain.length > maxBytes) {
      parts.push(plain.subarray(0, Math.max(0, maxBytes - bytes)).toString("utf8"));
      truncated = true;
      break;
    }
    parts.push(plain.toString("utf8"));
    bytes += plain.length;
  }

  return { text: parts.join(""), frameCount, tornStart, truncated };
}

/**
 * Parse one newline-delimited JSON log into records.
 *
 * @param {string} text - decoded log text.
 * @returns {unknown[]} parsed records; an unparsable line is skipped.
 */
export function parseJsonLines(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A torn tail line is expected while the runtime is mid-append.
    }
  }
  return out;
}
