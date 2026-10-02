/** 工具层：release_teammate 的注册形状、输出契约与执行接线。 */
import test from "node:test";
import assert from "node:assert/strict";
import { apply, inject, name } from "../lib/tools.js";

const BASE_TOOL_NAMES = [
	"spawn_teammate",
	"send_message",
	"list_agents",
	"wait_agent",
	"interrupt_agent",
	"team_task_create",
	"team_task_get",
	"team_task_list",
	"team_task_update"
];

function createToolFixture() {
	const registered = [];
	const sections = [];
	const calls = [];
	const lead = {
		id: "lead-session",
		ctx: {
			systemPrompt: {
				section(config) {
					sections.push(config);
					return () => {};
				},
				getSectionOrder: () => 10
			},
			tools: {
				register(tool) {
					registered.push(tool);
					return () => {};
				}
			}
		}
	};
	const ctx = {
		agents: { list: () => [lead] },
		agentTeams: {
			tryMembership: () => ({
				root: lead,
				id: lead.id,
				role: "lead",
				name: "lead"
			}),
			releaseTeammate(caller, target) {
				calls.push({ caller, target });
				return Promise.resolve({
					target,
					previousStatus: "inactive"
				});
			}
		},
		on: () => () => {},
		effect(fn) {
			fn();
		}
	};
	apply(ctx, {
		freshProvider: "spawn",
		forkProvider: "fork"
	});
	return {
		lead,
		registered,
		sections,
		calls
	};
}

test("插件身份与注入保持稳定（服务名 agentTeams 不变）", () => {
	assert.equal(name, "tool-agent-team");
	assert.deepEqual(inject, [
		"agents",
		"agentTeams",
		"tools",
		"systemPrompt"
	]);
});

test("工具面从 9 个扩展到 10 个，且新增 release_teammate", () => {
	const fixture = createToolFixture();
	const names = fixture.registered.map((tool) => tool.name);
	assert.equal(names.length, 10);
	assert.deepEqual([...names].sort(), [...BASE_TOOL_NAMES, "release_teammate"].sort());
});

test("release_teammate 的输出契约是 { target, previousStatus }", () => {
	const fixture = createToolFixture();
	const tool = fixture.registered.find((candidate) => candidate.name === "release_teammate");
	assert.match(tool.description, /Team Lead only/);
	assert.deepEqual(tool.parameters.target, {
		type: "string",
		required: true,
		description: "Teammate target returned by spawn_teammate or list_agents."
	});
	assert.deepEqual(tool.output.schema, {
		type: "object",
		additionalProperties: false,
		properties: {
			target: {
				type: "string",
				required: true
			},
			previousStatus: {
				type: "string",
				required: true,
				enum: ["running", "inactive"]
			}
		}
	});
});

test("release_teammate 执行接线到 agentTeams.releaseTeammate", async () => {
	const fixture = createToolFixture();
	const tool = fixture.registered.find((candidate) => candidate.name === "release_teammate");
	const value = await tool.execute({ target: "worker" }, { agent: fixture.lead });
	assert.deepEqual(value, {
		target: "worker",
		previousStatus: "inactive"
	});
	assert.deepEqual(fixture.calls, [{ caller: fixture.lead, target: "worker" }]);
});

test("POLICY 里写明散伙语义与任务门禁", () => {
	const fixture = createToolFixture();
	assert.equal(fixture.sections.length, 1);
	assert.equal(fixture.sections[0].name, "team:policy");
	const policy = fixture.sections[0].text;
	assert.match(policy, /release_teammate/);
	assert.match(policy, /slot and name become reusable/);
	assert.match(policy, /refused while the member owns an in_progress task/);
});
