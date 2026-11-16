import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough, Readable, Writable } from 'stream';
import multer from 'multer';
import * as ftp from 'basic-ftp';
import SftpClient = require('ssh2-sftp-client');
import sharp from 'sharp';
import { UPLOAD_DIR } from './storage.service';
import { logger } from '../utils/logger';

// New-listing files (photos, videos, price sheets, documents) are private.
// They are NEVER added to server.ts's static mounts, and the storage path is
// never sent to a client: a file is read back only through
// GET /api/v1/drafts/:id/attachments/:attachmentId, which checks who is asking
// (routes/drafts.ts).
//
// Owner decisions (2026-11-15): stored on Hostinger over FTP (the same place as
// refund bills), videos up to 100 MB. Files are streamed to and from storage,
// never held whole in memory: the server has 512 MB.

// Owner decision (2026-11-16): videos up to 500 MB, photos of any quality (phone
// cameras give 5-30 MB files; RAW and HEIC are bigger still).
export const PHOTO_MAX_BYTES = 100 * 1024 * 1024;
export const VIDEO_MAX_BYTES = 500 * 1024 * 1024;
export const DOC_MAX_BYTES = 10 * 1024 * 1024;
/** Kept for older imports: the largest file of any kind. */
export const DRAFT_ATTACHMENT_MAX_BYTES = VIDEO_MAX_BYTES;
export const DRAFT_ATTACHMENT_MAX_PER_DRAFT = 30;
export const DRAFT_VIDEO_MAX_PER_DRAFT = 5;

const LOCAL_SUBDIR = 'draft-attachments';
const DEFAULT_REMOTE_SUBDIR = 'listing-files';

/** Where a file lives, and how to put, read and remove it. */
export interface DraftFileStore {
  /** Store from a buffer or a local file path; returns the storage key. */
  put(source: Buffer | string, storedName: string): Promise<string>;
  /** Write the file into `out`, from byte `start`; resolves when written. */
  pipeTo(storagePath: string, out: Writable, start?: number): Promise<void>;
  delete(storagePath: string): Promise<void>;
}

const randomName = (storedName: string) =>
  `${crypto.randomUUID()}${path.extname(storedName).toLowerCase() || '.bin'}`;

/** Pipes `fill(pass)` into `out` without ending `out` (the zip writes several files). */
async function relay(out: Writable, fill: (pass: PassThrough) => Promise<void>) {
  const pass = new PassThrough();
  const done = new Promise<void>((resolve, reject) => {
    pass.on('end', resolve);
    pass.on('error', reject);
  });
  pass.pipe(out, { end: false });
  try {
    await fill(pass);
  } finally {
    if (!pass.writableEnded) pass.end();
  }
  await done;
}

// ── FTP (Hostinger) ─────────────────────────────────────────────

async function ftpClient() {
  const client = new ftp.Client(60_000);
  client.ftp.verbose = false;
  await client.access({
    host: process.env.FTP_HOST,
    user: process.env.FTP_USERNAME,
    password: process.env.FTP_PASSWORD,
    port: parseInt(process.env.FTP_PORT || '21', 10),
    secure: false,
  });
  return client;
}

// The folder sits under the FTP base path, which is usually inside the web
// root; a deny-all .htaccess keeps the web server from handing files out.
const DENY_ALL = 'Require all denied\nDeny from all\nOptions -Indexes\n';

class FtpDraftStore implements DraftFileStore {
  constructor(private readonly subdir: string) {}
  private remote(storagePath: string) {
    const base = process.env.FTP_PUBLIC_BASE_URL || '';
    if (!storagePath.startsWith(base)) throw new Error('Unknown storage path');
    return path.posix.join(process.env.FTP_REMOTE_BASE_PATH || '', storagePath.slice(base.length));
  }
  async put(source: Buffer | string, storedName: string) {
    const name = randomName(storedName);
    const client = await ftpClient();
    try {
      await client.ensureDir(path.posix.join(process.env.FTP_REMOTE_BASE_PATH || '', this.subdir));
      const list = await client.list().catch(() => []);
      if (!list.some((f) => f.name === '.htaccess')) {
        await client.uploadFrom(Readable.from(Buffer.from(DENY_ALL)), '.htaccess');
      }
      await client.uploadFrom(
        typeof source === 'string' ? fs.createReadStream(source) : Readable.from(source),
        name,
      );
      return `${process.env.FTP_PUBLIC_BASE_URL || ''}/${this.subdir}/${name}`;
    } finally {
      client.close();
    }
  }
  async pipeTo(storagePath: string, out: Writable, start = 0) {
    const client = await ftpClient();
    try {
      await relay(out, (pass) =>
        client.downloadTo(pass, this.remote(storagePath), start).then(() => undefined),
      );
    } finally {
      client.close();
    }
  }
  async delete(storagePath: string) {
    const client = await ftpClient();
    try {
      await client.remove(this.remote(storagePath));
    } finally {
      client.close();
    }
  }
}

// ── SFTP ───────────────────────────────────────────────────────

async function sftpClient() {
  const client = new SftpClient();
  const config: Record<string, unknown> = {
    host: process.env.SFTP_HOST,
    port: parseInt(process.env.SFTP_PORT || '22', 10),
    username: process.env.SFTP_USERNAME,
  };
  if (process.env.SFTP_PRIVATE_KEY) {
    config.privateKey = process.env.SFTP_PRIVATE_KEY;
    if (process.env.SFTP_PASSPHRASE) config.passphrase = process.env.SFTP_PASSPHRASE;
  } else config.password = process.env.SFTP_PASSWORD;
  await client.connect(config);
  return client;
}

class SftpDraftStore implements DraftFileStore {
  constructor(private readonly subdir: string) {}
  private remote(storagePath: string) {
    const base = process.env.SFTP_PUBLIC_BASE_URL || '';
    if (!storagePath.startsWith(base)) throw new Error('Unknown storage path');
    return path.posix.join(process.env.SFTP_REMOTE_BASE_PATH || '', storagePath.slice(base.length));
  }
  async put(source: Buffer | string, storedName: string) {
    const name = randomName(storedName);
    const client = await sftpClient();
    try {
      const dir = path.posix.join(process.env.SFTP_REMOTE_BASE_PATH || '', this.subdir);
      await client.mkdir(dir, true);
      const access = path.posix.join(dir, '.htaccess');
      if (!(await client.exists(access))) await client.put(Buffer.from(DENY_ALL), access);
      await client.put(source as any, path.posix.join(dir, name));
      return `${process.env.SFTP_PUBLIC_BASE_URL || ''}/${this.subdir}/${name}`;
    } finally {
      await client.end();
    }
  }
  async pipeTo(storagePath: string, out: Writable, start = 0) {
    const client = await sftpClient();
    try {
      await relay(
        out,
        (pass) =>
          new Promise<void>((resolve, reject) => {
            const rs = client.createReadStream(this.remote(storagePath), { start }) as Readable;
            rs.on('error', reject);
            rs.on('end', resolve);
            rs.pipe(pass, { end: false });
          }),
      );
    } finally {
      await client.end();
    }
  }
  async delete(storagePath: string) {
    const client = await sftpClient();
    try {
      await client.delete(this.remote(storagePath));
    } finally {
      await client.end();
    }
  }
}

// ── local disk (development; production only with a mounted disk) ──

class LocalDraftStore implements DraftFileStore {
  private readonly base = path.resolve(UPLOAD_DIR);
  private abs(storagePath: string) {
    const rel = storagePath.replace(/^\/uploads\//, '');
    const resolved = path.resolve(this.base, rel);
    if (!resolved.startsWith(this.base + path.sep)) throw new Error('Invalid storage path');
    return resolved;
  }
  async put(source: Buffer | string, storedName: string) {
    const name = randomName(storedName);
    const dir = path.join(this.base, LOCAL_SUBDIR);
    await fs.promises.mkdir(dir, { recursive: true });
    const target = path.join(dir, name);
    if (typeof source === 'string') await fs.promises.copyFile(source, target);
    else await fs.promises.writeFile(target, source);
    return `/uploads/${LOCAL_SUBDIR}/${name}`;
  }
  async pipeTo(storagePath: string, out: Writable, start = 0) {
    await relay(
      out,
      (pass) =>
        new Promise<void>((resolve, reject) => {
          const rs = fs.createReadStream(this.abs(storagePath), { start });
          rs.on('error', reject);
          rs.on('end', resolve);
          rs.pipe(pass, { end: false });
        }),
    );
  }
  async delete(storagePath: string) {
    await fs.promises.unlink(this.abs(storagePath)).catch(() => undefined);
  }
}

/**
 * Where listing files go.
 *  - ftp / sftp: the folder DRAFT_ATTACHMENTS_SUBDIR (default "listing-files")
 *    under the remote base path, with a deny-all .htaccess written into it.
 *  - local: UPLOAD_DIR/draft-attachments (not served statically). Render's
 *    free disk is wiped by every deploy, so on production this is refused
 *    unless DRAFT_LOCAL_UPLOADS=true says a disk is mounted.
 */
export function getDraftStorage(): DraftFileStore {
  const driver = process.env.STORAGE_DRIVER;
  const subdir =
    (process.env.DRAFT_ATTACHMENTS_SUBDIR || '').trim().replace(/^\/+|\/+$/g, '') ||
    DEFAULT_REMOTE_SUBDIR;
  if (driver === 'ftp') return new FtpDraftStore(subdir);
  if (driver === 'sftp') return new SftpDraftStore(subdir);
  if (process.env.NODE_ENV === 'production' && process.env.DRAFT_LOCAL_UPLOADS !== 'true') {
    throw {
      status: 503,
      message:
        'File uploads for new listings are not set up on this server yet. Send the listing without files for now.',
    };
  }
  return new LocalDraftStore();
}

// ── upload intake ──────────────────────────────────────────────

// extension -> what it is and the one content type we store and serve it as.
type FileClass = 'image' | 'video' | 'pdf' | 'xlsx';
const TYPES: Record<string, { mime: string; cls: FileClass }> = {
  '.jpg': { mime: 'image/jpeg', cls: 'image' },
  '.jpeg': { mime: 'image/jpeg', cls: 'image' },
  '.jfif': { mime: 'image/jpeg', cls: 'image' },
  '.png': { mime: 'image/png', cls: 'image' },
  '.webp': { mime: 'image/webp', cls: 'image' },
  '.gif': { mime: 'image/gif', cls: 'image' },
  '.bmp': { mime: 'image/bmp', cls: 'image' },
  '.tif': { mime: 'image/tiff', cls: 'image' },
  '.tiff': { mime: 'image/tiff', cls: 'image' },
  '.avif': { mime: 'image/avif', cls: 'image' },
  '.heic': { mime: 'image/heic', cls: 'image' },
  '.heif': { mime: 'image/heif', cls: 'image' },
  '.dng': { mime: 'image/x-adobe-dng', cls: 'image' },
  '.cr2': { mime: 'image/x-canon-cr2', cls: 'image' },
  '.nef': { mime: 'image/x-nikon-nef', cls: 'image' },
  '.arw': { mime: 'image/x-sony-arw', cls: 'image' },
  '.mkv': { mime: 'video/x-matroska', cls: 'video' },
  '.mp4': { mime: 'video/mp4', cls: 'video' },
  '.m4v': { mime: 'video/mp4', cls: 'video' },
  '.mov': { mime: 'video/quicktime', cls: 'video' },
  '.webm': { mime: 'video/webm', cls: 'video' },
  '.3gp': { mime: 'video/3gpp', cls: 'video' },
  '.pdf': { mime: 'application/pdf', cls: 'pdf' },
  '.xlsx': {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    cls: 'xlsx',
  },
};

const TMP_DIR = path.join(os.tmpdir(), 'rrh-listing-uploads');

// Files land in a temp folder (not memory), one per request; the route deletes it.
export const draftAttachmentUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdir(TMP_DIR, { recursive: true }, (err) => cb(err, TMP_DIR));
    },
    filename: (_req, _file, cb) => cb(null, crypto.randomUUID()),
  }),
  limits: { fileSize: VIDEO_MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (TYPES[ext]) return cb(null, true);
    cb(
      Object.assign(
        new Error(
          'Upload a photo (JPG, PNG, WebP, HEIC and other image types), a video (MP4, MOV), a PDF or an XLSX sheet.',
        ),
        { statusCode: 400 },
      ),
    );
  },
});

export const removeTemp = (filePath?: string) => {
  if (filePath) fs.promises.unlink(filePath).catch(() => undefined);
};

export interface PreparedDraftFile {
  /** a buffer, or the temp file path for a video */
  source: Buffer | string;
  storedName: string;
  mime: string;
  size: number;
  kind: 'PHOTO' | 'VIDEO' | 'PRICE_SHEET' | 'DOCUMENT';
}

const readHead = async (filePath: string, n: number) => {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
};

/**
 * Proves the file is what its name says (photos are re-encoded by sharp,
 * which also strips anything that is not an image; videos and documents are
 * checked by their first bytes), applies the size limit of its kind, and picks
 * the content type it is served as. The kind is worked out from the file;
 * PRICE_SHEET only when asked for. Throws a 400 for anything else.
 */
export async function prepareDraftFile(
  filePath: string,
  originalName: string,
  size: number,
  askedKind?: string,
): Promise<PreparedDraftFile> {
  const ext = path.extname(originalName || '').toLowerCase();
  const spec = TYPES[ext];
  const bad = (message: string) => ({ status: 400, message });
  if (!spec) throw bad('That file type is not allowed.');
  const base =
    path
      .basename(originalName, ext)
      .replace(/[^\w.\- ]+/g, '_')
      .slice(0, 80) || 'file';
  const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;

  if (spec.cls === 'image') {
    if (size > PHOTO_MAX_BYTES) throw bad(`A photo can be up to ${mb(PHOTO_MAX_BYTES)}.`);
    const original = await fs.promises.readFile(filePath);
    if (ext === '.gif') {
      // Kept as sent (may be animated); check it really is a GIF.
      if (original.subarray(0, 3).toString('latin1') !== 'GIF') {
        throw bad('That file is not a valid image.');
      }
      return {
        source: original,
        storedName: `${base}.gif`,
        mime: 'image/gif',
        size: original.length,
        kind: 'PHOTO',
      };
    }
    try {
      // Any quality: only re-encoded as high-quality WebP (up to 4096 px, q90,
      // turned upright by the phone's orientation tag).
      const processed = await sharp(original, { limitInputPixels: 400_000_000 })
        .rotate()
        .resize({ width: 4096, height: 4096, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 90 })
        .toBuffer();
      return {
        source: processed,
        storedName: `${base}.webp`,
        mime: 'image/webp',
        size: processed.length,
        kind: 'PHOTO',
      };
    } catch (err) {
      // HEIC/RAW and other formats this server cannot decode: keep the original
      // so nothing is lost (browsers that cannot show it offer it as a download).
      if (
        [
          '.heic',
          '.heif',
          '.dng',
          '.cr2',
          '.nef',
          '.arw',
          '.tif',
          '.tiff',
          '.avif',
          '.bmp',
        ].includes(ext)
      ) {
        logger.warn(`[Listings] kept ${ext} photo as sent (not decodable here)`, err);
        return {
          source: original,
          storedName: `${base}${ext}`,
          mime: spec.mime,
          size: original.length,
          kind: 'PHOTO',
        };
      }
      throw bad('That file is not a valid image.');
    }
  }

  const head = await readHead(filePath, 16);
  if (spec.cls === 'video') {
    if (size > VIDEO_MAX_BYTES) throw bad(`A video can be up to ${mb(VIDEO_MAX_BYTES)}.`);
    const isoMedia = head.length >= 8 && head.subarray(4, 8).toString('latin1') === 'ftyp';
    const ebml = head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3;
    if (!(isoMedia || ((ext === '.webm' || ext === '.mkv') && ebml)))
      throw bad('That file is not a valid video.');
    return { source: filePath, storedName: `${base}${ext}`, mime: spec.mime, size, kind: 'VIDEO' };
  }

  if (size > DOC_MAX_BYTES) throw bad(`A document can be up to ${mb(DOC_MAX_BYTES)}.`);
  if (spec.cls === 'pdf' && head.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw bad('That file is not a PDF.');
  }
  if (spec.cls === 'xlsx' && (head.length < 4 || head.readUInt32BE(0) !== 0x504b0304)) {
    throw bad('That file is not an XLSX spreadsheet.');
  }
  const kind = spec.cls === 'xlsx' || askedKind === 'PRICE_SHEET' ? 'PRICE_SHEET' : 'DOCUMENT';
  return {
    source: await fs.promises.readFile(filePath),
    storedName: `${base}${ext}`,
    mime: spec.mime,
    size,
    kind,
  };
}

// ── zip of every file (download all) ─────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crcUpdate = (crc: number, buf: Buffer) => {
  let c = crc ^ 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/**
 * Streams a .zip (stored, not compressed: photos and videos are compressed
 * already) of the given files into `out`, one file at a time, so memory stays
 * flat whatever the total size.
 */
export async function streamZip(
  out: Writable,
  files: { name: string; storagePath: string }[],
  store: DraftFileStore = getDraftStorage(),
) {
  const central: Buffer[] = [];
  let offset = 0;
  const write = (b: Buffer) =>
    new Promise<void>((resolve) => {
      offset += b.length;
      if (out.write(b)) resolve();
      else out.once('drain', resolve);
    });
  const used = new Set<string>();
  for (const f of files) {
    let name = f.name.replace(/[\\/:*?"<>|]+/g, '_') || 'file';
    for (let i = 2; used.has(name.toLowerCase()); i++) {
      const ext = path.extname(f.name);
      name = `${path.basename(f.name, ext)} (${i})${ext}`;
    }
    used.add(name.toLowerCase());
    const nameBuf = Buffer.from(name, 'utf8');
    const start = offset;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0808, 6); // sizes in the trailing descriptor; UTF-8 name
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(nameBuf.length, 26);
    await write(Buffer.concat([local, nameBuf]));

    let crc = 0;
    let size = 0;
    const counter = new Writable({
      write(chunk: Buffer, _enc, cb) {
        crc = crcUpdate(crc, chunk);
        size += chunk.length;
        offset += chunk.length;
        if (out.write(chunk)) cb();
        else out.once('drain', () => cb());
      },
    });
    try {
      await store.pipeTo(f.storagePath, counter);
    } catch (err) {
      logger.error(`[Listings] zip: could not read ${f.name}`, err);
    }
    const desc = Buffer.alloc(16);
    desc.writeUInt32LE(0x08074b50, 0);
    desc.writeUInt32LE(crc, 4);
    desc.writeUInt32LE(size, 8);
    desc.writeUInt32LE(size, 12);
    await write(desc);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0808, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(size, 20);
    cen.writeUInt32LE(size, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(start, 42);
    central.push(Buffer.concat([cen, nameBuf]));
  }
  const cdStart = offset;
  const cd = Buffer.concat(central);
  await write(cd);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(cdStart, 16);
  await write(end);
}

// ── short-lived links for <img> / <video> / download-all ──────────

// A page cannot send the sign-in header with <img src> or <video src>, so the
// signed-in viewer asks for a link that is good for 30 minutes, for one
// listing, for them only.
const mediaKey = () =>
  crypto
    .createHmac('sha256', process.env.JWT_ACCESS_SECRET || 'missing-secret')
    .update('listing-media-v1')
    .digest();

export function signMediaToken(employeeId: number, draftId: number, ttlMs = 30 * 60_000) {
  const exp = Date.now() + ttlMs;
  const body = `${employeeId}.${draftId}.${exp}`;
  const sig = crypto.createHmac('sha256', mediaKey()).update(body).digest('base64url');
  return { token: `${body}.${sig}`, expires_at: new Date(exp).toISOString() };
}

export function readMediaToken(token: string, draftId: number): { employeeId: number } | null {
  const parts = String(token || '').split('.');
  if (parts.length !== 4) return null;
  const [emp, draft, exp, sig] = parts;
  const want = crypto
    .createHmac('sha256', mediaKey())
    .update(`${emp}.${draft}.${exp}`)
    .digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Number(draft) !== draftId || Number(exp) < Date.now()) return null;
  return { employeeId: Number(emp) };
}
