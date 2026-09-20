/**
 * Config file locations, merging and persistence.
 *
 * Global lives next to the rest of the agent config; a project file overrides
 * it per role and per agent mapping, so a repo can pin a cheaper table without
 * touching your global one.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { BUILT_IN_ROLES, type RoleConfig, type RolesFile, emptyConfig } from "./types.ts";

export * from "./types.ts";

export function globalConfigPath(): string {
	return join(getAgentDir(), "model-roles.json");
}

export function projectConfigPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "model-roles.json");
}

function readFile(path: string): Partial<RolesFile> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as Partial<RolesFile>;
	} catch {
		// A broken config must not stop pi from starting.
		return undefined;
	}
}

/** Project entries override global ones per role / per agent. */
export function loadConfig(cwd: string): RolesFile {
	const merged = emptyConfig();
	for (const path of [globalConfigPath(), projectConfigPath(cwd)]) {
		const raw = readFile(path);
		if (!raw) continue;
		for (const [name, role] of Object.entries(raw.roles ?? {})) {
			merged.roles[name] = { ...merged.roles[name], ...role };
		}
		Object.assign(merged.agentRoles, raw.agentRoles ?? {});
		if (raw.advisor) merged.advisor = { ...merged.advisor, ...raw.advisor };
		if (typeof raw.injectPrompt === "boolean") merged.injectPrompt = raw.injectPrompt;
		if (raw.compactionRole !== undefined) merged.compactionRole = raw.compactionRole;
	}
	return merged;
}

/**
 * Write one scope's file.
 *
 * Built-in roles with nothing configured are dropped, so a fresh install stays
 * a small readable file instead of ten empty stubs.
 */
export function saveConfig(path: string, config: RolesFile): void {
	const roles: Record<string, RoleConfig> = {};
	for (const [name, role] of Object.entries(config.roles)) {
		const meaningful = role.model || role.thinking || (role.fallback && role.fallback.length > 0);
		if (!meaningful && name in BUILT_IN_ROLES) continue;
		const entry: RoleConfig = {};
		if (role.model) entry.model = role.model;
		if (role.thinking) entry.thinking = role.thinking;
		if (role.fallback && role.fallback.length > 0) entry.fallback = [...role.fallback];
		if (role.description && !(name in BUILT_IN_ROLES)) entry.description = role.description;
		roles[name] = entry;
	}

	const out: RolesFile = {
		roles,
		agentRoles: config.agentRoles,
		advisor: config.advisor,
		injectPrompt: config.injectPrompt,
		compactionRole: config.compactionRole,
	};

	mkdirSync(dirname(path), { recursive: true });

	// A project save lands inside the checkout, so the temp path must not be
	// guessable and must not be followed: a repo can commit a symlink at a
	// fixed `<file>.tmp` and have the default create-truncate write land on
	// whatever it points at. `wx` fails with EEXIST instead of following one.
	const tmp = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`, { encoding: "utf-8", flag: "wx" });
		// rename() acts on the destination link itself rather than its target,
		// so a symlinked `path` is replaced here rather than written through.
		renameSync(tmp, path);
	} catch (error) {
		// Cleanup must never mask why the save actually failed.
		try {
			rmSync(tmp, { force: true });
		} catch {}
		throw error;
	}
}
