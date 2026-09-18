/**
 * Types, constants and defaults.
 *
 * Deliberately free of pi imports and of node:fs — everything here is pure
 * data, so resolution logic and its tests can run without a pi runtime.
 */

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * One role slot.
 *
 * `model` and every `fallback` entry may be a concrete selector
 * (`provider/id`, a bare id, or a fuzzy substring) or an alias (`@slow`),
 * each optionally carrying a `:thinking` suffix.
 */
export interface RoleConfig {
	model?: string;
	thinking?: ThinkingLevel;
	fallback?: string[];
	description?: string;
}

export type AdvisorMode = "advise" | "steer";
export type Severity = "ok" | "note" | "concern" | "blocker";

export const SEVERITIES: Severity[] = ["ok", "note", "concern", "blocker"];

export interface AdvisorConfig {
	enabled: boolean;
	/** Review every N completed turns. */
	everyTurns: number;
	/** advise = hand the plan to the main agent; steer = tell it to dispatch now. */
	mode: AdvisorMode;
	/** Do not inject anything below this severity. */
	minSeverity: Severity;
	/** Max advisor notes carried in one injection. */
	maxNotes: number;
}

export interface RolesFile {
	roles: Record<string, RoleConfig>;
	/** subagent definition name -> role name. */
	agentRoles: Record<string, string>;
	advisor: AdvisorConfig;
	/** Append a short role cheat-sheet to the system prompt. */
	injectPrompt: boolean;
	/** Role used to summarize on compaction. null = leave pi's default alone. */
	compactionRole: string | null;
}

/** Built-in role names, in display order, with what each one is for. */
export const BUILT_IN_ROLES: Record<string, string> = {
	default: "Main session / primary work",
	smol: "Cheap and fast — scouting, greps, recon",
	slow: "Deep reasoning, hard debugging, architecture",
	vision: "Image and screenshot analysis",
	plan: "Brainstorming and planning",
	designer: "Frontend design, UI/UX",
	commit: "Git work — commit messages, diffs, PRs",
	tiny: "Micro tasks — session names, memory, classification",
	task: "Default executor for delegated subagents",
	advisor: "Supervisor that reviews turns and routes work",
};

export const DEFAULT_ADVISOR: AdvisorConfig = {
	enabled: false,
	everyTurns: 1,
	mode: "advise",
	minSeverity: "concern",
	maxNotes: 3,
};

export function emptyConfig(): RolesFile {
	const roles: Record<string, RoleConfig> = {};
	for (const [name, description] of Object.entries(BUILT_IN_ROLES)) roles[name] = { description };
	return { roles, agentRoles: {}, advisor: { ...DEFAULT_ADVISOR }, injectPrompt: true, compactionRole: null };
}
