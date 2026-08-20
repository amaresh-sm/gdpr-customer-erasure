import type { SubjectContext } from './types.js';

const REDACTED = '[redacted]';
const PERSONAL_KEYS = new Set([
  'email', 'customerEmail', 'name', 'phone', 'externalReference', 'external_reference',
  'providerToken', 'paymentMethodId', 'billingName', 'billingAddress', 'address', 'destination',
]);

function replacements(context: SubjectContext): Array<[string, string]> {
  const unique = new Set(context.sensitiveValues.filter((value) => value.length >= 3));
  unique.delete(context.customerId);
  unique.delete(context.surrogateId);
  return [
    [context.customerId, context.surrogateId],
    ...[...unique].sort((left, right) => right.length - left.length).map((value) => [value, REDACTED] as [string, string]),
  ];
}

function redactUnknown(value: unknown, context: SubjectContext): unknown {
  if (typeof value === 'string') {
    let redacted = value;
    for (const [needle, replacement] of replacements(context)) redacted = redacted.split(needle).join(replacement);
    return redacted;
  }
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item, context));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, redactUnknown(item, context)]));
  }
  return value;
}

/** Redacts known subject values while preserving unrelated object structure and financial facts. */
export function redactSubjectValue<T>(value: T, context: SubjectContext): T {
  return redactUnknown(value, context) as T;
}

function sanitizeUnknown(value: unknown, context: SubjectContext): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeUnknown(item, context));
  if (!value || typeof value !== 'object') return redactUnknown(value, context);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => {
    if ((key === 'customerId' || key === 'customer_id') && item === context.customerId) {
      return [key, context.surrogateId];
    }
    if (key === 'metadata') return [key, {}];
    if (key === 'attachments') return [key, []];
    if (PERSONAL_KEYS.has(key)) return [key, null];
    return [key, sanitizeUnknown(item, context)];
  }));
}

/** Removes personal-data fields from a target-linked payload while retaining non-personal facts. */
export function sanitizeSubjectPayload<T>(value: T, context: SubjectContext): T {
  return sanitizeUnknown(value, context) as T;
}

/** Reports whether a structured or text value contains any known subject identifier or PII canary. */
export function containsSubjectValue(value: unknown, context: SubjectContext): boolean {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  return [context.customerId, ...context.sensitiveValues]
    .filter((candidate) => candidate.length >= 3)
    .some((candidate) => serialized.includes(candidate));
}

/** Produces the minimal customer block allowed in a retained financial document. */
export function erasedCustomerBlock(context: SubjectContext): Record<string, unknown> {
  return { erased: true, subjectReference: context.surrogateId };
}
