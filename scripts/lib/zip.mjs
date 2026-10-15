// Minimal, dependency-free, deterministic zip writer/reader for the release
// artifact (pack_artifact.mjs). Timestamps are pinned and entries sorted, so
// identical trees give byte-identical archives: the SHA-256 of runtime.zip
// identifies the deploy. Store/deflate only; no zip64 (writeZip asserts the
// limits), no encryption, no symlinks.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const LOCAL_SIG = 0x04034b50
const CENTRAL_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50

// 1980-01-01 00:00:00 — the earliest representable DOS timestamp. Pinned so
// the archive is a pure function of its contents.
const DOS_TIME = 0
const DOS_DATE = 0x0021

const MAX_ENTRIES = 0xffff
const MAX_SIZE = 0xffffffff

const STORE = 0
const DEFLATE = 8

function crc32(buf) {
  let table = crc32.table
  if (!table) {
    table = new Int32Array(256)
    for (let i = 0; i < 256; i += 1) {
      let c = i
      for (let k = 0; k < 8; k += 1) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      }
      table[i] = c
    }
    crc32.table = table
  }
  let crc = -1
  for (let i = 0; i < buf.length; i += 1) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff]
  }
  return (crc ^ -1) >>> 0
}

// Every file under `dir`, as posix-separated paths relative to it, sorted.
// Sorted because the archive must not depend on readdir order (which differs
// between filesystems), and because a stable order makes a diff of two
// central directories readable.
export function listFiles(dir) {
  const out = []
  const walk = (abs, rel) => {
    const entries = fs.readdirSync(abs, { withFileTypes: true })
    for (const entry of entries) {
      const childAbs = path.join(abs, entry.name)
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        walk(childAbs, childRel)
      } else if (entry.isFile()) {
        out.push(childRel)
      } else {
        throw new Error(`zip: ${childAbs} is neither a file nor a directory`)
      }
    }
  }
  walk(dir, '')
  return out.sort()
}

/**
 * Write `entries` ([{ name, data }]) to `outPath` as a deterministic zip.
 * Directory entries are not emitted — extractors create parents from the
 * member paths, and omitting them removes another source of ordering skew.
 */
export function writeZip(entries, outPath) {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  if (sorted.length > MAX_ENTRIES) {
    throw new Error(`zip: ${sorted.length} entries exceeds the non-zip64 limit (${MAX_ENTRIES})`)
  }

  const chunks = []
  const central = []
  let offset = 0

  for (const entry of sorted) {
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const raw = entry.data
    if (raw.length > MAX_SIZE) {
      throw new Error(`zip: ${entry.name} exceeds the non-zip64 size limit`)
    }
    const deflated = zlib.deflateRawSync(raw, { level: 9 })
    // Incompressible input (already-gzipped fonts, png) deflates LARGER than
    // it started; store those verbatim rather than paying to grow them.
    const useDeflate = deflated.length < raw.length
    const payload = useDeflate ? deflated : raw
    const method = useDeflate ? DEFLATE : STORE
    const crc = crc32(raw)

    const local = Buffer.alloc(30 + nameBuf.length)
    local.writeUInt32LE(LOCAL_SIG, 0)
    local.writeUInt16LE(20, 4) // version needed: 2.0 (deflate)
    local.writeUInt16LE(0, 6) // flags — no data descriptor, sizes known up front
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28) // extra field length
    nameBuf.copy(local, 30)

    chunks.push(local, payload)

    const dir = Buffer.alloc(46 + nameBuf.length)
    dir.writeUInt32LE(CENTRAL_SIG, 0)
    dir.writeUInt16LE(20, 4) // version made by
    dir.writeUInt16LE(20, 6) // version needed
    dir.writeUInt16LE(0, 8)
    dir.writeUInt16LE(method, 10)
    dir.writeUInt16LE(DOS_TIME, 12)
    dir.writeUInt16LE(DOS_DATE, 14)
    dir.writeUInt32LE(crc, 16)
    dir.writeUInt32LE(payload.length, 20)
    dir.writeUInt32LE(raw.length, 24)
    dir.writeUInt16LE(nameBuf.length, 28)
    dir.writeUInt16LE(0, 30) // extra
    dir.writeUInt16LE(0, 32) // comment
    dir.writeUInt16LE(0, 34) // disk number
    dir.writeUInt16LE(0, 36) // internal attrs
    dir.writeUInt32LE(((0o100644 << 16) >>> 0), 38) // external attrs: regular file, 0644
    dir.writeUInt32LE(offset, 42)
    nameBuf.copy(dir, 46)
    central.push(dir)

    offset += local.length + payload.length
  }

  const centralBuf = Buffer.concat(central)
  if (offset + centralBuf.length > MAX_SIZE) {
    throw new Error('zip: archive exceeds the non-zip64 total size limit')
  }
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD_SIG, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(sorted.length, 8)
  eocd.writeUInt16LE(sorted.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, Buffer.concat([...chunks, centralBuf, eocd]))
  return { entryCount: sorted.length, bytes: fs.statSync(outPath).size }
}

/** Pack a directory tree (recursively) into `outPath` under `prefix`. */
export function zipDirectory(dir, outPath, prefix = '') {
  const entries = listFiles(dir).map(name => ({
    name: prefix ? `${prefix}/${name}` : name,
    data: fs.readFileSync(path.join(dir, name)),
  }))
  return writeZip(entries, outPath)
}

/**
 * Read an archive written by writeZip back into [{ name, data }].
 * Deliberately reads the CENTRAL directory (the authoritative index) rather
 * than scanning local headers, so a truncated archive fails loudly.
 */
export function readZip(zipPath) {
  const buf = fs.readFileSync(zipPath)
  let eocdAt = -1
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocdAt = i
      break
    }
  }
  if (eocdAt < 0) throw new Error(`zip: no end-of-central-directory in ${zipPath}`)
  const count = buf.readUInt16LE(eocdAt + 10)
  let at = buf.readUInt32LE(eocdAt + 16)

  const out = []
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(at) !== CENTRAL_SIG) {
      throw new Error(`zip: bad central directory entry ${i} in ${zipPath}`)
    }
    const method = buf.readUInt16LE(at + 10)
    const crc = buf.readUInt32LE(at + 16)
    const compressedSize = buf.readUInt32LE(at + 20)
    const nameLen = buf.readUInt16LE(at + 28)
    const extraLen = buf.readUInt16LE(at + 30)
    const commentLen = buf.readUInt16LE(at + 32)
    const localAt = buf.readUInt32LE(at + 42)
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen)

    const localNameLen = buf.readUInt16LE(localAt + 26)
    const localExtraLen = buf.readUInt16LE(localAt + 28)
    const dataAt = localAt + 30 + localNameLen + localExtraLen
    const payload = buf.subarray(dataAt, dataAt + compressedSize)
    const data = method === DEFLATE ? zlib.inflateRawSync(payload) : Buffer.from(payload)
    if (crc32(data) !== crc) {
      throw new Error(`zip: CRC mismatch for ${name} in ${zipPath}`)
    }
    out.push({ name, data })
    at += 46 + nameLen + extraLen + commentLen
  }
  return out
}

/** Extract an archive to `destDir`, refusing any path that escapes it. */
export function extractZip(zipPath, destDir) {
  const root = path.resolve(destDir)
  for (const entry of readZip(zipPath)) {
    const target = path.resolve(root, entry.name)
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error(`zip: ${entry.name} escapes the destination directory`)
    }
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, entry.data)
  }
}
