import { Router, Response, NextFunction } from 'express';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { MessageTemplateService, TemplateContext } from '../services/messageTemplate.service';

const router = Router();

// Resolve a template safely for Sales/Telecaller (doesn't require MESSAGE_TEMPLATES_MANAGE)
router.post(
  '/resolve',
  authenticateToken, // Just authentication, no specific global permission required for generating text links
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { template_key, phone, context } = req.body;
      
      if (!template_key || !phone) {
        return res.status(400).json({ error: 'template_key and phone are required' });
      }

      const ctx: TemplateContext = context || {};
      
      // Resolve using the fallback mechanism so it always succeeds even if admin hasn't created it
      const resolved = await MessageTemplateService.resolveWithFallback(template_key, ctx);

      // Clean phone number and ensure 91 prefix
      const cleanPhone = phone.replace(/[^0-9]/g, '');
      const formattedPhone = cleanPhone.startsWith('91') ? cleanPhone : '91' + cleanPhone;
      
      const whatsAppUrl = `https://wa.me/${formattedPhone}?text=${encodeURIComponent(resolved.body_text)}`;

      return res.json({
        whatsAppUrl,
        whatsAppText: resolved.body_text,
        templateKey: resolved.templateKey,
        usedFallback: resolved.usedFallback,
      });
    } catch (error) {
      next(error);
    }
  },
);

export default router;
