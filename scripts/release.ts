// Publishes a release from this machine (DECISIONS D32): @potatosalad775/eqcaps-core, -client
// and -device-bridge to npm, a git tag, and a GitHub Release with the current bundle.json. Run it
// from a clean, pushed main; npm asks for your 2FA code as it publishes.
//
// Usage: npm run release -- <version> [--dry-run] [--otp <code>]
//        npm run release -- <version> --pack
//
// <version> is a semver (0.3.0, 0.3.0-rc.1) or major, minor or patch: the next such version after
// the highest released v* tag on origin.
//
// --pack builds the packages and writes their tarballs to dist/pack/ instead of publishing, from
// any working tree, to try them in another app before a release:
// `npm install <eqcaps>/dist/pack/*.tgz` there.
//
// package.json files in the repository stay at 0.0.0: the version, and the packages' dependencies
// on each other, are set only for the publish and restored afterwards. A pre-release version
// (1.2.3-beta.1) publishes under the npm dist-tag "next" and makes a GitHub pre-release.

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('..', import.meta.url));
const PUBLISHED = ['core', 'client', 'device-bridge'];

function run(cmd: string, args: string[], options: { capture?: boolean } = {}): string {
	const result = spawnSync(cmd, args, {
		cwd: root,
		encoding: 'utf8',
		stdio: options.capture ? ['inherit', 'pipe', 'inherit'] : 'inherit',
		// npm and gh are .cmd shims on Windows.
		shell: process.platform === 'win32'
	});
	if (result.status !== 0) {
		throw new Error(
			`${cmd} ${args.join(' ')} failed${result.error ? `: ${result.error.message}` : ''}`
		);
	}
	return (result.stdout ?? '').trim();
}

const git = (...args: string[]) => run('git', args, { capture: true });

function fail(message: string): never {
	console.error(`\n${message}`);
	process.exit(1);
}

/** package.json texts as they were before setVersions, for restoreVersions. */
const saved = new Map<string, string>();

function setVersions(version: string) {
	const names = new Set(PUBLISHED.map((p) => `@potatosalad775/eqcaps-${p}`));
	for (const pkg of PUBLISHED) {
		const path = `${root}packages/${pkg}/package.json`;
		const text = readFileSync(path, 'utf8');
		saved.set(path, text);
		const json = JSON.parse(text) as {
			version: string;
			dependencies?: Record<string, string>;
		};
		json.version = version;
		for (const dep of Object.keys(json.dependencies ?? {})) {
			if (names.has(dep)) json.dependencies![dep] = version;
		}
		writeFileSync(path, `${JSON.stringify(json, null, '\t')}\n`);
		copyFileSync(`${root}LICENSE`, `${root}packages/${pkg}/LICENSE`);
	}
}

function restoreVersions() {
	// Written back rather than checked out, so uncommitted edits survive a --pack.
	for (const [path, text] of saved) writeFileSync(path, text);
	for (const pkg of PUBLISHED) rmSync(`${root}packages/${pkg}/LICENSE`, { force: true });
}

/** Tarballs of the packages at `version` in dist/pack/, built from the working tree as it is. */
function pack(version: string) {
	console.log(`\n== Build`);
	run('npm', ['run', 'build']);
	const out = `${root}dist/pack`;
	rmSync(out, { recursive: true, force: true });
	mkdirSync(out, { recursive: true });
	console.log(`\n== Pack ${version}`);
	setVersions(version);
	try {
		run('npm', [
			'pack',
			...PUBLISHED.flatMap((p) => ['-w', `packages/${p}`]),
			'--pack-destination',
			out
		]);
	} finally {
		restoreVersions();
	}
	console.log(`\nTarballs in dist/pack/. In the app that should use them:`);
	console.log(`  npm install ${out}/*.tgz`);
}

const BUMPS = ['major', 'minor', 'patch'] as const;
type Bump = (typeof BUMPS)[number];

/** The version after the highest non-pre-release v* tag, bumped by `bump`. */
function nextVersion(bump: Bump): string {
	try {
		git('fetch', '--quiet', '--tags', 'origin');
	} catch {
		console.warn('Could not fetch tags from origin; using the local tags.');
	}
	const latest = git('tag', '--list', 'v*', '--sort=-v:refname')
		.split('\n')
		.map((t) => /^v(\d+)\.(\d+)\.(\d+)$/.exec(t.trim()))
		.find((m) => m !== null);
	if (!latest) fail('No v<major>.<minor>.<patch> tag to bump from. Give the version.');
	const [major, minor, patch] = [1, 2, 3].map((i) => Number(latest[i])) as [number, number, number];
	const next =
		bump === 'major'
			? `${major + 1}.0.0`
			: bump === 'minor'
				? `${major}.${minor + 1}.0`
				: `${major}.${minor}.${patch + 1}`;
	console.log(`${latest[0]} + ${bump} = v${next}`);
	return next;
}

function main() {
	const { positionals, values } = parseArgs({
		allowPositionals: true,
		options: {
			'dry-run': { type: 'boolean' },
			otp: { type: 'string' },
			pack: { type: 'boolean' }
		}
	});
	const arg = positionals[0];
	const version = BUMPS.includes(arg as Bump) ? nextVersion(arg as Bump) : arg?.replace(/^v/, '');
	if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
		fail(
			'usage: npm run release -- <version | major | minor | patch> [--dry-run] [--otp <code>] [--pack]'
		);
	}
	if (values.pack) {
		pack(version);
		return;
	}
	const dryRun = values['dry-run'] ?? false;
	const tag = `v${version}`;
	const prerelease = version.includes('-');

	// Release only what is on origin/main, so the tag points at a commit everyone can see.
	if (git('status', '--porcelain'))
		fail('The working tree has changes. Commit or stash them first.');
	if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main') fail('Release from main.');
	git('fetch', '--quiet', '--tags', 'origin');
	const head = git('rev-parse', 'HEAD');
	if (head !== git('rev-parse', 'origin/main'))
		fail('main is not in sync with origin/main. Push or pull first.');
	const tagged = spawnSync(
		'git',
		['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`],
		{
			cwd: root,
			encoding: 'utf8'
		}
	).stdout.trim();
	if (tagged && tagged !== head) {
		fail(`${tag} already exists at ${tagged.slice(0, 7)}, not at HEAD. Pick another version.`);
	}
	if (!dryRun) {
		try {
			console.log(`npm user: ${run('npm', ['whoami'], { capture: true })}`);
		} catch {
			fail('Not logged in to npm. Run `npm login` first.');
		}
	}

	console.log(`\n== Checks`);
	for (const script of ['data:validate', 'lint', 'check', 'test', 'build', 'data:build']) {
		run('npm', ['run', script]);
	}

	console.log(`\n== Publish ${version}${dryRun ? ' (dry run)' : ''}`);
	setVersions(version);
	try {
		run('npm', [
			'publish',
			...PUBLISHED.flatMap((p) => ['-w', `packages/${p}`]),
			'--access',
			'public',
			'--tag',
			prerelease ? 'next' : 'latest',
			...(values.otp ? ['--otp', values.otp] : []),
			...(dryRun ? ['--dry-run'] : [])
		]);
	} finally {
		restoreVersions();
	}
	if (dryRun) {
		console.log(`\nDry run done. Nothing was published, tagged or released.`);
		return;
	}

	console.log(`\n== Tag and GitHub Release`);
	if (!tagged) {
		git('tag', '-a', tag, '-m', tag);
		git('push', 'origin', tag);
	}
	run('gh', [
		'release',
		'create',
		tag,
		'dist/site/v1/bundle.json',
		'--verify-tag',
		'--title',
		tag,
		'--generate-notes',
		...(prerelease ? ['--prerelease'] : [])
	]);
	console.log(`\nReleased ${tag}.`);
}

main();
