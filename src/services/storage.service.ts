import multer from 'multer';
import path from 'path';
import fs from 'fs';
import sharp from 'sharp';
import crypto from 'crypto';

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads');

const MAX_SIZE = 10 * 1024 * 1024; // 10MB

export const propertyImageUpload = multer({
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
      console.warn(`Invalid or unrecognizable image URL for deletion: ${imageUrl}`);
      return;
    }
    
    const relativeSafePath = match[1];
    const absolutePath = path.join(UPLOAD_DIR, relativeSafePath);
    
    if (absolutePath.startsWith(path.resolve(UPLOAD_DIR)) && fs.existsSync(absolutePath)) {
      try {
        fs.unlinkSync(absolutePath);
      } catch (err) {
        console.error(`Failed to delete physical file: ${absolutePath}`, err);
      }
    }
  }
}

export class SftpPropertyImageStorage implements PropertyImageStorage {
  async upload(buffer: Buffer, propertyId: number): Promise<string> {
    const Client = (await import('ssh2-sftp-client')).default;
    const sftp = new Client();
    
    try {
      await sftp.connect({
        host: process.env.SFTP_HOST,
        port: parseInt(process.env.SFTP_PORT || '22', 10),
        username: process.env.SFTP_USERNAME,
        password: process.env.SFTP_PASSWORD,
      });

      const { processedBuffer, filename } = await processImageBuffer(buffer);
      const remoteDir = path.posix.join(process.env.SFTP_REMOTE_BASE_PATH || '', String(propertyId), 'images');
      
      const dirExists = await sftp.exists(remoteDir);
      if (!dirExists) {
        await sftp.mkdir(remoteDir, true);
      }

      const remotePath = path.posix.join(remoteDir, filename);
      await sftp.put(processedBuffer, remotePath);
      
      const baseUrl = process.env.SFTP_PUBLIC_BASE_URL || '';
      return `${baseUrl}/${propertyId}/images/${filename}`;
    } finally {
      await sftp.end();
    }
  }

  async delete(imageUrl: string): Promise<void> {
    const baseUrl = process.env.SFTP_PUBLIC_BASE_URL || '';
    if (!imageUrl.startsWith(baseUrl)) {
      console.warn(`Cannot delete SFTP image, URL does not match base URL: ${imageUrl}`);
      return;
    }

    const relativePath = imageUrl.slice(baseUrl.length);
    const remotePath = path.posix.join(process.env.SFTP_REMOTE_BASE_PATH || '', relativePath);

    const Client = (await import('ssh2-sftp-client')).default;
    const sftp = new Client();
    try {
      await sftp.connect({
        host: process.env.SFTP_HOST,
        port: parseInt(process.env.SFTP_PORT || '22', 10),
        username: process.env.SFTP_USERNAME,
        password: process.env.SFTP_PASSWORD,
      });
      
      const exists = await sftp.exists(remotePath);
      if (exists) {
        await sftp.delete(remotePath);
      }
    } catch (err) {
      console.error(`Failed to delete remote SFTP file: ${remotePath}`, err);
    } finally {
      await sftp.end();
    }
  }
}

export function getPropertyImageStorage(): PropertyImageStorage {
  if (process.env.STORAGE_DRIVER === 'sftp') {
    return new SftpPropertyImageStorage();
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

/**
 * Minimal local-disk implementation of StorageService.
 * Files are written under the configured base directory and addressed by
 * relative paths (e.g. "documents/...") so stored paths stay public-safe.
 * Path traversal outside the base directory is rejected.
 */
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
    return relativePath;
  }

  async download(storagePath: string): Promise<Buffer> {
    return fs.promises.readFile(this.resolveSafe(storagePath));
  }

  async delete(storagePath: string): Promise<void> {
    const filepath = this.resolveSafe(storagePath);
    if (fs.existsSync(filepath)) {
      await fs.promises.unlink(filepath);
    }
  }
}
