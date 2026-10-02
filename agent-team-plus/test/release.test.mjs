/** release_teammate 的服务层行为：门禁、腾坑、消息清理、恢复期防护。 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHarness, START_SENTINEL } from "./harness.mjs";

const spawnRequest = (name) => ({
	name,
	description: `${name} 的任务`,
	prompt: [{ type: "text", text: "干活" }],
	context: "fresh",
	provider: "spawn",
	signal: new AbortController().signal
});

const code = (expected) => (error) => {
	assert.equal(error.code, expected, `expected ${expected}, got ${String(error.code)}: ${error.message}`);
	return true;
};

test("非 Lead 调用 release 被拒绝", async () => {
	const h = createHarness();
	h.seedMember(h.lead, { id: "child-a", name: "worker", phase: "active" });
	const teammate = h.addAgent("child-a", { parentSession: "lead-session", subagent: true, status: "running" });
	await assert.rejects(() => h.service.releaseTeammate(teammate, "worker"), code("TEAM_LEAD_REQUIRED"));
});

test("释放 lead 本身被拒绝", async () => {
	const h = createHarness();
	await assert.rejects(() => h.service.releaseTeammate(h.lead, "lead"), code("TEAM_INVALID_TARGET"));
});

test("释放不存在的名字报 TEAM_MEMBER_NOT_FOUND", async () => {
	const h = createHarness();
	await assert.rejects(() => h.service.releaseTeammate(h.lead, "ghost"), code("TEAM_MEMBER_NOT_FOUND"));
});

test("provisioning 中的成员不能释放", async () => {
	const h = createHarness();
	h.seedMember(h.lead, { id: "child-a", name: "worker", phase: "provisioning" });
	await assert.rejects(() => h.service.releaseTeammate(h.lead, "worker"), code("TEAM_MEMBER_NOT_RELEASABLE"));
});

test("名下有 in_progress 任务时拒绝释放", async () => {
	const h = createHarness();
	h.seedMember(h.lead, { id: "child-a", name: "worker", phase: "active" });
	h.seedTask(h.lead, { id: "task-1", status: "in_progress", ownerId: "child-a" });
	await assert.rejects(() => h.service.releaseTeammate(h.lead, "worker"), code("TEAM_MEMBER_HAS_TASKS"));
	assert.equal(h.rawState().members.length, 1, "被拒绝时不得改动名单");
});

test("成功释放：成员消失、排队消息被丢弃、子会话被停掉", async () => {
	const h = createHarness();
	h.seedMember(h.lead, { id: "child-a", name: "worker", phase: "active" });
	const queued = h.seedMessage(h.lead, { id: "team-message-1", targetId: "child-a", text: "干活" });

	const result = await h.service.releaseTeammate(h.lead, "worker");

	assert.deepEqual(result, { target: "worker", previousStatus: "inactive" });
	assert.deepEqual(h.rawState().members, []);
	assert.deepEqual(h.rawState().delivered, [queued.id]);
	assert.deepEqual(h.calls.drains, [{ rootId: "lead-session", childIds: ["child-a"] }]);
	assert.deepEqual(h.service.listMembers(h.lead).map((row) => row.name), ["lead"]);

	const released = h.lead.session.events.filter((event) => event.type === "team/member" && event.data.member.phase === "released");
	assert.equal(released.length, 1);
	assert.equal(released[0].data.member.id, "child-a");
});

test("正在跑的成员：返回 running 并先打断其回合", async () => {
	const h = createHarness();
	h.seedMember(h.lead, { id: "child-a", name: "worker", phase: "active" });
	h.addAgent("child-a", { parentSession: "lead-session", subagent: true, status: "running" });

	const result = await h.service.releaseTeammate(h.lead, "worker");

	assert.deepEqual(result, { target: "worker", previousStatus: "running" });
	assert.equal(h.calls.interrupts.length, 1);
	assert.equal(h.calls.interrupts[0].id, "child-a");
	assert.deepEqual(h.calls.interrupts[0].payload, { kind: "ancestor", agent: h.lead });
});

test("failed 成员也能释放（腾出它占的名额）", async () => {
	const h = createHarness();
	h.seedMember(h.lead, { id: "child-a", name: "worker", phase: "failed", error: "启动失败" });

	const result = await h.service.releaseTeammate(h.lead, "worker");

	assert.deepEqual(result, { target: "worker", previousStatus: "inactive" });
	assert.deepEqual(h.rawState().members, []);
});

test("释放后给旧名字发消息报 TEAM_MEMBER_NOT_FOUND", async () => {
	const h = createHarness();
	h.seedMember(h.lead, { id: "child-a", name: "worker", phase: "active" });
	await h.service.releaseTeammate(h.lead, "worker");

	await assert.rejects(
		() => h.service.sendMessage(h.lead, {
			target: "worker",
			content: [{ type: "text", text: "还在吗" }],
			signal: new AbortController().signal
		}),
		code("TEAM_MEMBER_NOT_FOUND")
	);
});

test("恢复期防护：已释放目标身上残留的排队消息被就地丢弃而不是投递", async () => {
	const h = createHarness();
	h.seedMember(h.lead, { id: "child-a", name: "worker", phase: "active" });
	const queued = h.seedMessage(h.lead, { id: "team-message-1", targetId: "child-a", text: "残留" });
	// 模拟“released 已落盘、丢弃 delivered 尚未落盘”的崩溃窗口。
	h.append(h.lead, "team/member", {
		version: 2,
		teamId: h.teamIdOf(h.lead),
		member: {
			id: "child-a",
			name: "worker",
			description: "worker 工作",
			provider: "spawn",
			context: "fresh",
			phase: "released"
		}
	});
	const message = h.rawState().messages.find((row) => row.id === queued.id);

	const handled = await h.service.mailbox.dispatchOnce(h.lead, message, new AbortController().signal);

	assert.equal(handled, true);
	assert.deepEqual(h.rawState().delivered, [queued.id]);
});

test("释放腾出名额：maxMembers=1 时可再雇一个", async () => {
	const h = createHarness({ config: { maxMembers: 1 } });
	h.seedMember(h.lead, { id: "child-a", name: "worker", phase: "active" });

	await assert.rejects(() => h.service.spawnTeammate(h.lead, spawnRequest("worker2")), code("TEAM_MEMBER_LIMIT"));

	await h.service.releaseTeammate(h.lead, "worker");
	h.setStartFailure(START_SENTINEL);

	await assert.rejects(
		() => h.service.spawnTeammate(h.lead, spawnRequest("worker2")),
		(error) => error === START_SENTINEL
	);
});

test("释放解冻名字：同名可以再次 spawn_teammate", async () => {
	const h = createHarness();
	h.seedMember(h.lead, { id: "child-a", name: "worker", phase: "active" });

	await assert.rejects(() => h.service.spawnTeammate(h.lead, spawnRequest("worker")), code("TEAM_MEMBER_NAME_TAKEN"));

	await h.service.releaseTeammate(h.lead, "worker");
	h.setStartFailure(START_SENTINEL);

	await assert.rejects(
		() => h.service.spawnTeammate(h.lead, spawnRequest("worker")),
		(error) => error === START_SENTINEL
	);
});
