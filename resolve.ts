/**
 * Role -> concrete model resolution, with alias chains and fallback lists.
 */

import { THINKING_LEVELS, type RoleConfig, type RolesFile, type ThinkingLevel } from "./types.ts";

export interface AnyModel {
	id: string;
	name: string;
	provider: string;
	reasoning: boolean;
	input: string[];
	contextWindow: number;
	/** Price per million tokens, when the catalog knows it. */
	cost?: { input: number; output: number };
	maxTokens?: number;
}

export interface ModelSource {
	getAvailable(): AnyModel[];
}

export interface Resolved {
	/** Role the model came from (may differ from the requested one via alias). */
	role: string;
	model: AnyModel;
	thinking?: ThinkingLevel;
	/** The selector string that matched. */
	selector: string;
	/** Index in [model, ...fallback]; 0 means the primary choice was used. */
	rank: number;
	/** Alias hops taken, e.g. ["designer", "slow"]. */
	chain: string[];
}

/** Split `anthropic/claude-sonnet-4-5:high` into selector + thinking. */
export function splitSelector(raw: string): { spec: string; thinking?: ThinkingLevel } {
	const trimmed = raw.trim();
	const idx = trimmed.lastIndexOf(":");
	if (idx > 0) {
		const suffix = trimmed.slice(idx + 1).toLowerCase();
		if ((THINKING_LEVELS as string[]).includes(suffix)) {
			return { spec: trimmed.slice(0, idx), thinking: suffix as ThinkingLevel };
		}
	}
	return { spec: trimmed };
}

/** Exact `provider/id`, then exact id, then fuzzy on `provider/id` and name. */
export function matchModel(spec: string, models: AnyModel[]): AnyModel | undefined {
	const needle = spec.trim().toLowerCase();
	if (!needle) return undefined;

	if (needle.includes("/")) {
		const slash = needle.indexOf("/");
		const provider = needle.slice(0, slash);
		const id = needle.slice(slash + 1);
		const exact = models.find((m) => m.provider.toLowerCase() === provider && m.id.toLowerCase() === id);
		if (exact) return exact;
	} else {
		const exact = models.find((m) => m.id.toLowerCase() === needle);
		if (exact) return exact;
	}

	return (
		models.find((m) => `${m.provider}/${m.id}`.toLowerCase().includes(needle)) ??
		models.find((m) => m.name.toLowerCase().includes(needle))
	);
}

/**
 * Resolve a role to a live model.
 *
 * Order: the role's `model`, then each `fallback` in turn. An entry starting
 * with `@` hands off to another role; a `:thinking` suffix on the referring
 * entry wins over the target role's own level. Unresolvable roles fall through
 * to `default` once, so a half-configured file still runs.
 */
export function resolveRole(
	config: RolesFile,
	source: ModelSource,
	roleName: string,
	options: { seen?: Set<string>; thinkingOverride?: ThinkingLevel; chain?: string[]; allowDefault?: boolean } = {},
): Resolved | undefined {
	const seen = options.seen ?? new Set<string>();
	const chain = options.chain ?? [];
	const name = roleName.replace(/^@/, "").trim();
	if (!name || seen.has(name)) return undefined;
	seen.add(name);

	const role: RoleConfig | undefined = config.roles[name];
	const models = source.getAvailable();
	const candidates = [role?.model, ...(role?.fallback ?? [])].filter((c): c is string => typeof c === "string" && c.trim().length > 0);

	for (let rank = 0; rank < candidates.length; rank++) {
		const { spec, thinking } = splitSelector(candidates[rank]);
		const effectiveThinking = options.thinkingOverride ?? thinking ?? role?.thinking;

		if (spec.startsWith("@")) {
			const nested = resolveRole(config, source, spec, {
				seen,
				thinkingOverride: effectiveThinking,
				chain: [...chain, name],
				allowDefault: false,
			});
			if (nested) return { ...nested, rank, chain: [...chain, name] };
			continue;
		}

		const model = matchModel(spec, models);
		if (model) {
			return { role: name, model, thinking: effectiveThinking, selector: spec, rank, chain };
		}
	}

	if (options.allowDefault !== false && name !== "default") {
		const fallbackToDefault = resolveRole(config, source, "default", { seen, chain: [...chain, name], allowDefault: false });
		if (fallbackToDefault) return { ...fallbackToDefault, chain: [...chain, name] };
	}
	return undefined;
}

/** `provider/id` or `provider/id:thinking` — the form pi's `--model` accepts. */
export function selectorFor(resolved: Resolved, withThinking = true): string {
	const base = `${resolved.model.provider}/${resolved.model.id}`;
	return withThinking && resolved.thinking ? `${base}:${resolved.thinking}` : base;
}

export type RoleHealth = "unset" | "primary" | "fallback" | "broken";

/** What the TUI shows next to each role. */
export function roleHealth(config: RolesFile, source: ModelSource, name: string): { health: RoleHealth; resolved?: Resolved } {
	const role = config.roles[name];
	const hasAny = Boolean(role?.model) || (role?.fallback?.length ?? 0) > 0;
	if (!hasAny) return { health: "unset" };
	const resolved = resolveRole(config, source, name, { allowDefault: false });
	if (!resolved) return { health: "broken" };
	return { health: resolved.rank === 0 ? "primary" : "fallback", resolved };
}
