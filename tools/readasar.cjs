'use strict'

// 从 Electron 的 app.asar 里读文件。
//
//   node readasar.cjs list <正则>                 # 列路径（大小 + 路径）
//   node readasar.cjs cat  <完整路径>             # 打印单个文件
//   node readasar.cjs dump <正则> <输出目录>       # 把匹配的文本文件导出来（跳过 unpacked 与 >4MB）
//   node readasar.cjs grep <正则> <内容正则>       # 在匹配路径的文件里找内容（列出 文件:行）
//
// 为什么需要它：DSH 桌面端的前端产物、设计系统 token、插槽契约都在
// `F:\dsh\resources\app.asar` 里，仓库里没有源码。想核对「官方到底用什么值」
// （例如 `--dsw-radius-md` 是 8 还是 12、官方卡片的底色是哪个 token）时，
// 掏 asar 比凭印象靠谱得多——2026-10-04 用它查出三处自造样式与官方不符。
//
// asar 头是**两层 pickle**，位置很容易记错：
//   [0..4)   pickle1 载荷长度（=4）
//   [4..8)   header pickle 总长度 headerSize
//   [8..12)  内层载荷长度
//   [12..16) JSON 字符串长度
//   [16..16+jsonLen) JSON 索引
//   数据区起点 = 8 + headerSize
// （照 Node 常见示例写 `readUInt32LE(4)` 当 jsonLen 会解析失败。）

const fs = require('node:fs')
const path = require('node:path')

const ASAR = process.env.DSH_ASAR || 'F:/dsh/resources/app.asar'

if (!fs.existsSync(ASAR)) {
  console.error(`找不到 app.asar：${ASAR}\n（可用 $env:DSH_ASAR 指定其它位置）`)
  process.exit(1)
}

const buf = fs.readFileSync(ASAR)
const headerSize = buf.readUInt32LE(4)
const jsonLen = buf.readUInt32LE(12)
const header = JSON.parse(buf.subarray(16, 16 + jsonLen).toString('utf8'))
const dataStart = 8 + headerSize

function walk(node, prefix, out) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const p = prefix ? `${prefix}/${name}` : name
    if (entry.files) walk(entry, p, out)
    else out.push({ path: p, size: Number(entry.size || 0), offset: Number(entry.offset || 0), unpacked: !!entry.unpacked })
  }
  return out
}

const all = walk(header, '', [])
const [mode, ...rest] = process.argv.slice(2)

if (!mode) {
  console.error('用法： node readasar.cjs list|cat|dump|grep …（见文件头注释）')
  process.exit(1)
}

if (mode === 'list') {
  const re = new RegExp(rest[0] || '.', 'i')
  const hits = all.filter((f) => re.test(f.path))
  for (const f of hits.slice(0, 200)) console.log(`${String(f.size).padStart(9)}  ${f.path}`)
  console.log(`（共 ${hits.length} 个匹配 / 总计 ${all.length} 个文件）`)
} else if (mode === 'cat') {
  const one = all.find((f) => f.path === rest[0])
  if (!one) { console.error(`找不到：${rest[0]}`); process.exit(1) }
  process.stdout.write(buf.subarray(dataStart + one.offset, dataStart + one.offset + one.size))
} else if (mode === 'dump') {
  const re = new RegExp(rest[0] || '.', 'i')
  const outDir = rest[1]
  if (!outDir) { console.error('dump 需要输出目录'); process.exit(1) }
  fs.mkdirSync(outDir, { recursive: true })
  let n = 0
  for (const f of all.filter((x) => re.test(x.path))) {
    if (f.unpacked || f.size > 4 * 1024 * 1024) continue
    fs.writeFileSync(path.join(outDir, f.path.replace(/[\\/]/g, '__')), buf.subarray(dataStart + f.offset, dataStart + f.offset + f.size))
    n++
  }
  console.log(`已写出 ${n} 个文件到 ${outDir}`)
} else if (mode === 'grep') {
  const pathRe = new RegExp(rest[0] || '.', 'i')
  const textRe = new RegExp(rest[1] || '.')
  let files = 0
  let hits = 0
  for (const f of all) {
    if (f.unpacked || f.size > 4 * 1024 * 1024) continue
    if (!pathRe.test(f.path)) continue
    const data = buf.subarray(dataStart + f.offset, dataStart + f.offset + f.size)
    if (data.includes(0)) continue // 跳过二进制
    const lines = data.toString('utf8').split('\n')
    let any = false
    lines.forEach((line, i) => {
      if (!textRe.test(line)) return
      any = true
      hits++
      if (hits <= 200) console.log(`${f.path}:${i + 1}: ${line.trim().slice(0, 240)}`)
    })
    if (any) files++
  }
  console.log(`（${files} 个文件命中，共 ${hits} 行）`)
} else {
  console.error(`未知子命令：${mode}`)
  process.exit(1)
}
