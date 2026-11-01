'use strict'
// dsh-sysmon host half: samples system stats via PowerShell and serves them
// over the webServer HTTP routes consumed by the browser panel.
// Spawning goes through the dsh `subprocess` service (sandbox-compatible),
// NOT node:child_process.execFile (which EPERMs inside the dsh process).

const os = require('node:os')

/**
 * 纯函数：由两次 `os.cpus()` 累计时间算 CPU 使用率（%）。
 *
 * 为什么要自己算：宿主原来的采样整包跑 PowerShell（脚本里三次 Start-Sleep 就 ~700ms），
 * 只能 1s 一次；而 CPU/内存用 Node 的 `os` 模块是**零成本**的，可以 500ms 甚至更快。
 * 注意 `os.cpus()[i].times` 是**开机以来的累计值**，必须两次快照相减才有意义。
 *
 * @param prev - 上一次的 `{ idle, total }`（首次传入 null）。
 * @param curr - 这一次的 `{ idle, total }`。
 * @returns 0–100 的百分比（保留一位小数）；没有可比基线时返回 null。
 */
function cpuDeltaPct(prev, curr) {
  if (!prev || !curr) return null
  const dTotal = curr.total - prev.total
  const dIdle = curr.idle - prev.idle
  if (!(dTotal > 0)) return null
  const busy = 100 * (1 - dIdle / dTotal)
  return Math.round(Math.max(0, Math.min(100, busy)) * 10) / 10
}

/** 当前 CPU 累计快照（所有核的 times 求和）。 */
function cpuSnapshot() {
  let idle = 0
  let total = 0
  for (const cpu of os.cpus() || []) {
    for (const key of Object.keys(cpu.times || {})) total += cpu.times[key]
    idle += (cpu.times && cpu.times.idle) || 0
  }
  return { idle, total }
}

/** 慢采样（磁盘 / GPU）的刷新周期：PowerShell 起来一次要 ~1s，2s 一次足够且不烧 CPU。 */
const SLOW_TTL_MS = 2000

const SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "# CPU: warm up once, then read",
  "$null = Get-Counter '\\Processor(_Total)\\% Processor Time' -ErrorAction SilentlyContinue",
  "Start-Sleep -Milliseconds 300",
  "$c2 = (Get-Counter '\\Processor(_Total)\\% Processor Time' -ErrorAction SilentlyContinue).CounterSamples[0].CookedValue",
  "$cpu = if ($null -eq $c2) { $null } else { [math]::Round([double]$c2, 1) }",
  "# Memory: available + committed approximates physical RAM",
  "$memSamples = @((Get-Counter '\\Memory\\Available MBytes','\\Memory\\Committed Bytes' -ErrorAction SilentlyContinue).CounterSamples)",
  "$availMB = 0",
  "$committed = 0",
  "foreach ($s in $memSamples) {",
  "  if ($s.Path -match 'available mbytes') { $availMB = [double]$s.CookedValue }",
  "  if ($s.Path -match 'committed bytes') { $committed = [double]$s.CookedValue }",
  "}",
  "$memTotal = [math]::Round(($availMB + $committed / 1MB) / 1024, 1)",
  "$memUsed = [math]::Round($committed / 1MB / 1024, 1)",
  "# Disk: per physical disk, utilization + read/write MB/s (Task Manager style)",
  "$null = Get-Counter '\\PhysicalDisk(*)\\Disk Read Bytes/sec','\\PhysicalDisk(*)\\Disk Write Bytes/sec','\\PhysicalDisk(*)\\% Disk Time' -ErrorAction SilentlyContinue",
  "Start-Sleep -Milliseconds 200",
  "$dSamples = @((Get-Counter '\\PhysicalDisk(*)\\Disk Read Bytes/sec','\\PhysicalDisk(*)\\Disk Write Bytes/sec','\\PhysicalDisk(*)\\% Disk Time' -ErrorAction SilentlyContinue).CounterSamples)",
  "$diskMap = @{}",
  "foreach ($s in $dSamples) {",
  "  $inst = $s.InstanceName",
  "  if ($inst -eq '_total') { continue }",
  "  if (-not $diskMap.ContainsKey($inst)) { $diskMap[$inst] = @{ read = 0.0; write = 0.0; util = 0.0 } }",
  "  if ($s.Path -match 'read bytes') { $diskMap[$inst].read = [double]$s.CookedValue / 1MB }",
  "  if ($s.Path -match 'write bytes') { $diskMap[$inst].write = [double]$s.CookedValue / 1MB }",
  "  if ($s.Path -match 'disk time') {",
  "    $u = [double]$s.CookedValue",
  "    if ($u -gt 100) { $u = 100 }",
  "    $diskMap[$inst].util = [math]::Round($u, 1)",
  "  }",
  "}",
  "$disks = @($diskMap.GetEnumerator() | ForEach-Object {",
  "  $disp = ($_.Key -replace '^\\d+\\s*', '').ToUpper()",
  "  [PSCustomObject]@{",
  "    name = $disp",
  "    util = $_.Value.util",
  "    readMBs = [math]::Round($_.Value.read, 2)",
  "    writeMBs = [math]::Round($_.Value.write, 2)",
  "  }",
  "} | Sort-Object name)",
  "# GPU 1/2: NVIDIA via nvidia-smi (always present), Intel via GPU Engine minus NVIDIA",
  "$nvidiaUse = $null",
  "$nvPath = 'C:\\Windows\\System32\\nvidia-smi.exe'",
  "if (-not (Test-Path $nvPath)) {",
  "  $nc = Get-Command nvidia-smi -ErrorAction SilentlyContinue",
  "  if ($nc) { $nvPath = $nc.Source }",
  "}",
  "if ($nvPath) {",
  "  try {",
  "    $nv = (& $nvPath --query-gpu=utilization.gpu --format=csv,noheader,nounits 2>$null | Select-Object -First 1)",
  "    if ($nv -match '^[\\d.]+$') { $nvidiaUse = [math]::Round([double]$nv, 1) }",
  "  } catch { }",
  "}",
  "$null = Get-Counter '\\GPU Engine(*)\\Utilization Percentage' -ErrorAction SilentlyContinue",
  "Start-Sleep -Milliseconds 200",
  "$gSamples = @((Get-Counter '\\GPU Engine(*)\\Utilization Percentage' -ErrorAction SilentlyContinue).CounterSamples)",
  "$gpuMap = @{}",
  "foreach ($s in $gSamples) {",
  "  if ($s.InstanceName -match 'luid_0x[0-9a-fA-F]+') {",
  "    $luid = $Matches[0]",
  "    if (-not $gpuMap.ContainsKey($luid)) { $gpuMap[$luid] = 0.0 }",
  "    $v = [double]$s.CookedValue",
  "    if ($v -gt $gpuMap[$luid]) { $gpuMap[$luid] = $v }",
  "  }",
  "}",
  "$groups = @($gpuMap.GetEnumerator() | Sort-Object Name)",
  "$gpus = @()",
  "if ($nvidiaUse -ne $null) {",
  "  $intelUse = 0",
  "  $candidates = @($groups | Where-Object { [math]::Abs([double]$_.Value - [double]$nvidiaUse) -ge 10 })",
  "  if ($candidates.Count -gt 0) { $intelUse = [math]::Round([math]::Min([double]$candidates[0].Value, 100), 1) }",
  "  $gpus += [PSCustomObject]@{ name = 'Intel GPU'; use = $intelUse }",
  "  $gpus += [PSCustomObject]@{ name = 'NVIDIA GPU'; use = $nvidiaUse }",
  "} else {",
  "  $gIdx = 0",
  "  foreach ($kv in $groups) {",
  "    $short = 'GPU' + ($gIdx + 1)",
  "    if ($gIdx -eq 0 -and $groups.Count -ge 2) { $short = 'Intel GPU' }",
  "    elseif ($gIdx -eq 1) { $short = 'NVIDIA GPU' }",
  "    $gpus += [PSCustomObject]@{ name = $short; use = [math]::Round([math]::Min([double]$kv.Value, 100), 1) }",
  "    $gIdx++",
  "  }",
  "  if ($gpus.Count -eq 0) { $gpus += [PSCustomObject]@{ name = 'GPU'; use = 0 } }",
  "}",
  "[PSCustomObject]@{",
  "  cpu = $cpu",
  "  memTotal = $memTotal",
  "  memUsed = $memUsed",
  "  disks = $disks",
  "  gpus = $gpus",
  "  at = (Get-Date).ToString('HH:mm:ss')",
  "} | ConvertTo-Json -Compress -Depth 4"
].join('\n')

module.exports = {
  inject: ['webServer', 'subprocess', 'sandboxPolicy'],
  apply(ctx) {
    let sidebarWidth = 280
    let sidebarWide = true
    // 慢采样（磁盘 / GPU，走 PowerShell）：只留最近一次结果，后台刷新，**不阻塞**接口
    let slow = { disks: [], gpus: [] }
    let slowAt = 0
    let slowInflight = null
    // 快采样（CPU / 内存，走 node:os）：每次请求即时算
    let cpuPrev = null

    async function runSample() {
      let exe
      try {
        exe = await ctx.subprocess.resolveExecutable('powershell.exe')
      } catch (e) {
        try {
          exe = await ctx.subprocess.resolveExecutable('pwsh.exe')
        } catch (e2) {
          return { error: 'no powershell: ' + String((e2 && e2.message) || e2) }
        }
      }
      let proc
      try {
        proc = ctx.subprocess.spawn({
          argv: [exe, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT],
          cwd: process.cwd(),
          stdio: {
            stdin: 'ignore',
            stdout: { maxBytes: 65536 },
            stderr: { maxBytes: 8192 }
          },
          graceMs: 15000
        })
      } catch (e) {
        return { error: 'spawn: ' + String((e && e.message) || e) }
      }
      try {
        await proc.done
      } catch (e) {
        return { error: 'run: ' + String((e && e.message) || e) }
      }
      let out = ''
      try {
        const read = proc.collected.stdout && proc.collected.stdout.readFrom(0)
        if (read) out = read.text
      } catch (e) { /* readFrom is sync; guard anyway */ }
      try {
        return JSON.parse(out)
      } catch (e) {
        return { error: 'parse', raw: String(out).slice(0, 500) }
      }
    }

    /**
     * 后台刷新慢数据（磁盘 / GPU）：到了 TTL 才起一次 PowerShell，已有 inflight 就复用。
     * 绝不 await——接口要立刻返回快数据，慢数据用上一次的结果。
     */
    function refreshSlow() {
      if (slowInflight !== null) return
      if (Date.now() - slowAt < SLOW_TTL_MS) return
      slowInflight = runSample().then((result) => {
        if (result && !result.error) {
          slow = { disks: result.disks || [], gpus: result.gpus || [] }
          slowAt = Date.now()
        }
        slowInflight = null
      }, () => { slowInflight = null })
    }

    /** 快数据：CPU 用两次 os.cpus() 快照相减，内存直接取 total/free。 */
    function fastSample() {
      const curr = cpuSnapshot()
      const cpu = cpuDeltaPct(cpuPrev, curr)
      cpuPrev = curr
      const memTotal = os.totalmem() / 1e9
      const memFree = os.freemem() / 1e9
      return {
        cpu,
        memTotal: Math.round(memTotal * 10) / 10,
        memUsed: Math.round((memTotal - memFree) * 10) / 10,
        at: new Date().toTimeString().slice(0, 8)
      }
    }

    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/sysmon-api/sample',
      handler: (req, res) => {
        // 先踢一脚后台慢采样，然后立刻返回：CPU/内存是当场算的，磁盘/GPU 用最近一次的值
        refreshSlow()
        const data = fastSample()
        const body = JSON.stringify({
          ...data,
          disks: slow.disks,
          gpus: slow.gpus,
          sidebarWidth,
          sidebarWide
        })
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.setHeader('Cache-Control', 'no-store')
        res.end(body)
      }
    }), 'dsh-sysmon: sample route')

    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/sysmon-api/width',
      handler: (req, res) => {
        if (req.method === 'POST') {
          let body = ''
          req.on('data', (chunk) => { body += chunk })
          req.on('end', () => {
            try {
              const data = JSON.parse(body || '{}')
              if (typeof data.width === 'number' && data.width > 0) sidebarWidth = Math.round(data.width)
              if (typeof data.wide === 'boolean') sidebarWide = data.wide
            } catch (e) { /* ignore malformed */ }
            res.setHeader('Content-Type', 'application/json')
            res.end('{"ok":true}')
          })
          return
        }
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ width: sidebarWidth, wide: sidebarWide }))
      }
    }), 'dsh-sysmon: width route')
  }
}
