import { it } from 'vitest';
import { createSchemaValidator } from '../src/schema.ts';
import { loadSchemas } from '../src/node.ts';
it('compiles', () => {
	const v = createSchemaValidator(loadSchemas());
	console.log(JSON.stringify(v.published({ id: 'X' }), null, 1));
});
