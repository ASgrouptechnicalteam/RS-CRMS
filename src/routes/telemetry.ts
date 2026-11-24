import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { logger } from '../utils/logger';
import { clientIp } from '../middleware/rateLimiter';

/**
 * Crash reports from the website (a screen that broke, a failed page download). They go to the server log
 * (Render Logs, search "[Client]") so a problem on a staff phone is visible. No sign-in is needed (a crash
 * can happen before sign-in), so the limit is strict and every field is cut short and cleaned.
 */
const router = Router();

const limiter = rateLimit({
  keyGenerator: (req: any) => clientIp(req),
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many reports' },
});

const clean = (v: string | undefined, max: number) =>
  // eslint-disable-next-line no-control-regex
  (v || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, max);

const ReportSchema = z.object({
  kind: z.enum(['render', 'error', 'unhandledrejection', 'chunk', 'api']),
  message: z.string().max(2000),
  stack: z.string().max(10000).optional(),
  url: z.string().max(1000).optional(),
  route: z.string().max(300).optional(),
  release: z.string().max(100).optional(),
  employee_code: z.string().max(100).optional(),
  online: z.boolean().optional(),
  ua: z.string().max(1000).optional(),
});

// Anything that looks like a secret is blanked before it is written to the log: a crash message can quote a
// URL with a token, a header, or a sign-in token.
const redact = (v: string) =>
  v
    .replace(
      /\b(token|password|passwd|secret|authorization|api[_-]?key|otp|pin)\b\s*[=:]\s*\S+/gi,
      '$1=[removed]',
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [removed]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[token removed]');

router.post('/client-error', limiter, (req: Request, res: Response) => {
  const parsed = ReportSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Not a valid report' });
  const r = parsed.data;
  const url = clean(r.url, 300).split('?')[0].split('#')[0];
  const route = clean(r.route, 120);
  const stack = redact(clean(r.stack, 2000));
  // One readable line (search "[Client]" in the Render logs).
  logger.error(
    `[Client] ${r.kind} on ${route || url || 'unknown page'} | release ${clean(r.release, 40) || 'unknown'} | user ${
      clean(r.employee_code, 40) || 'not signed in'
    } | ${r.online === false ? 'offline' : 'online'} | ${clean(r.ua, 120)} | ${redact(clean(r.message, 500))}${
      stack ? ` | ${stack}` : ''
    }`,
  );
  return res.status(204).end();
});

export default router;
