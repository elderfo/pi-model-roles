/**
 * The /roles TUI: browse roles, pick models, manage fallback chains,
 * create and delete custom roles, map subagents to roles, tune the advisor.
 *
 * Built on ctx.ui.select/input/confirm so it works in every pi mode rather
 * than only in the interactive TUI.
 */

import { readAgentRoster } from "./agents.ts";
import { globalConfigPath, projectConfigPath, saveConfig } from "./config.ts";
import {
	BUILT_IN_ROLES,
	SEVERITIES,
	THINKING_LEVELS,
	type AdvisorMode,
	type RolesFile,
	type Severity,
	type ThinkingLevel,
} from "./types.ts";
import { type ModelSource, type Resolved, roleHealth, selectorFor } from "./resolve.ts";

const BACK = "← Back";
const HEALTH_ICON: Record<string, string> = { unset: "○", primary: "●", fallback: "◐", broken: "✗" };

export interface UiDeps {
	ui: {
		select(title: string, options: string[], opts?: any): Promise<string | undefined>;
		input(title: string, placeholder?: string, opts?: any): Promise<string | undefined>;
		confirm(title: string, message: string, opts?: any): Promise<boolean>;
		notify(message: string, type?: "info" | "warning" | "error"): void;
	};
	cwd: string;
	source: ModelSource;
	getConfig(): RolesFile;
	/** Persist the in-memory config to the active scope. */
	commit(): void;
	applyRole(name: string): Promise<string>;
}

/** Where saves land. Flipped from the main menu; not persisted itself. */
let saveScope: "global" | "project" = "global";

export function currentSavePath(cwd: string): string {
	return saveScope === "global" ? globalConfigPath() : projectConfigPath(cwd);
}

export function saveScopeLabel(): string {
	return saveScope;
}

export function toggleSaveScope(): void {
	saveScope = saveScope === "global" ? "project" : "global";
}

/**
 * Ask for a new custom role name, reject duplicates, return the created name.
 * Shared by the menu tree and the board.
 */
export async function promptNewRole(deps: UiDeps): Promise<string | undefined> {
	const config = deps.getConfig();
	const raw = await deps.ui.input("New role name", "e.g. reviewer, translator");
	const name = raw?.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
	if (!name) return undefined;
	if (config.roles[name]) {
		deps.ui.notify(`@${name} already exists.`, "warning");
		return undefined;
	}
	const description = (await deps.ui.input("What is it for?", "short description"))?.trim();
	config.roles[name] = description ? { description } : {};
	deps.commit();
	return name;
}

/** Confirm and delete a custom role, unmapping any agent that pointed at it. */
export async function confirmDeleteRole(deps: UiDeps, name: string): Promise<boolean> {
	const config = deps.getConfig();
	if (name in BUILT_IN_ROLES) {
		deps.ui.notify(`@${name} is built in and cannot be deleted.`, "warning");
		return false;
	}
	const ok = await deps.ui.confirm(`Delete @${name}?`, "Custom role. Anything pointing at it falls back to @default.");
	if (!ok) return false;
	delete config.roles[name];
	for (const [agent, mapped] of Object.entries(config.agentRoles)) {
		if (mapped === name) delete config.agentRoles[agent];
	}
	deps.commit();
	return true;
}

function pad(text: string, width: number): string {
	return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function describeResolved(resolved: Resolved | undefined): string {
	if (!resolved) return "unresolved";
	const via = resolved.chain.length > 0 ? ` via @${resolved.chain[resolved.chain.length - 1]}` : "";
	const rank = resolved.rank > 0 ? ` (fallback #${resolved.rank})` : "";
	return `${selectorFor(resolved)}${rank}${via}`;
}

function roleLine(deps: UiDeps, name: string): string {
	const config = deps.getConfig();
	const role = config.roles[name] ?? {};
	const { health, resolved } = roleHealth(config, deps.source, name);
	const icon = HEALTH_ICON[health] ?? "?";
	const fallbacks = role.fallback?.length ?? 0;
	const tail = health === "unset" ? "— not set —" : describeResolved(resolved);
	const extra = fallbacks > 0 ? `  [+${fallbacks} fallback]` : "";
	return `${icon} ${pad(name, 10)} ${tail}${extra}`;
}

/** Models the account can actually use right now. */
function modelChoices(deps: UiDeps, filter: string): string[] {
	const needle = filter.trim().toLowerCase();
	return deps.source
		.getAvailable()
		.filter((m) => !needle || `${m.provider}/${m.id} ${m.name}`.toLowerCase().includes(needle))
		.map((m) => {
			const flags: string[] = [];
			if (m.reasoning) flags.push("reasoning");
			if (m.input?.includes("image")) flags.push("vision");
			const suffix = flags.length > 0 ? `  [${flags.join(", ")}]` : "";
			return `${m.provider}/${m.id}${suffix}`;
		})
		.sort();
}

/** Returns a selector string (`provider/id`, or a hand-typed spec/alias). */
async function pickModel(deps: UiDeps, title: string): Promise<string | undefined> {
	const filter = await deps.ui.input(`${title} — filter (empty = all, Esc = cancel)`, "e.g. sonnet, gemini, gpt");
	if (filter === undefined) return undefined;

	const choices = modelChoices(deps, filter);
	if (choices.length === 0) deps.ui.notify(`No available model matches "${filter}"`, "warning");

	const MANUAL = "✎ Type a selector or @alias manually…";
	const picked = await deps.ui.select(title, [...choices.slice(0, 300), MANUAL, BACK]);
	if (!picked || picked === BACK) return undefined;
	if (picked === MANUAL) {
		const raw = await deps.ui.input("Selector", "provider/id, fuzzy id, or @role");
		return raw?.trim() || undefined;
	}
	return picked.split("  [")[0];
}

async function pickThinking(deps: UiDeps, current?: ThinkingLevel): Promise<ThinkingLevel | undefined | null> {
	const INHERIT = "(inherit — let pi decide)";
	const options = [INHERIT, ...THINKING_LEVELS.map((l) => (l === current ? `${l}  ←` : l))];
	const picked = await deps.ui.select("Thinking level", [...options, BACK]);
	if (!picked || picked === BACK) return undefined;
	if (picked === INHERIT) return null;
	return picked.replace("  ←", "").trim() as ThinkingLevel;
}

export async function editRole(deps: UiDeps, name: string): Promise<void> {
	for (;;) {
		const config = deps.getConfig();
		const role = (config.roles[name] ??= {});
		const { resolved } = roleHealth(config, deps.source, name);
		const fallbacks = role.fallback ?? [];

		const header = [
			`primary:   ${role.model ?? "— not set —"}`,
			`thinking:  ${role.thinking ?? "(inherit)"}`,
			`fallback:  ${fallbacks.length > 0 ? fallbacks.join(" → ") : "—"}`,
			`resolves:  ${describeResolved(resolved)}`,
		].join("\n");

		const actions = [
			"Set primary model",
			"Set thinking level",
			"Add fallback model",
			...(fallbacks.length > 0 ? ["Remove a fallback", "Promote a fallback to first"] : []),
			...(role.model ? ["Clear primary model"] : []),
			...(resolved ? ["Use this role in the current session"] : []),
			...(name in BUILT_IN_ROLES ? [] : ["Delete this role"]),
			BACK,
		];

		const picked = await deps.ui.select(`Role @${name}\n${header}`, actions);
		if (!picked || picked === BACK) return;

		switch (picked) {
			case "Set primary model": {
				const selector = await pickModel(deps, `@${name} — primary model`);
				if (selector) {
					role.model = selector;
					deps.commit();
				}
				break;
			}
			case "Set thinking level": {
				const level = await pickThinking(deps, role.thinking);
				if (level === undefined) break;
				if (level === null) delete role.thinking;
				else role.thinking = level;
				deps.commit();
				break;
			}
			case "Add fallback model": {
				const selector = await pickModel(deps, `@${name} — add fallback`);
				if (selector) {
					role.fallback = [...fallbacks, selector];
					deps.commit();
				}
				break;
			}
			case "Remove a fallback": {
				const victim = await deps.ui.select(`@${name} — remove which fallback?`, [...fallbacks, BACK]);
				if (!victim || victim === BACK) break;
				const at = fallbacks.indexOf(victim);
				role.fallback = fallbacks.filter((_, i) => i !== at);
				if (role.fallback.length === 0) delete role.fallback;
				deps.commit();
				break;
			}
			case "Promote a fallback to first": {
				const chosen = await deps.ui.select(`@${name} — promote which fallback?`, [...fallbacks, BACK]);
				if (!chosen || chosen === BACK) break;
				const at = fallbacks.indexOf(chosen);
				const rest = fallbacks.filter((_, i) => i !== at);
				const demoted = role.model ? [role.model, ...rest] : rest;
				role.model = chosen;
				role.fallback = demoted;
				if (role.fallback.length === 0) delete role.fallback;
				deps.commit();
				break;
			}
			case "Clear primary model": {
				delete role.model;
				deps.commit();
				break;
			}
			case "Use this role in the current session": {
				deps.ui.notify(await deps.applyRole(name), "info");
				break;
			}
			case "Delete this role": {
				const ok = await deps.ui.confirm(`Delete @${name}?`, "Custom role. Anything pointing at it falls back to @default.");
				if (!ok) break;
				delete config.roles[name];
				for (const [agent, mapped] of Object.entries(config.agentRoles)) {
					if (mapped === name) delete config.agentRoles[agent];
				}
				deps.commit();
				return;
			}
		}
	}
}

export async function editAgentMap(deps: UiDeps): Promise<void> {
	for (;;) {
		const config = deps.getConfig();
		const discovered = readAgentRoster(deps.cwd);
		const names = [...new Set([...discovered.map((a) => a.name), ...Object.keys(config.agentRoles)])].sort();
		const ADD = "＋ Map an agent name manually…";

		const rows = names.map((agent) => {
			const mapped = config.agentRoles[agent];
			const description = discovered.find((a) => a.name === agent)?.description ?? "";
			const short = description.length > 42 ? `${description.slice(0, 41)}…` : description;
			return `${pad(agent, 14)} → @${mapped ?? "task (default)"}${short ? `   ${short}` : ""}`;
		});

		const picked = await deps.ui.select("Agent → role\nPicks the model every spawn of that agent gets.", [...rows, ADD, BACK]);
		if (!picked || picked === BACK) return;

		let agent: string | undefined;
		if (picked === ADD) {
			agent = (await deps.ui.input("Agent name", "as written in its frontmatter"))?.trim();
		} else {
			agent = names[rows.indexOf(picked)];
		}
		if (!agent) continue;

		const UNMAP = "✕ Unmap (use @task)";
		const roleNames = Object.keys(config.roles).sort();
		const role = await deps.ui.select(`${agent} → which role?`, [...roleNames.map((r) => `@${r}`), UNMAP, BACK]);
		if (!role || role === BACK) continue;
		if (role === UNMAP) delete config.agentRoles[agent];
		else config.agentRoles[agent] = role.slice(1);
		deps.commit();
	}
}

export async function editAdvisor(deps: UiDeps): Promise<void> {
	for (;;) {
		const config = deps.getConfig();
		const advisor = config.advisor;
		const { resolved } = roleHealth(config, deps.source, "advisor");
		const header = [
			`model:        ${describeResolved(resolved)}`,
			`enabled:      ${advisor.enabled ? "yes" : "no"}`,
			`mode:         ${advisor.mode}`,
			`every:        ${advisor.everyTurns} turn(s)`,
			`min severity: ${advisor.minSeverity}`,
			`max notes:    ${advisor.maxNotes}`,
		].join("\n");

		const picked = await deps.ui.select(`Advisor\n${header}`, [
			advisor.enabled ? "Disable advisor" : "Enable advisor",
			"Set advisor model (@advisor)",
			"Mode: advise / steer",
			"Review interval",
			"Minimum severity to inject",
			"Max notes per review",
			BACK,
		]);
		if (!picked || picked === BACK) return;

		switch (picked) {
			case "Enable advisor":
			case "Disable advisor": {
				if (!advisor.enabled && !resolved) {
					deps.ui.notify("Assign a model to @advisor first.", "warning");
					break;
				}
				advisor.enabled = !advisor.enabled;
				deps.commit();
				break;
			}
			case "Set advisor model (@advisor)":
				await editRole(deps, "advisor");
				break;
			case "Mode: advise / steer": {
				const mode = await deps.ui.select("Advisor mode", [
					"advise — report findings, main agent decides",
					"steer — tell the main agent to dispatch the plan now",
					BACK,
				]);
				if (!mode || mode === BACK) break;
				advisor.mode = (mode.startsWith("steer") ? "steer" : "advise") as AdvisorMode;
				deps.commit();
				break;
			}
			case "Review interval": {
				const raw = await deps.ui.input("Review every N turns", String(advisor.everyTurns));
				const n = Number.parseInt(raw ?? "", 10);
				if (Number.isFinite(n) && n >= 1) {
					advisor.everyTurns = n;
					deps.commit();
				}
				break;
			}
			case "Minimum severity to inject": {
				const sev = await deps.ui.select("Inject when severity is at least", [...SEVERITIES.filter((s) => s !== "ok"), BACK]);
				if (!sev || sev === BACK) break;
				advisor.minSeverity = sev as Severity;
				deps.commit();
				break;
			}
			case "Max notes per review": {
				const raw = await deps.ui.input("Max notes (1-10)", String(advisor.maxNotes));
				const n = Number.parseInt(raw ?? "", 10);
				if (Number.isFinite(n) && n >= 1 && n <= 10) {
					advisor.maxNotes = n;
					deps.commit();
				}
				break;
			}
		}
	}
}

export async function openRolesUi(deps: UiDeps): Promise<void> {
	for (;;) {
		const config = deps.getConfig();
		const order = Object.keys(BUILT_IN_ROLES);
		const names = Object.keys(config.roles).sort((a, b) => {
			const ia = order.indexOf(a);
			const ib = order.indexOf(b);
			if (ia !== -1 && ib !== -1) return ia - ib;
			if (ia !== -1) return -1;
			if (ib !== -1) return 1;
			return a.localeCompare(b);
		});

		const rows = names.map((name) => roleLine(deps, name));
		const CREATE = "＋ Create a custom role…";
		const AGENTS = "⇄ Agent → role mapping…";
		const ADVISOR = `⚙ Advisor  (${config.advisor.enabled ? "on" : "off"})…`;
		const SCOPE = `💾 Save to: ${saveScope}  (${currentSavePath(deps.cwd)})`;
		const PROMPT = `📝 Role cheat-sheet in system prompt: ${config.injectPrompt ? "on" : "off"}`;
		const COMPACT = `🗜 Compaction summariser: ${config.compactionRole ? `@${config.compactionRole}` : "pi default"}`;
		const CLOSE = "✕ Close";

		const picked = await deps.ui.select("Model roles   ● primary  ◐ fallback in use  ✗ broken  ○ unset", [
			...rows,
			CREATE,
			AGENTS,
			ADVISOR,
			SCOPE,
			PROMPT,
			COMPACT,
			CLOSE,
		]);
		if (!picked || picked === CLOSE) return;

		if (picked === CREATE) {
			const name = await promptNewRole(deps);
			if (name) await editRole(deps, name);
			continue;
		}
		if (picked === AGENTS) {
			await editAgentMap(deps);
			continue;
		}
		if (picked === ADVISOR) {
			await editAdvisor(deps);
			continue;
		}
		if (picked === SCOPE) {
			toggleSaveScope();
			saveConfig(currentSavePath(deps.cwd), config);
			deps.ui.notify(`Saving to ${saveScope}: ${currentSavePath(deps.cwd)}`, "info");
			continue;
		}
		if (picked === PROMPT) {
			config.injectPrompt = !config.injectPrompt;
			deps.commit();
			continue;
		}
		if (picked === COMPACT) {
			const OFF = "pi default (no override)";
			const choice = await deps.ui.select("Which role summarises on compaction?", [
				OFF,
				...Object.keys(config.roles).sort().map((r) => `@${r}`),
				BACK,
			]);
			if (!choice || choice === BACK) continue;
			config.compactionRole = choice === OFF ? null : choice.slice(1);
			deps.commit();
			continue;
		}

		const index = rows.indexOf(picked);
		if (index >= 0) await editRole(deps, names[index]);
	}
}
