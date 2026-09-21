import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

export const correlationId = (req: Request, res: Response, next: NextFunction) => {
  const incoming = req.header('x-request-id');
  const id = incoming && incoming.length <= 64 ? incoming : randomUUID();
  (req as any).requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
};