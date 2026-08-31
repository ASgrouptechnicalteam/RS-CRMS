import rateLimit from 'express-rate-limit';
import { prisma } from '../lib/prisma';


const p = prisma;
const skipRateLimitInTests = (req: any) => process.env.NODE_ENV === 'test' && req.headers['x-strict-rate-limit'] !== 'true';

export const apiRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  skip: skipRateLimitInTests,
  message: { error: 'Too many API requests, please try again later', code: 'RATE_LIMIT_EXCEEDED' },
  standardHeaders: true,
  legacyHeaders: false,
});

export const refreshRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  skip: skipRateLimitInTests,
  message: { error: 'Too many refresh attempts, please try again later', code: 'RATE_LIMIT_EXCEEDED' },
  standardHeaders: true,
  legacyHeaders: false,
});

export const publicReadLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  skip: skipRateLimitInTests,
  max: 120, // 120 public read requests per IP per minute
  message: { error: 'Too many requests from this IP, please try again after a minute', code: 'RATE_LIMIT_EXCEEDED' },
  standardHeaders: true,
  legacyHeaders: false,
});

export const publicWriteLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  skip: skipRateLimitInTests,
  max: 10, // 10 public lead submissions per IP per minute
  message: { error: 'Too many submissions from this IP, please try again after a minute', code: 'RATE_LIMIT_EXCEEDED' },
  standardHeaders: true,
  legacyHeaders: false,
});

export const loginRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  skip: skipRateLimitInTests,
  max: 5, // Limit each IP to 5 login requests per window
  message: { error: 'Too many login attempts from this IP, please try again after a minute', code: 'RATE_LIMIT_EXCEEDED' },
  standardHeaders: true, 
  legacyHeaders: false, 
  handler: async (req, res, next, options) => {
    const ip = req.ip || req.headers['x-forwarded-for'] || 'UNKNOWN_IP';
    const emailOrCode = req.body?.employee_code || 'UNKNOWN_CODE';
    
    try {
      await p.auditEvent.create({
        data: {
          actor_id: 0,
          action: 'SECURITY_ALERT',
          entity_type: 'RATE_LIMIT_EXCEEDED',
          entity_id: 0,
          new_value: `Login rate limit exceeded for IP: ${ip}, targeting: ${emailOrCode}`
        }
      });
    } catch (err) {
      console.error('Failed to log rate limit audit event', err);
    }
    
    res.status(options.statusCode).json(options.message);
  }
});

// AI Search endpoint — conservative because each call invokes a provider (costly + slow).
// Follows the existing express-rate-limit conventions (IP-based window, test skip).
export const aiSearchLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  skip: skipRateLimitInTests,
  max: 10, // 10 AI search requests per IP per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many AI search requests, please try again after a minute', code: 'RATE_LIMIT_EXCEEDED' },
});

