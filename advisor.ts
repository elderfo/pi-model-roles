/**
 * ADVISOR runtime.
 *
 * After a turn settles, a second model (role @advisor) reads what just
 * happened, judges whether the main session is on track, and — this is the
 * part that ties into pi-interactive-subagents — names which agent should take
 * the next chunk of work and which role's model it should run on.
 *
 * The advisor never spawns anything itself. It injects a steering message; the
 * main agent calls `subagent(...)`, and the tool_call hook in index.ts stamps
 * the role's model onto that spawn. So the advisor decides *who*, the role
 * table decides *on what model*, and the main agent stays in control.
 */

import { readAgentRoster } from "./agents.ts";
import { SEVERITIES, type RolesFile, type Severity } from "./types.ts";
import { type ModelSource, resolveRole, selectorFor } from "./resolve.ts";

export interface AdvisorPlanItem {
	agent: string;
	role?: string;
	task: string;
	why?: string;
}

export interface AdvisorVerdict {
	severity: Severity;
	summary: string;
	notes?: string[];
	delegate?: AdvisorPlanItem[];
}

function severityRank(severity: Severity): number {
	const index = SEVERITIES.indexOf(severity);
	return index === -1 ? 0 : index;
}

/** Pull the first JSON object out of a model reply that may be fenced or chatty. */
function extractJson(text: string): unknown | undefined {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	const candidate = fenced ? fenced[1] : text;
	const start = candidate.indexOf("{");
	const end = candidate.lastIndexOf("}");
	if (start === -1 || end <= start) return undefined;
	try {
		return JSON.parse(candidate.slice(start, end + 1));
	} catch {
		return undefined;
	}
}

function coerceVerdict(raw: unknown, maxNotes: number): AdvisorVerdict | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const obj = raw as Record<string, unknown>;
	const severity = typeof obj.severity === "string" && (SEVERITIES as string[]).includes(obj.severity) ? (obj.severity as Severity) : "note";
	const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
	if (!summary) return undefined;

	const notes = Array.isArray(obj.notes)
		? obj.notes.filter((n): n is string => typeof n === "string" && n.trim().length > 0).slice(0, maxNotes)
		: [];

	const delegate = Array.isArray(obj.delegate)
		? obj.delegate
				.filter((d): d is Record<string, unknown> => Boolean(d) && typeof d === "object")
				.map((d) => ({
					agent: typeof d.agent === "string" ? d.agent : "",
					role: typeof d.role === "string" ? d.role.replace(/^@/, "") : undefined,
					task: typeof d.task === "string" ? d.task : "",
					why: typeof d.why === "string" ? d.why : undefined,
				}))
				.filter((d) => d.agent && d.task)
				.slice(0, maxNotes)
		: [];

	return { severity, summary, notes, delegate };
}

export interface ReviewInput {
	userPrompt: string;
	assistantText: string;
	toolSummary: string;
	cwd: string;
	config: RolesFile;
	source: ModelSource;
}

function buildPrompt(input: ReviewInput): string {
	const { config, cwd } = input;
	const roster = readAgentRoster(cwd);

	const roleLines = Object.entries(config.roles)
		.map(([name, role]) => {
			const resolved = resolveRole(config, input.source, name, { allowDefault: false });
			const target = resolved ? selectorFor(resolved) : "unassigned";
			return `- @${name}: ${role.description ?? ""} -> ${target}`;
		})
		.join("\n");

	const agentLines =
		roster.length > 0
			? roster
					.map((a) => {
						const mapped = config.agentRoles[a.name];
						return `- ${a.name}${mapped ? ` (role @${mapped})` : ""}: ${a.description}${a.tools ? ` | tools: ${a.tools}` : ""}`;
					})
					.join("\n")
			: "- (no agent definitions found; do not propose delegation)";

	return [
		"You are the ADVISOR for a coding agent session. You do not write code and you do not act.",
		"You review the turn that just finished and decide whether the primary agent is on track,",
		"and whether the next chunk of work should be delegated to a subagent.",
		"",
		"## Available roles (role -> model it resolves to)",
		roleLines,
		"",
		"## Available subagents",
		agentLines,
		"",
		"## What the user asked",
		input.userPrompt || "(no fresh user prompt; continuation of earlier work)",
		"",
		"## What the primary agent just did",
		input.assistantText || "(no assistant text)",
		"",
		"## Tool activity this turn",
		input.toolSummary || "(no tool calls)",
		"",
		"## Your reply",
		"Reply with ONLY a JSON object, no prose around it:",
		"{",
		'  "severity": "ok" | "note" | "concern" | "blocker",',
		'  "summary": "one sentence on the state of the work",',
		'  "notes": ["specific, actionable observations"],',
		'  "delegate": [{ "agent": "<name from the list>", "role": "<role name>", "task": "self-contained task prompt", "why": "one line" }]',
		"}",
		"",
		"Rules:",
		"- severity ok means no intervention is warranted. Use it freely; silence is cheap, noise is not.",
		"- Only propose delegation when the work is genuinely separable and the primary agent has not already started it.",
		"- Match the role to the work: recon and greps -> @smol, hard reasoning -> @slow, UI work -> @designer,",
		"  planning -> @plan, git work -> @commit, image reading -> @vision, anything else -> @task.",
		"- Never propose an agent name that is not in the list above.",
		"- Keep every field short. The primary agent pays for your words.",
	].join("\n");
}

/** Render the verdict as the text injected into the primary session. */
export function renderVerdict(verdict: AdvisorVerdict, config: RolesFile, source: ModelSource, mode: "advise" | "steer"): string {
	const lines = [`**Advisor (${verdict.severity})** — ${verdict.summary}`];

	for (const note of verdict.notes ?? []) lines.push(`- ${note}`);

	if (verdict.delegate && verdict.delegate.length > 0) {
		lines.push("");
		lines.push(mode === "steer" ? "Dispatch these now:" : "Delegation worth considering:");
		for (const item of verdict.delegate) {
			const role = item.role ?? config.agentRoles[item.agent] ?? "task";
			const resolved = resolveRole(config, source, role, { allowDefault: true });
			const model = resolved ? selectorFor(resolved) : "(role unresolved, inherits parent model)";
			lines.push(`- \`subagent({ agent: "${item.agent}", model: "@${role}", task: "${item.task.replace(/"/g, "'")}" })\``);
			lines.push(`  → @${role} = ${model}${item.why ? ` · ${item.why}` : ""}`);
		}
		if (mode === "steer") {
			lines.push("");
			lines.push("Spawn them in this turn unless you have a concrete reason not to, then continue your own work.");
		}
	}

	return lines.join("\n");
}

export async function runAdvisorReview(
	registry: { complete: (model: any, context: any, options?: any) => Promise<any> },
	advisorModel: any,
	input: ReviewInput,
	options: { signal?: AbortSignal; maxNotes: number },
): Promise<AdvisorVerdict | undefined> {
	const response = await registry.complete(
		advisorModel,
		{
			messages: [
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: buildPrompt(input) }],
					timestamp: Date.now(),
				},
			],
		},
		{ maxTokens: 1200, signal: options.signal, cacheRetention: "none" },
	);

	const text = (response?.content ?? [])
		.filter((c: any) => c?.type === "text")
		.map((c: any) => c.text)
		.join("\n");

	return coerceVerdict(extractJson(text), options.maxNotes);
}

export function shouldInject(verdict: AdvisorVerdict, minSeverity: Severity): boolean {
	if (verdict.severity === "ok") return (verdict.delegate?.length ?? 0) > 0 && severityRank(minSeverity) <= severityRank("note");
	return severityRank(verdict.severity) >= severityRank(minSeverity);
}
