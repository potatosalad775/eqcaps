/** Format version this package implements (SPEC §15). */
export const SCHEMA_VERSION = '1.6';

export type * from './types/schema.generated.ts';
// The schema's value lists (FILTER_TYPES is exported with the engine's filter helpers below).
export {
	CONTROL_KINDS,
	CONTROL_ROLES,
	PREAMP_MODES,
	SOURCE_KINDS,
	STATUSES
} from './types/values.generated.ts';
export { ISSUE_CODES } from './issues.ts';
export type { Issue, IssueCode } from './issues.ts';
export { EPSILON, near, onGrid, domainForm, domainBounds, isLockedDomain } from './domain.ts';
export type { DomainForm } from './domain.ts';
export { compareFirmware, firmwareInRange, firmwareRangesOverlap } from './firmware.ts';
export { controlPresent, controlTakes, eqDisabledBy } from './controls.ts';
export type { ControlValues } from './controls.ts';
export { eqProfile, profileEqs } from './eqs.ts';
export type { ProfileEq } from './eqs.ts';
export { mergeSlotFields, overrideIndices, slotOverrides } from './slots.ts';
export type { SlotOverride } from './slots.ts';
export { COUNTING_SOURCE_KINDS, isCountingSource, validateProfile } from './validate-profile.ts';
export { MAX_EXTENDS_DEPTH, PROFILE_SCHEMA_URL, flattenProfile } from './flatten.ts';
export type { FlattenResult } from './flatten.ts';
export { checkDatabase } from './database.ts';
export { expandBluetoothMatch, expandUsbMatch, matchValues } from './match.ts';
export type { ScalarBluetoothMatch, ScalarUsbMatch } from './match.ts';
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
export { validate, validateList } from './validate.ts';
export type { Violation, ViolationCode } from './validate.ts';
export { assign } from './assign.ts';
export type { AssignResult } from './assign.ts';
export { fit } from './fit.ts';
export type { Change, FitResult } from './fit.ts';
export { complete } from './complete.ts';
export type { CompleteOptions, CompleteResult, CompleteWarning } from './complete.ts';
export { plan } from './plan.ts';
export type { Plan, PlanChannel, PlanHeld, PlanOptions, PlanWanted, PlanWrite } from './plan.ts';
export { describe, describeDomain, isGraphic, unsupported } from './describe.ts';
export type { ProfileDescription, SlotGroupDescription } from './describe.ts';
