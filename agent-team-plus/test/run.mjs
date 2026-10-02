/**
 * 在进程内依次加载所有 *.test.mjs。
 *
 * 为什么不用 `node --test`：DSH 文件沙箱下 node:test 的 runner 会用默认
 * 管道 stdio 去 spawn 子进程，被沙箱拒绝（EPERM）。直接在单进程里 import
 * 这些文件即可，node:test 会自动汇总输出。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(here).filter((file) => file.endsWith(".test.mjs")).sort();
for (const file of files) await import(new URL(`./${file}`, import.meta.url));
