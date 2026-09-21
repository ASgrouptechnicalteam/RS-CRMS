/**
 * Phase 17-A — Redaction boundary.
 *
 * Prevents highly sensitive values from being forwarded to the AI provider by default.
 * This is an engineering boundary derived from repository conventions and the approved
 * AI Search scope — it is NOT a broad compliance policy. Data-classification decisions
 * beyond this boundary remain a human decision.
 *
 * The redaction is deterministic and field/pattern based (default-deny for recognized
 * sensitive kinds/values).
 */

import { RetrievedField } from './contextBuilder';

/** Field-kind names that must never be forwarded by default. */
const SENSITIVE_FIELD_NAMES = [
  'password',
  'passwd',
  'api key',
  'apikey',
  'api_key',
  'secret',
  'token',
  'jwt',
  'authorization',
  'credential',
  'cvv',
  'pan',
  'aadhaar',
  'aadhar',
  'kyc',
  'otp',
  'account number',
  'account_number',
  'iban',
  'card number',
  'card_number',
  'pin',
];

/** Value patterns treated as sensitive even if the field kind is innocuous. */
const SENSITIVE_VALUE_RE =
  /(api[_-]?key|pass(word)?|secret|token|jwt|authorization|credential|cvv|\bpan\b|aadhaar|aadhar|account[_-]?no\b|card[_-]?number\b|otp|pin\b)/i;

export class Redactor {
  /** Returns only the fields that are safe to forward. */
  redact(fields: RetrievedField[]): RetrievedField[] {
    return (fields || []).filter((field) => !this.isSensitive(field));
  }

  isSensitive(field: RetrievedField): boolean {
    const kind = (field.kind || '').toLowerCase();
    if (SENSITIVE_FIELD_NAMES.some((name) => kind.includes(name))) return true;
    return SENSITIVE_VALUE_RE.test(field.content || '');
  }
}