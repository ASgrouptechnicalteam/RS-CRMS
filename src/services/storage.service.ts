import { logger } from '../utils/logger';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import sharp from 'sharp';
import crypto from 'crypto';
import * as ftp from 'basic-ftp';

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads');

const MAX_SIZE = 10 * 1024 * 1024; // 10MB

export const propertyImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE },
});

export const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE },
});

/**
 * Reusable helper to process image buffer before storage
 */
export async function processImageBuffer(buffer: Buffer): Promise<{ processedBuffer: Buffer, filename: string }> {
  const processedBuffer = await sharp(buffer)
    .resize(2560, 2560, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: 80 })
    .toBuffer();

  const uuid = crypto.randomUUID();
  const filename = `${uuid}.webp`;
  
  return { processedBuffer, filename };
}

export interface PropertyImageStorage {
  upload(buffer: Buffer, propertyId: number): Promise<string>;
  delete(imageUrl: string): Promise<void>;
}

export class LocalPropertyImageStorage implements PropertyImageStorage {
  async upload(buffer: Buffer, propertyId: number): Promise<string> {
    const { processedBuffer, filename } = await processImageBuffer(buffer);
    const propertyImagesDir = path.join(UPLOAD_DIR, 'properties', String(propertyId), 'images');
    
    if (!fs.existsSync(propertyImagesDir)) {
      fs.mkdirSync(propertyImagesDir, { recursive: true });
    }

    const absolutePath = path.join(propertyImagesDir, filename);
    await fs.promises.writeFile(absolutePath, processedBuffer);
    
    return `/uploads/properties/${propertyId}/images/${filename}`;
  }

  async delete(imageUrl: string): Promise<void> {
    const match = imageUrl.match(/^\/uploads\/(properties\/\d+\/images\/[a-f0-9-]+\.webp|property-images\/prop-[0-9-]+\.[a-z]+)$/i);
    if (!match) {
      logger.warn(`Invalid or unrecognizable image URL for deletion: ${imageUrl}`);
      return;
    }
    
    const relativeSafePath = match[1];
    const absolutePath = path.join(UPLOAD_DIR, relativeSafePath);
    
    if (absolutePath.startsWith(path.resolve(UPLOAD_DIR)) && fs.existsSync(absolutePath)) {
      try {
        fs.unlinkSync(absolutePath);
      } catch (err) {
        logger.error(`Failed to delete physical file: ${absolutePath}`, err);
      }
    }
  }
}

async function getFtpClient() {
  const client = new ftp.Client();
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

export class FtpPropertyImageStorage implements PropertyImageStorage {
  async upload(buffer: Buffer, propertyId: number): Promise<string> {
    const client = await getFtpClient();
    try {
      const { processedBuffer, filename } = await processImageBuffer(buffer);
      const remoteDir = path.posix.join(process.env.FTP_REMOTE_BASE_PATH || '', 'properties', String(propertyId), 'images');
      
      await client.ensureDir(remoteDir);
      
      // Write buffer to stream for basic-ftp
      const { Readable } = await import('stream');
      const stream = Readable.from(processedBuffer);
      
      const remotePath = path.posix.join(remoteDir, filename);
      await client.uploadFrom(stream, remotePath);
      
      const baseUrl = process.env.FTP_PUBLIC_BASE_URL || '';
      return `${baseUrl}/properties/${propertyId}/images/${filename}`;
    } finally {
      client.close();
    }
  }

  async delete(imageUrl: string): Promise<void> {
    const baseUrl = process.env.FTP_PUBLIC_BASE_URL || '';
    if (!imageUrl.startsWith(baseUrl)) {
      logger.warn(`Cannot delete FTP image, URL does not match base URL: ${imageUrl}`);
      return;
    }

    const relativePath = imageUrl.slice(baseUrl.length);
    const remotePath = path.posix.join(process.env.FTP_REMOTE_BASE_PATH || '', relativePath);

    const client = await getFtpClient();
    try {
      await client.remove(remotePath);
    } catch (err) {
      logger.error(`Failed to delete remote FTP file: ${remotePath}`, err);
    } finally {
      client.close();
    }
  }
}

export function getPropertyImageStorage(): PropertyImageStorage {
  if (process.env.STORAGE_DRIVER === 'ftp') {
    return new FtpPropertyImageStorage();
  }
  return new LocalPropertyImageStorage();
}

/**
 * Storage abstraction used by the document module.
 * Implementations must return relative, public-safe storage paths and must
 * never expose full server filesystem paths.
 */
export interface StorageService {
  upload(buffer: Buffer, originalName: string, mimeType: string): Promise<string>;
  download(storagePath: string): Promise<Buffer>;
  delete(storagePath: string): Promise<void>;
}

export class LocalStorageService implements StorageService {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = path.resolve(baseDir);
  }

  private resolveSafe(storagePath: string): string {
    const resolved = path.resolve(this.baseDir, storagePath);
    if (!resolved.startsWith(this.baseDir + path.sep)) {
      throw new Error('Invalid storage path');
    }
    return resolved;
  }

  async upload(buffer: Buffer, originalName: string, _mimeType: string): Promise<string> {
    const ext = path.extname(originalName).toLowerCase() || '.bin';
    const filename = `doc-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    const relativePath = path.posix.join('documents', filename);
    const dir = path.join(this.baseDir, 'documents');
    fs.mkdirSync(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, filename), buffer);
    return `/uploads/${relativePath}`; // Make it accessible via public URL locally
  }

  async download(storagePath: string): Promise<Buffer> {
    const relativePath = storagePath.replace(/^\/uploads\//, '');
    return fs.promises.readFile(this.resolveSafe(relativePath));
  }

  async delete(storagePath: string): Promise<void> {
    const relativePath = storagePath.replace(/^\/uploads\//, '');
    const filepath = this.resolveSafe(relativePath);
    if (fs.existsSync(filepath)) {
      await fs.promises.unlink(filepath);
    }
  }
}

export class FtpStorageService implements StorageService {
  private readonly remoteSubdir: string;

  constructor(remoteSubdir: string = 'documents') {
    this.remoteSubdir = remoteSubdir;
  }

  async upload(buffer: Buffer, originalName: string, _mimeType: string): Promise<string> {
    const ext = path.extname(originalName).toLowerCase() || '.bin';
    const filename = `doc-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    
    const client = await getFtpClient();
    try {
      const remoteDir = path.posix.join(process.env.FTP_REMOTE_BASE_PATH || '', this.remoteSubdir);
      await client.ensureDir(remoteDir);
      
      const { Readable } = await import('stream');
      const stream = Readable.from(buffer);
      
      const remotePath = path.posix.join(remoteDir, filename);
      await client.uploadFrom(stream, remotePath);
      
      const baseUrl = process.env.FTP_PUBLIC_BASE_URL || '';
      return `${baseUrl}/${this.remoteSubdir}/${filename}`;
    } finally {
      client.close();
    }
  }

  async download(storagePath: string): Promise<Buffer> {
    const baseUrl = process.env.FTP_PUBLIC_BASE_URL || '';
    if (!storagePath.startsWith(baseUrl)) {
      throw new Error(`Cannot download FTP file, URL does not match base URL: ${storagePath}`);
    }

    const relativePath = storagePath.slice(baseUrl.length);
    const remotePath = path.posix.join(process.env.FTP_REMOTE_BASE_PATH || '', relativePath);

    const client = await getFtpClient();
    try {
      const { PassThrough } = await import('stream');
      const stream = new PassThrough();
      const chunks: Buffer[] = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      
      await client.downloadTo(stream, remotePath);
      return Buffer.concat(chunks);
    } finally {
      client.close();
    }
  }

  async delete(storagePath: string): Promise<void> {
    const baseUrl = process.env.FTP_PUBLIC_BASE_URL || '';
    if (!storagePath.startsWith(baseUrl)) {
      logger.warn(`Cannot delete FTP file, URL does not match base URL: ${storagePath}`);
      return;
    }

    const relativePath = storagePath.slice(baseUrl.length);
    const remotePath = path.posix.join(process.env.FTP_REMOTE_BASE_PATH || '', relativePath);

    const client = await getFtpClient();
    try {
      await client.remove(remotePath);
    } catch (err) {
      logger.error(`Failed to delete remote FTP file: ${remotePath}`, err);
    } finally {
      client.close();
    }
  }
}

export function getStorageService(subdir: string = 'documents'): StorageService {
  if (process.env.STORAGE_DRIVER === 'ftp') {
    return new FtpStorageService(subdir);
  }
  return new LocalStorageService(UPLOAD_DIR);
}
