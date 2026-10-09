'use strict'
// 一段"写给压缩引擎"的指令，由 host.js 注册进**系统提示词**。
//
// 为什么放系统提示词（而不是直接改压缩提示词）：
//   ① dsh-compaction-basic 的 `COMPACTION_INSTRUCTION` 是**模块私有常量**，config schema 里
//      只有 thresholdRatio/retainRatio/retainTokens/maxTokens/modelPolicies —— 没有提示词字段，
//      想"直接改"只能 patch asar（应用一更新就没了，且改的是官方安装）。
//   ② 压缩时摘要模型会**逐字回放系统提示词**（surface 节点 0）作为 messages 的首项
//      （dsh-compaction-basic README「摘要机制」一节），所以写在这里，要求必然送到摘要模型眼前。
//   ③ 系统提示词**永不被遮蔽**：压缩范围一律从第一个非 `system/message` 的节点开始
//      （同 README「自动触发与溢出恢复」一节）—— 指令自己不会被压缩掉。
//   ④ 正式扩展点：`ctx.systemPrompt.section({name, order, text})`（dsh-system-prompt）。
//
// 诚实分界：这是**软保证**（靠摘要模型照做）。硬保证是 host.js 里那套「压缩后比对 shadowedSeqs
// 再补送」——两者叠加：前者降低丢失概率，后者兜住漏网的。
//
// VERSION 变更时递增（host.js 会把它打进日志，用于确认跑的是哪一版）。
const VERSION = 1

const TEXT = [
  'Note for context compaction only: when this conversation is condensed into a `<compacted-summary>`',
  'checkpoint, messages that begin with "（dsh-memory 自动检索：" carry entries retrieved from the',
  "user's long-term memory store. They are small (roughly 1 KB) and were fetched precisely because they",
  'are relevant to the current task. In that checkpoint, copy their entry lines (title, `name`, and',
  'summary) verbatim into "## Critical Context" — do not paraphrase, merge, shorten or drop them; if a',
  'prior checkpoint already lists them, keep them. Outside of compaction this note has no effect.'
].join('\n')

/** 默认注册顺序：排在第一方内容之后（harness 源 10000 / Web 表层 10100 / persona 后缀 10200 之后） */
const DEFAULT_ORDER = 10300

/** 段名（注册表里唯一） */
const SECTION_NAME = 'dsh-memory:compaction-guard'

module.exports = { VERSION, TEXT, DEFAULT_ORDER, SECTION_NAME }
