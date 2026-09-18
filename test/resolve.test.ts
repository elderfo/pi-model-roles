import assert from "node:assert/strict";
import { test } from "node:test";
import { matchModel, resolveRole, selectorFor, splitSelector, roleHealth, type AnyModel } from "../resolve.ts";
import { emptyConfig, type RolesFile } from "../types.ts";

const MODELS: AnyModel[] = [
	{ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", provider: "anthropic", reasoning: true, input: ["text", "image"], contextWindow: 200_000 },
	{ id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "anthropic", reasoning: true, input: ["text", "image"], contextWindow: 200_000 },
	{ id: "gpt-5.2", name: "GPT-5.2", provider: "openai", reasoning: true, input: ["text", "image"], contextWindow: 272_000 },
	{ id: "claude-sonnet-4-5", name: "Sonnet via proxy", provider: "proxy", reasoning: true, input: ["text"], contextWindow: 200_000 },
];

const source = { getAvailable: () => MODELS };

function config(roles: RolesFile["roles"]): RolesFile {
	const base = emptyConfig();
	base.roles = { ...base.roles, ...roles };
	return base;
}

test("splitSelector separates a thinking suffix from the selector", () => {
	assert.deepEqual(splitSelector("anthropic/claude-opus-4-5:high"), { spec: "anthropic/claude-opus-4-5", thinking: "high" });
	assert.deepEqual(splitSelector("openai/gpt-5.2"), { spec: "openai/gpt-5.2" });
	// A colon that is not a thinking level belongs to the selector.
	assert.deepEqual(splitSelector("vertex/publishers:model"), { spec: "vertex/publishers:model" });
});

test("matchModel prefers provider/id, then exact id, then fuzzy", () => {
	assert.equal(matchModel("proxy/claude-sonnet-4-5", MODELS)?.provider, "proxy");
	assert.equal(matchModel("gpt-5.2", MODELS)?.provider, "openai");
	assert.equal(matchModel("haiku", MODELS)?.id, "claude-haiku-4-5");
	assert.equal(matchModel("Sonnet via", MODELS)?.provider, "proxy");
	assert.equal(matchModel("does-not-exist", MODELS), undefined);
});

test("a role resolves to its primary model", () => {
	const cfg = config({ default: { model: "anthropic/claude-sonnet-4-5" } });
	const resolved = resolveRole(cfg, source, "default");
	assert.equal(selectorFor(resolved!), "anthropic/claude-sonnet-4-5");
	assert.equal(resolved!.rank, 0);
});

test("fallback takes over when the primary is unavailable, keeping the role thinking level", () => {
	const cfg = config({ smol: { model: "dead/model", fallback: ["haiku"], thinking: "low" } });
	const resolved = resolveRole(cfg, source, "smol");
	assert.equal(selectorFor(resolved!), "anthropic/claude-haiku-4-5:low");
	assert.equal(resolved!.rank, 1);
	assert.equal(roleHealth(cfg, source, "smol").health, "fallback");
});

test("an alias inherits the target model, and a suffix on the referring role wins", () => {
	const cfg = config({
		slow: { model: "openai/gpt-5.2:high" },
		designer: { model: "@slow" },
		plan: { model: "@slow:medium" },
	});
	assert.equal(selectorFor(resolveRole(cfg, source, "designer")!), "openai/gpt-5.2:high");
	assert.equal(selectorFor(resolveRole(cfg, source, "plan")!), "openai/gpt-5.2:medium");
});

test("an unresolvable role falls through to @default but still reports as broken", () => {
	const cfg = config({ default: { model: "anthropic/claude-sonnet-4-5" }, vision: { model: "dead/model" } });
	assert.equal(selectorFor(resolveRole(cfg, source, "vision")!), "anthropic/claude-sonnet-4-5");
	assert.equal(roleHealth(cfg, source, "vision").health, "broken");
});

test("an alias cycle terminates instead of recursing forever", () => {
	const cfg = config({ a: { model: "@b" }, b: { model: "@a" } });
	assert.equal(resolveRole(cfg, source, "a", { allowDefault: false }), undefined);
});

test("a role with nothing configured reads as unset", () => {
	assert.equal(roleHealth(emptyConfig(), source, "commit").health, "unset");
});

test("selectorFor can drop the thinking suffix for tools that take it separately", () => {
	const cfg = config({ slow: { model: "openai/gpt-5.2", thinking: "high" } });
	const resolved = resolveRole(cfg, source, "slow")!;
	assert.equal(selectorFor(resolved, true), "openai/gpt-5.2:high");
	assert.equal(selectorFor(resolved, false), "openai/gpt-5.2");
});
