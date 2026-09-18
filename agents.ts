/**
 * Discovery of subagent definitions, shared by the TUI and the advisor.
 *
 * Covers the three places the subagent extensions read agents from: the user
 * directory, the project directory, and the `agents/` folder shipped inside an
 * installed pi package (pi-interactive-subagents bundles scout/researcher/worker
 * that way, and they never appear under ~/.pi/agent/agents).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export interface AgentInfo {
	name: string;
	description: string;
	model?: string;
	tools?: string;
	source: "user" | "project" | "package";
}

function isDir(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function listDirs(parent: string): string[] {
	if (!isDir(parent)) return [];
	try {
		return readdirSync(parent).map((name) => join(parent, name));
	} catch {
		return [];
	}
}

/** `agents/` folders inside installed npm and git packages. */
function packageAgentDirs(): string[] {
	const agentDir = getAgentDir();
	const roots: string[] = [];

	for (const scopeOrPkg of listDirs(join(agentDir, "npm", "node_modules"))) {
		const base = scopeOrPkg.split(/[\\/]/).pop() ?? "";
		if (base.startsWith("@")) roots.push(...listDirs(scopeOrPkg));
		else roots.push(scopeOrPkg);
	}
	// git packages live at <agentDir>/git/<host>/<owner>/<repo>
	for (const host of listDirs(join(agentDir, "git"))) {
		for (const owner of listDirs(host)) roots.push(...listDirs(owner));
	}

	return roots.map((root) => join(root, "agents")).filter(isDir);
}

export function readAgentRoster(cwd: string): AgentInfo[] {
	const sources: { dir: string; source: AgentInfo["source"] }[] = [
		...packageAgentDirs().map((dir) => ({ dir, source: "package" as const })),
		{ dir: join(getAgentDir(), "agents"), source: "user" as const },
		{ dir: join(cwd, CONFIG_DIR_NAME, "agents"), source: "project" as const },
	];

	// Later sources win, matching the project > user > package priority the
	// subagent extensions use.
	const found = new Map<string, AgentInfo>();
	for (const { dir, source } of sources) {
		if (!existsSync(dir)) continue;
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			continue;
		}
		for (const file of entries) {
			if (!file.endsWith(".md")) continue;
			try {
				const parsed = parseFrontmatter<Record<string, unknown>>(readFileSync(join(dir, file), "utf-8"));
				const fm = parsed.frontmatter;
				const name = typeof fm.name === "string" ? fm.name : file.replace(/\.md$/, "");
				found.set(name, {
					name,
					description: typeof fm.description === "string" ? fm.description : "",
					model: typeof fm.model === "string" ? fm.model : undefined,
					tools: typeof fm.tools === "string" ? fm.tools : undefined,
					source,
				});
			} catch {
				// A malformed definition must not take down the whole roster.
			}
		}
	}
	return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}
