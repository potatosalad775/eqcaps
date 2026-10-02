/** Format version this package implements (SPEC §15). */
export const SCHEMA_VERSION = '1.0';

export type * from './types/schema.generated.ts';
export { ISSUE_CODES } from './issues.ts';
export type { Issue, IssueCode } from './issues.ts';
export { EPSILON, near, onGrid, domainForm, domainBounds, isLockedDomain } from './domain.ts';
export type { DomainForm } from './domain.ts';
export { compareFirmware, firmwareRangesOverlap } from './firmware.ts';
export { mergeSlotFields, overrideIndices, slotOverrides } from './slots.ts';
export type { SlotOverride } from './slots.ts';
export { COUNTING_SOURCE_KINDS, isCountingSource, validateProfile } from './validate-profile.ts';
export { MAX_EXTENDS_DEPTH, PROFILE_SCHEMA_URL, flattenProfile } from './flatten.ts';
export type { FlattenResult } from './flatten.ts';
export { checkDatabase } from './database.ts';
export { indexFields } from './published.ts';
export type { DataBundle, DataIndex, IndexEntry } from './published.ts';

// Engine (SPEC §13)
export type { Field, NumericField } from './dependencies.ts';
export { FILTER_TYPES, isActive, isKnownType, normalizeFilter, usesGain } from './filter.ts';
export type { Filter, KnownFilterType } from './filter.ts';
export { domainViolation, inDomain, project, projectType } from './project.ts';
export type { DomainField, DomainViolation } from './project.ts';
export { resolveSlot } from './resolve.ts';
export type { EffectiveSlot } from './resolve.ts';
export { toRealized, toWritten } from './realization.ts';
export { validate, validateList } from './validate.ts';
export type { Violation, ViolationCode } from './validate.ts';
export { assign } from './assign.ts';
export type { AssignResult } from './assign.ts';
export { fit } from './fit.ts';
export type { Change, FitResult } from './fit.ts';
export { complete } from './complete.ts';
export type { CompleteResult, CompleteWarning } from './complete.ts';
export { describe, describeDomain, isGraphic, unsupported } from './describe.ts';
export type { ProfileDescription, SlotGroupDescription } from './describe.ts';
