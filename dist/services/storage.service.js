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
exports.getStorageService = exports.FtpStorageService = exports.LocalStorageService = exports.getPropertyImageStorage = exports.FtpPropertyImageStorage = exports.LocalPropertyImageStorage = exports.processImageBuffer = exports.memoryUpload = exports.propertyImageUpload = void 0;
const logger_1 = require("../utils/logger");
const multer_1 = __importDefault(require("multer"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const sharp_1 = __importDefault(require("sharp"));
const crypto_1 = __importDefault(require("crypto"));
const ftp = __importStar(require("basic-ftp"));
const UPLOAD_DIR = process.env.UPLOAD_DIR || path_1.default.join(process.cwd(), 'uploads');
const MAX_SIZE = 10 * 1024 * 1024; // 10MB
exports.propertyImageUpload = (0, multer_1.default)({
    storage: multer_1.default.memoryStorage(),
    limits: { fileSize: MAX_SIZE },
});
exports.memoryUpload = (0, multer_1.default)({
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
            logger_1.logger.warn(`Invalid or unrecognizable image URL for deletion: ${imageUrl}`);
            return;
        }
        const relativeSafePath = match[1];
        const absolutePath = path_1.default.join(UPLOAD_DIR, relativeSafePath);
        if (absolutePath.startsWith(path_1.default.resolve(UPLOAD_DIR)) && fs_1.default.existsSync(absolutePath)) {
            try {
                fs_1.default.unlinkSync(absolutePath);
            }
            catch (err) {
                logger_1.logger.error(`Failed to delete physical file: ${absolutePath}`, err);
            }
        }
    }
}
exports.LocalPropertyImageStorage = LocalPropertyImageStorage;
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
class FtpPropertyImageStorage {
    async upload(buffer, propertyId) {
        const client = await getFtpClient();
        try {
            const { processedBuffer, filename } = await processImageBuffer(buffer);
            const remoteDir = path_1.default.posix.join(process.env.FTP_REMOTE_BASE_PATH || '', 'properties', String(propertyId), 'images');
            await client.ensureDir(remoteDir);
            // Write buffer to stream for basic-ftp
            const { Readable } = await Promise.resolve().then(() => __importStar(require('stream')));
            const stream = Readable.from(processedBuffer);
            const remotePath = path_1.default.posix.join(remoteDir, filename);
            await client.uploadFrom(stream, remotePath);
            const baseUrl = process.env.FTP_PUBLIC_BASE_URL || '';
            return `${baseUrl}/properties/${propertyId}/images/${filename}`;
        }
        finally {
            client.close();
        }
    }
    async delete(imageUrl) {
        const baseUrl = process.env.FTP_PUBLIC_BASE_URL || '';
        if (!imageUrl.startsWith(baseUrl)) {
            logger_1.logger.warn(`Cannot delete FTP image, URL does not match base URL: ${imageUrl}`);
            return;
        }
        const relativePath = imageUrl.slice(baseUrl.length);
        const remotePath = path_1.default.posix.join(process.env.FTP_REMOTE_BASE_PATH || '', relativePath);
        const client = await getFtpClient();
        try {
            await client.remove(remotePath);
        }
        catch (err) {
            logger_1.logger.error(`Failed to delete remote FTP file: ${remotePath}`, err);
        }
        finally {
            client.close();
        }
    }
}
exports.FtpPropertyImageStorage = FtpPropertyImageStorage;
function getPropertyImageStorage() {
    if (process.env.STORAGE_DRIVER === 'ftp') {
        return new FtpPropertyImageStorage();
    }
    return new LocalPropertyImageStorage();
}
exports.getPropertyImageStorage = getPropertyImageStorage;
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
        return `/uploads/${relativePath}`; // Make it accessible via public URL locally
    }
    async download(storagePath) {
        const relativePath = storagePath.replace(/^\/uploads\//, '');
        return fs_1.default.promises.readFile(this.resolveSafe(relativePath));
    }
    async delete(storagePath) {
        const relativePath = storagePath.replace(/^\/uploads\//, '');
        const filepath = this.resolveSafe(relativePath);
        if (fs_1.default.existsSync(filepath)) {
            await fs_1.default.promises.unlink(filepath);
        }
    }
}
exports.LocalStorageService = LocalStorageService;
class FtpStorageService {
    constructor(remoteSubdir = 'documents') {
        this.remoteSubdir = remoteSubdir;
    }
    async upload(buffer, originalName, _mimeType) {
        const ext = path_1.default.extname(originalName).toLowerCase() || '.bin';
        const filename = `doc-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
        const client = await getFtpClient();
        try {
            const remoteDir = path_1.default.posix.join(process.env.FTP_REMOTE_BASE_PATH || '', this.remoteSubdir);
            await client.ensureDir(remoteDir);
            const { Readable } = await Promise.resolve().then(() => __importStar(require('stream')));
            const stream = Readable.from(buffer);
            const remotePath = path_1.default.posix.join(remoteDir, filename);
            await client.uploadFrom(stream, remotePath);
            const baseUrl = process.env.FTP_PUBLIC_BASE_URL || '';
            return `${baseUrl}/${this.remoteSubdir}/${filename}`;
        }
        finally {
            client.close();
        }
    }
    async download(storagePath) {
        const baseUrl = process.env.FTP_PUBLIC_BASE_URL || '';
        if (!storagePath.startsWith(baseUrl)) {
            throw new Error(`Cannot download FTP file, URL does not match base URL: ${storagePath}`);
        }
        const relativePath = storagePath.slice(baseUrl.length);
        const remotePath = path_1.default.posix.join(process.env.FTP_REMOTE_BASE_PATH || '', relativePath);
        const client = await getFtpClient();
        try {
            const { PassThrough } = await Promise.resolve().then(() => __importStar(require('stream')));
            const stream = new PassThrough();
            const chunks = [];
            stream.on('data', (chunk) => chunks.push(chunk));
            await client.downloadTo(stream, remotePath);
            return Buffer.concat(chunks);
        }
        finally {
            client.close();
        }
    }
    async delete(storagePath) {
        const baseUrl = process.env.FTP_PUBLIC_BASE_URL || '';
        if (!storagePath.startsWith(baseUrl)) {
            logger_1.logger.warn(`Cannot delete FTP file, URL does not match base URL: ${storagePath}`);
            return;
        }
        const relativePath = storagePath.slice(baseUrl.length);
        const remotePath = path_1.default.posix.join(process.env.FTP_REMOTE_BASE_PATH || '', relativePath);
        const client = await getFtpClient();
        try {
            await client.remove(remotePath);
        }
        catch (err) {
            logger_1.logger.error(`Failed to delete remote FTP file: ${remotePath}`, err);
        }
        finally {
            client.close();
        }
    }
}
exports.FtpStorageService = FtpStorageService;
function getStorageService(subdir = 'documents') {
    if (process.env.STORAGE_DRIVER === 'ftp') {
        return new FtpStorageService(subdir);
    }
    return new LocalStorageService(UPLOAD_DIR);
}
exports.getStorageService = getStorageService;
