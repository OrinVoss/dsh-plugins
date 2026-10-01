'use strict'
// dsh-sysmon host half: samples system stats via PowerShell and serves them
// over the webServer HTTP routes consumed by the browser panel.
// Spawning goes through the dsh `subprocess` service (sandbox-compatible),
// NOT node:child_process.execFile (which EPERMs inside the dsh process).

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
    let cache = null
    let lastAt = 0
    let inflight = null

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

    const sample = async () => {
      const now = Date.now()
      if (cache && now - lastAt < 1000) return cache
      if (inflight) return inflight
      inflight = runSample().then((result) => {
        cache = result
        lastAt = Date.now()
        inflight = null
        return result
      }, (err) => {
        inflight = null
        return { error: String((err && err.message) || err) }
      })
      return inflight
    }

    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/sysmon-api/sample',
      handler: async (req, res) => {
        const data = await sample()
        const body = JSON.stringify({ ...data, sidebarWidth, sidebarWide })
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
