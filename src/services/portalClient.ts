import { prisma } from '../lib/prisma';


const p = prisma;

const REQUEST_TIMEOUT_MS = 30000;

export interface PortalHandoffResponse {
  statusCode: number;
  body: any;
}

/**
 * HTTP client for outbound CRM → Portal API calls.
 * Uses Node's native fetch (Node v24). No external HTTP dependency.
 */
export class PortalClient {
  /**
   * Sends a booking handoff payload to the Portal's /handoff endpoint.
   * The idempotency key must be the SAME on every retry.
   */
  static async sendHandoff(payload: any, idempotencyKey: string): Promise<PortalHandoffResponse> {
    const portalApiUrl = process.env.PORTAL_API_URL || '';
    const crmPortalSecret = process.env.CRM_PORTAL_SECRET || '';

    if (!portalApiUrl) {
      throw new Error('PORTAL_API_URL is not configured');
    }
    if (!crmPortalSecret) {
      throw new Error('CRM_PORTAL_SECRET is not configured');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(`${portalApiUrl}/api/v1/portal/handoff`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${crmPortalSecret}`,
        },
        body: JSON.stringify({
          idempotency_key: idempotencyKey,
          ...payload,
        }),
        signal: controller.signal,
      });

      let body: any = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }

      return { statusCode: res.status, body };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Sends a customer KYC status push to the Portal's /kyc-status endpoint.
   * The idempotency key must be the SAME on every retry.
   * The payload carries ONLY kyc_status + masked_pan — never raw PAN/Aadhaar/bank.
   */
  static async sendKycStatus(payload: any, idempotencyKey: string): Promise<PortalHandoffResponse> {
    const portalApiUrl = process.env.PORTAL_API_URL || '';
    const crmPortalSecret = process.env.CRM_PORTAL_SECRET || '';

    if (!portalApiUrl) {
      throw new Error('PORTAL_API_URL is not configured');
    }
    if (!crmPortalSecret) {
      throw new Error('CRM_PORTAL_SECRET is not configured');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(`${portalApiUrl}/api/v1/portal/kyc-status`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${crmPortalSecret}`,
        },
        body: JSON.stringify({
          idempotency_key: idempotencyKey,
          ...payload,
        }),
        signal: controller.signal,
      });

      let body: any = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }

      return { statusCode: res.status, body };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Sends a payment status push to the Portal's /payment-status endpoint
   * (Phase 11 Packet 3F). The idempotency key must be the SAME on every retry.
   * The payload carries ONLY amounts + identifiers — never card/UPI/bank credentials.
   */
  static async sendPaymentStatus(payload: any, idempotencyKey: string): Promise<PortalHandoffResponse> {
    const portalApiUrl = process.env.PORTAL_API_URL || '';
    const crmPortalSecret = process.env.CRM_PORTAL_SECRET || '';

    if (!portalApiUrl) {
      throw new Error('PORTAL_API_URL is not configured');
    }
    if (!crmPortalSecret) {
      throw new Error('CRM_PORTAL_SECRET is not configured');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(`${portalApiUrl}/api/v1/portal/payment-status`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${crmPortalSecret}`,
        },
        body: JSON.stringify({
          idempotency_key: idempotencyKey,
          ...payload,
        }),
        signal: controller.signal,
      });

      let body: any = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }

      return { statusCode: res.status, body };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Sends an installment financial status push to the Portal's
   * /installment-status endpoint (Phase 11 Packet 3H). The idempotency key
   * must be the SAME on every retry. The payload carries ONLY identifiers +
   * amounts + status — never PAN/Aadhaar/bank data or credentials.
   */
  static async sendInstallmentStatus(payload: any, idempotencyKey: string): Promise<PortalHandoffResponse> {
    const portalApiUrl = process.env.PORTAL_API_URL || '';
    const crmPortalSecret = process.env.CRM_PORTAL_SECRET || '';

    if (!portalApiUrl) {
      throw new Error('PORTAL_API_URL is not configured');
    }
    if (!crmPortalSecret) {
      throw new Error('CRM_PORTAL_SECRET is not configured');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(`${portalApiUrl}/api/v1/portal/installment-status`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${crmPortalSecret}`,
        },
        body: JSON.stringify({
          idempotency_key: idempotencyKey,
          ...payload,
        }),
        signal: controller.signal,
      });

      let body: any = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }

      return { statusCode: res.status, body };
    } finally {
      clearTimeout(timeout);
    }
  }
}