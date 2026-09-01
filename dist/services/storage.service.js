"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LocalStorageService = exports.getPropertyImageStorage = exports.SftpPropertyImageStorage = exports.LocalPropertyImageStorage = exports.processImageBuffer = exports.propertyImageUpload = void 0;
const multer_1 = __importDefault(require("multer"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const sharp_1 = __importDefault(require("sharp"));
const crypto_1 = __importDefault(require("crypto"));
const UPLOAD_DIR = process.env.UPLOAD_DIR || path_1.default.join(process.cwd(), 'uploads');
const MAX_SIZE = 10 * 1024 * 1024; // 10MB
exports.propertyImageUpload = (0, multer_1.default)({
    storage: multer_1.default.memoryStorage(),
    limits: { fileSize: MAX_SIZE },
});
/**
 * Reusable helper to process image buffer before storage
 */
async function processImageBuffer(buffer) {
    const processedBuffer = await (0, sharp_1.default)(buffer)
        .resize(2560, 2560, {
        fit: 'inside',
        withoutEnlargement: true,
    })
        .webp({ quality: 80 })
        .toBuffer();
    const uuid = crypto_1.default.randomUUID();
    const filename = `${uuid}.webp`;
    return { processedBuffer, filename };
}
exports.processImageBuffer = processImageBuffer;
class LocalPropertyImageStorage {
    async upload(buffer, propertyId) {
        const { processedBuffer, filename } = await processImageBuffer(buffer);
        const propertyImagesDir = path_1.default.join(UPLOAD_DIR, 'properties', String(propertyId), 'images');
        if (!fs_1.default.existsSync(propertyImagesDir)) {
            fs_1.default.mkdirSync(propertyImagesDir, { recursive: true });
        }
        const absolutePath = path_1.default.join(propertyImagesDir, filename);
        await fs_1.default.promises.writeFile(absolutePath, processedBuffer);
        return `/uploads/properties/${propertyId}/images/${filename}`;
    }
    async delete(imageUrl) {
        const match = imageUrl.match(/^\/uploads\/(properties\/\d+\/images\/[a-f0-9-]+\.webp|property-images\/prop-[0-9-]+\.[a-z]+)$/i);
        if (!match) {
            console.warn(`Invalid or unrecognizable image URL for deletion: ${imageUrl}`);
            return;
        }
        const relativeSafePath = match[1];
        const absolutePath = path_1.default.join(UPLOAD_DIR, relativeSafePath);
        if (absolutePath.startsWith(path_1.default.resolve(UPLOAD_DIR)) && fs_1.default.existsSync(absolutePath)) {
            try {
                fs_1.default.unlinkSync(absolutePath);
            }
            catch (err) {
                console.error(`Failed to delete physical file: ${absolutePath}`, err);
            }
        }
    }
}
exports.LocalPropertyImageStorage = LocalPropertyImageStorage;
class SftpPropertyImageStorage {
    async upload(buffer, propertyId) {
        const Client = (await Promise.resolve().then(() => __importStar(require('ssh2-sftp-client')))).default;
        const sftp = new Client();
        try {
            await sftp.connect({
                host: process.env.SFTP_HOST,
                port: parseInt(process.env.SFTP_PORT || '22', 10),
                username: process.env.SFTP_USERNAME,
                password: process.env.SFTP_PASSWORD,
            });
            const { processedBuffer, filename } = await processImageBuffer(buffer);
            const remoteDir = path_1.default.posix.join(process.env.SFTP_REMOTE_BASE_PATH || '', String(propertyId), 'images');
            const dirExists = await sftp.exists(remoteDir);
            if (!dirExists) {
                await sftp.mkdir(remoteDir, true);
            }
            const remotePath = path_1.default.posix.join(remoteDir, filename);
            await sftp.put(processedBuffer, remotePath);
            const baseUrl = process.env.SFTP_PUBLIC_BASE_URL || '';
            return `${baseUrl}/${propertyId}/images/${filename}`;
        }
        finally {
            await sftp.end();
        }
    }
    async delete(imageUrl) {
        const baseUrl = process.env.SFTP_PUBLIC_BASE_URL || '';
        if (!imageUrl.startsWith(baseUrl)) {
            console.warn(`Cannot delete SFTP image, URL does not match base URL: ${imageUrl}`);
            return;
        }
        const relativePath = imageUrl.slice(baseUrl.length);
        const remotePath = path_1.default.posix.join(process.env.SFTP_REMOTE_BASE_PATH || '', relativePath);
        const Client = (await Promise.resolve().then(() => __importStar(require('ssh2-sftp-client')))).default;
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
        }
        catch (err) {
            console.error(`Failed to delete remote SFTP file: ${remotePath}`, err);
        }
        finally {
            await sftp.end();
        }
    }
}
exports.SftpPropertyImageStorage = SftpPropertyImageStorage;
function getPropertyImageStorage() {
    if (process.env.STORAGE_DRIVER === 'sftp') {
        return new SftpPropertyImageStorage();
    }
    return new LocalPropertyImageStorage();
}
exports.getPropertyImageStorage = getPropertyImageStorage;
/**
 * Minimal local-disk implementation of StorageService.
 * Files are written under the configured base directory and addressed by
 * relative paths (e.g. "documents/...") so stored paths stay public-safe.
 * Path traversal outside the base directory is rejected.
 */
class LocalStorageService {
    constructor(baseDir) {
        this.baseDir = path_1.default.resolve(baseDir);
    }
    resolveSafe(storagePath) {
        const resolved = path_1.default.resolve(this.baseDir, storagePath);
        if (!resolved.startsWith(this.baseDir + path_1.default.sep)) {
            throw new Error('Invalid storage path');
        }
        return resolved;
    }
    async upload(buffer, originalName, _mimeType) {
        const ext = path_1.default.extname(originalName).toLowerCase() || '.bin';
        const filename = `doc-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
        const relativePath = path_1.default.posix.join('documents', filename);
        const dir = path_1.default.join(this.baseDir, 'documents');
        fs_1.default.mkdirSync(dir, { recursive: true });
        await fs_1.default.promises.writeFile(path_1.default.join(dir, filename), buffer);
        return relativePath;
    }
    async download(storagePath) {
        return fs_1.default.promises.readFile(this.resolveSafe(storagePath));
    }
    async delete(storagePath) {
        const filepath = this.resolveSafe(storagePath);
        if (fs_1.default.existsSync(filepath)) {
            await fs_1.default.promises.unlink(filepath);
        }
    }
}
exports.LocalStorageService = LocalStorageService;
