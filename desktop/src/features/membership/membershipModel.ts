import type { I18nKey } from '../../i18n';
import { ENTITLEMENTS, type EntitlementKey } from './entitlementKeys';

export type MembershipPlan = 'free' | 'premium' | 'founder' | 'founder_sponsor' | string;

export type MembershipState = {
  active: boolean;
  founderActive: boolean;
  plan: MembershipPlan;
  expiresAtMs: number | null;
  entitlements: Record<string, boolean | number | string>;
};

export type FounderSponsorState = {
  active: boolean;
  labelKey: I18nKey;
};

const PREMIUM_PLANS = ['premium', 'founder', 'founder_sponsor', 'founder-sponsor'];
const FOUNDER_PLANS = ['premium', 'founder', 'founder_sponsor', 'founder-sponsor'];
const LEGACY_ACTIVE_MEMBER_ENTITLEMENTS: EntitlementKey[] = [
  ENTITLEMENTS.devicesLoginUnlimited,
  ENTITLEMENTS.featuresMemberOnly,
  ENTITLEMENTS.supportPriority,
];
const FOUNDER_MEMBER_ENTITLEMENTS: EntitlementKey[] = [
  ENTITLEMENTS.spacesCreate,
  ENTITLEMENTS.spacesCreateUnlimited,
];

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

function normalizedPlan(value: unknown): string {
  return String(value || '').trim().toLowerCase();
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

function mergeEntitlement(target: Record<string, boolean | number | string>, key: unknown, value: unknown = true): void {
  const entitlementKey = String(key || '').trim();
  if (!entitlementKey) return;
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    target[entitlementKey] = value;
    return;
  }
  target[entitlementKey] = true;
}

function collectEntitlements(source: unknown, target: Record<string, boolean | number | string>): void {
  if (!source) return;
  if (Array.isArray(source)) {
    source.forEach((item) => {
      if (typeof item === 'string') {
        mergeEntitlement(target, item);
        return;
      }
      const record = asRecord(item);
      if (!record) return;
      const status = String(record.status || record.state || '').trim().toLowerCase();
      if (record.active === false || ['inactive', 'expired', 'cancelled', 'canceled'].includes(status)) return;
      mergeEntitlement(
        target,
        record.key || record.entitlement || record.scope || record.name || record.code,
        record.value ?? record.enabled ?? true,
      );
    });
    return;
  }

  const record = asRecord(source);
  if (!record) return;
  Object.entries(record).forEach(([key, value]) => {
    mergeEntitlement(target, key, value);
  });
}

function userMembership(user: Record<string, unknown> | null): Pick<MembershipState, 'active' | 'plan' | 'expiresAtMs'> {
  if (!user) {
    return { active: false, plan: 'free', expiresAtMs: null };
  }
  const plan = normalizedPlan(user.membership_type || user.membershipType || user.memberType || 'free') || 'free';
  const expiresAtMs = parseTimeMs(user.membership_expires_at || user.membershipExpiresAt);
  const active = PREMIUM_PLANS.includes(plan) && (expiresAtMs === null || expiresAtMs > Date.now());
  return { active, plan, expiresAtMs };
}

export function normalizeMembershipState(authSnapshot: unknown): MembershipState {
  const root = asRecord(authSnapshot);
  const session = asRecord(root?.session);
  const user = asRecord(root?.user) || asRecord(session?.user);
  const rootMembership = asRecord(root?.membership);
  const sessionMembership = asRecord(session?.membership);
  const userMembershipRecord = asRecord(user?.membership);
  const membership = userMembership(user);
  const entitlements: Record<string, boolean | number | string> = {};

  [
    root?.entitlements,
    session?.entitlements,
    user?.entitlements,
    rootMembership?.entitlements,
    sessionMembership?.entitlements,
    userMembershipRecord?.entitlements,
  ].forEach((value) => collectEntitlements(value, entitlements));

  const founderCandidates = [
    rootMembership,
    root?.subscription,
    root?.founderMembership,
    root?.founder_sponsor,
    sessionMembership,
    session?.subscription,
    userMembershipRecord,
    user?.subscription,
    user?.founderMembership,
    user?.founder_sponsor,
  ];
  const founderArrays = [
    root?.memberships,
    session?.memberships,
    user?.memberships,
  ];
  const founderActive = founderCandidates.some((value) => recordIsActiveFounder(asRecord(value)))
    || founderArrays.some((value) => Array.isArray(value) && value.some((item) => recordIsActiveFounder(asRecord(item))));
  const founderPlanActive = membership.active && FOUNDER_PLANS.includes(String(membership.plan || '').trim().toLowerCase());
  const hasFounderMembership = founderActive || founderPlanActive;

  const active = membership.active || hasFounderMembership;
  const plan = hasFounderMembership && membership.plan === 'free' ? 'founder_sponsor' : membership.plan;

  if (active) {
    LEGACY_ACTIVE_MEMBER_ENTITLEMENTS.forEach((key) => {
      if (entitlements[key] === undefined) {
        entitlements[key] = true;
      }
    });
  }
  if (hasFounderMembership) {
    FOUNDER_MEMBER_ENTITLEMENTS.forEach((key) => {
      if (entitlements[key] === undefined) {
        entitlements[key] = true;
      }
    });
  }

  return {
    active,
    founderActive: hasFounderMembership,
    plan,
    expiresAtMs: membership.expiresAtMs,
    entitlements,
  };
}

function entitlementValueIsEnabled(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === 'number') return value > 0;
  if (typeof value === 'string') {
    return !['', '0', 'false', 'no', 'disabled'].includes(value.trim().toLowerCase());
  }
  return false;
}

export function canUseEntitlement(state: MembershipState, entitlement: EntitlementKey | string): boolean {
  if (entitlement === ENTITLEMENTS.spacesCreate) {
    return state.founderActive && (
      entitlementValueIsEnabled(state.entitlements[ENTITLEMENTS.spacesCreate])
      || entitlementValueIsEnabled(state.entitlements[ENTITLEMENTS.spacesCreateUnlimited])
    );
  }
  if (entitlementValueIsEnabled(state.entitlements[entitlement])) return true;
  return false;
}

export function resolveFounderSponsorState(authSnapshot: unknown): FounderSponsorState {
  const state = normalizeMembershipState(authSnapshot);
  return {
    active: state.founderActive,
    labelKey: state.founderActive ? 'layout.founderSponsor.memberLabel' : 'layout.founderSponsor.entryLabel',
  };
}
