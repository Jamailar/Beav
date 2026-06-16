import type { ReactNode } from 'react';
import { useMembership } from './useMembership';
import type { EntitlementKey } from './entitlementKeys';

type MembershipGateProps = {
  entitlement: EntitlementKey | string;
  children: ReactNode;
  fallback?: ReactNode;
};

export function MembershipGate({ entitlement, children, fallback = null }: MembershipGateProps) {
  const { can } = useMembership();
  return can(entitlement) ? <>{children}</> : <>{fallback}</>;
}

