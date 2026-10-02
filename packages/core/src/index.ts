/** Format version this package implements (SPEC §15). */
export const SCHEMA_VERSION = '1.0';

export type * from './types/schema.generated.ts';
export { ISSUE_CODES } from './issues.ts';
export type { Issue, IssueCode } from './issues.ts';
export { EPSILON, near, onGrid, domainForm, domainBounds, isLockedDomain } from './domain.ts';
export type { DomainForm } from './domain.ts';
export { compareFirmware, firmwareRangesOverlap } from './firmware.ts';
export { parseMaintainers } from './maintainers.ts';
export type { Maintainer } from './maintainers.ts';
export { mergeSlotFields, overrideIndices, slotOverrides } from './slots.ts';
export type { SlotOverride } from './slots.ts';
export { COUNTING_SOURCE_KINDS, isCountingSource, validateProfile } from './validate-profile.ts';
export type { ValidateProfileOptions } from './validate-profile.ts';
export { MAX_EXTENDS_DEPTH, PROFILE_SCHEMA_URL, flattenProfile } from './flatten.ts';
export type { FlattenResult } from './flatten.ts';
export { checkDatabase } from './database.ts';
