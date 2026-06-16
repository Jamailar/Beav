import type { I18nKey } from '../i18n';

export type FounderSponsorState = {
  active: boolean;
  labelKey: I18nKey;
};

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function valueContainsFounder(value: unknown): boolean {
  const normalized = String(value || '').trim().toLowerCase();
  return [
    'founder',
    'founding',
    'founder_sponsor',
    'founder-sponsor',
    'founderSponsor',
    '创始',
    '赞助',
  ].some((token) => normalized.includes(token.toLowerCase()));
}

export function parseTimeMs(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

export function hasActivePremiumMembership(user: Record<string, unknown> | null): boolean {
  if (!user) return false;
  const membershipType = String(
    user.membership_type
    || user.membershipType
    || user.memberType
    || '',
  ).trim().toLowerCase();
  if (!['premium', 'founder', 'founder_sponsor', 'founder-sponsor'].includes(membershipType)) {
    return false;
  }
  const expiryMs = parseTimeMs(user.membership_expires_at || user.membershipExpiresAt);
  return expiryMs === null || expiryMs > Date.now();
}

function recordIsActiveFounder(record: Record<string, unknown> | null): boolean {
  if (!record) return false;
  const status = String(record.status || record.state || '').trim().toLowerCase();
  const explicitlyInactive = record.active === false
    || record.enabled === false
    || ['inactive', 'expired', 'cancelled', 'canceled'].includes(status);
  if (explicitlyInactive) return false;

  return [
    record.tier,
    record.type,
    record.badge,
    record.product_id,
    record.productId,
    record.plan,
    record.scope,
    record.name,
    record.label,
  ].some(valueContainsFounder);
}

export function resolveFounderSponsorState(authSnapshot: unknown): FounderSponsorState {
  const root = asRecord(authSnapshot);
  const session = asRecord(root?.session);
  const user = asRecord(root?.user) || asRecord(session?.user);
  const candidates = [
    root?.membership,
    root?.subscription,
    root?.founderMembership,
    root?.founder_sponsor,
    session?.membership,
    session?.subscription,
    user?.membership,
    user?.subscription,
    user?.founderMembership,
    user?.founder_sponsor,
  ];

  const arrays = [
    root?.entitlements,
    session?.entitlements,
    user?.entitlements,
    root?.memberships,
    session?.memberships,
    user?.memberships,
  ];

  const active = candidates.some((value) => recordIsActiveFounder(asRecord(value)))
    || arrays.some((value) => Array.isArray(value) && value.some((item) => recordIsActiveFounder(asRecord(item))))
    || hasActivePremiumMembership(user);

  return {
    active,
    labelKey: active ? 'layout.founderSponsor.memberLabel' : 'layout.founderSponsor.entryLabel',
  };
}
