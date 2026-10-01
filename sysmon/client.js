window.__ModuleLoader__.load({
  id: 'dsh-sysmon',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    let react = require('react')

    const CSS = [
      // Ring gauges docked above Settings at the sidebar foot (layout flow, so
      // they can never cover the workspace tree).
      '.dsh-sysmon-foot{flex:1;min-width:0;display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-end;gap:6px 8px;padding:8px 2px;box-sizing:border-box;font-family:var(--dsw-font-family)}',
      '.dsh-sysmon-cell{display:flex;flex-direction:column;align-items:center;gap:3px;min-width:0}',
      '.dsh-sysmon-cap{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-secondary);white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-sysmon-note{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      // Collapsed rail: a single CPU ring
      '.dsh-sysmon-rail{display:flex;align-items:center;justify-content:center;padding:6px 0}'
    ].join('\n')

    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="dsh-sysmon"]') === null) {
      const tag = document.createElement('style')
      tag.dataset.pluginCss = 'dsh-sysmon'
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    function useSample(ms) {
      const [data, setData] = react.useState(null)
      const [failed, setFailed] = react.useState(false)
      react.useEffect(() => {
        let disposed = false
        const load = async () => {
          try {
            const r = await fetch('/sysmon-api/sample', { cache: 'no-store' })
            const d = await r.json()
            if (!disposed) {
              setData(d)
              setFailed(false)
            }
          } catch (e) {
            if (!disposed) setFailed(true)
          }
        }
        load()
        const stop = window.setInterval(load, ms)
        return () => { disposed = true; window.clearInterval(stop) }
      }, [ms])
      return [data, failed]
    }

    // Display names: the host still reports the vendor identity, the UI calls
    // the integrated one 核显 and the discrete one 独显.
    function gpuLabel(name, index) {
      const n = String(name || '')
      if (/intel/i.test(n)) return '核显'
      if (/nvidia|geforce|rtx|gtx/i.test(n)) return '独显'
      return n || ('GPU' + (index + 1))
    }

    function ringColor(v) {
      return v >= 90 ? 'var(--dsw-alias-state-error-primary)'
        : (v >= 60 ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-brand-primary)')
    }

    // Ring gauge: an arc sweeping clockwise from 12 o'clock, optional centered text.
    function ring(pct, size, stroke, text) {
      const v = Math.max(0, Math.min(100, Math.round(pct || 0)))
      const r = (size - stroke) / 2
      const c = 2 * Math.PI * r
      const children = [
        react.createElement('circle', { key: 'track', cx: size / 2, cy: size / 2, r, fill: 'none', stroke: 'var(--dsw-alias-border-l2)', strokeWidth: stroke }),
        react.createElement('circle', {
          key: 'arc',
          cx: size / 2,
          cy: size / 2,
          r,
          fill: 'none',
          stroke: ringColor(v),
          strokeWidth: stroke,
          strokeLinecap: 'round',
          strokeDasharray: c,
          strokeDashoffset: c * (1 - v / 100),
          transform: 'rotate(-90 ' + size / 2 + ' ' + size / 2 + ')',
          style: { transition: 'stroke-dashoffset .5s ease' }
        })
      ]
      if (text) {
        children.push(react.createElement('text', {
          key: 'text',
          x: size / 2,
          y: size / 2,
          textAnchor: 'middle',
          dominantBaseline: 'central',
          fontSize: Math.round(size * 0.3),
          fontWeight: 600,
          fill: 'var(--dsw-alias-label-primary)'
        }, text))
      }
      return react.createElement('svg', {
        width: size,
        height: size,
        viewBox: '0 0 ' + size + ' ' + size,
        style: { flex: 'none', display: 'block' }
      }, children)
    }

    function cell(key, cap, pct, title) {
      return react.createElement('div', { key, className: 'dsh-sysmon-cell', title },
        ring(pct, 34, 3.5, pct == null ? '—' : Math.round(pct) + '%'),
        react.createElement('div', { className: 'dsh-sysmon-cap' }, cap))
    }

    // ---- Sidebar foot ring gauges (sidebar.footer.action) ----
    function SysmonFoot(props) {
      const wide = !(props && props.wide === false)
      const [data, failed] = useSample(1000)
      const ok = data && !data.error
      const cpu = ok && data.cpu != null ? data.cpu : 0

      if (!wide) {
        return react.createElement('div', { className: 'dsh-sysmon-rail', title: '系统监控 · CPU ' + Math.round(cpu) + '%' }, ring(cpu, 22, 2.5))
      }

      if (!ok) {
        return react.createElement('div', { className: 'dsh-sysmon-foot' },
          react.createElement('div', { className: 'dsh-sysmon-note' },
            failed ? '系统监控不可用' : '系统监控加载中…'))
      }

      const memPct = data.memTotal > 0 ? Math.round((data.memUsed / data.memTotal) * 100) : 0
      const disks = data.disks || []
      const gpus = data.gpus || []

      let diskPct = null
      for (let i = 0; i < disks.length; i++) {
        const u = disks[i].util
        if (u == null) continue
        diskPct = diskPct == null ? u : Math.max(diskPct, u)
      }
      const diskTitle = disks.length === 0 ? '磁盘' : disks.map((d) =>
        (d.name || '磁盘') + ' ' + Math.round(d.util || 0) + '% ↓ ' + d.readMBs + ' MB/s ↑ ' + d.writeMBs + ' MB/s').join(' · ')

      const cells = [
        cell('cpu', 'CPU', data.cpu, 'CPU 使用率 ' + (data.cpu == null ? 'N/A' : Math.round(data.cpu) + '%')),
        cell('mem', '内存', memPct, '内存 ' + data.memUsed + ' / ' + data.memTotal + ' GB'),
        cell('disk', '磁盘', diskPct, diskTitle)
      ]
      gpus.forEach((g, i) => {
        const label = gpuLabel(g.name, i)
        cells.push(cell('gpu' + i, label, g.use,
          label + ' ' + (g.use == null ? 'N/A' : Math.round(g.use) + '%')))
      })

      return react.createElement('div', { className: 'dsh-sysmon-foot' }, cells)
    }

    const inject = ['slots']

    function apply(ctx) {
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'sysmon',
        order: 10,
        label: '系统监控'
      }, SysmonFoot))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
