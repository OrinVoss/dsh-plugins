/**
 * 部署安全网：静态检查裸导入是否都声明了 peerDependencies（DSH 的
 * routeLinked 只按本包 peers 决定是否把导入重定向到安装副本），并核对
 * bundle patch 的接线形状。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8"));

const barePackageName = (specifier) => {
	if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) return void 0;
	const parts = specifier.split("/");
	return specifier.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
};

const collectImports = (source) => {
	const collected = new Set();
	for (const match of source.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/gu)) collected.add(match[1]);
	return [...collected];
};

test("lib 下每个裸导入都在 peerDependencies 里", () => {
	const declared = new Set(Object.keys(manifest.peerDependencies ?? {}));
	const missing = [];
	for (const file of fs.readdirSync(path.join(pkgRoot, "lib"))) {
		if (!file.endsWith(".js")) continue;
		const source = fs.readFileSync(path.join(pkgRoot, "lib", file), "utf8");
		for (const specifier of collectImports(source)) {
			const pkg = barePackageName(specifier);
			if (pkg === void 0) continue;
			if (!declared.has(pkg)) missing.push(`${file}: ${specifier}`);
		}
	}
	assert.deepEqual(missing, [], "缺少 peerDependencies 会让运行时解析退回本包 node_modules");
});

test("dsh-* peer 精确钉在 0.2.0-rc.2（DSH 升级时 bundle 自动跳过而不是崩）", () => {
	for (const [name, range] of Object.entries(manifest.peerDependencies)) {
		if (name === "@deepseek-ai/dsh" || name.startsWith("@deepseek-ai/dsh-")) assert.equal(range, "0.2.0-rc.2", `${name} 应为精确版本`);
	}
});

test("manifest 声明 bundle patch 且导出路径存在", () => {
	assert.equal(manifest.type, "module");
	assert.equal(manifest.dsh.bundle.patch, "./cordis.patch.yml");
	assert.ok(fs.existsSync(path.join(pkgRoot, "cordis.patch.yml")));
	for (const target of [manifest.main, manifest.icon, ...Object.values(manifest.exports)]) {
		assert.ok(fs.existsSync(path.join(pkgRoot, target)), `${target} 不存在`);
	}
});

test("cordis.patch.yml 关掉官方两行、插入上限 16 的 fork 两行", () => {
	const patch = fs.readFileSync(path.join(pkgRoot, "cordis.patch.yml"), "utf8");
	assert.match(patch, /id:\s*agent-team\b/);
	assert.match(patch, /id:\s*tool-agent-team\b/);
	assert.match(patch, /name:\s*'@local\/dsh-agent-team-plus'/);
	assert.match(patch, /name:\s*'@local\/dsh-agent-team-plus\/tools'/);
	assert.match(patch, /maxMembers:\s*16/);
	assert.match(patch, /freshProvider:\s*spawn/);
	assert.match(patch, /forkProvider:\s*fork/);
});
