// The format's JSON Schemas, bundled with the app so the editor checks files offline, exactly as
// CI does (packages/build). Ajv compiles them on first use.

import { createSchemaValidator, type SchemaValidator } from '@potatosalad775/eqcaps-build';
import profile from '../../../../schema/v1/profile.schema.json';
import source from '../../../../schema/v1/source.schema.json';

let validator: SchemaValidator | null = null;

export function schemaValidator(): SchemaValidator {
	validator ??= createSchemaValidator({ profile, source });
	return validator;
}
