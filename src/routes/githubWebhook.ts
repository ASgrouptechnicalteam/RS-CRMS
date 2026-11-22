import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { Roles } from '../shared';

/**
 * Code updates for Team Today (owner, 2026-11-21): GitHub tells the CRM about each push, and
 * every commit on the main branch becomes one "code update" for the person who made it.
 * Mounted at /api/v1/webhooks/github. Nothing here is open to the public: a push is accepted only
 * with a valid signature made with GITHUB_WEBHOOK_SECRET.
 */
const router = Router();
const p = prisma as any;

export const signatureOk = (secret: string, raw: Buffer | undefined, header: string | undefined) => {
  if (!secret || !raw || !header || !header.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

/** Whose commit it is: the employee with that GitHub name, else the company's only Technical Manager. */
export async function creditedEmployee(
  login: string | null,
  companyId: number,
): Promise<number | null> {
  if (login) {
    const named = await p.employee.findFirst({
      where: { company_id: companyId, github_username: login, status: 'ACTIVE' },
      select: { id: true },
    });
    if (named) return named.id;
  }
  const managers = await p.employee.findMany({
    where: {
      company_id: companyId,
      status: 'ACTIVE',
      deleted_at: null,
      roles: { some: { role: { name: Roles.TECHNICAL_MANAGER } } },
    },
    select: { id: true },
    take: 2,
  });
  return managers.length === 1 ? managers[0].id : null;
}

router.post('/', async (req: Request, res: Response) => {
  try {
    const secret = process.env.GITHUB_WEBHOOK_SECRET || '';
    if (!signatureOk(secret, (req as any).rawBody, req.header('x-hub-signature-256'))) {
      return res.status(401).json({ error: 'Invalid signature' });
    }
    const event = req.header('x-github-event');
    if (event === 'ping') return res.json({ ok: true });
    if (event !== 'push') return res.json({ ok: true, ignored: event });

    const body = req.body || {};
    const branch = String(body.ref || '').replace('refs/heads/', '');
    const repo = String(body.repository?.full_name || '').slice(0, 80);
    const defaultBranch = String(body.repository?.default_branch || 'main');
    // Only what reaches the main branch is a code update.
    if (!repo || branch !== defaultBranch) return res.json({ ok: true, ignored: 'not the main branch' });

    // The company is the one the CRM serves; with several, the first (one company runs this code).
    const company = await p.company.findFirst({ orderBy: { id: 'asc' }, select: { id: true } });
    if (!company) return res.json({ ok: true, ignored: 'no company' });

    let saved = 0;
    for (const c of (body.commits || []).slice(0, 100)) {
      const message = String(c.message || '').split('\n')[0].slice(0, 300);
      // A merge only joins work already counted.
      if (/^Merge (pull request|branch)/i.test(message)) continue;
      const sha = String(c.id || '').slice(0, 40);
      if (!sha) continue;
      const login: string | null = c.author?.username || c.committer?.username || null;
      const exists = await p.codeUpdate.findFirst({ where: { repo, sha }, select: { id: true } });
      if (exists) continue;
      await p.codeUpdate.create({
        data: {
          company_id: company.id,
          repo,
          sha,
          message,
          author_name: String(c.author?.name || '').slice(0, 120) || null,
          author_login: login ? login.slice(0, 60) : null,
          committed_at: c.timestamp ? new Date(c.timestamp) : new Date(),
          employee_id: await creditedEmployee(login, company.id),
        },
      });
      saved++;
    }
    return res.json({ ok: true, saved });
  } catch (error) {
    logger.error('GitHub webhook error:', error);
    return res.status(500).json({ error: 'Could not record the push' });
  }
});

export default router;
