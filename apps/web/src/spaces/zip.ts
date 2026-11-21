/**
 * A streaming ZIP writer in store mode (no compression). Each entry's bytes pass straight through
 * while their CRC-32 is computed; the CRC and sizes follow the data in a data descriptor and are
 * repeated in the central directory, so nothing is buffered whole. No ZIP64: a Space stays far below 4 GB.
 */

export interface ZipEntry {
  /** The path inside the archive, `/`-separated. Written as UTF-8. */
  name: string;
  modified: Date;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** Continue a CRC-32 over `bytes`. Start from `0`. */
export function crc32(bytes: Uint8Array, crc = 0) {
  let c = ~crc >>> 0;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return ~c >>> 0;
}

/** MS-DOS time and date fields, in UTC. DOS dates start in 1980. */
function dosDateTime(date: Date) {
  const year = Math.max(date.getUTCFullYear(), 1980);
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

/** A little-endian record of 16- (`2`) and 32-bit (`4`) fields. */
function record(fields: [2 | 4, number][], tail?: Uint8Array) {
  const size = fields.reduce((sum, [width]) => sum + width, 0);
  const bytes = new Uint8Array(size + (tail?.byteLength ?? 0));
  const view = new DataView(bytes.buffer);
  let offset = 0;
  for (const [width, value] of fields) {
    if (width === 2) view.setUint16(offset, value, true);
    else view.setUint32(offset, value, true);
    offset += width;
  }
  if (tail) bytes.set(tail, size);
  return bytes;
}

/** General purpose flags: sizes and CRC in a data descriptor (bit 3), UTF-8 names (bit 11). */
const FLAGS = 0x0808;

/**
 * Stream a ZIP of `entries`. `open` gives an entry's bytes when the writer reaches it; `null`
 * skips it (the file was deleted meanwhile). Entries are opened one at a time, as the reader pulls.
 */
export function zipStream<E extends ZipEntry>(
  entries: readonly E[],
  open: (entry: E) => Promise<ReadableStream<Uint8Array> | null>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  async function* chunks(): AsyncGenerator<Uint8Array> {
    const central: Uint8Array[] = [];
    let offset = 0;
    for (const entry of entries) {
      const body = await open(entry);
      if (!body) continue;
      const name = encoder.encode(entry.name);
      const { time, date } = dosDateTime(entry.modified);
      const headerOffset = offset;
      const local = record([
        [4, 0x04034b50], [2, 20], [2, FLAGS], [2, 0], [2, time], [2, date],
        [4, 0], [4, 0], [4, 0], [2, name.byteLength], [2, 0],
      ], name);
      yield local;
      offset += local.byteLength;
      let crc = 0;
      let size = 0;
      for await (const chunk of body) {
        crc = crc32(chunk, crc);
        size += chunk.byteLength;
        yield chunk;
      }
      offset += size;
      const descriptor = record([[4, 0x08074b50], [4, crc], [4, size], [4, size]]);
      yield descriptor;
      offset += descriptor.byteLength;
      central.push(record([
        [4, 0x02014b50], [2, 20], [2, 20], [2, FLAGS], [2, 0], [2, time], [2, date],
        [4, crc], [4, size], [4, size], [2, name.byteLength], [2, 0], [2, 0], [2, 0], [2, 0], [4, 0], [4, headerOffset],
      ], name));
    }
    const directorySize = central.reduce((sum, item) => sum + item.byteLength, 0);
    yield* central;
    yield record([
      [4, 0x06054b50], [2, 0], [2, 0], [2, central.length], [2, central.length], [4, directorySize], [4, offset], [2, 0],
    ]);
  }
  const iterator = chunks();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await iterator.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    async cancel() {
      await iterator.return(undefined);
    },
  });
}
