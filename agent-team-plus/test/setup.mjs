/**
 * 生成本地测试依赖（幂等）。
 *
 * 本包在真实运行时由 DSH 的模块解析拦截层把 `@deepseek-ai/*` 与 `zod`
 * 路由到 app.asar 里的安装副本；裸 Node 跑单测时没有这一层，所以这里
 * 在包内 node_modules 下写最小桩，并把 app.asar 里真实的 zod 抽出来。
 * 该 node_modules 被仓库 .gitignore 忽略，也不会随插件部署拷贝。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const modulesRoot = path.join(pkgRoot, "node_modules");
const asarPath = process.env.DSH_ASAR ?? "F:\\dsh\\resources\\app.asar";

/** name -> { manifest, files } */
const STUBS = {
	"@deepseek-ai/cordis": {
		manifest: {
			name: "@deepseek-ai/cordis",
			version: "4.0.4",
			type: "module",
			main: "./index.js",
			exports: { ".": "./index.js" }
		},
		files: {
			"index.js": `/** 最小 Cordis Service 桩：只保留域服务用到的 ctx/name 归属。 */
export class Service {
	constructor(ctx, name) {
		this.ctx = ctx;
		if (name !== void 0) this.name = name;
	}
}
export default Service;
`
		}
	},
	"@deepseek-ai/schemastery": {
		manifest: {
			name: "@deepseek-ai/schemastery",
			version: "3.18.4",
			type: "module",
			main: "./index.js",
			exports: { ".": "./index.js" }
		},
		files: {
			"index.js": `/** 链式 schema 桩：单测直接构造服务，不经过 Loader 配置解析。 */
const chain = new Proxy(function () {}, {
	get(_target, prop) {
		if (prop === "then") return void 0;
		if (prop === Symbol.toPrimitive) return () => "";
		return () => chain;
	},
	apply() {
		return chain;
	}
});
const z = {
	object: () => chain,
	string: () => chain,
	number: () => chain,
	boolean: () => chain,
	array: () => chain,
	enum: () => chain,
	union: () => chain,
	any: () => chain,
	unknown: () => chain
};
export default z;
export { z };
`
		}
	},
	"@deepseek-ai/dsh-llm": {
		manifest: {
			name: "@deepseek-ai/dsh-llm",
			version: "0.2.0-rc.2",
			type: "module",
			main: "./index.js",
			exports: { ".": "./index.js" }
		},
		files: {
			"index.js": `/** 只保留域服务依赖的 HarnessError 语义（message/code/cause）。 */
export class HarnessError extends Error {
	constructor(message, code, options) {
		super(message, options);
		this.name = "HarnessError";
		if (code !== void 0) this.code = code;
	}
}
export function createUserMessage(value) {
	return {
		type: "user/message",
		data: value
	};
}
`
		}
	},
	"@deepseek-ai/dsh-brand": {
		manifest: {
			name: "@deepseek-ai/dsh-brand",
			version: "0.2.0-rc.2",
			type: "module",
			main: "./index.js",
			exports: { ".": "./index.js" }
		},
		files: {
			"index.js": `/** brand 只影响类型层；单测里恒等映射即可保持比较自洽。 */
export function brandString(value) {
	return value;
}
export function brandNumber(value) {
	return value;
}
`
		}
	},
	"@deepseek-ai/dsh-subagent": {
		manifest: {
			name: "@deepseek-ai/dsh-subagent",
			version: "0.2.0-rc.2",
			type: "module",
			main: "./index.js",
			exports: {
				".": "./index.js",
				"./internal": "./internal.js"
			}
		},
		files: {
			"index.js": `/** 面元数据桩：测试会话用固定事件标记自己是被 spawn 出来的子会话。 */
export const TEST_DESCRIPTOR_EVENT = "test/subagent-descriptor";
export function foldSubagentDescriptor(events) {
	const seen = events.some((event) => event !== null && typeof event === "object" && event.type === TEST_DESCRIPTOR_EVENT);
	return seen ? { mode: "continuable", provider: "test" } : void 0;
}
`,
			"internal.js": `/** 测试里任何真实 steer 都说明发生了一次不该发生的投递。 */
export async function steerHostSubagentPrompt() {
	throw new Error("steerHostSubagentPrompt must not be called in unit tests");
}
`
		}
	},
	"@deepseek-ai/dsh-tools": {
		manifest: {
			name: "@deepseek-ai/dsh-tools",
			version: "0.2.0-rc.2",
			type: "module",
			main: "./index.js",
			exports: { ".": "./index.js" }
		},
		files: {
			"index.js": `/** defineTool 桩：单测直接检查注册进来的配置对象。 */
export function defineTool(config) {
	return config;
}
`
		}
	}
};

function writeStubs() {
	for (const [name, stub] of Object.entries(STUBS)) {
		const dir = path.join(modulesRoot, ...name.split("/"));
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify(stub.manifest, null, 2)}\n`, "utf8");
		for (const [file, source] of Object.entries(stub.files)) {
			const target = path.join(dir, file);
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, source, "utf8");
		}
	}
}

/** 解析 asar 头，返回 { baseOffset, entries: Map<path, {size, offset}> }。 */
function readAsarHeader(file) {
	const fd = fs.openSync(file, "r");
	try {
		const head = Buffer.alloc(64);
		fs.readSync(fd, head, 0, 64, 0);
		for (const candidate of [16, 12, 8]) {
			const length = head.readUInt32LE(candidate - 4);
			if (length <= 0 || length > 64 * 1024 * 1024) continue;
			let parsed;
			try {
				const buffer = Buffer.alloc(length);
				fs.readSync(fd, buffer, 0, length, candidate);
				parsed = JSON.parse(buffer.toString("utf8"));
			} catch {
				continue;
			}
			if (parsed === null || typeof parsed !== "object" || parsed.files === undefined) continue;
			const headerSize = head.readUInt32LE(4);
			const entries = new Map();
			const walk = (node, prefix) => {
				for (const [name, meta] of Object.entries(node.files ?? {})) {
					const entryPath = `${prefix}/${name}`;
					if (meta.files !== undefined) walk(meta, entryPath);
					else entries.set(entryPath, {
						size: meta.size ?? 0,
						offset: meta.offset === undefined ? null : Number(meta.offset)
					});
				}
			};
			walk(parsed, "");
			return { baseOffset: 8 + headerSize, entries };
		}
	} finally {
		fs.closeSync(fd);
	}
	throw new Error(`无法解析 asar 头：${file}`);
}

/** 从 app.asar 抽取真实 zod；DSH 升级后这里仍按包内路径取。 */
function extractZod() {
	const target = path.join(modulesRoot, "zod");
	const marker = path.join(target, "package.json");
	if (fs.existsSync(marker)) return `reuse ${target}`;
	if (!fs.existsSync(asarPath)) throw new Error(`找不到 app.asar：${asarPath}（可用 DSH_ASAR 覆盖）`);
	const { baseOffset, entries } = readAsarHeader(asarPath);
	const prefix = "/dsh/node_modules/zod/";
	const selected = [...entries.entries()].filter(([entryPath]) => entryPath.startsWith(prefix) && !entryPath.endsWith("/"));
	if (selected.length === 0) throw new Error(`app.asar 内没有 ${prefix}（DSH 布局可能已变）`);
	const fd = fs.openSync(asarPath, "r");
	try {
		for (const [entryPath, meta] of selected) {
			if (meta.offset === null) continue;
			const buffer = Buffer.alloc(meta.size);
			fs.readSync(fd, buffer, 0, meta.size, baseOffset + meta.offset);
			const file = path.join(target, entryPath.slice(prefix.length));
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, buffer);
		}
	} finally {
		fs.closeSync(fd);
	}
	return `extract ${selected.length} files -> ${target}`;
}

writeStubs();
const zodResult = extractZod();
console.log(`[agent-team-plus] test deps ready: ${zodResult}`);
