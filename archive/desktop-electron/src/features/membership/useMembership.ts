import { useMemo } from 'react';
import { useOfficialAuthState } from '../../hooks/useOfficialAuthState';
import { normalizeMembershipState } from './membershipModel';
import type { EntitlementKey } from './entitlementKeys';

export function useMembership() {
  const { snapshot, bootstrapped } = useOfficialAuthState();
  const state = useMemo(() => normalizeMembershipState(snapshot), [snapshot]);

  return {
    bootstrapped,
    snapshot,
    state,
    can: (_entitlement: EntitlementKey | string) => true,
  };
}
