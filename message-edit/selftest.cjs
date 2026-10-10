/**
 * dsh-message-edit 端到端探针：打运行中的桌面端 HTTP 路由。
 *
 *   node selftest.cjs                # 走默认端口 19387
 *   node selftest.cjs 3080           # 指定端口
 *   node selftest.cjs 19387 <sessionId>
 *
 * 三步：
 *  1. POST /message-edit-api/selftest —— 在临时会话上验证替换机制（不碰真实会话）
 *  2. GET  /message-edit-api/state    —— 插件是否真的加载了
 *  3. 若给了 sessionId，打印那个会话的可撤回目标与已遮蔽轮次
 */
const port = process.argv[2] ?? '19387'
const sessionId = process.argv[3]

const base = `http://127.0.0.1:${port}`

async function json(path, init) {
  const response = await fetch(base + path, init)
  const text = await response.text()
  try {
    return { status: response.status, body: JSON.parse(text) }
  } catch {
    return { status: response.status, body: text.slice(0, 500) }
  }
}

async function main() {
  const health = await json('/message-edit-api/state?sessionId=')
  console.log(`[1] 路由可达：HTTP ${health.status}`, JSON.stringify(health.body).slice(0, 200))
  if (health.status === 404) {
    console.error('    插件宿主半边没有加载（404）。检查 profile 的 dsh.profile.bundles 并重载。')
    process.exitCode = 2
    return
  }

  const test = await json('/message-edit-api/selftest', { method: 'POST' })
  console.log('[2] 机制自检：', JSON.stringify(test.body, null, 2))
  if (!test.body || test.body.ok !== true) process.exitCode = 1

  if (sessionId !== undefined) {
    const state = await json(`/message-edit-api/state?sessionId=${encodeURIComponent(sessionId)}`)
    console.log('[3] 会话状态：', JSON.stringify(state.body, null, 2))
  }
}

main().catch((error) => {
  console.error('探针失败：', error.message)
  process.exitCode = 1
})
