export const ENTITLEMENTS = {
  spacesCreate: 'spaces.create',
  spacesCreateUnlimited: 'spaces.create.unlimited',
  devicesLoginUnlimited: 'devices.login.unlimited',
  pointsInitialBonus: 'points.initial_bonus',
  featuresMemberOnly: 'features.member_only',
  supportPriority: 'support.priority',
} as const;

export type EntitlementKey = typeof ENTITLEMENTS[keyof typeof ENTITLEMENTS];
