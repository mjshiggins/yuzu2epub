/**
 * zip.js - minimal ZIP writer for EPUB assembly.
 *
 * EPUB needs exactly two things a general zip library gives you: a STOREd
 * "mimetype" entry written first, and DEFLATEd entries for everything else.
 * That is ~150 lines with CompressionStream, so we do it here instead of
 * vendoring a minified dependency into the repo.
 *
 * No Zip64. An EPUB over 4GB or with 65535+ files is out of scope.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(bytes) {
  const cs = new CompressionStream('deflate-raw');
  const writer = cs.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const buf = await new Response(cs.readable).arrayBuffer();
  return new Uint8Array(buf);
}

function toBytes(data) {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new TypeError('zip: unsupported entry data type');
}

/** DOS time/date, which is what the ZIP spec stores. */
function dosDateTime(d) {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

class ByteWriter {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }
  push(bytes) {
    this.chunks.push(bytes);
    this.length += bytes.length;
  }
  u16(n) {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, n, true);
    this.push(b);
  }
  u32(n) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n >>> 0, true);
    this.push(b);
  }
  concat() {
    const out = new Uint8Array(this.length);
    let off = 0;
    for (const c of this.chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }
}

/**
 * Build a ZIP blob.
 * @param {Array<{name: string, data: string|Uint8Array|ArrayBuffer, store?: boolean}>} entries
 *        Entry order is preserved. For EPUB, "mimetype" must be first with store:true.
 * @param {string} mimeType blob MIME type
 */
async function buildZip(entries, mimeType = 'application/zip') {
  const out = new ByteWriter();
  const central = [];
  const { time, date } = dosDateTime(new Date());

  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.name);
    const raw = toBytes(entry.data);
    const crc = crc32(raw);

    let method = 0;
    let payload = raw;
    if (!entry.store) {
      const deflated = await deflateRaw(raw);
      // Only take the compressed form if it actually helps.
      if (deflated.length < raw.length) {
        method = 8;
        payload = deflated;
      }
    }

    const offset = out.length;

    // Local file header.
    out.u32(0x04034b50);
    out.u16(20); // version needed
    out.u16(0); // flags (sizes known upfront, ASCII names)
    out.u16(method);
    out.u16(time);
    out.u16(date);
    out.u32(crc);
    out.u32(payload.length);
    out.u32(raw.length);
    out.u16(nameBytes.length);
    out.u16(0); // extra length
    out.push(nameBytes);
    out.push(payload);

    central.push({ nameBytes, method, crc, csize: payload.length, usize: raw.length, offset });
  }

  const cdStart = out.length;
  for (const e of central) {
    out.u32(0x02014b50);
    out.u16(20); // version made by
    out.u16(20); // version needed
    out.u16(0); // flags
    out.u16(e.method);
    out.u16(time);
    out.u16(date);
    out.u32(e.crc);
    out.u32(e.csize);
    out.u32(e.usize);
    out.u16(e.nameBytes.length);
    out.u16(0); // extra
    out.u16(0); // comment
    out.u16(0); // disk number start
    out.u16(0); // internal attrs
    out.u32(0); // external attrs
    out.u32(e.offset);
    out.push(e.nameBytes);
  }
  const cdSize = out.length - cdStart;

  // End of central directory.
  out.u32(0x06054b50);
  out.u16(0);
  out.u16(0);
  out.u16(central.length);
  out.u16(central.length);
  out.u32(cdSize);
  out.u32(cdStart);
  out.u16(0);

  return new Blob([out.concat()], { type: mimeType });
}

self.YuzuZip = { buildZip, crc32 };
