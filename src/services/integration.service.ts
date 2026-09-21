import { prisma } from '../lib/prisma';
import { PortalCallbackInput, KycCallbackInput, PaymentCallbackInput, PAYMENT_EVENT_TYPE, IntegrationMetricsQueryInput } from '../shared';
import { NotificationService } from './notification.service';
import { getISTComponents } from '../utils/time';

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000; // IST = UTC+5:30
const DAY_MS = 24 * 60 * 60 * 1000;


const p = prisma;

export class AppError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
    this.name = 'AppError';
  }
}

const IDEMPOTENCY_KEY_PREFIX = 'crms-evt-';

export class IntegrationService {
  /**
   * Processes a Portal → CRM callback.
   *
   * The callback is a lifecycle event (customer account provisioned/activated), NOT a
   * delivery acknowledgment. It updates BookingPortalMapping (customer handoff lifecycle)
   * and creates an audit event. It does NOT modify IntegrationEvent (delivery state).
   */
  static async processPortalCallback(dto: PortalCallbackInput) {
    const { company_id, crms_booking_id, status } = dto;

    // 1. Resolve the IntegrationEvent from the idempotency key
    const eventId = this.parseIdempotencyKey(dto.idempotency_key);
    const event = await p.integrationEvent.findUnique({ where: { id: eventId } });
    if (!event) {
      throw new AppError(404, 'Integration event not found');
    }
    if (event.company_id !== company_id) {
      throw new AppError(403, 'Company mismatch');
    }
    if (event.crms_booking_id !== crms_booking_id) {
      throw new AppError(409, 'Idempotency key does not match booking');
    }

    // 2. Resolve the booking (company-scoped)
    const booking = await p.booking.findFirst({
      where: { id: crms_booking_id, company_id },
    });
    if (!booking) {
      throw new AppError(404, 'Booking not found');
    }

    // 3. Resolve the handoff mapping
    const mapping = await p.bookingPortalMapping.findFirst({
      where: { crms_booking_id, company_id },
    });
    if (!mapping) {
      throw new AppError(404, 'Portal mapping not found');
    }

    // 4. Idempotency check — already ACTIVE is a successful no-op
    if (mapping.handoff_status === 'ACTIVE') {
      return { status: 'accepted', message: 'Already processed', duplicate: true };
    }

    // 5. Unexpected lifecycle states — worker has not delivered yet
    if (mapping.handoff_status === 'CREATED' || mapping.handoff_status === 'PROCESSING') {
      throw new AppError(409, `Unexpected handoff state: ${mapping.handoff_status}`);
    }
    if (mapping.handoff_status === 'FAILED') {
      throw new AppError(409, 'Handoff failed; callback cannot be processed');
    }

    // 6. Only WAITING_ACTIVATION → ACTIVE is the valid transition
    if (mapping.handoff_status !== 'WAITING_ACTIVATION') {
      throw new AppError(409, `Unexpected handoff state: ${mapping.handoff_status}`);
    }

    // 7. Apply the lifecycle transition. The mapping update, audit and the
    //    PORTAL_ACTIVATED customer notification (Packet 3E) are atomic — one
    //    genuine WAITING_ACTIVATION → ACTIVE transition yields exactly one
    //    notification. The conditional updateMany guards concurrency: a losing
    //    concurrent duplicate matches 0 rows and creates no notification.
    if (status === 'completed') {
      const outcome = await p.$transaction(async (tx: import('@prisma/client').Prisma.TransactionClient) => {
        const updated = await tx.bookingPortalMapping.updateMany({
          where: { id: mapping.id, handoff_status: 'WAITING_ACTIVATION' },
          data: {
            handoff_status: 'ACTIVE',
            portal_customer_id: dto.portal_customer_id ?? null,
            portal_booking_id: dto.portal_booking_id ?? null,
            last_sync_at: new Date(),
            error_message: null,
          },
        });

        if (updated.count !== 1) {
          return 'duplicate';
        }

        await tx.auditEvent.create({
          data: {
            actor_id: 0, // system action (no human actor)
            action: 'PORTAL_CALLBACK_RECEIVED',
            entity_type: 'Booking',
            entity_id: crms_booking_id,
            old_value: mapping.handoff_status,
            new_value: 'ACTIVE',
          },
        });

        await tx.customerNotification.create({
          data: {
            company_id,
            customer_id: booking.customer_id,
            booking_id: crms_booking_id,
            type: 'PORTAL_ACTIVATED',
            title: 'Customer Portal Activated',
            message: `Your Customer Portal is now active. Booking ${crms_booking_id} is live.`,
          },
        });

        return 'transitioned';
      });

      if (outcome === 'duplicate') {
        return { status: 'accepted', message: 'Already processed', duplicate: true };
      }

      return { status: 'accepted', message: 'Callback processed' };
    }

    // status === 'failed' — record the failure, keep lifecycle state for retry
    await p.bookingPortalMapping.update({
      where: { id: mapping.id },
      data: {
        error_message: dto.message || 'Portal reported activation failure',
        last_sync_at: new Date(),
      },
    });

    await p.auditEvent.create({
      data: {
        actor_id: 0, // system action (no human actor)
        action: 'PORTAL_CALLBACK_FAILED',
        entity_type: 'Booking',
        entity_id: crms_booking_id,
        old_value: mapping.handoff_status,
        new_value: mapping.handoff_status,
      },
    });

    return { status: 'accepted', message: 'Callback failure recorded' };
  }

  /**
   * Processes a Portal → CRM KYC submission callback (Phase 11 Packet 3D).
   *
   * This is the inbound half of the KYC bridge. The Portal may report ONLY
   * "submitted" — it may never claim "verified"/"rejected" (those are CRM-owned
   * verification outcomes, enforced at the schema boundary). The callback
   * references the outbound CUSTOMER_KYC_STATUS_CHANGED IntegrationEvent via its
   * idempotency key; it NEVER creates a new IntegrationEvent.
   *
   * It does NOT modify IntegrationEvent (delivery state) — it records the
   * submission on the Customer (kyc_submission_status = SUBMITTED) and audits it.
   */
  static async processKycCallback(dto: KycCallbackInput) {
    const { company_id, crms_customer_id } = dto;

    // 1. Resolve the IntegrationEvent from the idempotency key (format crms-evt-{id})
    const eventId = this.parseIdempotencyKey(dto.idempotency_key);
    const event = await p.integrationEvent.findUnique({ where: { id: eventId } });
    if (!event) {
      throw new AppError(404, 'Integration event not found');
    }

    // 2. The referenced event must actually BE the outbound KYC event the callback
    //    claims to be acking — a booking handoff (or any other) event must not be
    //    usable to mark a customer's KYC as SUBMITTED. Validate the PERSISTED
    //    event_type, not just the request DTO's.
    if (event.event_type !== 'CUSTOMER_KYC_STATUS_CHANGED') {
      throw new AppError(409, 'Idempotency key does not reference a KYC status event');
    }

    // 3. Company ownership — never trust dto.company_id by itself
    if (event.company_id !== company_id) {
      throw new AppError(403, 'Company mismatch');
    }

    // 4. The callback must reference the customer the event belongs to
    if (event.crms_customer_id !== crms_customer_id) {
      throw new AppError(409, 'Idempotency key does not match customer');
    }

    // 5. Resolve the customer (tenant-scoped — id AND company_id)
    const customer = await p.customer.findFirst({
      where: { id: crms_customer_id, company_id },
    });
    if (!customer) {
      throw new AppError(404, 'Customer not found');
    }

    // 6. Atomic, concurrency-safe state transition. The conditional updateMany guards
    //    on kyc_submission_status = null, so two simultaneous callbacks for the same
    //    customer can never both transition: only the winner matches count === 1 and
    //    only the winner creates the KYC_CALLBACK_SUBMITTED audit (same transaction).
    //    A duplicate (already SUBMITTED) callback matches 0 rows and short-circuits
    //    without any write or audit.
    const outcome = await p.$transaction(async (tx: import('@prisma/client').Prisma.TransactionClient) => {
      const updated = await tx.customer.updateMany({
        where: { id: customer.id, kyc_submission_status: null },
        data: {
          kyc_submission_status: 'SUBMITTED',
          kyc_submitted_at: new Date(),
        },
      });

      if (updated.count !== 1) {
        return 'duplicate';
      }

      await tx.auditEvent.create({
        data: {
          actor_id: 0, // system action (no human actor)
          action: 'KYC_CALLBACK_SUBMITTED',
          entity_type: 'Customer',
          entity_id: customer.id,
          old_value: 'NONE',
          new_value: 'SUBMITTED',
        },
      });

      return 'transitioned';
    });

    if (outcome === 'duplicate') {
      // Confirm the row still exists and actually is SUBMITTED; fail closed otherwise.
      const latest = await p.customer.findUnique({ where: { id: customer.id } });
      if (!latest) {
        throw new AppError(404, 'Customer not found');
      }
      if (latest.kyc_submission_status !== 'SUBMITTED') {
        throw new AppError(500, 'KYC submission state inconsistent');
      }
      return { status: 'accepted', message: 'Already processed', duplicate: true };
    }

    return { status: 'accepted' };
  }

  /**
   * Processes a Portal → CRM payment callback (Phase 11 Packet 3F).
   *
   * The Portal may report ONLY "completed" / "failed" — it may never claim
   * SUCCESS/REFUNDED (those are CRM-owned verification outcomes). The callback
   * references the outbound PAYMENT_STATUS_CHANGED IntegrationEvent via its
   * idempotency key; it NEVER creates a new IntegrationEvent and NEVER modifies
   * IntegrationEvent delivery state (worker-owned). Its only CRM-side effect is
   * marking the payment's sync delivery as SYNCED (+ recording the Portal's
   * payment reference) or recording a delivery failure — the payment's own
   * financial status is never touched by the Portal.
   */
  static async processPaymentCallback(dto: PaymentCallbackInput) {
    const { company_id, crms_customer_id, crms_booking_id, payment_id } = dto;

    // 1. Resolve the IntegrationEvent from the idempotency key (format crms-evt-{id})
    const eventId = this.parseIdempotencyKey(dto.idempotency_key);
    const event = await p.integrationEvent.findUnique({ where: { id: eventId } });
    if (!event) {
      throw new AppError(404, 'Integration event not found');
    }

    // 2. The referenced event must actually BE the outbound payment event the
    //    callback claims to be acking — a handoff or KYC event must not be usable
    //    to mark a payment as synced. Validate the PERSISTED event_type.
    if (event.event_type !== PAYMENT_EVENT_TYPE) {
      throw new AppError(409, 'Idempotency key does not reference a payment status event');
    }

    // 3. Company ownership — never trust dto.company_id by itself
    if (event.company_id !== company_id) {
      throw new AppError(403, 'Company mismatch');
    }

    // 4. The callback must reference the customer the event belongs to
    if (event.crms_customer_id !== crms_customer_id) {
      throw new AppError(409, 'Idempotency key does not match customer');
    }

    // 5. The callback must reference the booking the event belongs to
    if (event.crms_booking_id !== crms_booking_id) {
      throw new AppError(409, 'Idempotency key does not match booking');
    }

    // 6. Resolve the payment (tenant-scoped — id AND company_id)
    const payment = await p.payment.findFirst({
      where: { id: payment_id, company_id },
    });
    if (!payment) {
      throw new AppError(404, 'Payment not found');
    }

    // status === 'failed' — record the delivery failure only. The payment's own
    // financial status and sync_status are untouched (worker will retry).
    if (dto.status === 'failed') {
      await p.auditEvent.create({
        data: {
          actor_id: 0, // system action (no human actor)
          action: 'PAYMENT_CALLBACK_FAILED',
          entity_type: 'Payment',
          entity_id: payment_id,
          old_value: 'PENDING_SYNC',
          new_value: 'PENDING_SYNC',
        },
      });
      return { status: 'accepted', message: 'Callback failure recorded' };
    }

    // status === 'completed' — mark the delivery as SYNCED. The conditional
    // updateMany guards on sync_status = 'PENDING_SYNC', so two simultaneous
    // callbacks for the same payment can never both transition: only the winner
    // matches count === 1 and only the winner creates the audit (same transaction).
    // A duplicate (already SYNCED) callback matches 0 rows and short-circuits
    // without any write or audit.
    const outcome = await p.$transaction(async (tx: import('@prisma/client').Prisma.TransactionClient) => {
      const updated = await tx.payment.updateMany({
        where: { id: payment.id, sync_status: 'PENDING_SYNC' },
        data: {
          sync_status: 'SYNCED',
          portal_payment_id: dto.portal_payment_id ?? payment.portal_payment_id,
        },
      });

      if (updated.count !== 1) {
        return 'duplicate';
      }

      await tx.auditEvent.create({
        data: {
          actor_id: 0, // system action (no human actor)
          action: 'PAYMENT_CALLBACK_RECEIVED',
          entity_type: 'Payment',
          entity_id: payment_id,
          old_value: 'PENDING_SYNC',
          new_value: 'SYNCED',
        },
      });

      return 'transitioned';
    });

    if (outcome === 'duplicate') {
      // Confirm the row still exists and actually is SYNCED; fail closed otherwise.
      const latest = await p.payment.findUnique({ where: { id: payment_id } });
      if (!latest) {
        throw new AppError(404, 'Payment not found');
      }
      if (latest.sync_status !== 'SYNCED') {
        throw new AppError(500, 'Payment sync state inconsistent');
      }
      return { status: 'accepted', message: 'Already processed', duplicate: true };
    }

    return { status: 'accepted' };
  }

  private static parseIdempotencyKey(key: string): number {
    if (!key.startsWith(IDEMPOTENCY_KEY_PREFIX)) {
      throw new AppError(400, 'Invalid idempotency key format');
    }
    const id = parseInt(key.substring(IDEMPOTENCY_KEY_PREFIX.length), 10);
    if (isNaN(id) || id <= 0) {
      throw new AppError(400, 'Invalid idempotency key format');
    }
    return id;
  }

  // ─────────────────────────────────────────────────────────
  // PORTAL / INTEGRATION METRICS — Phase 11 Packet 3G
  // ─────────────────────────────────────────────────────────

  private static readonly HANDOFF_STATUSES = ['CREATED', 'PENDING', 'PROCESSING', 'COMPLETED', 'WAITING_ACTIVATION', 'ACTIVE', 'FAILED'];
  private static readonly EVENT_STATUSES = ['CREATED', 'PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'];
  private static readonly EVENT_TYPES = ['BOOKING_PORTAL_HANDOFF', 'CUSTOMER_KYC_STATUS_CHANGED', 'PAYMENT_STATUS_CHANGED'];
  private static readonly SYNC_STATUSES = ['LOCAL', 'PENDING_SYNC', 'SYNCED'];
  private static readonly SOURCES = ['CRM', 'PORTAL'];
  private static readonly KYC_STATUSES = ['PENDING', 'PARTIAL', 'VERIFIED', 'REJECTED'];
  private static readonly NOTIFICATION_TYPES = ['PORTAL_ACTIVATED', 'KYC_STATUS_UPDATED', 'PAYMENT_STATUS_UPDATED'];

  /**
   * Converts an IST calendar date (YYYY-MM-DD) to the UTC instant of IST
   * midnight. IST is UTC+5:30, so IST midnight of `date` is UTC 18:30 of the
   * previous day. Never relies on the server's local timezone.
   */
  private static istMidnightUtc(dateStr: string): Date {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - IST_OFFSET_MS);
  }

  /**
   * Builds a UTC created_at filter from an IST date range (YYYY-MM-DD, both
   * inclusive). Returns an empty object when no range is supplied.
   */
  private static istDateRangeFilter(from?: string, to?: string): { created_at?: { gte?: Date; lt?: Date } } {
    const range: { gte?: Date; lt?: Date } = {};
    if (from) range.gte = this.istMidnightUtc(from);
    if (to) range.lt = new Date(this.istMidnightUtc(to).getTime() + DAY_MS);
    return Object.keys(range).length ? { created_at: range } : {};
  }

  /**
   * Groups Prisma groupBy rows into an object with every known status key
   * present (absent rows default to 0) — deterministic across callers.
   */
  private static normalizeCounts<T extends string>(known: readonly T[], groups: any[], key: string): Record<string, number> {
    const counts: Record<string, number> = Object.fromEntries(known.map((k) => [k, 0]));
    for (const g of groups) {
      const value = g[key];
      if (value !== null && value !== undefined && Object.prototype.hasOwnProperty.call(counts, value)) {
        counts[value] = g._count._all;
      }
    }
    return counts;
  }

  /**
   * GET /api/v1/integration/metrics — read-only portal/integration metrics.
   *
   * Pure Option-A aggregations over existing transactional/event data. Company
   * isolation is enforced on every query via `company_id`. Returns aggregates
   * ONLY — no raw IntegrationEvent payloads, PAN/Aadhaar, bank data, or secrets
   * ever cross this boundary (3A–3G sensitive-data policy).
   */
  static async getPortalMetrics(companyId: number, query: IntegrationMetricsQueryInput = {}) {
    const { from, to, includeTimeseries } = query;
    const wantTimeseries = includeTimeseries === 'true';

    if (wantTimeseries && (!from || !to)) {
      throw new AppError(400, 'from and to (YYYY-MM-DD, IST) are required when includeTimeseries=true');
    }
    if (from && to && from > to) {
      throw new AppError(400, 'from must not be later than to');
    }

    const baseWhere: any = { company_id: companyId };
    const dateFilter = this.istDateRangeFilter(from, to);
    const where = { ...baseWhere, ...dateFilter };

    const [
      handoffTotal,
      handoffGroups,
      eventTotal,
      eventTypeGroups,
      eventStatusGroups,
      retriedCount,
      terminalFailureCount,
      paymentTotal,
      paymentSyncGroups,
      paymentSourceGroups,
      customerTotal,
      customerKycGroups,
      kycSubmissions,
      notificationTotal,
      notificationTypeGroups,
    ] = await Promise.all([
      p.bookingPortalMapping.count({ where }),
      p.bookingPortalMapping.groupBy({ by: ['handoff_status'], where, _count: { _all: true } }),
      p.integrationEvent.count({ where }),
      p.integrationEvent.groupBy({ by: ['event_type'], where, _count: { _all: true } }),
      p.integrationEvent.groupBy({ by: ['status'], where, _count: { _all: true } }),
      p.integrationEvent.count({ where: { ...where, retry_count: { gt: 0 } } }),
      p.integrationEvent.count({ where: { ...where, status: 'FAILED' } }),
      p.payment.count({ where }),
      p.payment.groupBy({ by: ['sync_status'], where, _count: { _all: true } }),
      p.payment.groupBy({ by: ['source'], where, _count: { _all: true } }),
      p.customer.count({ where }),
      p.customer.groupBy({ by: ['kyc_status'], where, _count: { _all: true } }),
      p.customer.count({ where: { ...where, kyc_submission_status: 'SUBMITTED' } }),
      p.customerNotification.count({ where }),
      p.customerNotification.groupBy({ by: ['type'], where, _count: { _all: true } }),
    ]);

    const handoffByStatus = this.normalizeCounts(this.HANDOFF_STATUSES, handoffGroups, 'handoff_status');
    const eventByType = this.normalizeCounts(this.EVENT_TYPES, eventTypeGroups, 'event_type');
    const eventByStatus = this.normalizeCounts(this.EVENT_STATUSES, eventStatusGroups, 'status');
    const paymentBySyncStatus = this.normalizeCounts(this.SYNC_STATUSES, paymentSyncGroups, 'sync_status');
    const paymentBySource = this.normalizeCounts(this.SOURCES, paymentSourceGroups, 'source');

    const kycByStatus = this.normalizeCounts(this.KYC_STATUSES, customerKycGroups, 'kyc_status');
    if (kycByStatus['UNKNOWN'] === undefined) {
      kycByStatus['UNKNOWN'] = 0;
    }
    for (const g of customerKycGroups) {
      if (g.kyc_status === null) {
        kycByStatus['UNKNOWN'] = (kycByStatus['UNKNOWN'] || 0) + g._count._all;
      }
    }

    const notificationByType = this.normalizeCounts(this.NOTIFICATION_TYPES, notificationTypeGroups, 'type');

    const activationRate = handoffTotal > 0
      ? Number((((handoffByStatus['ACTIVE'] || 0) / handoffTotal) * 100).toFixed(2))
      : null;

    const response: any = {
      generated_at: new Date().toISOString(),
      company_id: companyId,
      range: { from: from || null, to: to || null },
      handoffs: {
        total: handoffTotal,
        byStatus: handoffByStatus,
        activationRate,
      },
      outbox: {
        total: eventTotal,
        byEventType: eventByType,
        byStatus: eventByStatus,
        retried: retriedCount,
        terminalFailures: terminalFailureCount,
      },
      payments: {
        total: paymentTotal,
        bySyncStatus: paymentBySyncStatus,
        bySource: paymentBySource,
      },
      kyc: {
        total: customerTotal,
        byStatus: kycByStatus,
        submissions: kycSubmissions,
      },
      notifications: {
        total: notificationTotal,
        byType: notificationByType,
      },
    };

    if (wantTimeseries && from && to) {
      response.timeseries = await this.buildMetricsTimeseries(companyId, from, to);
    }

    return response;
  }

  /**
   * Builds daily IST buckets for all five metric domains within the IST range.
   * Rows are fetched with the existing created_at index and bucketed in-memory
   * by IST day via getISTComponents — no DB timezone conversion required.
   */
  private static async buildMetricsTimeseries(companyId: number, from: string, to: string) {
    const where: any = { company_id: companyId, ...this.istDateRangeFilter(from, to) };

    const [events, handoffs, payments, customers, notifications] = await Promise.all([
      p.integrationEvent.findMany({ where, select: { created_at: true, event_type: true, status: true } }),
      p.bookingPortalMapping.findMany({ where, select: { created_at: true, handoff_status: true } }),
      p.payment.findMany({ where, select: { created_at: true, sync_status: true, source: true } }),
      p.customer.findMany({ where, select: { created_at: true, kyc_status: true, kyc_submission_status: true } }),
      p.customerNotification.findMany({ where, select: { created_at: true, type: true } }),
    ]);

    const days = new Map<string, any>();

    const dayKey = (date: Date) => getISTComponents(date).dateString;

    const ensureDay = (date: Date) => {
      const key = dayKey(date);
      if (!days.has(key)) {
        days.set(key, {
          date: key,
          handoffs: Object.fromEntries(this.HANDOFF_STATUSES.map((s) => [s, 0])),
          outbox: Object.fromEntries(this.EVENT_STATUSES.map((s) => [s, 0])),
          payments: { ...Object.fromEntries(this.SYNC_STATUSES.map((s) => [s, 0])), ...Object.fromEntries(this.SOURCES.map((s) => [s, 0])) },
          kyc: Object.fromEntries(this.KYC_STATUSES.map((s) => [s, 0])),
          notifications: Object.fromEntries(this.NOTIFICATION_TYPES.map((t) => [t, 0])),
        });
      }
      return days.get(key);
    };

    for (const e of events) {
      const day = ensureDay(e.created_at);
      day.outbox[e.status] += 1;
      day[`outboxType_${e.event_type}`] = (day[`outboxType_${e.event_type}`] || 0) + 1;
    }
    for (const h of handoffs) {
      ensureDay(h.created_at).handoffs[h.handoff_status] += 1;
    }
    for (const pay of payments) {
      const day = ensureDay(pay.created_at);
      day.payments[pay.sync_status] += 1;
      day.payments[pay.source] += 1;
    }
    for (const c of customers) {
      const day = ensureDay(c.created_at);
      day.kyc[c.kyc_status || 'UNKNOWN'] = (day.kyc[c.kyc_status || 'UNKNOWN'] || 0) + 1;
      if (c.kyc_submission_status === 'SUBMITTED') {
        day.kyc['SUBMITTED'] = (day.kyc['SUBMITTED'] || 0) + 1;
      }
    }
    for (const n of notifications) {
      ensureDay(n.created_at).notifications[n.type] += 1;
    }

    return { days: Array.from(days.values()).sort((a, b) => a.date.localeCompare(b.date)) };
  }
}