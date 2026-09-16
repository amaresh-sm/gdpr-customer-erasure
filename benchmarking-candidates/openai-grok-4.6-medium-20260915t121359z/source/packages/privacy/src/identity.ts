export function customerIdFromEvent(
  payload: Record<string, unknown>,
  aggregateType: string,
  aggregateId: string,
): string | undefined {
  if (typeof payload.customerId === 'string') return payload.customerId;
  if (aggregateType === 'customer') return aggregateId;
  return undefined;
}
