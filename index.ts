/**
 * pi-model-roles — assign models to roles instead of to individual agents.
 *
 * Roles: default, smol, slow, vision, plan, designer, commit, tiny, task,
 * advisor — plus any custom role you create. Every role has a primary model
 * and an ordered fallback chain, so a provider outage or a revoked key
 * degrades instead of breaking.
 *
 * Wiring:
 *   /roles                  full TUI (pick models, fallbacks, create, delete)
 *   /role <name>            switch the current session to that role's model
 *   /advisor [on|off]       toggle the supervisor
 *   subagent spawns         get their model from the role mapped to the agent
 *   compaction              can be handed to a cheap role
 */

import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { type RolesFile, loadConfig, saveConfig } from "./config.ts";
import { type ModelSource, resolveRole, selectorFor } from "./resolve.ts";
import { renderVerdict, runAdvisorReview, shouldInject } from "./advisor.ts";
import { currentSavePath, openRolesUi } from "./ui.ts";

/** Tool names that spawn a child agent, across the subagent extensions in use. */
const SPAWN_TOOLS = new Set(["subagent", "agent", "subagent_delegate", "subagent_run", "task"]);

/** Tools whose model parameter accepts a `:thinking` suffix (they pass it to `--model`). */
const SUFFIX_TOOLS = new Set(["subagent"]);

export default function (pi: ExtensionAPI) {
	let config: RolesFile | undefined;
	let configCwd = "";
	let lastUserPrompt = "";
	let turnsSinceReview = 0;
	let reviewing = false;

	function sourceFor(ctx: ExtensionContext): ModelSource {
		return { getAvailable: () => ctx.modelRegistry.getAvailable() as any };
	}

	function ensure(ctx: ExtensionContext): RolesFile {
		if (!config || configCwd !== ctx.cwd) {
			configCwd = ctx.cwd;
			config = loadConfig(ctx.cwd);
		}
		return config;
	}

	function statusLine(ctx: ExtensionContext): void {
		const cfg = ensure(ctx);
		ctx.ui.setStatus("model-roles", cfg.advisor.enabled ? "advisor on" : undefined);
	}

	async function applyRole(name: string, ctx: ExtensionContext): Promise<string> {
		const cfg = ensure(ctx);
		const resolved = resolveRole(cfg, sourceFor(ctx), name);
		if (!resolved) return `@${name} does not resolve to an available model.`;

		const model = ctx.modelRegistry.find(resolved.model.provider, resolved.model.id);
		if (!model) return `@${name} -> ${selectorFor(resolved)} is not in the registry.`;

		const ok = await pi.setModel(model);
		if (!ok) return `No auth configured for ${resolved.model.provider}.`;
		if (resolved.thinking) pi.setThinkingLevel(resolved.thinking);

		const note = resolved.rank > 0 ? ` (fallback #${resolved.rank})` : "";
		return `@${name} -> ${selectorFor(resolved)}${note}`;
	}

	function cheatSheet(ctx: ExtensionContext): string {
		const cfg = ensure(ctx);
		const lines: string[] = [];
		for (const [name, role] of Object.entries(cfg.roles)) {
			const resolved = resolveRole(cfg, sourceFor(ctx), name, { allowDefault: false });
			if (!resolved) continue;
			lines.push(`- @${name}: ${role.description ?? ""} (${selectorFor(resolved)})`);
		}
		if (lines.length === 0) return "";
		return [
			"",
			"## Model roles",
			"When you spawn a subagent you may pass a role alias as the model, e.g.",
			'`subagent({ agent: "scout", model: "@smol", task: "..." })`. Omit the model and the',
			"agent's mapped role is used automatically. Available roles:",
			...lines,
		].join("\n");
	}

	// ---- config surface -----------------------------------------------------

	pi.on("session_start", (_event, ctx) => {
		config = undefined;
		ensure(ctx);
		statusLine(ctx);
	});

	pi.registerCommand("roles", {
		description: "Configure which model each role uses (TUI)",
		handler: async (_args, ctx) => {
			const cfg = ensure(ctx);
			await openRolesUi({
				ui: ctx.ui,
				cwd: ctx.cwd,
				source: sourceFor(ctx),
				getConfig: () => cfg,
				commit: () => saveConfig(currentSavePath(ctx.cwd), cfg),
				applyRole: (name) => applyRole(name, ctx),
			});
			statusLine(ctx);
		},
	});

	pi.registerCommand("role", {
		description: "Switch the session to a role's model (usage: /role slow)",
		handler: async (args, ctx) => {
			const cfg = ensure(ctx);
			const name = args.trim().replace(/^@/, "");
			if (!name) {
				const rows = Object.keys(cfg.roles).map((r) => {
					const resolved = resolveRole(cfg, sourceFor(ctx), r, { allowDefault: false });
					return `@${r} -> ${resolved ? selectorFor(resolved) : "unset"}`;
				});
				ctx.ui.notify(rows.join("\n"), "info");
				return;
			}
			ctx.ui.notify(await applyRole(name, ctx), "info");
		},
	});

	pi.registerCommand("advisor", {
		description: "Turn the advisor on or off (usage: /advisor on|off)",
		handler: async (args, ctx) => {
			const cfg = ensure(ctx);
			const arg = args.trim().toLowerCase();
			if (arg === "on" || arg === "off") {
				if (arg === "on" && !resolveRole(cfg, sourceFor(ctx), "advisor", { allowDefault: false })) {
					ctx.ui.notify("Assign a model to @advisor first (/roles -> advisor).", "warning");
					return;
				}
				cfg.advisor.enabled = arg === "on";
				saveConfig(currentSavePath(ctx.cwd), cfg);
			}
			const resolved = resolveRole(cfg, sourceFor(ctx), "advisor", { allowDefault: false });
			ctx.ui.notify(
				`Advisor ${cfg.advisor.enabled ? "on" : "off"} · mode ${cfg.advisor.mode} · every ${cfg.advisor.everyTurns} turn(s) · ${
					resolved ? selectorFor(resolved) : "no model"
				}`,
				"info",
			);
			statusLine(ctx);
		},
	});

	// ---- role cheat-sheet + prompt capture ----------------------------------

	pi.on("before_agent_start", (event, ctx) => {
		lastUserPrompt = typeof event.prompt === "string" ? event.prompt : "";
		const cfg = ensure(ctx);
		if (!cfg.injectPrompt) return;
		const sheet = cheatSheet(ctx);
		if (!sheet) return;
		return { systemPrompt: `${event.systemPrompt}\n${sheet}` };
	});

	// ---- subagent spawns inherit their role's model --------------------------

	pi.on("tool_call", (event, ctx) => {
		if (!SPAWN_TOOLS.has(event.toolName)) return;
		const input = event.input as Record<string, any>;
		if (!input || typeof input !== "object") return;

		const cfg = ensure(ctx);
		const raw = typeof input.model === "string" ? input.model.trim() : "";
		const agentName = input.agent ?? input.type ?? input.subagent ?? input.agent_type;

		let roleName: string | undefined;
		if (raw.startsWith("@")) {
			roleName = raw.slice(1).split(":")[0];
		} else if (!raw) {
			roleName = (typeof agentName === "string" ? cfg.agentRoles[agentName] : undefined) ?? "task";
		} else {
			// An explicit concrete model is the caller's decision; leave it alone.
			return;
		}

		const resolved = resolveRole(cfg, sourceFor(ctx), roleName);
		if (!resolved) {
			if (raw.startsWith("@")) delete input.model; // Never ship a literal "@role" to the CLI.
			return;
		}

		if (SUFFIX_TOOLS.has(event.toolName)) {
			input.model = selectorFor(resolved, true);
		} else {
			input.model = selectorFor(resolved, false);
			if (resolved.thinking && resolved.thinking !== "off" && !input.thinking) input.thinking = resolved.thinking;
		}
	});

	// ---- compaction can run on a cheap role ---------------------------------

	pi.on("session_before_compact", async (event, ctx) => {
		const cfg = ensure(ctx);
		if (!cfg.compactionRole) return;

		const resolved = resolveRole(cfg, sourceFor(ctx), cfg.compactionRole);
		if (!resolved) return;
		const model = ctx.modelRegistry.find(resolved.model.provider, resolved.model.id);
		if (!model) return;

		const { preparation, signal } = event;
		const { messagesToSummarize, turnPrefixMessages, tokensBefore, firstKeptEntryId, previousSummary } = preparation;
		const conversation = serializeConversation(convertToLlm([...messagesToSummarize, ...turnPrefixMessages]));
		const previous = previousSummary ? `\n\nEarlier summary:\n${previousSummary}` : "";

		try {
			const response = await ctx.modelRegistry.complete(
				model,
				{
					messages: [
						{
							role: "user" as const,
							content: [
								{
									type: "text" as const,
									text: [
										"Summarize this coding session so work can continue without the original transcript.",
										"Cover: goals, decisions and their reasons, files and code touched, current state,",
										"blockers and open questions, planned next steps. Structured markdown, no preamble.",
										previous,
										"",
										"<conversation>",
										conversation,
										"</conversation>",
									].join("\n"),
								},
							],
							timestamp: Date.now(),
						},
					],
				},
				{ maxTokens: 8192, signal, cacheRetention: "none", sessionId: uuidv7() },
			);

			const summary = (response.content as any[])
				.filter((c) => c?.type === "text")
				.map((c) => c.text)
				.join("\n")
				.trim();
			if (!summary) return;

			return { compaction: { summary, firstKeptEntryId, tokensBefore, usage: response.usage } };
		} catch (error) {
			if (!signal.aborted) {
				ctx.ui.notify(`Role compaction failed (${error instanceof Error ? error.message : String(error)}); using pi default.`, "warning");
			}
			return;
		}
	});

	// ---- advisor ------------------------------------------------------------

	pi.on("turn_end", async (event, ctx) => {
		const cfg = ensure(ctx);
		if (!cfg.advisor.enabled || reviewing) return;

		turnsSinceReview++;
		if (turnsSinceReview < cfg.advisor.everyTurns) return;

		const resolved = resolveRole(cfg, sourceFor(ctx), "advisor", { allowDefault: false });
		if (!resolved) return;
		const advisorModel = ctx.modelRegistry.find(resolved.model.provider, resolved.model.id);
		if (!advisorModel) return;

		const assistantText = ((event.message as any)?.content ?? [])
			.filter((c: any) => c?.type === "text")
			.map((c: any) => c.text)
			.join("\n")
			.slice(0, 6000);

		const toolSummary = ((event.toolResults as any[]) ?? [])
			.map((r) => {
				const name = r?.toolName ?? r?.name ?? "tool";
				const body = typeof r?.output === "string" ? r.output : JSON.stringify(r?.output ?? r?.details ?? r ?? "");
				return `- ${name}: ${String(body).slice(0, 300)}`;
			})
			.join("\n")
			.slice(0, 6000);

		// Nothing happened worth paying a second model for.
		if (!assistantText.trim() && !toolSummary.trim()) return;

		turnsSinceReview = 0;
		reviewing = true;
		ctx.ui.setStatus("model-roles", "advisor reviewing…");
		try {
			const verdict = await runAdvisorReview(
				ctx.modelRegistry as any,
				advisorModel,
				{
					userPrompt: lastUserPrompt,
					assistantText,
					toolSummary,
					cwd: ctx.cwd,
					config: cfg,
					source: sourceFor(ctx),
				},
				{ signal: ctx.signal, maxNotes: cfg.advisor.maxNotes },
			);

			if (verdict && shouldInject(verdict, cfg.advisor.minSeverity)) {
				pi.sendMessage(
					{
						customType: "model-roles-advisor",
						content: renderVerdict(verdict, cfg, sourceFor(ctx), cfg.advisor.mode),
						display: true,
						details: verdict,
					},
					{ deliverAs: "steer" },
				);
			}
		} catch (error) {
			ctx.ui.notify(`Advisor review failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
		} finally {
			reviewing = false;
			statusLine(ctx);
		}
	});
}
