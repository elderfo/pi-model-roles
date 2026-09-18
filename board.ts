/**
 * The role board — a two-pane overlay for `/roles` in interactive mode.
 *
 * Left: your roles, each with the model it currently resolves to.
 * Right: the live model catalog, filtered as you type.
 *
 * Pick a role on the left, tab to the right, type a few letters, press enter.
 * That is the whole loop for changing a role's model — no sub-menus, and the
 * catalog is always on screen so you never have to remember what you can use.
 *
 * Non-interactive modes fall back to the menu tree in ui.ts.
 *
 * Imports only pi-tui, never the agent package, so the board can be driven
 * headlessly in tests.
 */

import { Key, type Component, type TUI, fuzzyFilter, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type AnyModel, type ModelSource, matchModel, resolveRole, roleHealth, selectorFor, splitSelector } from "./resolve.ts";
import { BUILT_IN_ROLES, THINKING_LEVELS, type RolesFile, type ThinkingLevel } from "./types.ts";

/** What the board asks the caller to do after it closes. */
export type BoardResult =
	| { kind: "close" }
	| { kind: "newRole" }
	| { kind: "deleteRole"; role: string }
	| { kind: "agents" }
	| { kind: "advisor" }
	| { kind: "applyRole"; role: string };

export interface BoardDeps {
	source: ModelSource;
	getConfig(): RolesFile;
	/** Persist the in-memory config to the active scope. */
	commit(): void;
	/** Label for the active save scope, e.g. "global". */
	scopeLabel(): string;
	toggleScope(): void;
}

type Theme = {
	fg(color: string, text: string): string;
	bold(text: string): string;
};

const ROWS = 12;
const HEALTH_ICON: Record<string, string> = { unset: "○", primary: "●", fallback: "◐", broken: "✗" };
const HEALTH_COLOR: Record<string, string> = { unset: "dim", primary: "success", fallback: "warning", broken: "error" };
const FALLBACK_MARKS = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨"];

function pad(text: string, width: number): string {
	return truncateToWidth(text, width, "…", true);
}

function fit(text: string, width: number): string {
	return visibleWidth(text) > width ? truncateToWidth(text, width, "…") : text;
}

function compactTokens(count: number): string {
	if (!count || count <= 0) return "";
	if (count >= 1_000_000) return `${Math.round(count / 100_000) / 10}M`;
	if (count >= 1_000) return `${Math.round(count / 1_000)}K`;
	return String(count);
}

function modelKey(model: AnyModel): string {
	return `${model.provider}/${model.id}`;
}

/** Trailing column of a model row: provider, context window, modalities, price. */
function modelMeta(model: AnyModel): string {
	const bits: string[] = [model.provider];
	const ctx = compactTokens(model.contextWindow);
	if (ctx) bits.push(`${ctx} ctx`);
	if (model.input?.includes("image")) bits.push("vision");
	if (model.reasoning) bits.push("reasoning");
	const cost = model.cost;
	if (cost && (cost.input > 0 || cost.output > 0)) bits.push(`$${cost.input}/$${cost.output}`);
	return bits.join(" · ");
}

/** Cycle order for the `t` key: the seven levels, then back to inherit. */
function nextThinking(current: ThinkingLevel | undefined): ThinkingLevel | undefined {
	if (!current) return THINKING_LEVELS[0];
	const index = THINKING_LEVELS.indexOf(current);
	return index === -1 || index === THINKING_LEVELS.length - 1 ? undefined : THINKING_LEVELS[index + 1];
}

export class RoleBoard implements Component {
	private focus: "roles" | "models" = "roles";
	private roleIndex = 0;
	private roleScroll = 0;
	private modelIndex = 0;
	private modelScroll = 0;
	private filter = "";
	private flash = "";
	private helpOpen = false;

	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly deps: BoardDeps;
	private readonly done: (result: BoardResult) => void;

	// Plain assignment rather than parameter properties: Node's type-stripping
	// test runner rejects those, and the board is worth testing headlessly.
	constructor(tui: TUI, theme: Theme, deps: BoardDeps, done: (result: BoardResult) => void) {
		this.tui = tui;
		this.theme = theme;
		this.deps = deps;
		this.done = done;
	}

	// ---- data ---------------------------------------------------------------

	private roleNames(): string[] {
		const order = Object.keys(BUILT_IN_ROLES);
		return Object.keys(this.deps.getConfig().roles).sort((a, b) => {
			const ia = order.indexOf(a);
			const ib = order.indexOf(b);
			if (ia !== -1 && ib !== -1) return ia - ib;
			if (ia !== -1) return -1;
			if (ib !== -1) return 1;
			return a.localeCompare(b);
		});
	}

	private currentRole(): string | undefined {
		return this.roleNames()[this.roleIndex];
	}

	private models(): AnyModel[] {
		const all = this.deps.source.getAvailable();
		if (!this.filter.trim()) return [...all].sort((a, b) => modelKey(a).localeCompare(modelKey(b)));
		return fuzzyFilter(all, this.filter, (m) => `${modelKey(m)} ${m.name}`);
	}

	/**
	 * What a selector actually points at right now.
	 *
	 * Selectors are not always literal ids — `haiku` and `@slow` are both legal —
	 * so the marks in the catalog have to compare resolved models, not strings.
	 */
	private resolveSelector(selector: string): AnyModel | undefined {
		const { spec } = splitSelector(selector);
		if (spec.startsWith("@")) {
			return resolveRole(this.deps.getConfig(), this.deps.source, spec, { allowDefault: false })?.model;
		}
		return matchModel(spec, this.deps.source.getAvailable());
	}

	/** `●` when the model is the role's primary, `①②③` for its fallbacks. */
	private markFor(model: AnyModel, role: string | undefined): string {
		if (!role) return " ";
		const entry = this.deps.getConfig().roles[role];
		if (!entry) return " ";

		const same = (other: AnyModel | undefined) => other?.provider === model.provider && other?.id === model.id;
		if (entry.model && same(this.resolveSelector(entry.model))) return "●";

		const index = (entry.fallback ?? []).findIndex((f) => same(this.resolveSelector(f)));
		return index === -1 ? " " : (FALLBACK_MARKS[index] ?? "·");
	}

	// ---- rendering ----------------------------------------------------------

	render(width: number): string[] {
		const theme = this.theme;
		const roles = this.roleNames();
		const models = this.models();
		this.clampScroll(roles.length, models.length);

		const lines: string[] = [];
		lines.push(`  ${theme.fg("accent", theme.bold("Model roles"))}${theme.fg("dim", "   one table the whole session reads from")}`);
		lines.push("");

		const rolesHeader = this.focus === "roles" ? theme.fg("accent", theme.bold("ROLES")) : theme.fg("muted", "ROLES");
		const modelsHeader = this.focus === "models" ? theme.fg("accent", theme.bold("MODELS")) : theme.fg("muted", "MODELS");
		const filterLabel = this.filter ? theme.fg("accent", `/${this.filter}`) : theme.fg("dim", "type to filter");
		const catalogHeader = `${modelsHeader} ${theme.fg("dim", String(models.length))}  ${filterLabel}`;

		// Narrow terminals show one pane at a time; tab still swaps them.
		if (width < 80) {
			const paneWidth = width - 4;
			lines.push(`  ${fit(this.focus === "roles" ? rolesHeader : catalogHeader, paneWidth)}`);
			for (let row = 0; row < ROWS; row++) {
				const line =
					this.focus === "roles"
						? this.renderRoleRow(roles, this.roleScroll + row, paneWidth)
						: this.renderModelRow(models, this.modelScroll + row, paneWidth);
				lines.push(`  ${fit(line, paneWidth)}`);
			}
		} else {
			const leftWidth = Math.max(24, Math.min(40, Math.floor(width * 0.4)));
			const rightWidth = Math.max(24, width - leftWidth - 7);
			lines.push(`  ${pad(rolesHeader, leftWidth)} ${theme.fg("dim", "│")} ${fit(catalogHeader, rightWidth)}`);
			for (let row = 0; row < ROWS; row++) {
				const left = this.renderRoleRow(roles, this.roleScroll + row, leftWidth);
				const right = this.renderModelRow(models, this.modelScroll + row, rightWidth);
				lines.push(`  ${pad(left, leftWidth)} ${theme.fg("dim", "│")} ${fit(right, rightWidth)}`);
			}
		}

		lines.push("");
		lines.push(...this.renderDetail(width));
		lines.push("");
		lines.push(...(this.helpOpen ? this.renderHelp() : this.renderFooter(width)));
		return lines.map((line) => fit(line, width));
	}

	private clampScroll(roleCount: number, modelCount: number): void {
		this.roleIndex = Math.max(0, Math.min(this.roleIndex, roleCount - 1));
		this.modelIndex = Math.max(0, Math.min(this.modelIndex, Math.max(0, modelCount - 1)));
		this.roleScroll = Math.max(0, Math.min(this.roleScroll, Math.max(0, roleCount - ROWS)));
		this.modelScroll = Math.max(0, Math.min(this.modelScroll, Math.max(0, modelCount - ROWS)));
		if (this.roleIndex < this.roleScroll) this.roleScroll = this.roleIndex;
		if (this.roleIndex >= this.roleScroll + ROWS) this.roleScroll = this.roleIndex - ROWS + 1;
		if (this.modelIndex < this.modelScroll) this.modelScroll = this.modelIndex;
		if (this.modelIndex >= this.modelScroll + ROWS) this.modelScroll = this.modelIndex - ROWS + 1;
	}

	private renderRoleRow(roles: string[], index: number, width: number): string {
		if (index >= roles.length) return "";
		const theme = this.theme;
		const config = this.deps.getConfig();
		const name = roles[index];
		const { health, resolved } = roleHealth(config, this.deps.source, name);
		const selected = index === this.roleIndex;

		const icon = theme.fg(HEALTH_COLOR[health] ?? "dim", HEALTH_ICON[health] ?? "?");
		const label = pad(`@${name}`, 9);

		// Only the model id here — the provider and the full chain live in the
		// detail block, and role rows have to stay scannable.
		const thinking = resolved?.thinking ? theme.fg("dim", `:${resolved.thinking}`) : "";
		const target = resolved ? `${resolved.model.id}${thinking}` : theme.fg("dim", "— not set —");
		const depth = resolved && resolved.rank > 0 ? theme.fg("warning", ` ↓${resolved.rank}`) : "";
		const spare = (config.roles[name]?.fallback?.length ?? 0) > 0 ? theme.fg("dim", ` +${config.roles[name]?.fallback?.length}`) : "";

		const body = `${icon} ${selected ? theme.bold(label) : label} ${target}${depth}${spare}`;
		const row = fit(body, width - 2);
		return selected && this.focus === "roles"
			? `${theme.fg("accent", "▸")} ${theme.fg("accent", row)}`
			: selected
				? `${theme.fg("muted", "▸")} ${row}`
				: `  ${row}`;
	}

	private renderModelRow(models: AnyModel[], index: number, width: number): string {
		const theme = this.theme;
		if (models.length === 0 && index === 0) return theme.fg("warning", "no model matches this filter");
		if (index >= models.length) return "";

		const model = models[index];
		const selected = index === this.modelIndex;
		const mark = this.markFor(model, this.currentRole());
		const nameWidth = Math.max(14, Math.min(34, Math.floor(width * 0.45)));
		const meta = width - nameWidth > 16 ? modelMeta(model) : model.provider;

		const body = `${mark === " " ? " " : theme.fg("success", mark)} ${pad(model.id, nameWidth)} ${theme.fg("dim", meta)}`;
		const row = fit(body, width - 2);
		return selected && this.focus === "models"
			? `${theme.fg("accent", "▸")} ${theme.fg("accent", row)}`
			: selected
				? `${theme.fg("muted", "▸")} ${row}`
				: `  ${row}`;
	}

	private renderDetail(width: number): string[] {
		const theme = this.theme;
		const name = this.currentRole();
		if (!name) return [theme.fg("dim", "  no roles configured")];

		const config = this.deps.getConfig();
		const role = config.roles[name] ?? {};
		const { resolved } = roleHealth(config, this.deps.source, name);
		const description = role.description ?? BUILT_IN_ROLES[name] ?? "";

		const chain = [role.model ? theme.fg("success", role.model) : theme.fg("dim", "— not set —"), ...(role.fallback ?? []).map((f) => theme.fg("muted", f))].join(
			theme.fg("dim", " → "),
		);

		const resolvedNote = resolved
			? `${selectorFor(resolved)}${resolved.rank > 0 ? theme.fg("warning", ` (fallback #${resolved.rank})`) : ""}`
			: theme.fg("error", "nothing in the chain is available");

		return [
			fit(`  ${theme.fg("accent", theme.bold(`@${name}`))} ${theme.fg("dim", description)}`, width - 2),
			fit(`  ${theme.fg("dim", "chain   ")}${chain}`, width - 2),
			fit(
				`  ${theme.fg("dim", "resolves")} ${resolvedNote}   ${theme.fg("dim", "thinking")} ${role.thinking ?? theme.fg("dim", "inherit")}`,
				width - 2,
			),
		];
	}

	private renderFooter(width: number): string[] {
		const theme = this.theme;
		const config = this.deps.getConfig();
		const key = (text: string) => theme.fg("accent", text);
		const sep = theme.fg("dim", " · ");

		const paneHints =
			this.focus === "models"
				? [`${key("enter")} set as primary`, `${key("ctrl+f")} add fallback`, `${key("type")} filter`, `${key("ctrl+u")} clear filter`]
				: [`${key("enter")} use in session`, `${key("t")} thinking`, `${key("x")} clear model`, `${key("-")} drop fallback`, `${key("p")} promote`];

		const state = [
			`${key("s")} scope:${config ? this.deps.scopeLabel() : "?"}`,
			`${key("i")} prompt:${config.injectPrompt ? "on" : "off"}`,
			`${key("c")} compact:${config.compactionRole ? `@${config.compactionRole}` : "off"}`,
			`${key("v")} advisor:${config.advisor.enabled ? "on" : "off"}`,
		];

		// Drop hints from the right until the line fits rather than spilling.
		const clip = (parts: string[]) => {
			const kept = [...parts];
			while (kept.length > 1 && visibleWidth(kept.join(sep)) > width - 4) kept.pop();
			return `  ${kept.join(sep)}${kept.length < parts.length ? theme.fg("dim", " …") : ""}`;
		};

		const lines = [
			clip([`${theme.fg("dim", "↑↓")} move`, `${key("tab")} ${this.focus === "roles" ? "→ models" : "→ roles"}`, ...paneHints]),
			clip([...state, `${key("n")} new`, `${key("d")} delete`, `${key("a")} agents`, `${key("?")} help`, `${key("esc")} close`]),
		];
		if (this.flash) lines.push(`  ${theme.fg("success", fit(this.flash, width - 4))}`);
		return lines;
	}

	private renderHelp(): string[] {
		const theme = this.theme;
		const row = (keys: string, text: string) => `  ${theme.fg("accent", pad(keys, 12))} ${theme.fg("muted", text)}`;
		return [
			`  ${theme.bold("Keys")}`,
			row("tab", "switch between the roles pane and the model catalog"),
			row("↑ ↓", "move within the focused pane"),
			row("enter", "models pane: make the highlighted model the role's primary"),
			row("", "roles pane: switch this session to the role's model"),
			row("ctrl+f", "models pane: append that model to the role's fallback chain"),
			row("a-z 0-9", "models pane: fuzzy-filter the catalog (ctrl+u clears)"),
			row("t", "cycle the role's thinking level, ending at inherit"),
			row("x", "clear the role's primary model, keeping its fallbacks"),
			row("-", "drop the last fallback"),
			row("p", "promote fallback #1 to primary"),
			row("n / d", "create a custom role / delete the selected custom role"),
			row("a / v", "agent → role mapping / advisor settings"),
			row("s / i / c", "save scope / role cheat-sheet in prompt / compaction role"),
			row("? / esc", "close this help / close the board"),
			`  ${theme.fg("dim", "● primary  ◐ running on a fallback  ✗ nothing available  ○ unset")}`,
		];
	}

	// ---- input --------------------------------------------------------------

	invalidate(): void {}

	handleInput(data: string): void {
		this.flash = "";

		if (matchesKey(data, Key.escape)) {
			if (this.helpOpen) this.helpOpen = false;
			else this.done({ kind: "close" });
			return this.tui.requestRender();
		}
		if (this.helpOpen) {
			this.helpOpen = false;
			return this.tui.requestRender();
		}
		if (matchesKey(data, Key.tab)) {
			this.focus = this.focus === "roles" ? "models" : "roles";
			return this.tui.requestRender();
		}
		if (matchesKey(data, Key.up)) return this.move(-1);
		if (matchesKey(data, Key.down)) return this.move(1);
		if (matchesKey(data, Key.pageUp)) return this.move(-ROWS);
		if (matchesKey(data, Key.pageDown)) return this.move(ROWS);
		if (matchesKey(data, Key.left) && this.focus === "models") {
			this.focus = "roles";
			return this.tui.requestRender();
		}
		if (matchesKey(data, Key.right) && this.focus === "roles") {
			this.focus = "models";
			return this.tui.requestRender();
		}

		if (this.focus === "models") return this.handleModelsInput(data);
		return this.handleRolesInput(data);
	}

	/**
	 * Clamp here rather than only in render: holding an arrow key past the end
	 * would otherwise leave the cursor pointing at nothing, and every key that
	 * needs a selected row would quietly do nothing until the next render.
	 */
	private move(delta: number): void {
		const limit = (this.focus === "roles" ? this.roleNames().length : this.models().length) - 1;
		const next = (this.focus === "roles" ? this.roleIndex : this.modelIndex) + delta;
		const clamped = Math.max(0, Math.min(next, Math.max(0, limit)));
		if (this.focus === "roles") this.roleIndex = clamped;
		else this.modelIndex = clamped;
		this.tui.requestRender();
	}

	private handleModelsInput(data: string): void {
		const role = this.currentRole();
		const models = this.models();
		const model = models[this.modelIndex];

		if (matchesKey(data, Key.enter)) {
			if (role && model) {
				this.mutate(role, (entry) => {
					entry.model = modelKey(model);
				});
				this.flash = `@${role} primary → ${modelKey(model)}`;
			}
			return this.tui.requestRender();
		}
		if (matchesKey(data, Key.ctrl("f"))) {
			if (role && model) {
				this.mutate(role, (entry) => {
					entry.fallback = [...(entry.fallback ?? []), modelKey(model)];
				});
				this.flash = `@${role} fallback += ${modelKey(model)}`;
			}
			return this.tui.requestRender();
		}
		if (matchesKey(data, Key.ctrl("u"))) {
			this.filter = "";
			this.modelIndex = 0;
			return this.tui.requestRender();
		}
		if (matchesKey(data, Key.backspace)) {
			this.filter = this.filter.slice(0, -1);
			this.modelIndex = 0;
			return this.tui.requestRender();
		}
		// Printable ASCII goes to the filter — the catalog is a search box.
		if (data.length === 1 && data >= " " && data <= "~") {
			this.filter += data;
			this.modelIndex = 0;
			return this.tui.requestRender();
		}
	}

	private handleRolesInput(data: string): void {
		const config = this.deps.getConfig();
		const role = this.currentRole();

		if (matchesKey(data, Key.enter)) {
			if (role) this.done({ kind: "applyRole", role });
			return;
		}
		if (!role) return;

		switch (data) {
			case "t":
				this.mutate(role, (entry) => {
					const next = nextThinking(entry.thinking);
					if (next) entry.thinking = next;
					else delete entry.thinking;
				});
				this.flash = `@${role} thinking → ${config.roles[role]?.thinking ?? "inherit"}`;
				break;
			case "x":
				this.mutate(role, (entry) => {
					delete entry.model;
				});
				this.flash = `@${role} primary cleared`;
				break;
			case "-":
				this.mutate(role, (entry) => {
					const fallback = [...(entry.fallback ?? [])];
					fallback.pop();
					if (fallback.length > 0) entry.fallback = fallback;
					else delete entry.fallback;
				});
				this.flash = `@${role} dropped last fallback`;
				break;
			case "p":
				this.mutate(role, (entry) => {
					const fallback = [...(entry.fallback ?? [])];
					const promoted = fallback.shift();
					if (!promoted) return;
					if (entry.model) fallback.unshift(entry.model);
					entry.model = promoted;
					if (fallback.length > 0) entry.fallback = fallback;
					else delete entry.fallback;
				});
				this.flash = `@${role} promoted fallback #1`;
				break;
			case "n":
				return this.done({ kind: "newRole" });
			case "d":
				if (role in BUILT_IN_ROLES) this.flash = "built-in roles cannot be deleted";
				else return this.done({ kind: "deleteRole", role });
				break;
			case "a":
				return this.done({ kind: "agents" });
			case "v":
				return this.done({ kind: "advisor" });
			case "s":
				this.deps.toggleScope();
				this.deps.commit();
				this.flash = `saving to ${this.deps.scopeLabel()}`;
				break;
			case "i":
				config.injectPrompt = !config.injectPrompt;
				this.deps.commit();
				break;
			case "c": {
				const names = [null, ...Object.keys(config.roles)];
				const current = names.indexOf(config.compactionRole);
				config.compactionRole = names[(current + 1) % names.length] ?? null;
				this.deps.commit();
				break;
			}
			case "?":
				this.helpOpen = true;
				break;
			default:
				return;
		}
		this.tui.requestRender();
	}

	private mutate(role: string, change: (entry: NonNullable<RolesFile["roles"][string]>) => void): void {
		const config = this.deps.getConfig();
		const entry = (config.roles[role] ??= {});
		change(entry);
		this.deps.commit();
	}
}
