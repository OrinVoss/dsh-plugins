/** 投影折叠：released 是终态、把成员从 members 中摘除，且不破坏既有规则。 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHarness } from "./harness.mjs";

const member = (overrides) => ({
	id: "child-a",
	name: "worker",
	description: "worker 工作",
	provider: "spawn",
	context: "fresh",
	phase: "active",
	...overrides
});

test("active -> released：成员被摘除，状态与 wire view 都干净", () => {
	const h = createHarness();
	h.seedMember(h.lead, { id: "child-a", name: "worker", phase: "active" });
	assert.equal(h.rawState().members.length, 1);

	const next = h.fold({
		type: "team/member",
		data: { version: 2, teamId: h.teamIdOf(h.lead), member: member({ phase: "released" }) }
	});

	assert.equal(next.failure, void 0);
	assert.deepEqual(next.members, []);
	assert.doesNotThrow(() => h.definition.stateSchema.parse(next));

	const view = h.definition.wire.view(next);
	assert.doesNotThrow(() => h.definition.wire.viewSchema.parse(view));
	assert.deepEqual(view.members.map((row) => row.name), ["lead"]);
});

test("failed -> released：失败成员同样可以腾坑", () => {
	const h = createHarness();
	h.seedMember(h.lead, { id: "child-a", name: "worker", phase: "failed", error: "启动失败" });
	assert.equal(h.rawState().members.length, 1);

	const next = h.fold({
		type: "team/member",
		data: { version: 2, teamId: h.teamIdOf(h.lead), member: member({ phase: "released" }) }
	});

	assert.equal(next.failure, void 0);
	assert.deepEqual(next.members, []);
});

test("provisioning -> released 属非法迁移", () => {
	const h = createHarness();
	h.seedMember(h.lead, { id: "child-a", name: "worker", phase: "provisioning" });

	const next = h.fold({
		type: "team/member",
		data: { version: 2, teamId: h.teamIdOf(h.lead), member: member({ phase: "released" }) }
	});

	assert.match(next.failure, /invalid provisioning -> released transition/);
});

test("未知成员的 released 事件被拒绝", () => {
	const h = createHarness();
	const next = h.fold({
		type: "team/member",
		data: { version: 2, teamId: h.teamIdOf(h.lead), member: member({ phase: "released" }) }
	});
	assert.match(next.failure, /must begin provisioning/);
});

test("释放后同名可以再雇一名新成员（名字解冻）", () => {
	const h = createHarness();
	h.seedMember(h.lead, { id: "child-a", name: "worker", phase: "active" });
	const released = h.fold({
		type: "team/member",
		data: { version: 2, teamId: h.teamIdOf(h.lead), member: member({ phase: "released" }) }
	});
	assert.equal(released.failure, void 0);

	const reused = h.fold({
		type: "team/member",
		data: {
			version: 2,
			teamId: h.teamIdOf(h.lead),
			member: member({ id: "child-b", phase: "provisioning" })
		}
	});

	assert.equal(reused.failure, void 0);
	assert.deepEqual(reused.members.map((row) => row.id), ["child-b"]);
});

test("同名成员同时在册仍被拒绝（既有规则未放松）", () => {
	const h = createHarness();
	h.seedMember(h.lead, { id: "child-a", name: "worker", phase: "active" });
	const next = h.fold({
		type: "team/member",
		data: {
			version: 2,
			teamId: h.teamIdOf(h.lead),
			member: member({ id: "child-b", phase: "provisioning" })
		}
	});
	assert.match(next.failure, /is reused by another member/);
});

test("已释放的成员身份不能被复活", () => {
	const h = createHarness();
	h.seedMember(h.lead, { id: "child-a", name: "worker", phase: "active" });
	h.fold({
		type: "team/member",
		data: { version: 2, teamId: h.teamIdOf(h.lead), member: member({ phase: "released" }) }
	});

	const next = h.fold({
		type: "team/member",
		data: { version: 2, teamId: h.teamIdOf(h.lead), member: member({ phase: "active" }) }
	});

	assert.match(next.failure, /must begin provisioning/);
});

test("有 in_progress 任务的成员被释放后，任务视图丢掉 ownerName（已接受的代价）", () => {
	const h = createHarness();
	h.seedMember(h.lead, { id: "child-a", name: "worker", phase: "active" });
	h.seedTask(h.lead, { id: "task-1", status: "in_progress", ownerId: "child-a" });

	const before = h.definition.wire.view(h.rawState());
	assert.equal(before.tasks[0].ownerName, "worker");

	h.fold({
		type: "team/member",
		data: { version: 2, teamId: h.teamIdOf(h.lead), member: member({ phase: "released" }) }
	});

	const after = h.definition.wire.view(h.rawState());
	assert.equal(after.tasks.length, 1);
	assert.equal(after.tasks[0].ownerName, void 0);
	assert.doesNotThrow(() => h.definition.wire.viewSchema.parse(after));
});

test("消息投递顺序规则未回归：先 delivered 后 queued 仍然报错", () => {
	const h = createHarness();
	const next = h.fold({
		type: "team/message/delivered",
		data: {
			version: 2,
			teamId: h.teamIdOf(h.lead),
			messageId: "team-message-missing",
			targetId: "child-a"
		}
	});
	assert.match(next.failure, /was delivered before queueing/);
});

test("未知事件版本仍被拒绝（防止绕过 released 折叠）", () => {
	const h = createHarness();
	const next = h.fold({
		type: "team/member",
		data: { version: 3, teamId: h.teamIdOf(h.lead), member: member({ phase: "released" }) }
	});
	assert.match(next.failure, /unsupported Agent Teams event version 3/);
});
