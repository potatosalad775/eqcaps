import { expect, it } from 'vitest';
import { parseMaintainers } from './maintainers.ts';

it('parses handles, former markers and comments', () => {
	const text = '# header\n\npotatosalad775\n@someone former  # left 2027\r\n';
	expect(parseMaintainers(text)).toEqual([
		{ handle: 'potatosalad775', former: false },
		{ handle: 'someone', former: true }
	]);
});
