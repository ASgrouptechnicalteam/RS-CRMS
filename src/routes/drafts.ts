import { NextFunction, Response, Router } from 'express';
import multer from 'multer';
import { ZodError } from 'zod';
import { AuthenticatedRequest, authenticateToken } from '../middleware/auth';
import { hasEffectivePermission, requireAuthz } from '../middleware/authz';
import { validateRequestBody } from '../middleware/validate';
import {
  DraftLinkSchema,
  DraftNeedsInfoSchema,
  DraftReplySchema,
  ProjectDraftCreateSchema,
  PropertyDraftCreateSchema,
  Permissions,
  DRAFT_ATTACHMENT_KINDS,
  DRAFT_STATUSES,
  DRAFT_TYPES,
} from '../shared';
import { DraftService } from '../services/draft.service';
import {
  draftAttachmentUpload,
  getDraftStorage,
  readMediaToken,
  removeTemp,
  signMediaToken,
  streamZip,
} from '../services/draftStorage';
import { logger } from '../utils/logger';

// DraftSubmission module (docs/plans/rbac-plan.md section 3).
// Never mounted as a public route and never served from /uploads: every read
// of a draft or of one of its files goes through the checks in DraftService.
const router = Router();

const parseId = (value: string) => {
  const id = parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
};

/** Submitters and reviewers may both list/read; DraftService narrows what each sees. */
const requireDraftAccess = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const user = req.user!;
    const ok =
      (await hasEffectivePermission(user, Permissions.DRAFTS_SUBMIT)) ||
      (await hasEffectivePermission(user, Permissions.DRAFTS_REVIEW));
    if (!ok) {
      return res.status(403).json({
        error: 'Forbidden: Missing required permission (drafts.submit or drafts.review)',
        code: 'FORBIDDEN',
      });
    }
    next();
  } catch (err) {
    next(err);
  }
};

const withType =
  (type: 'PROPERTY' | 'PROJECT') =>
  (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
    req.body = { ...(req.body || {}), type };
    next();
  };

// Staff must give the contactable person (name and number) with every new listing (owner, 2026-11-21).
const requireContact = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const b = req.body || {};
  if (!String(b.owner_contact_name || '').trim() || !String(b.owner_contact_phone || '').trim()) {
    return res.status(400).json({ error: 'Enter the contactable person name and number.' });
  }
  return next();
};

router.post(
  '/property',
  authenticateToken,
  requireAuthz(Permissions.DRAFTS_SUBMIT),
  requireContact,
  withType('PROPERTY'),
  validateRequestBody(PropertyDraftCreateSchema),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const draft = await DraftService.create(req.user!, req.body);
      return res.status(201).json({ message: 'Listing sent to the digital team.', draft });
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/project',
  authenticateToken,
  requireAuthz(Permissions.DRAFTS_SUBMIT),
  requireContact,
  withType('PROJECT'),
  validateRequestBody(ProjectDraftCreateSchema),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const draft = await DraftService.create(req.user!, req.body);
      return res.status(201).json({ message: 'Listing sent to the digital team.', draft });
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  '/',
  authenticateToken,
  requireDraftAccess,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      const type = typeof req.query.type === 'string' ? req.query.type : undefined;
      if (status && !(DRAFT_STATUSES as readonly string[]).includes(status)) {
        return res.status(400).json({ error: 'Unknown status' });
      }
      if (type && !(DRAFT_TYPES as readonly string[]).includes(type)) {
        return res.status(400).json({ error: 'Unknown type' });
      }
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 200);
      const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);
      const { drafts, total } = await DraftService.list(req.user!, { status, type, limit, offset });
      // Each listing carries a 30-minute key so the page can show its photos.
      const withMedia = drafts.map((d) => ({
        ...d,
        media_token: signMediaToken(req.user!.employeeId, d.id).token,
      }));
      return res
        .status(200)
        .json({ drafts: withMedia, total, pagination: { limit, offset, total } });
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  '/:id',
  authenticateToken,
  requireDraftAccess,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const id = parseId(req.params.id);
      if (!id) return res.status(400).json({ error: 'Invalid ID format' });
      const draft = await DraftService.get(req.user!, id);
      return res.status(200).json({
        draft: { ...draft, media_token: signMediaToken(req.user!.employeeId, id).token },
      });
    } catch (err) {
      next(err);
    }
  },
);

router.put(
  '/:id',
  authenticateToken,
  requireAuthz(Permissions.DRAFTS_SUBMIT),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const id = parseId(req.params.id);
      if (!id) return res.status(400).json({ error: 'Invalid ID format' });
      const draft = await DraftService.update(req.user!, id, req.body || {});
      return res.status(200).json({ message: 'Listing updated.', draft });
    } catch (err) {
      if (err instanceof ZodError) {
        return res.status(400).json({
          error: err.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', '),
        });
      }
      next(err);
    }
  },
);

router.post(
  '/:id/reply',
  authenticateToken,
  requireAuthz(Permissions.DRAFTS_SUBMIT),
  validateRequestBody(DraftReplySchema),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const id = parseId(req.params.id);
      if (!id) return res.status(400).json({ error: 'Invalid ID format' });
      return res
        .status(200)
        .json({ draft: await DraftService.reply(req.user!, id, req.body.note) });
    } catch (err) {
      next(err);
    }
  },
);

// ── reviewer actions ──────────────────────────────────────────

router.post(
  '/:id/accept',
  authenticateToken,
  requireAuthz(Permissions.DRAFTS_REVIEW),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const id = parseId(req.params.id);
      if (!id) return res.status(400).json({ error: 'Invalid ID format' });
      return res.status(200).json({ draft: await DraftService.accept(req.user!, id) });
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/:id/needs-info',
  authenticateToken,
  requireAuthz(Permissions.DRAFTS_REVIEW),
  validateRequestBody(DraftNeedsInfoSchema),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const id = parseId(req.params.id);
      if (!id) return res.status(400).json({ error: 'Invalid ID format' });
      return res
        .status(200)
        .json({ draft: await DraftService.needsInfo(req.user!, id, req.body.note) });
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/:id/link',
  authenticateToken,
  requireAuthz(Permissions.DRAFTS_REVIEW),
  validateRequestBody(DraftLinkSchema),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const id = parseId(req.params.id);
      if (!id) return res.status(400).json({ error: 'Invalid ID format' });
      return res
        .status(200)
        .json({ draft: await DraftService.link(req.user!, id, req.body.record_id) });
    } catch (err) {
      next(err);
    }
  },
);

// ── files ─────────────────────────────────────────────────────

/**
 * Writes one line when a file arrives and one when it is answered, so a failed upload can be traced (the
 * hosting logs do not keep individual requests). If the server answers before the whole file has arrived (not
 * signed in, no permission), the rest of the file is read and thrown away: otherwise a phone on a weak
 * connection can see the connection drop instead of the real answer, and report "cut off".
 */
const traceUpload = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const started = Date.now();
  const size = Number(req.headers['content-length']) || 0;
  const who = () => req.user?.employeeCode || 'not signed in';
  logger.info(
    `[Listings] file arriving: listing ${req.params.id}, ${Math.round(size / 1024)} KB, ${who()}`,
  );
  let answered = false;
  res.on('finish', () => {
    answered = true;
    logger.info(
      `[Listings] file answered ${res.statusCode} in ${Date.now() - started} ms: listing ${req.params.id}, ${who()}`,
    );
    if (!req.complete) req.resume();
  });
  res.on('close', () => {
    if (!answered) {
      logger.warn(
        `[Listings] connection closed before the file was answered after ${Date.now() - started} ms: listing ${req.params.id}, ${who()}, ${Math.round((req.socket?.bytesRead || 0) / 1024)} KB read`,
      );
    }
  });
  next();
};

// One file per request, written to a temp file (videos are up to 500 MB).
const uploadOne = (req: AuthenticatedRequest, res: Response, next: NextFunction) =>
  draftAttachmentUpload.single('file')(req as any, res as any, (err: any) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      return res.status(400).json({
        error: err.code === 'LIMIT_FILE_SIZE' ? 'The file is larger than 500 MB.' : err.message,
      });
    }
    return res.status(err.statusCode || 400).json({ error: err.message || 'Upload failed' });
  });

router.post(
  '/:id/attachments',
  traceUpload,
  authenticateToken,
  requireAuthz(Permissions.DRAFTS_SUBMIT),
  uploadOne,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const file = (req as any).file as
      { path: string; originalname: string; size: number } | undefined;
    try {
      const id = parseId(req.params.id);
      if (!id) return res.status(400).json({ error: 'Invalid ID format' });
      if (!file) return res.status(400).json({ error: 'Choose a file to upload.' });
      const kind = req.body?.kind ? String(req.body.kind).toUpperCase() : undefined;
      if (kind && !(DRAFT_ATTACHMENT_KINDS as readonly string[]).includes(kind)) {
        return res.status(400).json({ error: 'Unknown file kind' });
      }
      const attachment = await DraftService.addAttachment(req.user!, id, file, kind);
      return res.status(201).json({ message: 'File added.', attachment });
    } catch (err) {
      logger.error('[Listings] file upload failed', err);
      next(err);
    } finally {
      removeTemp(file?.path);
    }
  },
);

// A 30-minute link key, so the page can show photos and play videos in
// <img> / <video> (which cannot send the sign-in header).
router.get(
  '/:id/media-token',
  authenticateToken,
  requireDraftAccess,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const id = parseId(req.params.id);
      if (!id) return res.status(400).json({ error: 'Invalid ID format' });
      return res.status(200).json(await DraftService.mediaToken(req.user!, id));
    } catch (err) {
      next(err);
    }
  },
);

/** Signed in, or carrying a valid media link (?t=) for this listing. */
const signedInOrMediaLink = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const id = parseId(req.params.id);
  if (id && typeof req.query.t === 'string') {
    if (readMediaToken(req.query.t, id)) {
      (req as any).mediaLink = true;
      return next();
    }
    return res.status(401).json({ error: 'This link has expired. Reload the page.' });
  }
  return authenticateToken(req, res, (err?: any) =>
    err ? next(err) : requireDraftAccess(req, res, next),
  );
};

// Every file of the listing as one zip, streamed (download all).
router.get(
  '/:id/attachments.zip',
  signedInOrMediaLink,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const id = parseId(req.params.id);
      if (!id) return res.status(400).json({ error: 'Invalid ID format' });
      if (!(req as any).mediaLink) await DraftService.get(req.user!, id);
      const draft = await DraftService.allAttachments(id);
      if (!draft.attachments.length) return res.status(404).json({ error: 'No files' });
      const name = `listing-${draft.id}-${draft.title}`.replace(/[^\w\- ]+/g, '').slice(0, 80);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(name)}.zip`,
      );
      res.setHeader('Cache-Control', 'private, no-store');
      await streamZip(
        res,
        draft.attachments.map((a) => ({ name: a.original_name, storagePath: a.storage_path })),
      );
      res.end();
    } catch (err) {
      if (res.headersSent) {
        logger.error('[Listings] zip failed part way', err);
        return res.destroy();
      }
      next(err);
    }
  },
);

// The only way a listing file leaves the server. Shown in the page by default
// (photos, video with seeking); ?download=1 saves it instead.
router.get(
  '/:id/attachments/:attachmentId',
  signedInOrMediaLink,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const id = parseId(req.params.id);
      const attachmentId = parseId(req.params.attachmentId);
      if (!id || !attachmentId) return res.status(400).json({ error: 'Invalid ID format' });
      const att = (req as any).mediaLink
        ? await DraftService.attachmentById(id, attachmentId)
        : await DraftService.attachmentFor(req.user!, id, attachmentId);
      const store = getDraftStorage();

      // Video seeking: "bytes=N-" (or "bytes=N-M"; the rest of the file is sent).
      let start = 0;
      const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range || ''));
      if (range) {
        start = Number(range[1]);
        if (start >= att.size) {
          res.setHeader('Content-Range', `bytes */${att.size}`);
          return res.status(416).end();
        }
      }
      const inline = req.query.download !== '1';
      res.setHeader('Content-Type', att.mime);
      res.setHeader(
        'Content-Disposition',
        `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(att.original_name)}`,
      );
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      res.setHeader('Cache-Control', 'private, max-age=1800');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Length', String(att.size - start));
      if (range) {
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${att.size - 1}/${att.size}`);
      } else res.status(200);
      await store.pipeTo(att.storage_path, res, start);
      res.end();
    } catch (err: any) {
      if (res.headersSent) {
        // The viewer stopped watching, or storage dropped: just close.
        return res.destroy();
      }
      if (err?.status) return next(err);
      logger.error('[Listings] file read failed', err);
      return res.status(404).json({ error: 'File not found on the server.' });
    }
  },
);

router.delete(
  '/:id/attachments/:attachmentId',
  authenticateToken,
  requireAuthz(Permissions.DRAFTS_SUBMIT),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const id = parseId(req.params.id);
      const attachmentId = parseId(req.params.attachmentId);
      if (!id || !attachmentId) return res.status(400).json({ error: 'Invalid ID format' });
      await DraftService.removeAttachment(req.user!, id, attachmentId);
      return res.status(200).json({ message: 'File removed.' });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
