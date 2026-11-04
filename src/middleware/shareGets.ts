import type { NextFunction, Request, Response } from 'express';

// A refresh does not stop the work the previous load started: the database
// keeps running those queries, and the new load runs them all again on top.
// Someone refreshing a slow page piles up work and makes it slower. So while a
// read is running, the same read by the same signed-in person (same token, same
// address) waits for that answer instead of starting again.

// If the first request never produces an answer to share, the others go ahead.
const GIVE_UP_MS = 20_000;

type Waiter = { res: Response; next: NextFunction };
const running = new Map<string, Waiter[]>();

export const shareGets = (req: Request, res: Response, next: NextFunction) => {
  const auth = req.headers.authorization;
  if (req.method !== 'GET' || !auth) return next();

  const key = `${auth}|${req.originalUrl}`;
  const waiting = running.get(key);
  if (waiting) {
    waiting.push({ res, next });
    return;
  }

  const waiters: Waiter[] = [];
  running.set(key, waiters);
  let settled = false;
  const settle = (answer: (w: Waiter) => void) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    running.delete(key);
    for (const w of waiters) if (!w.res.writableEnded && !w.res.destroyed) answer(w);
  };
  const letThemRun = () => settle((w) => w.next());
  const timer = setTimeout(letThemRun, GIVE_UP_MS);
  timer.unref?.();

  const json = res.json.bind(res);
  res.json = (body: any) => {
    settle((w) => w.res.status(res.statusCode).json(body));
    return json(body);
  };
  // Answered some other way (a file, a redirect): nothing to share. A client
  // that left fires 'close', not 'finish'; the handler is still working and
  // its res.json above will still settle this.
  res.on('finish', letThemRun);
  next();
};
