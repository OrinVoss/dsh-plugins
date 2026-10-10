'use strict'

// dsh-memory 插件半边自检：用 mock ctx 跑 host.js，验证工具注册形状与接线，
// 不需要启动 DSH。
//   node plugintest.cjs

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')

const host = require('./host')
const storeLib = require('./lib/store')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-plugin-'))
const home = path.join(root, 'memory')
const agentsPath = path.join(root, 'AGENTS.md')
// 假 session 的 cwd 必须是**临时目录**：注入工作区记忆区块的代码会写 <cwd>/AGENTS.local.md，
// 用真实工作区路径会把测试夹具泄漏到开发者自己的仓库里（2026-10-09 真漏过一次）。
const cwd = path.join(root, 'workspace')
fs.mkdirSync(cwd, { recursive: true })
const projectKeyOfCwd = storeLib.projectKey(cwd)

const registered = []
const logs = []
function makeWebServer(bucket) {
  return {
    register(def) {
      bucket.set(def.path, def)
      return () => bucket.delete(def.path)
    }
  }
}
const ctxRoutes = new Map()
const ctx = {
  logger: { info: (...a) => logs.push(['info', ...a]), warn: (...a) => logs.push(['warn', ...a]) },
  effect(fn, label) {
    const disposer = fn()
    assert.equal(typeof disposer, 'function', `effect(${label}) 应返回 disposer`)
    return disposer
  },
  inject(deps, cb) {
    assert.ok(Array.isArray(deps))
    return cb(ctx)
  },
  webServer: makeWebServer(ctxRoutes),
  tools: {
    register(def) {
      registered.push(def)
      return () => { /* disposer */ }
    }
  }
}

// ---------------------------------------------------------------- HTTP 假请求
function fakeRes() {
  const res = { statusCode: 0, headers: {}, body: '', done: false }
  res.setHeader = (k, v) => { res.headers[k] = v }
  res.end = (s) => { res.body = s; res.done = true }
  return res
}
function fakeGet(url) {
  return { url, method: 'GET', on() { return this } }
}
function fakePost(url, payload) {
  const handlers = {}
  const req = {
    url,
    method: 'POST',
    on(ev, cb) {
      handlers[ev] = cb
      if (handlers.data && handlers.end) {
        queueMicrotask(() => {
          handlers.data(Buffer.from(JSON.stringify(payload)))
          handlers.end()
        })
      }
      return req
    }
  }
  return req
}
let activeBucket = ctxRoutes
async function callRoute(path, req, bucket = activeBucket) {
  const route = bucket.get(path)
  assert.ok(route, `路由 ${path} 未注册`)
  const res = fakeRes()
  await route.handler(req, res)
  assert.equal(res.done, true, `${path} 没有结束响应`)
  return { status: res.statusCode, json: JSON.parse(res.body) }
}
const get = (path, url, bucket) => callRoute(path, fakeGet(url), bucket)
const post = (path, body, bucket) => callRoute(path, fakePost(path, body), bucket)

const exec = { agent: { session: { header: { cwd, id: 'sess_plugin_test' } } } }
const execNoCwd = { agent: { session: { header: {} } } }

let passed = 0
const failures = []
function check(label, fn) {
  try {
    fn()
    passed++
    process.stdout.write(`  PASS  ${label}\n`)
  } catch (err) {
    failures.push({ label, err })
    process.stdout.write(`  FAIL  ${label}\n        ${String((err && err.message) || err).split('\n').join('\n        ')}\n`)
  }
}
function tool(name) {
  const t = registered.find((d) => d.name === name)
  assert.ok(t, `工具 ${name} 未注册`)
  return t
}
function run(name, args, e) {
  return tool(name).execute(args, e || exec)
}
function render(name, args, value) {
  return tool(name).output.render(args, value)
}

// ---------------------------------------------------------------------------
// DSH 的原始 JSON Schema 子集校验（复刻 @deepseek-ai/dsh-tools 的
// assertSupportedJsonSchema / checkSchemaNode / checkObjectSchemaTail）。
// register() 校验的是「已经转换好的 JSON Schema」而不是 defineTool 的参数规格，
// 所以属性里写 `required: true` 会被直接拒绝——这里把它变成可本地复现的检查。
const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
const KEYWORD_TYPES = {
  properties: ['object'],
  required: ['object'],
  additionalProperties: ['object'],
  items: ['array'],
  enum: ['string', 'number', 'integer', 'boolean', 'null'],
  const: ['string', 'number', 'integer', 'boolean', 'null']
}
function validateDshSchema(root, path, violations) {
  const node = root
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    violations.push(`${path} must be a schema object`)
    return
  }
  if (typeof node.type !== 'string' || !SCHEMA_TYPES.includes(node.type)) {
    violations.push(`${path}.type must be one of ${SCHEMA_TYPES.join('/')}`)
    return
  }
  for (const [key, types] of Object.entries(KEYWORD_TYPES)) {
    if (Object.hasOwn(node, key) && !types.includes(node.type)) {
      violations.push(`${path}.${key} is not supported on type "${node.type}"`)
    }
  }
  if (node.type === 'object') {
    const props = Object.hasOwn(node, 'properties') ? node.properties : undefined
    if (Object.hasOwn(node, 'properties')) {
      if (props === null || typeof props !== 'object' || Array.isArray(props)) {
        violations.push(`${path}.properties must be an object of schemas`)
      } else {
        for (const [key, sub] of Object.entries(props)) validateDshSchema(sub, `${path}.properties.${key}`, violations)
      }
    }
    if (Object.hasOwn(node, 'required')) {
      const req = node.required
      if (!Array.isArray(req) || req.some((e) => typeof e !== 'string')) {
        violations.push(`${path}.required must be an array of strings`)
      } else {
        const declared = props && typeof props === 'object' ? props : {}
        for (const key of req) {
          if (!Object.hasOwn(declared, key)) violations.push(`${path}.required names "${key}" which is not in properties`)
        }
      }
    }
    if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') {
      violations.push(`${path}.additionalProperties must be a boolean`)
    }
  }
  if (node.type === 'array' && Object.hasOwn(node, 'items')) {
    validateDshSchema(node.items, `${path}.items`, violations)
  }
  if (Array.isArray(node.enum)) {
    if (node.enum.length === 0) violations.push(`${path}.enum must be non-empty`)
    for (const v of node.enum) {
      if (!SCHEMA_TYPES.includes(typeof v === 'object' ? (v === null ? 'null' : 'object') : typeof v)) {
        violations.push(`${path}.enum entry is not a scalar`)
      }
    }
  }
}
function assertDshSchema(schema, label) {
  const violations = []
  validateDshSchema(schema, label, violations)
  assert.deepEqual(violations, [], `${label} 不是合法的 DSH JSON Schema：\n  ${violations.join('\n  ')}`)
}

console.log(`\n临时目录：${root}\n`)

check('onStartup 同步：AGENTS.md 被创建且带托管区块', () => {
  host.apply(ctx, { home, agentsPath })
  const text = fs.readFileSync(agentsPath, 'utf8')
  assert.match(text, /dsh-memory:begin/)
  assert.match(text, /长期记忆库/)
})

check('注册了 4 个工具且形状合法', () => {
  assert.deepEqual(registered.map((d) => d.name).sort(), ['memory_forget', 'memory_read', 'memory_search', 'memory_write'])
  for (const def of registered) {
    assert.equal(typeof def.description, 'string')
    assert.ok(def.description.length > 20, `${def.name} 缺 description`)
    assert.equal(def.parameters.type, 'object')
    assert.equal(def.parameters.additionalProperties, false)
    assert.equal(def.output.schema.type, 'object')
    assert.deepEqual(def.output.schema.required, ['text'])
    assert.equal(typeof def.output.render, 'function')
    assert.equal(typeof def.execute, 'function')
    assertDshSchema(def.parameters, `${def.name}.parameters`)
    assertDshSchema(def.output.schema, `${def.name}.output.schema`)
  }
  assert.deepEqual(tool('memory_write').parameters.required, ['scope', 'name', 'description', 'body'])
  assert.deepEqual(tool('memory_read').parameters.required, ['name'])
  assert.deepEqual(tool('memory_forget').parameters.required, ['name'])
  assert.equal(tool('memory_search').parameters.required, undefined)
})

check('参数里所有 enum 值都合法', () => {
  assert.deepEqual(tool('memory_write').parameters.properties.scope.enum, ['global', 'project'])
  assert.deepEqual(tool('memory_search').parameters.properties.scope.enum, ['global', 'project', 'auto'])
  assert.ok(tool('memory_write').parameters.properties.type.enum.includes('reference'))
})

check('inject 声明了 tools、且没有多余依赖', () => {
  assert.deepEqual(host.inject, ['tools'])
  assert.equal(host.name, 'dsh-memory')
})

check('memory_write → 落盘 + 索引 + 回执', () => {
  const value = run('memory_write', {
    scope: 'global',
    name: 'tools/dsh-desktop-app',
    title: 'DSH 桌面端',
    description: 'DSH 桌面端在 F:\\dsh，插件隔离在 profiles/desktop',
    type: 'reference',
    section: '工具配置',
    body: '正文：桌面端与 CLI 共享 DSH_HOME，但插件隔离。'
  })
  assert.match(value.text, /已写入全局记忆/)
  assert.match(value.text, /已同步/)
  assert.ok(fs.existsSync(path.join(home, 'tools', 'dsh-desktop-app.md')))
  const idx = fs.readFileSync(path.join(home, 'INDEX.md'), 'utf8')
  assert.match(idx, /DSH 桌面端/)
})

check('render 产出模型可见的文本块', () => {
  const value = run('memory_search', { query: 'DSH' })
  const parts = render('memory_search', { query: 'DSH' }, value)
  assert.ok(Array.isArray(parts))
  assert.equal(parts[0].type, 'text')
  assert.match(parts[0].text, /DSH 桌面端/)
})

check('memory_search 命中正文', () => {
  const value = run('memory_search', { query: '插件隔离' })
  assert.match(value.text, /插件隔离/)
  assert.match(value.text, /tools\/dsh-desktop-app\.md/)
})

check('memory_search 未命中时给出引导', () => {
  const value = run('memory_search', { query: '不存在的关键词xyzzy' })
  assert.match(value.text, /没有命中/)
  assert.match(value.text, /memory_write/)
})

// ------------------------------------------------- 回归：BUG-1 文案 / 备注 命中过重

check('BUG-1 空命中文案跟随请求的 scope，不再写死「项目作用域」', () => {
  const g = run('memory_search', { query: '不存在的关键词xyzzy', scope: 'global' })
  assert.match(g.text, /已搜索：全局记忆/)
  assert.doesNotMatch(g.text, /项目作用域/, '显式要求 global 时不该提项目作用域')

  const p = run('memory_search', { query: '不存在的关键词xyzzy', scope: 'project' })
  assert.match(p.text, /已搜索：当前工作区记忆/)

  const a = run('memory_search', { query: '不存在的关键词xyzzy' })
  assert.match(a.text, /当前工作区记忆 \+ 全局记忆/, 'auto 应列出实际搜索过的作用域')
})

check('多词检索命中（BUG-2 的宿主侧表现）', () => {
  run('memory_write', {
    scope: 'global',
    name: 'regress/cuda-note',
    title: 'CUDA 构建',
    description: '必须用 CUDA 13.4 构建才有 sm_120a',
    section: '压测',
    body: '正文：Blackwell 需要 CUDA 13.4。'
  })
  const value = run('memory_search', { query: 'CUDA 13.4' })
  assert.match(value.text, /CUDA 构建/)
  const spread = run('memory_search', { query: 'CUDA 插件隔离' })
  assert.match(spread.text, /CUDA 构建/, '词分散在不同条目时都该被找到')
  assert.match(spread.text, /插件隔离/)
})

check('命中过重：长条目按份截断并给出 memory_read 指针', () => {
  const longBody = '长正文段落。'.repeat(1600) // ≈9600 字，超过单条 6000 的额度
  run('memory_write', {
    scope: 'global',
    name: 'regress/long-entry',
    title: '超长条目',
    description: '用于验证检索按份截断',
    section: '压测',
    body: longBody
  })
  const value = run('memory_search', { query: '超长条目' })
  assert.match(value.text, /超长条目/)
  assert.match(value.text, /已截断/)
  assert.match(value.text, /memory_read `regress\/long-entry`/)
  assert.ok(value.text.length < longBody.length, '返回体应明显小于正文')
})

check('memory_read 读全文', () => {
  const value = run('memory_read', { name: 'tools/dsh-desktop-app' })
  assert.match(value.text, /正文：桌面端与 CLI 共享/)
  assert.match(value.text, /作用域：global/)
})

check('memory_read 未命中时给出引导', () => {
  const value = run('memory_read', { name: 'nope/none' })
  assert.match(value.text, /没找到记忆条目/)
})

check('project 作用域用会话 cwd 定位', () => {
  const value = run('memory_write', {
    scope: 'project',
    name: 'decisions/use-httpx',
    title: '用 httpx',
    description: '本项目统一用 httpx',
    body: '正文'
  })
  assert.match(value.text, /已写入工作区记忆/)
  const projects = fs.readdirSync(path.join(home, 'projects'))
  assert.equal(projects.length, 1)
  assert.ok(fs.existsSync(path.join(home, 'projects', projects[0], 'MEMORY.md')))
  // 新行为：项目条目要按工作区注入 → 写进 <cwd>/AGENTS.local.md 的托管区块
  const wsFile = path.join(cwd, 'AGENTS.local.md')
  assert.ok(fs.existsSync(wsFile), '项目写入后应生成工作区指令文件')
  const wsText = fs.readFileSync(wsFile, 'utf8')
  assert.match(wsText, /<!-- dsh-memory-project:begin -->/)
  assert.match(wsText, /decisions\/use-httpx\.md/)
})

check('search 的 auto 同时覆盖项目与全局', () => {
  const value = run('memory_search', { query: 'httpx' })
  assert.match(value.text, /工作区记忆/)
  assert.match(value.text, /decisions\/use-httpx\.md/)
})

check('无 cwd 时 project 写入返回可读错误而不是抛出', () => {
  const value = run('memory_write', {
    scope: 'project',
    name: 'a/b',
    description: 'd',
    body: 'b'
  }, execNoCwd)
  assert.match(value.text, /工作目录/)
})

check('重复写入被拒绝并提示 overwrite', () => {
  const value = run('memory_write', {
    scope: 'global',
    name: 'tools/dsh-desktop-app',
    description: '重复',
    body: '重复'
  })
  assert.match(value.text, /已存在/)
  assert.match(value.text, /overwrite: true/)
})

check('overwrite: true 正常覆盖', () => {
  const value = run('memory_write', {
    scope: 'global',
    name: 'tools/dsh-desktop-app',
    title: 'DSH 桌面端',
    description: '覆盖后的摘要',
    section: '工具配置',
    body: '覆盖后的正文',
    overwrite: true
  })
  assert.match(value.text, /已更新全局记忆/)
})

check('memory_forget 删除并同步区块', () => {
  const value = run('memory_forget', { name: 'tools/dsh-desktop-app' })
  assert.match(value.text, /已删除/)
  assert.equal(fs.existsSync(path.join(home, 'tools', 'dsh-desktop-app.md')), false)
  const agents = fs.readFileSync(agentsPath, 'utf8')
  assert.doesNotMatch(agents, /dsh-desktop-app\.md/)
})

check('memory_forget 未命中时明确说明', () => {
  const value = run('memory_forget', { name: 'tools/dsh-desktop-app' })
  assert.match(value.text, /没有找到要删除/)
})

check('autoAgentsSync=false 时不碰 AGENTS.md', () => {
  const dir2 = path.join(root, 'memory-off')
  const agents2 = path.join(root, 'AGENTS-off.md')
    const ctx2 = {
      logger: ctx.logger,
      effect: ctx.effect,
      inject: ctx.inject,
      webServer: makeWebServer(new Map()),
      tools: { register: (d) => { registered.push(d); return () => {} } }
    }
  const before = registered.length
  host.apply(ctx2, { home: dir2, agentsPath: agents2, autoAgentsSync: false })
  const write = registered.slice(before).find((d) => d.name === 'memory_write')
  write.execute({ scope: 'global', name: 'a/b', description: 'd', body: 'b' }, exec)
  assert.equal(fs.existsSync(agents2), false, 'AGENTS.md 不应被创建')
  assert.ok(fs.existsSync(path.join(dir2, 'INDEX.md')))
})

check('设置了 DSH_HOME 时默认落到 <DSH_HOME>/memory', () => {
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = path.join(root, 'fake-home')
  try {
    const captured = []
    const ctx3 = {
      logger: ctx.logger,
      effect: ctx.effect,
      inject: ctx.inject,
      webServer: makeWebServer(new Map()),
      tools: { register: (d) => { captured.push(d); return () => {} } }
    }
    host.apply(ctx3, {})
    const w = captured.find((d) => d.name === 'memory_write')
    const value = w.execute({ scope: 'global', name: 'x/y', description: 'd', body: 'b' }, exec)
    assert.ok(value.text.includes(path.join(root, 'fake-home', 'memory')), value.text)
    assert.ok(fs.existsSync(path.join(root, 'fake-home', 'AGENTS.md')))
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
  }
})

check('apply 后写了一条 info 日志', () => {
  assert.ok(logs.some((l) => l[0] === 'info' && String(l[1]).includes('dsh-memory')))
})

// ---------------------------------------------------------------- 设置页 HTTP 接口

async function checkAsync(label, fn) {
  try {
    await fn()
    passed++
    process.stdout.write(`  PASS  ${label}\n`)
  } catch (err) {
    failures.push({ label, err })
    process.stdout.write(`  FAIL  ${label}\n        ${String((err && err.message) || err).split('\n').join('\n        ')}\n`)
  }
}

async function main() {
  // 前两个测试各自 apply 过一次，会把共享的 ctxRoutes 指向它们自己的 store；
  // 这里用一份独立的路由桶重新 apply 一次，专门测设置页接口。
  const httpRoutes = new Map()
  const httpCtx = {
    logger: ctx.logger,
    effect: ctx.effect,
    inject: (deps, cb) => cb(httpCtx),
    webServer: makeWebServer(httpRoutes),
    tools: { register: () => () => {} }
  }
  host.apply(httpCtx, { home, agentsPath })
  activeBucket = httpRoutes

  await checkAsync('设置页接口全部注册在 /memory-api/*', async () => {
    const paths = [...httpRoutes.keys()].sort()
    assert.deepEqual(paths, [
      '/memory-api/delete',
      '/memory-api/entry',
      '/memory-api/health',
      '/memory-api/list',
      '/memory-api/projects',
      '/memory-api/save',
      '/memory-api/status',
      '/memory-api/sync'
    ])
  })

  await checkAsync('GET /status 返回记忆库状态', async () => {
    const r = await get('/memory-api/status', '/memory-api/status')
    assert.equal(r.status, 200)
    assert.equal(r.json.ok, true)
    assert.equal(r.json.home, home)
    assert.equal(r.json.agentsPath, agentsPath)
    assert.ok(Number.isInteger(r.json.global.count))
    assert.ok(r.json.maxBlockBytes > 0)
  })

  // ------------------------------------------------- 回归：BUG-4 status 的 project 字段

  await checkAsync('BUG-4 不带参数时 project 为 null（保持旧行为）', async () => {
    const r = await get('/memory-api/status', '/memory-api/status')
    assert.equal(r.json.project, null)
    assert.ok(r.json.projects >= 1, 'projects 计数仍应给出')
  })

  await checkAsync('BUG-4 ?key= 能算出当前工作区', async () => {
    const key = projectKeyOfCwd
    const r = await get('/memory-api/status', `/memory-api/status?key=${encodeURIComponent(key)}`)
    assert.equal(r.json.ok, true)
    assert.ok(r.json.project, 'project 不应再是 null')
    assert.equal(r.json.project.key, key)
    assert.match(r.json.project.source, /key/)
  })

  await checkAsync('BUG-4 ?cwd= 由绝对路径推出项目键', async () => {
    const r = await get('/memory-api/status', `/memory-api/status?cwd=${encodeURIComponent(cwd)}`)
    assert.equal(r.json.ok, true)
    assert.ok(r.json.project)
    assert.equal(r.json.project.key, projectKeyOfCwd)
    assert.match(r.json.project.source, /cwd/)
  })

  await checkAsync('BUG-4 非法 key / 相对 cwd 被拒绝', async () => {
    const badKey = await get('/memory-api/status', '/memory-api/status?key=../../etc')
    assert.equal(badKey.status, 400)
    assert.match(badKey.json.error, /项目键/)
    const badCwd = await get('/memory-api/status', '/memory-api/status?cwd=relative%2Fpath')
    assert.equal(badCwd.status, 400)
    assert.match(badCwd.json.error, /绝对路径/)
  })

  await checkAsync('非法 key 在 /list 上也被拒绝', async () => {
    const r = await get('/memory-api/list', '/memory-api/list?scope=project&key=../escape')
    assert.equal(r.status, 400)
    assert.match(r.json.error, /项目键/)
  })

  await checkAsync('GET /list 返回分组与条目结构', async () => {
    const r = await get('/memory-api/list', '/memory-api/list?scope=global')
    assert.equal(r.json.scope, 'global')
    assert.ok(Array.isArray(r.json.sections))
    assert.ok(Array.isArray(r.json.entries))
    assert.ok(r.json.indexFile.endsWith('INDEX.md'))
  })

  await checkAsync('GET /list?scope=project 缺 key 时报错', async () => {
    const r = await get('/memory-api/list', '/memory-api/list?scope=project')
    assert.equal(r.status, 400)
    assert.equal(r.json.ok, false)
    assert.match(r.json.error, /key/)
  })

  await checkAsync('GET /projects 列出工作区记忆', async () => {
    const r = await get('/memory-api/projects', '/memory-api/projects')
    assert.equal(r.json.ok, true)
    assert.ok(Array.isArray(r.json.projects))
  })

  await checkAsync('POST /save 写入新条目并同步区块', async () => {
    const r = await post('/memory-api/save', {
      scope: 'global',
      name: 'ui/from-settings-page',
      title: '设置页写入',
      description: '由设置页 HTTP 接口写入的条目',
      type: 'reference',
      section: '工具配置',
      body: '正文'
    })
    assert.equal(r.status, 200, JSON.stringify(r.json))
    assert.equal(r.json.ok, true)
    assert.equal(r.json.target, 'ui/from-settings-page.md')
    assert.ok(fs.existsSync(path.join(home, 'ui', 'from-settings-page.md')))
    const agents = fs.readFileSync(agentsPath, 'utf8')
    assert.match(agents, /设置页写入/, 'AGENTS.md 区块应同步')
    const list = await get('/memory-api/list', '/memory-api/list?scope=global')
    assert.ok(list.json.entries.some((e) => e.target === 'ui/from-settings-page.md'), '新条目应出现在索引里')
  })

  await checkAsync('POST /save 重复写入（overwrite=false）被拒绝', async () => {
    const r = await post('/memory-api/save', {
      scope: 'global',
      name: 'ui/from-settings-page',
      description: '重复',
      body: '重复'
    })
    assert.equal(r.status, 400)
    assert.match(r.json.error, /已存在/)
  })

  await checkAsync('GET /entry 读回条目', async () => {
    const r = await get('/memory-api/entry', '/memory-api/entry?scope=global&name=ui/from-settings-page')
    assert.equal(r.json.found, true)
    assert.equal(r.json.meta.type, 'reference')
    assert.match(r.json.body, /正文/)
  })

  await checkAsync('GET /entry 不存在时 found=false 而不是报错', async () => {
    const r = await get('/memory-api/entry', '/memory-api/entry?scope=global&name=nope/none')
    assert.equal(r.status, 200)
    assert.equal(r.json.found, false)
  })

  await checkAsync('POST /sync 重写区块', async () => {
    const r = await post('/memory-api/sync', {})
    assert.equal(r.json.ok, true)
    assert.equal(r.json.agentsPath, agentsPath)
  })

  await checkAsync('POST /delete 删除条目并摘索引', async () => {
    const r = await post('/memory-api/delete', { scope: 'global', name: 'ui/from-settings-page' })
    assert.equal(r.json.ok, true)
    assert.equal(r.json.removed, true)
    assert.equal(fs.existsSync(path.join(home, 'ui', 'from-settings-page.md')), false)
    const agents = fs.readFileSync(agentsPath, 'utf8')
    assert.doesNotMatch(agents, /设置页写入/)
  })

  await checkAsync('POST /save 的请求体非法 JSON 时返回 400', async () => {
    const path0 = '/memory-api/save'
    const req = {
      url: path0,
      method: 'POST',
      on(ev, cb) {
        if (ev === 'data') queueMicrotask(() => cb(Buffer.from('{not json')))
        if (ev === 'end') setTimeout(() => cb(), 1)
        return req
      }
    }
    const r = await callRoute(path0, req)
    assert.equal(r.status, 400)
    assert.match(r.json.error, /JSON/)
  })

  // ------------------------------------------------- 体检接口

  await checkAsync('GET /health 返回体检报告与结论', async () => {
    const r = await get('/memory-api/health', '/memory-api/health')
    assert.equal(r.status, 200)
    assert.equal(r.json.ok, true)
    assert.ok(r.json.report && r.json.report.counts, '应有 report.counts')
    assert.ok(Array.isArray(r.json.report.mergeCandidates.pairs), '应有待合并候选数组')
    assert.ok(Number.isFinite(r.json.report.budget.blockBytes))
    assert.equal(typeof r.json.verdict.needsMaintenance, 'boolean')
    assert.ok(Array.isArray(r.json.verdict.reasons))
  })

  await checkAsync('体检：写入两条高度重复的条目后会被报成待合并候选', async () => {
    const body = '这段正文专门用来测试记忆库体检的相似度检测，重复度越高越该被合并。'.repeat(10)
    await run('memory_write', { scope: 'global', name: 'tmp/dup-a', description: '体检回归：重复候选 A', body })
    await run('memory_write', { scope: 'global', name: 'tmp/dup-b', description: '体检回归：重复候选 B', body: body + '尾巴' })
    const r = await get('/memory-api/health', '/memory-api/health')
    const pairs = r.json.report.mergeCandidates.pairs
    const hit = pairs.find((p) => (p.a.includes('dup-a') && p.b.includes('dup-b')) || (p.a.includes('dup-b') && p.b.includes('dup-a')))
    assert.ok(hit, `应报出 tmp/dup-a ↔ tmp/dup-b，实际候选：${JSON.stringify(pairs)}`)
    assert.ok(hit.containment >= r.json.report.mergeCandidates.threshold)
  })

  // ------------------------------------------------- 自动提交（只本地 commit、不 push）

  await checkAsync('namemap：能分辨路径式与叶子名，并给出真实 name', async () => {
    const nm = require('./namemap.cjs')
    const repo2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-nm-'))
    const s3 = storeLib.createStore({ home: repo2, agentsPath: path.join(repo2, 'AGENTS.md'), maxBlockBytes: 32768, autoCommit: false })
    s3.write('global', { name: 'tools/leaf-probe', description: '路径式探针', body: 'x' })
    s3.write('global', { name: 'leaf-probe', description: '叶子名探针', body: 'y' })
    const rows = nm.collect(repo2)
    const a = rows.find((r) => r.target === 'tools/leaf-probe.md')
    const b = rows.find((r) => r.target === 'leaf-probe.md')
    assert.ok(a && a.style === 'path' && a.name === 'tools/leaf-probe', '路径式应判为 path')
    assert.ok(b && b.style === 'leaf' && b.name === 'leaf-probe', '叶子名应判为 leaf')
    fs.rmSync(repo2, { recursive: true, force: true })
  })

  await checkAsync('自动提交：home 不是 git 仓库时静默跳过，不抛错', async () => {
    // 上面所有用例用的就是这个非仓库的临时 home；走到这里没抛错即通过
    const probe = storeLib.createStore({ home, agentsPath })
    const r = probe.commitLibrary('probe')
    assert.equal(r.committed, false)
    assert.equal(r.reason, 'not-a-repo')
  })

  await checkAsync('自动提交：git 仓库里写入后产生一次本地提交，且不推送', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-git-'))
    // stdio 一律 ignore：沙箱下用管道捕获子进程输出会 EPERM
    const git = (args) => require('node:child_process').execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
    git(['init', '-b', 'main'])
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'test'])
    const agents2 = path.join(repo, 'AGENTS.md')
    const s2 = storeLib.createStore({ home: repo, agentsPath: agents2, maxBlockBytes: 32768 })
    const w = s2.write('global', { name: 'tmp/auto', description: '自动提交用例', body: '正文' })
    assert.equal(w.ok, true)
    assert.equal(w.commit.committed, true, '写入后应产生一次提交')
    // 不读 git 输出（管道会 EPERM），改看 git 自己写的 COMMIT_EDITMSG
    const msg = fs.readFileSync(path.join(repo, '.git', 'COMMIT_EDITMSG'), 'utf8')
    assert.match(msg, /tmp\/auto\.md/, '提交信息里应带条目路径')
    // 删除也应提交
    const f = s2.forget('global', 'tmp/auto')
    assert.equal(f.removed, true)
    assert.equal(f.commit.committed, true, '删除后也应产生一次提交')
    fs.rmSync(repo, { recursive: true, force: true })
  })

  fs.rmSync(root, { recursive: true, force: true })

  console.log(`\n${passed} 项通过，${failures.length} 项失败。\n`)
  if (failures.length) {
    for (const f of failures) console.log(`FAILED: ${f.label}\n${(f.err && f.err.stack) || ''}\n`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
