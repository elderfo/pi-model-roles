import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { saveConfig } from "../config.ts";
import { emptyConfig } from "../types.ts";

/** Symlink and permission behaviour is POSIX-only. */
const posix = process.platform !== "win32";

function scratch(): string {
	return mkdtempSync(join(tmpdir(), "model-roles-"));
}

test("saving writes the config and leaves no temp file behind", () => {
	const dir = scratch();
	const path = join(dir, ".pi", "model-roles.json");

	saveConfig(path, emptyConfig());

	assert.deepEqual(readdirSync(join(dir, ".pi")), ["model-roles.json"]);
	assert.deepEqual(JSON.parse(readFileSync(path, "utf-8")).roles, {});
});

test("a symlinked config path is replaced, never written through", { skip: !posix }, () => {
	const dir = scratch();
	const victim = join(dir, "victim");
	writeFileSync(victim, "SECRET\n");
	mkdirSync(join(dir, ".pi"));
	const path = join(dir, ".pi", "model-roles.json");
	symlinkSync(victim, path);

	saveConfig(path, emptyConfig());

	assert.equal(readFileSync(victim, "utf-8"), "SECRET\n");
	assert.equal(lstatSync(path).isSymbolicLink(), false);
});

/**
 * The bug this guards: the temp path used to be a fixed `<file>.tmp`, so a repo
 * could commit a symlink there and have the save follow it back out of the
 * checkout. The temp name is random now, so the test plants links at both the
 * old fixed name and the config name to prove neither is followed.
 */
test("a symlink planted at the old fixed temp path cannot redirect the write", { skip: !posix }, () => {
	const dir = scratch();
	const victim = join(dir, "victim");
	writeFileSync(victim, "SECRET\n");
	mkdirSync(join(dir, ".pi"));
	const path = join(dir, ".pi", "model-roles.json");
	symlinkSync(victim, `${path}.tmp`);

	saveConfig(path, emptyConfig());

	assert.equal(readFileSync(victim, "utf-8"), "SECRET\n");
	assert.deepEqual(readdirSync(join(dir, ".pi")).sort(), ["model-roles.json", "model-roles.json.tmp"].sort());
});

test("a failed save rethrows and leaves no temp file behind", { skip: !posix || process.getuid?.() === 0 }, () => {
	const dir = scratch();
	const configDir = join(dir, ".pi");
	mkdirSync(configDir);
	chmodSync(configDir, 0o500);

	try {
		assert.throws(() => saveConfig(join(configDir, "model-roles.json"), emptyConfig()));
		chmodSync(configDir, 0o700);
		assert.deepEqual(readdirSync(configDir), []);
	} finally {
		chmodSync(configDir, 0o700);
	}
});
