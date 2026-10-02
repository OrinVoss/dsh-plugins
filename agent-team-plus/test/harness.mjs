/**
 * 单测夹具：用最小假 ctx 驱动真实的 TeamService / 投影 / 邮箱代码。
 *
 * 投影走真的 `teamProjectionDefinition`（构造服务时由 effect 注册），
 * 假 Session 的 append 会同步折叠事件，因此 journal.state 读到的就是
 * 真实折叠结果；stub 只提供 ctx 边界（agents / sessions / subagents）。
 */
import { TeamId, TeamMessageId, TeamService, TeamTaskId } from "../lib/index.js";
import { TEST_DESCRIPTOR_EVENT } from "@deepseek-ai/dsh-subagent";

/** 让 spawn 走到 startContinuable 就抛出的哨兵：用它证明前面的门禁都过了。 */
export const START_SENTINEL = new Error("SENTINEL_START_CONTINUABLE_REACHED");

export function createHarness(options = {}) {
	const handlers = new Map();
	const agents = new Map();
	const states = new Map();
	const warnings = [];
	const calls = {
		startContinuable: [],
		interrupts: [],
		drains: []
	};
	let definition = null;
	let startFailure = options.startFailure ?? null;

	const ctx = {
		logger: {
			warn: (message) => warnings.push(String(message)),
			info() {},
			error() {}
		},
		on(event, handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		effect(fn) {
			const dispose = fn();
			return () => {
				void dispose;
			};
		},
		root: {
			sessionProjections: {
				register(candidate) {
					definition = candidate;
					return () => {
						definition = null;
					};
				}
			}
		},
		sessionProjections: {
			stateOf: (session) => states.get(session)
		},
		sessions: {
			async flush() {},
			get: () => void 0
		},
		sessionPersistence: {},
		agents: {
			get: (id) => agents.get(id),
			list: () => [...agents.values()]
		},
		subagents: {
			async startContinuable(request) {
				calls.startContinuable.push(request);
				if (startFailure !== null) throw startFailure;
				return { messageId: `started-${request.childId}` };
			},
			interrupt(id, payload) {
				calls.interrupts.push({ id, payload });
			},
			async drainContinuableChildren(root, childIds) {
				calls.drains.push({ rootId: root.id, childIds: [...childIds] });
			}
		}
	};

	const service = new TeamService(ctx, options.config ?? {});

	/** 注册一个 live Agent；child 会话可带“我是子会话”标记事件。 */
	function addAgent(id, settings = {}) {
		const session = {
			id,
			header: { id, parentSession: settings.parentSession },
			inheritedEventCount: 0,
			events: [],
			extra: settings.subagent === true ? [{ type: TEST_DESCRIPTOR_EVENT }] : [],
			snapshotEvents(from) {
				return [...this.events.slice(from ?? 0), ...this.extra];
			},
			append(type, data) {
				this.events.push({ type, data });
				const current = states.get(this) ?? definition.init({ id });
				states.set(this, definition.apply(current, { type, data }));
			},
			steer() {}
		};
		const agent = {
			id,
			session,
			options: settings.model === void 0 ? {} : { model: settings.model },
			status: settings.status ?? "inactive"
		};
		agents.set(id, agent);
		states.set(session, definition.init({ id }));
		return agent;
	}

	const lead = addAgent(options.leadId ?? "lead-session");

	/** 读取 lead 侧当前折叠状态（绕过 journal 的失败短路，便于断言 failure）。 */
	function rawState(root = lead) {
		return states.get(root.session);
	}

	function append(root, type, data) {
		root.session.append(type, data);
	}

	const teamIdOf = (root) => TeamId(root.id);

	/** 落一名成员的 provisioning（+ 可选终态）事件。 */
	function seedMember(root, member) {
		const base = {
			id: member.id,
			name: member.name,
			description: member.description ?? `${member.name} 工作`,
			provider: member.provider ?? "spawn",
			context: member.context ?? "fresh"
		};
		append(root, "team/member", {
			version: 2,
			teamId: teamIdOf(root),
			member: { ...base, phase: "provisioning" }
		});
		if (member.phase !== void 0 && member.phase !== "provisioning") {
			append(root, "team/member", {
				version: 2,
				teamId: teamIdOf(root),
				member: {
					...base,
					phase: member.phase,
					...(member.error === void 0 ? {} : { error: member.error })
				}
			});
		}
		return base;
	}

	/** 落一条排队消息（不投递）。 */
	function seedMessage(root, message) {
		const queued = {
			id: TeamMessageId(message.id),
			senderId: message.senderId ?? root.id,
			senderName: message.senderName ?? "lead",
			targetId: message.targetId,
			content: message.content ?? [{ type: "text", text: message.text ?? "ping" }]
		};
		append(root, "team/message/queued", {
			version: 2,
			teamId: teamIdOf(root),
			message: queued
		});
		return queued;
	}

	/** 落一个 revision 1 任务快照。 */
	function seedTask(root, task) {
		const snapshot = {
			id: TeamTaskId(task.id),
			revision: 1,
			subject: task.subject ?? "任务",
			description: task.description ?? "描述",
			status: task.status ?? "pending",
			...(task.ownerId === void 0 ? {} : { ownerId: task.ownerId }),
			blockedBy: [],
			writeScopes: []
		};
		append(root, "team/task", {
			version: 2,
			teamId: teamIdOf(root),
			task: snapshot
		});
		return snapshot;
	}

	return {
		service,
		ctx,
		lead,
		addAgent,
		append,
		seedMember,
		seedMessage,
		seedTask,
		rawState,
		teamIdOf,
		warnings,
		calls,
		get definition() {
			return definition;
		},
		setStartFailure(error) {
			startFailure = error;
		},
		/** 直接折叠一个任意事件，返回新状态（不经 journal 的失败短路）。 */
		fold(event, root = lead) {
			const session = root.session;
			const current = states.get(session);
			const next = definition.apply(current, event);
			states.set(session, next);
			return next;
		}
	};
}
