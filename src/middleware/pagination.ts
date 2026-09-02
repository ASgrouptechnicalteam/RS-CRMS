import { Request, Response, NextFunction } from 'express';

export const enforceMaxPagination = (req: Request, res: Response, next: NextFunction) => {
  if (req.method === 'GET' && req.query.limit) {
    const limit = parseInt(req.query.limit as string, 10);
    if (!isNaN(limit) && limit > 100) {
      req.query.limit = '100'; // Enforce maximum cap of 100
    }
  }
  next();
};
