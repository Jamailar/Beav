import type { ReactNode } from 'react';
import type { EntitlementKey } from './entitlementKeys';

type MembershipGateProps = {
  entitlement: EntitlementKey | string;
  children: ReactNode;
  fallback?: ReactNode;
};

export function MembershipGate({ entitlement: _entitlement, children, fallback: _fallback = null }: MembershipGateProps) {
  return <>{children}</>;
}
