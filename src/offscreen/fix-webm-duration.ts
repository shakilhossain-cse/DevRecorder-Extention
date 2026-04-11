/**
 * Fix WebM duration metadata.
 *
 * Chrome's MediaRecorder produces WebM files without a duration in the
 * Segment > Info > Duration EBML element. This makes seeking impossible
 * because the browser doesn't know the total length of the video.
 *
 * This function patches the binary WebM data to inject the correct duration.
 */

// EBML element IDs we care about
const INFO_ID = [0x15, 0x49, 0xa9, 0x66];    // Info
const DURATION_ID = [0x44, 0x89];             // Duration
const TIMECODE_SCALE_ID = [0x2a, 0xd7, 0xb1]; // TimecodeScale

function matchBytes(data: Uint8Array, offset: number, pattern: number[]): boolean {
  for (let i = 0; i < pattern.length; i++) {
    if (data[offset + i] !== pattern[i]) return false;
  }
  return true;
}

function readVint(data: Uint8Array, offset: number): { value: number; length: number } {
  const first = data[offset];
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && !(first & mask)) {
    length++;
    mask >>= 1;
  }
  let value = first & (mask - 1);
  for (let i = 1; i < length; i++) {
    value = value * 256 + data[offset + i];
  }
  return { value, length };
}

function writeFloat64(value: number): Uint8Array {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, value);
  return new Uint8Array(buf);
}

export async function fixWebmDuration(blob: Blob, durationMs: number): Promise<Blob> {
  const buffer = await blob.arrayBuffer();
  const data = new Uint8Array(buffer);

  // Search for Duration element within the first 256 bytes (in Segment > Info)
  // If it already has a valid duration, return as-is
  const searchLimit = Math.min(data.length, 1024);
  let timecodeScale = 1_000_000; // default: 1ms

  for (let i = 0; i < searchLimit - 3; i++) {
    // Read TimecodeScale if present
    if (matchBytes(data, i, TIMECODE_SCALE_ID)) {
      const sizeInfo = readVint(data, i + TIMECODE_SCALE_ID.length);
      const valStart = i + TIMECODE_SCALE_ID.length + sizeInfo.length;
      let val = 0;
      for (let j = 0; j < sizeInfo.value; j++) {
        val = val * 256 + data[valStart + j];
      }
      if (val > 0) timecodeScale = val;
    }

    // Find Duration element
    if (matchBytes(data, i, DURATION_ID)) {
      const sizeInfo = readVint(data, i + DURATION_ID.length);
      const valStart = i + DURATION_ID.length + sizeInfo.length;

      if (sizeInfo.value === 8) {
        // Duration is float64 — check if it's 0 or invalid
        const view = new DataView(buffer, valStart, 8);
        const existing = view.getFloat64(0);

        if (!existing || !isFinite(existing) || existing <= 0) {
          // Patch the duration: convert ms to timecode scale units
          const durationInUnits = (durationMs * 1_000_000) / timecodeScale;
          const floatBytes = writeFloat64(durationInUnits);
          data.set(floatBytes, valStart);
        }

        return new Blob([data], { type: blob.type });
      }
    }
  }

  // No Duration element found — we need to inject one into the Info section
  // Find Info element and inject Duration after it
  for (let i = 0; i < searchLimit - 4; i++) {
    if (matchBytes(data, i, INFO_ID)) {
      const sizeInfo = readVint(data, i + INFO_ID.length);
      const infoDataStart = i + INFO_ID.length + sizeInfo.length;
      const infoDataEnd = infoDataStart + sizeInfo.value;

      // Build Duration element: ID(2) + size vint(1: 0x88 = 8 bytes) + float64(8) = 11 bytes
      const durationInUnits = (durationMs * 1_000_000) / timecodeScale;
      const durationElement = new Uint8Array(11);
      durationElement[0] = DURATION_ID[0];
      durationElement[1] = DURATION_ID[1];
      durationElement[2] = 0x88; // vint for size=8
      durationElement.set(writeFloat64(durationInUnits), 3);

      // We need to update the Info element's size
      const newInfoSize = sizeInfo.value + 11;
      // Encode new size as the same length vint
      const newSizeBytes = encodeVint(newInfoSize, sizeInfo.length);

      // Also update Segment size if it's not "unknown"
      const result = new Uint8Array(data.length + 11);
      result.set(data.subarray(0, infoDataEnd), 0);
      result.set(durationElement, infoDataEnd);
      result.set(data.subarray(infoDataEnd), infoDataEnd + 11);

      // Patch Info size
      const infoSizeOffset = i + INFO_ID.length;
      result.set(newSizeBytes, infoSizeOffset);

      return new Blob([result], { type: blob.type });
    }
  }

  // Couldn't fix — return original
  return blob;
}

function encodeVint(value: number, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = length - 1; i >= 0; i--) {
    bytes[i] = value & 0xff;
    value = Math.floor(value / 256);
  }
  // Set the VINT_MARKER
  bytes[0] |= (1 << (8 - length));
  return bytes;
}
