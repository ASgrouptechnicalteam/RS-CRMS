import { logger } from '../utils/logger';
import { prisma } from '../lib/prisma';
import { PortalClient } from './portalClient';
import { KYC_EVENT_TYPE } from './kyc.service';
import { PAYMENT_EVENT_TYPE, INSTALLMENT_EVENT_TYPE } from '../shared';


const p = prisma;

const POLL_INTERVAL_MS = parseInt(process.env.PORTAL_POLL_INTERVAL_MS || '30000', 10);

/**
 * Background worker for the CRM → Portal outbox.
 *
 * - DISABLED by default (PORTAL_WORKER_ENABLED=false). The Portal does not exist yet.
 * - Processes ONE IntegrationEvent at a time (max concurrency = 1).
 * - Claims events atomically (UPDATE ... WHERE status='CREATED') to prevent double-processing.
 * - Type-aware (Phase 11 Packet 3C): dispatches by event_type —
 *   BOOKING_PORTAL_HANDOFF → /api/v1/portal/handoff (updates BookingPortalMapping),
 *   CUSTOMER_KYC_STATUS_CHANGED → /api/v1/portal/kyc-status (no mapping).
 */
export class PortalWorker {
  private static running = false;
  private static timer: NodeJS.Timeout | null = null;

  static start() {
    if (process.env.PORTAL_WORKER_ENABLED !== 'true') {
      return;
    }
    if (this.running) {
      return;
    }
    this.running = true;
    logger.info('[portal-worker]: started (poll interval: ' + POLL_INTERVAL_MS + 'ms)');
    this.loop();
  }

  static stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.info('[portal-worker]: stopped');
  }

  private static async loop() {
    while (this.running) {
      try {
        await this.processNextEvent();
      } catch (err: any) {
        // Never crash the loop; log and continue
        logger.error('[portal-worker]: unexpected error:', err?.message || err);
      }
      await this.delay(POLL_INTERVAL_MS);
    }
  }

  private static delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.timer = setTimeout(resolve, ms);
    });
  }

  /**
   * Claims and processes a single IntegrationEvent. Returns true if an event was processed.
   * Dispatches by event_type (Phase 11 Packet 3C).
   */
  static async processNextEvent(): Promise<boolean> {
    // 1. Find next eligible event
    const event = await p.integrationEvent.findFirst({
      where: { status: 'CREATED' },
      orderBy: { created_at: 'asc' },
    });

    if (!event) {
      return false;
    }

    // 2. Atomic claim — increment retry_count and set PROCESSING in one step
    const claim = await p.integrationEvent.updateMany({
      where: { id: event.id, status: 'CREATED' },
      data: {
        status: 'PROCESSING',
        retry_count: { increment: 1 },
      },
    });

    if (claim.count === 0) {
      // Another worker claimed it first
      return false;
    }

    // 3. Type-aware dispatch — payment sync, installment sync, KYC events vs booking handoff events
    if (event.event_type === PAYMENT_EVENT_TYPE) {
      return await this.processPaymentStatusEvent(event);
    }
    if (event.event_type === INSTALLMENT_EVENT_TYPE) {
      return await this.processInstallmentStatusEvent(event);
    }
    if (event.event_type === KYC_EVENT_TYPE) {
      return await this.processKycStatusEvent(event);
    }
    return await this.processHandoffEvent(event);
  }

  private static async processHandoffEvent(event: any): Promise<boolean> {
    // PORTAL_HANDOFF_INITIATED — audit the successful claim
    await p.auditEvent.create({
      data: {
        actor_id: 0, // system action (no human actor)
        action: 'PORTAL_HANDOFF_INITIATED',
        entity_type: 'Booking',
        entity_id: event.crms_booking_id,
        old_value: 'CREATED',
        new_value: 'PROCESSING',
      },
    });

    // 3. Deserialize payload
    let payload: any;
    try {
      payload = JSON.parse(event.payload);
    } catch {
      payload = {};
    }

    const idempotencyKey = `crms-evt-${event.id}`;
    const attempt = event.retry_count + 1;

    // 4. Make the outbound API call
    let response: { statusCode: number; body: any };
    try {
      response = await PortalClient.sendHandoff(payload, idempotencyKey);
    } catch (err: any) {
      // Network error / timeout — retryable
      await this.handleRetryableFailure(event, attempt, err?.message || 'Network error');
      return true;
    }

    const { statusCode, body } = response;

    // 5. Handle response per failure semantics
    if (statusCode === 200 && body && body.status === 'accepted') {
      await this.handleSuccess(event, body);
      return true;
    }

    if (statusCode === 200 && body && body.status === 'error' && body.code && body.code.startsWith('DUPLICATE_')) {
      // Portal already has the data — treat as already delivered
      await this.handleSuccess(event, body);
      return true;
    }

    if (statusCode === 200 && body && body.status === 'error') {
      // Explicit portal rejection — mark FAILED (terminal), no retry
      await this.handleTerminalFailure(event, body.message || `Portal rejected handoff: ${body.code || 'UNKNOWN'}`);
      return true;
    }

    if (statusCode >= 500 || statusCode === 429) {
      // Server error / rate limited — retryable
      await this.handleRetryableFailure(event, attempt, `Portal error: HTTP ${statusCode}`);
      return true;
    }

    // 4xx — non-retryable
    await this.handleTerminalFailure(event, `Portal error: HTTP ${statusCode}`);
    return true;
  }

  private static async processKycStatusEvent(event: any): Promise<boolean> {
    // KYC_STATUS_NOTIFY_INITIATED — audit the successful claim
    await p.auditEvent.create({
      data: {
        actor_id: 0, // system action (no human actor)
        action: 'KYC_STATUS_NOTIFY_INITIATED',
        entity_type: 'Customer',
        entity_id: event.crms_customer_id,
        old_value: 'CREATED',
        new_value: 'PROCESSING',
      },
    });

    let payload: any;
    try {
      payload = JSON.parse(event.payload);
    } catch {
      payload = {};
    }

    const idempotencyKey = `crms-evt-${event.id}`;
    const attempt = event.retry_count + 1;

    let response: { statusCode: number; body: any };
    try {
      response = await PortalClient.sendKycStatus(payload, idempotencyKey);
    } catch (err: any) {
      // Network error / timeout — retryable
      await this.handleKycRetryableFailure(event, attempt, err?.message || 'Network error');
      return true;
    }

    const { statusCode, body } = response;

    if (statusCode === 200 && body && body.status === 'accepted') {
      await this.handleKycSuccess(event, body);
      return true;
    }

    if (statusCode === 200 && body && body.status === 'error' && body.code && body.code.startsWith('DUPLICATE_')) {
      // Portal already has the KYC status — treat as delivered (idempotent)
      await this.handleKycSuccess(event, body);
      return true;
    }

    if (statusCode === 200 && body && body.status === 'error') {
      // Explicit portal rejection — terminal, no retry
      await this.handleKycTerminalFailure(event, body.message || `Portal rejected KYC status: ${body.code || 'UNKNOWN'}`);
      return true;
    }

    if (statusCode >= 500 || statusCode === 429) {
      // Server error / rate limited — retryable
      await this.handleKycRetryableFailure(event, attempt, `Portal error: HTTP ${statusCode}`);
      return true;
    }

    // 4xx — non-retryable
    await this.handleKycTerminalFailure(event, `Portal error: HTTP ${statusCode}`);
    return true;
  }

  private static async processPaymentStatusEvent(event: any): Promise<boolean> {
    let payload: any;
    try {
      payload = JSON.parse(event.payload);
    } catch {
      payload = {};
    }

    const paymentId = payload.payment_id ?? event.id;

    // PAYMENT_SYNC_INITIATED — audit the successful claim
    await p.auditEvent.create({
      data: {
        actor_id: 0, // system action (no human actor)
        action: 'PAYMENT_SYNC_INITIATED',
        entity_type: 'Payment',
        entity_id: paymentId,
        old_value: 'CREATED',
        new_value: 'PROCESSING',
      },
    });

    const idempotencyKey = `crms-evt-${event.id}`;
    const attempt = event.retry_count + 1;

    let response: { statusCode: number; body: any };
    try {
      response = await PortalClient.sendPaymentStatus(payload, idempotencyKey);
    } catch (err: any) {
      // Network error / timeout — retryable
      await this.handlePaymentRetryableFailure(event, attempt, err?.message || 'Network error');
      return true;
    }

    const { statusCode, body } = response;

    if (statusCode === 200 && body && body.status === 'accepted') {
      await this.handlePaymentSuccess(event, body);
      return true;
    }

    if (statusCode === 200 && body && body.status === 'error' && body.code && body.code.startsWith('DUPLICATE_')) {
      // Portal already has the payment status — treat as delivered (idempotent)
      await this.handlePaymentSuccess(event, body);
      return true;
    }

    if (statusCode === 200 && body && body.status === 'error') {
      // Explicit portal rejection — terminal, no retry
      await this.handlePaymentTerminalFailure(event, body.message || `Portal rejected payment status: ${body.code || 'UNKNOWN'}`);
      return true;
    }

    if (statusCode >= 500 || statusCode === 429) {
      // Server error / rate limited — retryable
      await this.handlePaymentRetryableFailure(event, attempt, `Portal error: HTTP ${statusCode}`);
      return true;
    }

    // 4xx — non-retryable
    await this.handlePaymentTerminalFailure(event, `Portal error: HTTP ${statusCode}`);
    return true;
  }

  private static async handlePaymentSuccess(event: any, body: any) {
    let payload: any;
    try {
      payload = JSON.parse(event.payload);
    } catch {
      payload = {};
    }
    const paymentId = payload.payment_id ?? event.id;

    await p.integrationEvent.update({
      where: { id: event.id },
      data: {
        status: 'COMPLETED',
        processed_at: new Date(),
        error_message: null,
      },
    });

    await p.auditEvent.create({
      data: {
        actor_id: 0, // system action (no human actor)
        action: 'PAYMENT_SYNC_COMPLETED',
        entity_type: 'Payment',
        entity_id: paymentId,
        old_value: 'PROCESSING',
        new_value: 'COMPLETED',
      },
    });
  }

  private static async handlePaymentRetryableFailure(event: any, attempt: number, error: string) {
    let payload: any;
    try {
      payload = JSON.parse(event.payload);
    } catch {
      payload = {};
    }
    const paymentId = payload.payment_id ?? event.id;

    await p.integrationEvent.update({
      where: { id: event.id },
      data: { error_message: error },
    });

    // PAYMENT_SYNC_FAILED — audit every failed payment sync attempt
    await p.auditEvent.create({
      data: {
        actor_id: 0, // system action (no human actor)
        action: 'PAYMENT_SYNC_FAILED',
        entity_type: 'Payment',
        entity_id: paymentId,
        old_value: `attempt ${attempt}`,
        new_value: error,
      },
    });

    if (attempt >= event.max_retries) {
      await this.handlePaymentTerminalFailure(event, `Max retries exceeded: ${error}`);
      return;
    }

    // Reset to CREATED for the next retry cycle. Payment events have no mapping to mutate.
    await p.integrationEvent.update({
      where: { id: event.id },
      data: { status: 'CREATED' },
    });
  }

  private static async handlePaymentTerminalFailure(event: any, error: string) {
    let payload: any;
    try {
      payload = JSON.parse(event.payload);
    } catch {
      payload = {};
    }
    const paymentId = payload.payment_id ?? event.id;

    await p.integrationEvent.update({
      where: { id: event.id },
      data: {
        status: 'FAILED',
        error_message: error,
      },
    });

    await p.auditEvent.create({
      data: {
        actor_id: 0, // system action (no human actor)
        action: 'PAYMENT_SYNC_TERMINAL_FAILURE',
        entity_type: 'Payment',
        entity_id: paymentId,
        old_value: 'PROCESSING',
        new_value: 'FAILED',
      },
    });
  }

  // ─────────────────────────────────────────────────────────────
  // INSTALLMENT STATUS SYNC — Phase 11 Packet 3H
  // ─────────────────────────────────────────────────────────────

  private static async processInstallmentStatusEvent(event: any): Promise<boolean> {
    let payload: any;
    try {
      payload = JSON.parse(event.payload);
    } catch {
      payload = {};
    }

    const installmentId = payload.installment_id ?? event.id;

    // INSTALLMENT_SYNC_INITIATED — audit the successful claim
    await p.auditEvent.create({
      data: {
        actor_id: 0, // system action (no human actor)
        action: 'INSTALLMENT_SYNC_INITIATED',
        entity_type: 'Installment',
        entity_id: installmentId,
        old_value: 'CREATED',
        new_value: 'PROCESSING',
      },
    });

    const idempotencyKey = `crms-evt-${event.id}`;
    const attempt = event.retry_count + 1;

    let response: { statusCode: number; body: any };
    try {
      response = await PortalClient.sendInstallmentStatus(payload, idempotencyKey);
    } catch (err: any) {
      // Network error / timeout — retryable
      await this.handleInstallmentRetryableFailure(event, attempt, err?.message || 'Network error');
      return true;
    }

    const { statusCode, body } = response;

    if (statusCode === 200 && body && body.status === 'accepted') {
      await this.handleInstallmentSuccess(event, body);
      return true;
    }

    if (statusCode === 200 && body && body.status === 'error' && body.code && body.code.startsWith('DUPLICATE_')) {
      // Portal already has the installment status — treat as delivered (idempotent)
      await this.handleInstallmentSuccess(event, body);
      return true;
    }

    if (statusCode === 200 && body && body.status === 'error') {
      // Explicit portal rejection — terminal, no retry
      await this.handleInstallmentTerminalFailure(event, body.message || `Portal rejected installment status: ${body.code || 'UNKNOWN'}`);
      return true;
    }

    if (statusCode >= 500 || statusCode === 429) {
      // Server error / rate limited — retryable
      await this.handleInstallmentRetryableFailure(event, attempt, `Portal error: HTTP ${statusCode}`);
      return true;
    }

    // 4xx — non-retryable
    await this.handleInstallmentTerminalFailure(event, `Portal error: HTTP ${statusCode}`);
    return true;
  }

  private static async handleInstallmentSuccess(event: any, body: any) {
    let payload: any;
    try {
      payload = JSON.parse(event.payload);
    } catch {
      payload = {};
    }
    const installmentId = payload.installment_id ?? event.id;

    await p.integrationEvent.update({
      where: { id: event.id },
      data: {
        status: 'COMPLETED',
        processed_at: new Date(),
        error_message: null,
      },
    });

    await p.auditEvent.create({
      data: {
        actor_id: 0, // system action (no human actor)
        action: 'INSTALLMENT_SYNC_COMPLETED',
        entity_type: 'Installment',
        entity_id: installmentId,
        old_value: 'PROCESSING',
        new_value: 'COMPLETED',
      },
    });
  }

  private static async handleInstallmentRetryableFailure(event: any, attempt: number, error: string) {
    let payload: any;
    try {
      payload = JSON.parse(event.payload);
    } catch {
      payload = {};
    }
    const installmentId = payload.installment_id ?? event.id;

    await p.integrationEvent.update({
      where: { id: event.id },
      data: { error_message: error },
    });

    // INSTALLMENT_SYNC_FAILED — audit every failed installment sync attempt
    await p.auditEvent.create({
      data: {
        actor_id: 0, // system action (no human actor)
        action: 'INSTALLMENT_SYNC_FAILED',
        entity_type: 'Installment',
        entity_id: installmentId,
        old_value: `attempt ${attempt}`,
        new_value: error,
      },
    });

    if (attempt >= event.max_retries) {
      await this.handleInstallmentTerminalFailure(event, `Max retries exceeded: ${error}`);
      return;
    }

    // Reset to CREATED for the next retry cycle. Installment events have no mapping to mutate.
    await p.integrationEvent.update({
      where: { id: event.id },
      data: { status: 'CREATED' },
    });
  }

  private static async handleInstallmentTerminalFailure(event: any, error: string) {
    let payload: any;
    try {
      payload = JSON.parse(event.payload);
    } catch {
      payload = {};
    }
    const installmentId = payload.installment_id ?? event.id;

    await p.integrationEvent.update({
      where: { id: event.id },
      data: {
        status: 'FAILED',
        error_message: error,
      },
    });

    await p.auditEvent.create({
      data: {
        actor_id: 0, // system action (no human actor)
        action: 'INSTALLMENT_SYNC_TERMINAL_FAILURE',
        entity_type: 'Installment',
        entity_id: installmentId,
        old_value: 'PROCESSING',
        new_value: 'FAILED',
      },
    });
  }

  private static async handleSuccess(event: any, body: any) {
    await p.integrationEvent.update({
      where: { id: event.id },
      data: {
        status: 'COMPLETED',
        processed_at: new Date(),
        error_message: null,
      },
    });

    await p.bookingPortalMapping.updateMany({
      where: { crms_booking_id: event.crms_booking_id, company_id: event.company_id },
      data: {
        handoff_status: 'WAITING_ACTIVATION',
        portal_customer_id: body.portal_customer_id ?? null,
        portal_booking_id: body.portal_booking_id ?? null,
        last_sync_at: new Date(),
        error_message: null,
      },
    });

    await p.auditEvent.create({
      data: {
        actor_id: 0, // system action (no human actor)
        action: 'PORTAL_HANDOFF_COMPLETED',
        entity_type: 'Booking',
        entity_id: event.crms_booking_id,
        old_value: 'PROCESSING',
        new_value: 'COMPLETED',
      },
    });
  }

  private static async handleRetryableFailure(event: any, attempt: number, error: string) {
    await p.integrationEvent.update({
      where: { id: event.id },
      data: { error_message: error },
    });

    // PORTAL_HANDOFF_FAILED — audit every failed Portal API attempt
    await p.auditEvent.create({
      data: {
        actor_id: 0, // system action (no human actor)
        action: 'PORTAL_HANDOFF_FAILED',
        entity_type: 'Booking',
        entity_id: event.crms_booking_id,
        old_value: `attempt ${attempt}`,
        new_value: error,
      },
    });

    if (attempt >= event.max_retries) {
      await this.handleTerminalFailure(event, `Max retries exceeded: ${error}`);
      return;
    }

    // Reset to CREATED for the next retry cycle.
    // BookingPortalMapping.handoff_status is intentionally left unchanged on
    // retryable failures — only the terminal path may set it to FAILED.
    await p.integrationEvent.update({
      where: { id: event.id },
      data: { status: 'CREATED' },
    });
  }

  private static async handleKycSuccess(event: any, body: any) {
    await p.integrationEvent.update({
      where: { id: event.id },
      data: {
        status: 'COMPLETED',
        processed_at: new Date(),
        error_message: null,
      },
    });

    await p.auditEvent.create({
      data: {
        actor_id: 0, // system action (no human actor)
        action: 'KYC_STATUS_NOTIFY_COMPLETED',
        entity_type: 'Customer',
        entity_id: event.crms_customer_id,
        old_value: 'PROCESSING',
        new_value: 'COMPLETED',
      },
    });
  }

  private static async handleKycRetryableFailure(event: any, attempt: number, error: string) {
    await p.integrationEvent.update({
      where: { id: event.id },
      data: { error_message: error },
    });

    // KYC_STATUS_NOTIFY_FAILED — audit every failed KYC push attempt
    await p.auditEvent.create({
      data: {
        actor_id: 0, // system action (no human actor)
        action: 'KYC_STATUS_NOTIFY_FAILED',
        entity_type: 'Customer',
        entity_id: event.crms_customer_id,
        old_value: `attempt ${attempt}`,
        new_value: error,
      },
    });

    if (attempt >= event.max_retries) {
      await this.handleKycTerminalFailure(event, `Max retries exceeded: ${error}`);
      return;
    }

    // Reset to CREATED for the next retry cycle. KYC events have no mapping to mutate.
    await p.integrationEvent.update({
      where: { id: event.id },
      data: { status: 'CREATED' },
    });
  }

  private static async handleKycTerminalFailure(event: any, error: string) {
    await p.integrationEvent.update({
      where: { id: event.id },
      data: {
        status: 'FAILED',
        error_message: error,
      },
    });

    await p.auditEvent.create({
      data: {
        actor_id: 0, // system action (no human actor)
        action: 'KYC_STATUS_NOTIFY_TERMINAL_FAILURE',
        entity_type: 'Customer',
        entity_id: event.crms_customer_id,
        old_value: 'PROCESSING',
        new_value: 'FAILED',
      },
    });
  }

  private static async handleTerminalFailure(event: any, error: string) {
    await p.integrationEvent.update({
      where: { id: event.id },
      data: {
        status: 'FAILED',
        error_message: error,
      },
    });

    await p.bookingPortalMapping.updateMany({
      where: { crms_booking_id: event.crms_booking_id, company_id: event.company_id },
      data: {
        handoff_status: 'FAILED',
        error_message: error,
      },
    });

    await p.auditEvent.create({
      data: {
        actor_id: 0, // system action (no human actor)
        action: 'PORTAL_HANDOFF_TERMINAL_FAILURE',
        entity_type: 'Booking',
        entity_id: event.crms_booking_id,
        old_value: 'PROCESSING',
        new_value: 'FAILED',
      },
    });
  }
}