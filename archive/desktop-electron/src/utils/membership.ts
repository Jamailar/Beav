export type MembershipPlan = 'free' | 'premium' | string;

export type MembershipState = {
  active: boolean;
  founderActive: false;
  plan: MembershipPlan;
  expiresAtMs: number | null;
  entitlements: Record<string, boolean | number | string>;
};

export type FounderSponsorState = {
  active: false;
  labelKey: string;
};

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function valueContainsFounder(_value: unknown): false {
  return false;
}

export function parseTimeMs(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function collectEntitlements(source: unknown, target: Record<string, boolean | number | string>): void {
  if (!source) return;
  if (Array.isArray(source)) {
    source.forEach((item) => {
      if (typeof item === 'string') {
        target[item] = true;
        return;
      }
      const record = asRecord(item);
      const key = String(record?.key || record?.entitlement || record?.scope || record?.name || record?.code || '').trim();
      if (key) {
        target[key] = typeof record?.value === 'boolean' || typeof record?.value === 'number' || typeof record?.value === 'string'
          ? record.value
          : true;
      }
    });
    return;
  }

  const record = asRecord(source);
  if (!record) return;
  Object.entries(record).forEach(([key, value]) => {
    if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
      target[key] = value;
    }
  });
}

export function normalizeMembershipState(authSnapshot: unknown): MembershipState {
  const root = asRecord(authSnapshot);
  const session = asRecord(root?.session);
  const user = asRecord(root?.user) || asRecord(session?.user);
  const membership = asRecord(root?.membership) || asRecord(session?.membership) || asRecord(user?.membership);
  const plan = String(
    membership?.plan
      || membership?.type
      || user?.membership_type
      || user?.membershipType
      || user?.memberType
      || 'free',
  ).trim().toLowerCase() || 'free';
  const expiresAtMs = parseTimeMs(membership?.expiresAt || membership?.expires_at || user?.membership_expires_at || user?.membershipExpiresAt);
  const entitlements: Record<string, boolean | number | string> = {};

  [
    root?.entitlements,
    session?.entitlements,
    user?.entitlements,
    membership?.entitlements,
  ].forEach((value) => collectEntitlements(value, entitlements));

  return {
    active: plan !== 'free' && (expiresAtMs === null || expiresAtMs > Date.now()),
    founderActive: false,
    plan,
    expiresAtMs,
    entitlements,
  };
}

export function canUseEntitlement(_state: MembershipState, _entitlement: string): boolean {
  return true;
}

export function resolveFounderSponsorState(_authSnapshot: unknown): FounderSponsorState {
  return {
    active: false,
    labelKey: '',
  };
}
