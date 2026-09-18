import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { type BoardResult, RoleBoard } from "../board.ts";
import { type AnyModel } from "../resolve.ts";
import { emptyConfig, type RolesFile } from "../types.ts";

const MODELS: AnyModel[] = [
	{ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", provider: "anthropic", reasoning: true, input: ["text", "image"], contextWindow: 200_000, cost: { input: 3, output: 15 } },
	{ id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "anthropic", reasoning: true, input: ["text", "image"], contextWindow: 200_000, cost: { input: 1, output: 5 } },
	{ id: "gpt-5.2", name: "GPT-5.2", provider: "openai", reasoning: true, input: ["text", "image"], contextWindow: 272_000, cost: { input: 1.25, output: 10 } },
];

const KEY = {
	tab: "\t",
	enter: "\r",
	escape: "",
	up: "[A",
	down: "[B",
	ctrlF: "",
	ctrlU: "",
	backspace: "",
};

function harness(seed?: (config: RolesFile) => void) {
	const config = emptyConfig();
	seed?.(config);
	let commits = 0;
	let scope: "global" | "project" = "global";
	const results: BoardResult[] = [];

	const board = new RoleBoard(
		{ requestRender() {} } as any,
		{ fg: (_color: string, text: string) => text, bold: (text: string) => text } as any,
		{
			source: { getAvailable: () => MODELS },
			getConfig: () => config,
			commit: () => {
				commits++;
			},
			scopeLabel: () => scope,
			toggleScope: () => {
				scope = scope === "global" ? "project" : "global";
			},
		},
		(result) => results.push(result),
	);

	const type = (text: string) => {
		for (const char of text) board.handleInput(char);
	};

	return { board, config, results, type, commits: () => commits, scope: () => scope };
}

test("enter on the catalog sets the selected role's primary model", () => {
	const h = harness();
	h.board.handleInput(KEY.tab);
	h.type("haiku");
	h.board.handleInput(KEY.enter);

	assert.equal(h.config.roles.default?.model, "anthropic/claude-haiku-4-5");
	assert.ok(h.commits() > 0, "the change was persisted");
});

test("ctrl+f appends to the fallback chain without touching the primary", () => {
	const h = harness((config) => {
		config.roles.default = { model: "anthropic/claude-sonnet-4-5" };
	});
	h.board.handleInput(KEY.tab);
	h.type("gpt");
	h.board.handleInput(KEY.ctrlF);

	assert.equal(h.config.roles.default?.model, "anthropic/claude-sonnet-4-5");
	assert.deepEqual(h.config.roles.default?.fallback, ["openai/gpt-5.2"]);
});

test("typing filters the catalog and ctrl+u clears the filter", () => {
	const h = harness();
	h.board.handleInput(KEY.tab);
	h.type("zzzz");
	assert.match(h.board.render(100).join("\n"), /no model matches/);

	h.board.handleInput(KEY.ctrlU);
	assert.doesNotMatch(h.board.render(100).join("\n"), /no model matches/);
});

test("backspace edits the filter one character at a time", () => {
	const h = harness();
	h.board.handleInput(KEY.tab);
	h.type("haikuX");
	assert.match(h.board.render(100).join("\n"), /no model matches/);

	h.board.handleInput(KEY.backspace);
	assert.doesNotMatch(h.board.render(100).join("\n"), /no model matches/);
});

test("t cycles the thinking level and wraps back to inherit", () => {
	const h = harness((config) => {
		config.roles.default = { model: "anthropic/claude-sonnet-4-5", thinking: "xhigh" };
	});
	h.type("t");
	assert.equal(h.config.roles.default?.thinking, "max");
	h.type("t");
	assert.equal(h.config.roles.default?.thinking, undefined, "max wraps to inherit");
	h.type("t");
	assert.equal(h.config.roles.default?.thinking, "off");
});

test("x clears the primary but keeps the fallbacks", () => {
	const h = harness((config) => {
		config.roles.default = { model: "anthropic/claude-sonnet-4-5", fallback: ["openai/gpt-5.2"] };
	});
	h.type("x");
	assert.equal(h.config.roles.default?.model, undefined);
	assert.deepEqual(h.config.roles.default?.fallback, ["openai/gpt-5.2"]);
});

test("- drops the last fallback and removes the empty list", () => {
	const h = harness((config) => {
		config.roles.default = { model: "anthropic/claude-sonnet-4-5", fallback: ["openai/gpt-5.2"] };
	});
	h.type("-");
	assert.equal(h.config.roles.default?.fallback, undefined);
});

test("p promotes the first fallback and demotes the old primary", () => {
	const h = harness((config) => {
		config.roles.default = { model: "anthropic/claude-sonnet-4-5", fallback: ["openai/gpt-5.2", "anthropic/claude-haiku-4-5"] };
	});
	h.type("p");
	assert.equal(h.config.roles.default?.model, "openai/gpt-5.2");
	assert.deepEqual(h.config.roles.default?.fallback, ["anthropic/claude-sonnet-4-5", "anthropic/claude-haiku-4-5"]);
});

test("built-in roles refuse deletion; custom roles ask the caller to confirm", () => {
	const h = harness((config) => {
		config.roles.reviewer = { description: "custom" };
	});
	h.type("d");
	assert.deepEqual(h.results, [], "no delete was requested for @default");
	assert.match(h.board.render(100).join("\n"), /built-in roles cannot be deleted/);

	// Custom roles sort after the built-ins; arrowing past the end clamps there.
	for (let i = 0; i < 20; i++) h.board.handleInput(KEY.down);
	h.type("d");
	assert.deepEqual(h.results, [{ kind: "deleteRole", role: "reviewer" }]);
});

test("enter on the roles pane asks the caller to apply the role", () => {
	const h = harness();
	h.board.handleInput(KEY.enter);
	assert.deepEqual(h.results, [{ kind: "applyRole", role: "default" }]);
});

test("escape closes the board, but first closes the help screen", () => {
	const h = harness();
	h.type("?");
	assert.match(h.board.render(100).join("\n"), /switch between the roles pane/);

	h.board.handleInput(KEY.escape);
	assert.deepEqual(h.results, [], "the first escape only dismissed help");

	h.board.handleInput(KEY.escape);
	assert.deepEqual(h.results, [{ kind: "close" }]);
});

test("s, i and c toggle the persisted board-level settings", () => {
	const h = harness();
	h.type("s");
	assert.equal(h.scope(), "project");

	assert.equal(h.config.injectPrompt, true);
	h.type("i");
	assert.equal(h.config.injectPrompt, false);

	assert.equal(h.config.compactionRole, null);
	h.type("c");
	assert.equal(h.config.compactionRole, "default");
});

test("no rendered line is wider than the terminal", () => {
	const h = harness((config) => {
		config.roles.default = { model: "anthropic/claude-sonnet-4-5", fallback: ["openai/gpt-5.2", "@smol"] };
	});
	for (const width of [60, 70, 76, 80, 100, 140, 200]) {
		for (const line of h.board.render(width)) {
			assert.ok(visibleWidth(line) <= width, `width ${width}: line overflows (${visibleWidth(line)})`);
		}
	}
});

test("the catalog marks the role's primary and its fallbacks, fuzzy selectors included", () => {
	const h = harness((config) => {
		// "haiku" is a fuzzy selector, not a literal id — the mark has to resolve it.
		config.roles.default = { model: "haiku", fallback: ["openai/gpt-5.2"] };
	});
	const rendered = h.board.render(120).join("\n");
	assert.match(rendered, /● claude-haiku-4-5\s+anthropic/);
	assert.match(rendered, /① gpt-5\.2\s+openai/);
});
