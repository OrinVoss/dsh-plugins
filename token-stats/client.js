window.__ModuleLoader__.load({
  id: 'dsh-token-stats',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect
    const useMemo = React.useMemo
    const useRef = React.useRef
    const useCallback = React.useCallback

    // 主面板 key 与侧栏图标 id 必须是同一个值：外壳用这个 id 寻址 `main`
    // keyed slot 里注册的组件（见 dsh-client-ui-sidebar 的 README）。
    const PANEL_ID = 'token-stats'

    // ------------------------------------------------------------------ 样式
    //
    // 只用 `--dsw-*` token，不发明新视觉；半径 token 带兜底值。
    // 图表配色是固定色盘：数据系列要彼此可区分，且明暗主题下都读得清。
    const CSS = [
      '.dshts-root{display:flex;flex-direction:column;width:100%;height:100%;overflow-y:auto;box-sizing:border-box;padding:20px 24px 40px;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family)}',
      '.dshts-head{display:flex;align-items:center;gap:10px;padding-bottom:14px}',
      '.dshts-headIcon{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-business-primary)}',
      '.dshts-title{font-size:16px;font-weight:500;line-height:24px}',
      '.dshts-sub{margin-top:2px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.dshts-spacer{flex:1}',
      '.dshts-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:5px;height:28px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:18px;cursor:pointer;white-space:nowrap}',
      '.dshts-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshts-btn:disabled{cursor:not-allowed;opacity:.45}',
      '.dshts-seg{display:inline-flex;padding:2px;gap:2px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1)}',
      '.dshts-segBtn{height:24px;padding:0 12px;border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;line-height:18px;cursor:pointer}',
      '.dshts-segBtn:hover{color:var(--dsw-alias-label-primary)}',
      '.dshts-segBtn[data-on="1"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-weight:500}',

      '.dshts-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:12px;padding-bottom:16px}',
      '.dshts-kpi{padding:12px 14px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-1)}',
      '.dshts-kpiLabel{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.dshts-kpiValue{margin-top:4px;font-size:22px;line-height:30px;font-weight:500;letter-spacing:-.01em}',
      '.dshts-kpiUnit{margin-left:4px;font-size:12px;font-weight:400;color:var(--dsw-alias-label-secondary)}',
      '.dshts-kpiFoot{margin-top:2px;font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary)}',

      '.dshts-card{margin-bottom:16px;padding:16px 18px 18px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-1)}',
      '.dshts-cardHead{display:flex;align-items:center;gap:10px;padding-bottom:14px}',
      '.dshts-cardTitle{font-size:14px;line-height:20px;font-weight:500}',
      '.dshts-cardNote{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',

      '.dshts-heat{overflow-x:auto;padding-bottom:6px}',
      '.dshts-heatInner{display:flex;flex-direction:column;gap:6px}',
      '.dshts-heatMonths{position:relative;height:16px}',
      '.dshts-heatMonth{position:absolute;top:0;font-size:11px;line-height:16px;white-space:nowrap;color:var(--dsw-alias-label-tertiary)}',
      '.dshts-heatGrid{display:flex;gap:3px}',
      '.dshts-heatCol{display:flex;flex-direction:column;gap:3px}',
      '.dshts-heatCell{width:12px;height:12px;border-radius:2px;background:color-mix(in srgb, var(--dsw-alias-label-primary) 11%, transparent)}',
      '.dshts-heatCellVoid{background:transparent}',
      '.dshts-heatFoot{display:flex;align-items:center;gap:6px;justify-content:flex-end;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);padding-top:8px}',
      '.dshts-heatLegendCells{display:flex;gap:3px}',

      '.dshts-chartWrap{position:relative;width:100%}',
      '.dshts-svg{display:block;width:100%}',
      '.dshts-gridLine{stroke:var(--dsw-alias-border-l1);stroke-width:1;stroke-dasharray:2 4}',
      '.dshts-axisText{fill:var(--dsw-alias-label-tertiary);font-size:11px}',
      '.dshts-cursorLine{stroke:var(--dsw-alias-border-l4);stroke-width:1;stroke-dasharray:3 3}',
      '.dshts-tip{position:absolute;z-index:5;min-width:160px;max-width:280px;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-2);box-shadow:0 6px 24px rgba(0,0,0,.3);pointer-events:none;transform:translate(-50%,0)}',
      '.dshts-tipDay{font-size:12px;line-height:18px;font-weight:500;padding-bottom:2px}',
      '.dshts-tipRow{display:flex;align-items:center;gap:6px;font-size:12px;line-height:18px;white-space:nowrap}',
      '.dshts-tipDot{flex:none;width:8px;height:8px;border-radius:2px}',
      '.dshts-tipName{flex:1;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary)}',
      '.dshts-tipVal{font-variant-numeric:tabular-nums}',

      '.dshts-legend{display:flex;flex-wrap:wrap;gap:4px 16px;padding-bottom:12px}',
      '.dshts-legendItem{display:inline-flex;align-items:center;gap:6px;padding:2px 0;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;line-height:18px;cursor:pointer}',
      '.dshts-legendItem:hover{color:var(--dsw-alias-label-primary)}',
      '.dshts-legendItem[data-off="1"]{opacity:.38;text-decoration:line-through}',
      '.dshts-legendDot{flex:none;width:8px;height:8px;border-radius:2px}',

      '.dshts-usage{display:grid;grid-template-columns:minmax(190px,240px) 1fr;gap:28px;align-items:center}',
      '.dshts-donutWrap{position:relative;display:flex;align-items:center;justify-content:center}',
      '.dshts-donutCenter{position:absolute;display:flex;flex-direction:column;align-items:center;gap:1px;pointer-events:none}',
      '.dshts-donutValue{font-size:20px;line-height:26px;font-weight:500}',
      '.dshts-donutLabel{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}',
      '.dshts-usageList{display:flex;flex-direction:column;min-width:0}',
      '.dshts-usageRow{display:grid;grid-template-columns:10px minmax(0,1fr) auto;grid-template-rows:auto auto;gap:0 10px;padding:9px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}',
      '.dshts-usageRow:last-child{border-bottom:none}',
      '.dshts-usageDot{grid-row:1 / span 2;align-self:center;width:10px;height:10px;border-radius:3px}',
      '.dshts-usageName{grid-column:2;font-size:13px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshts-usagePct{grid-column:3;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}',
      '.dshts-usageVal{grid-column:2;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.dshts-usageSteps{grid-column:3;font-size:11px;line-height:18px;color:var(--dsw-alias-label-dimmed);font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}',

      '.dshts-empty{padding:60px 0;text-align:center;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}',
      '.dshts-note{margin:0 0 14px;padding:8px 10px;border-radius:var(--dsw-radius-sm,6px);font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent)}',
      '.dshts-banner{margin:0 0 14px;padding:6px 10px;border-radius:var(--dsw-radius-sm,6px);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}'
    ].join('\n')

    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="dsh-token-stats"]') === null) {
      const tag = document.createElement('style')
      tag.dataset.pluginCss = 'dsh-token-stats'
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // ------------------------------------------------------------------ 常量与工具

    // 图表色盘：固定顺序，保证相邻系列可区分。
    const PALETTE = ['#4f86f7', '#6fcf7f', '#8b6bf5', '#f4675a', '#f5a04a', '#3fb6c9', '#e07ab8', '#c9a24a', '#9aa4b2', '#5f9ea0']

    // 热力图色阶：蓝，从深到浅（值越大越亮）。
    const HEAT_STOPS = ['#17324d', '#1d4f86', '#2f74c0', '#4f9bf5', '#8cc2ff']

    const RANGES = [
      { id: '7', label: '近 7 日', days: 7 },
      { id: '30', label: '近 30 日', days: 30 },
      { id: 'all', label: '全部', days: 0 }
    ]

    // 趋势图默认只展示最靠前的几个模型，其余靠图例点开。
    const DEFAULT_SERIES = 6

    const colorOf = (index) => PALETTE[index % PALETTE.length]

    function trimZero(s) {
      return s.indexOf('.') >= 0 ? s.replace(/\.?0+$/, '') : s
    }

    /** Token 数按中文习惯缩写：亿 / 万。 */
    function fmtTokens(n) {
      if (!Number.isFinite(n)) return '–'
      const abs = Math.abs(n)
      if (abs >= 1e8) return trimZero((n / 1e8).toFixed(2)) + '亿'
      if (abs >= 1e4) return trimZero((n / 1e4).toFixed(1)) + '万'
      return String(Math.round(n))
    }

    function fmtCount(n) {
      if (!Number.isFinite(n)) return '–'
      return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    }

    function fmtPct(part, whole) {
      if (!whole) return '0%'
      const v = (part / whole) * 100
      if (v >= 10) return v.toFixed(0) + '%'
      if (v >= 1) return v.toFixed(1) + '%'
      if (v > 0) return v.toFixed(2) + '%'
      return '0%'
    }

    function fmtDay(key) {
      const parts = String(key).split('-')
      if (parts.length !== 3) return key
      return `${Number(parts[1])}月${Number(parts[2])}日`
    }

    function fmtDayShort(key) {
      const parts = String(key).split('-')
      if (parts.length !== 3) return key
      return `${Number(parts[1])}/${Number(parts[2])}`
    }

    function parseDay(key) {
      const parts = String(key).split('-')
      return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]))
    }

    /** parseDay 的逆运算：本地日期 → 'YYYY-MM-DD'。 */
    function keyOfDay(date) {
      const m = String(date.getMonth() + 1).padStart(2, '0')
      const d = String(date.getDate()).padStart(2, '0')
      return `${date.getFullYear()}-${m}-${d}`
    }

    function heatColor(ratio) {
      if (!(ratio > 0)) return null
      const idx = Math.min(HEAT_STOPS.length - 1, Math.floor(ratio * HEAT_STOPS.length))
      return HEAT_STOPS[idx]
    }

    /**
     * 单调三次插值（Fritsch–Carlson）转贝塞尔路径。
     *
     * 不能用普通的 Catmull-Rom 平滑：相邻点从高值骤降到 0 时，它的控制点会
     * 「冲过头」，把曲线带到 0 线以下（负值区），看起来像用量成了负数。
     * 单调插值会先把每点的切线夹到不越界，保证曲线在数据单调的区间内
     * 始终落在两端取值之间；谷底点的切线被压成 0，于是曲线平贴 0 线。
     */
    function monotonePath(points) {
      const n = points.length
      if (n === 0) return ''
      if (n === 1) return `M${points[0][0]},${points[0][1]}`

      const dx = []
      const dy = []
      const delta = []
      for (let i = 0; i < n - 1; i++) {
        dx[i] = points[i + 1][0] - points[i][0]
        dy[i] = points[i + 1][1] - points[i][1]
        delta[i] = dx[i] === 0 ? 0 : dy[i] / dx[i]
      }
      if (n === 2) {
        return `M${points[0][0]},${points[0][1]} L${points[1][0]},${points[1][1]}`
      }

      // 初始切线：内部点取两侧割线的平均，异号（局部极值）处取 0
      const m = new Array(n)
      m[0] = delta[0]
      m[n - 1] = delta[n - 2]
      for (let i = 1; i < n - 1; i++) {
        m[i] = delta[i - 1] * delta[i] <= 0 ? 0 : (delta[i - 1] + delta[i]) / 2
      }
      // 限制切线，消除过冲
      for (let i = 0; i < n - 1; i++) {
        if (delta[i] === 0) { m[i] = 0; m[i + 1] = 0; continue }
        const a = m[i] / delta[i]
        const b = m[i + 1] / delta[i]
        const s = a * a + b * b
        if (s > 9) {
          const t = 3 / Math.sqrt(s)
          m[i] = t * a * delta[i]
          m[i + 1] = t * b * delta[i]
        }
      }

      let d = `M${points[0][0]},${points[0][1]}`
      for (let i = 0; i < n - 1; i++) {
        const h = dx[i]
        const x1 = points[i][0]
        const y1 = points[i][1]
        const x2 = points[i + 1][0]
        const y2 = points[i + 1][1]
        const c1x = x1 + h / 3
        const c1y = y1 + (m[i] * h) / 3
        const c2x = x2 - h / 3
        const c2y = y2 - (m[i + 1] * h) / 3
        d += ` C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${x2},${y2}`
      }
      return d
    }

    /** 观察元素宽度，供自适应 SVG 用。 */
    function useWidth() {
      const ref = useRef(null)
      const [width, setWidth] = useState(0)
      useEffect(() => {
        const node = ref.current
        if (node === null) return undefined
        setWidth(node.clientWidth)
        if (typeof ResizeObserver === 'undefined') return undefined
        const ro = new ResizeObserver((entries) => {
          for (const entry of entries) setWidth(entry.contentRect.width)
        })
        ro.observe(node)
        return () => ro.disconnect()
      }, [])
      return [ref, width]
    }

    function useSummary() {
      const [state, setState] = useState({ loading: true, refreshing: false, error: null, data: null, stale: false })
      const load = useCallback(async (refresh) => {
        setState((prev) => ({ ...prev, loading: prev.data === null, refreshing: refresh === true, error: null }))
        try {
          const url = refresh === true ? '/token-stats-api/summary?refresh=1' : '/token-stats-api/summary'
          const res = await fetch(url, { cache: 'no-store' })
          let json = null
          try { json = await res.json() } catch (_) { throw new Error(`响应不是 JSON（HTTP ${res.status}）`) }
          if (!res.ok || json.ok === false) throw new Error(json.error || `HTTP ${res.status}`)
          setState({ loading: false, refreshing: false, error: null, data: json.data, stale: json.stale === true })
        } catch (err) {
          setState((prev) => ({ ...prev, loading: false, refreshing: false, error: String((err && err.message) || err) }))
        }
      }, [])
      useEffect(() => { load(false) }, [load])
      return [state, load]
    }

    // ------------------------------------------------------------------ 图标

    function StatsGlyph(props) {
      const size = (props && props.size) || 16
      return h('svg', {
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        style: { display: 'block' }
      },
      h('path', { d: 'M2.5 13.5h11' }),
      h('path', { d: 'M4.5 13.5V8.2M7.6 13.5V4.4M10.7 13.5V9.6M13.5 13.5V6.6' }))
    }

    function RefreshGlyph() {
      return h('svg', {
        viewBox: '0 0 16 16', width: 13, height: 13, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
        style: { display: 'block' }
      },
      h('path', { d: 'M13.2 7.2a5.2 5.2 0 1 0-.5 3.3' }),
      h('path', { d: 'M13.4 3.4v3.9h-3.9' }))
    }

    // ------------------------------------------------------------------ KPI

    function Kpi(props) {
      return h('div', { className: 'dshts-kpi' },
        h('div', { className: 'dshts-kpiLabel' }, props.label),
        h('div', { className: 'dshts-kpiValue' }, props.value,
          props.unit ? h('span', { className: 'dshts-kpiUnit' }, props.unit) : null),
        h('div', { className: 'dshts-kpiFoot' }, props.foot))
    }

    function KpiRow(props) {
      const t = props.totals
      const activeDays = props.activeDays
      return h('div', { className: 'dshts-kpis' },
        h(Kpi, { label: 'Token 总量', value: fmtTokens(t.total), unit: 'tokens', foot: `${fmtCount(t.steps)} 次模型调用` }),
        h(Kpi, { label: '输入', value: fmtTokens(t.input), unit: 'tokens', foot: fmtPct(t.input, t.total) + ' 占比' }),
        h(Kpi, { label: '输出', value: fmtTokens(t.output), unit: 'tokens', foot: fmtPct(t.output, t.total) + ' 占比' }),
        h(Kpi, { label: '缓存读取', value: fmtTokens(t.cache), unit: 'tokens', foot: fmtPct(t.cache, t.total) + ' 占比' }),
        h(Kpi, {
          label: '日均',
          value: fmtTokens(activeDays > 0 ? t.total / activeDays : 0),
          unit: 'tokens',
          foot: `${activeDays} 天有记录`
        })
      )
    }

    // ------------------------------------------------------------------ 热力图

    // 热力图始终铺满「最近 12 个自然月」，**不随时间范围切换**：
    // 没有记录的日子也要占一个空格子，这样一眼能看出用量是集中在某几周、
    // 还是均匀分布——只画有数据的那几十天反而看不出这个形状。
    const HEAT_GAP = 4
    const HEAT_MIN_CELL = 9
    const HEAT_MAX_CELL = 26
    // 空格子必须看得见，否则整片网格不成立（浅色主题下 bg-layer-2 几乎与背景同色，
    // 空月份会糊成一整块空白）。用 label-primary 的低透明度叠加：浅色主题下偏灰，
    // 深色主题下偏亮，两种主题都能形成「一个个小方块」的网格感。
    const HEAT_EMPTY = 'color-mix(in srgb, var(--dsw-alias-label-primary) 11%, transparent)'

    function Heatmap(props) {
      const days = props.days
      const [wrapRef, width] = useWidth()

      const layout = useMemo(() => {
        if (days.length === 0) return { weeks: [], months: [], max: 0 }

        let max = 0
        const byDay = new Map()
        for (const d of days) {
          byDay.set(d.day, d.total)
          if (d.total > max) max = d.total
        }

        // 窗口：末月往前推 11 个月的 1 号 → 最后一天所在周的周日
        const last = parseDay(days[days.length - 1].day)
        const windowStart = new Date(last.getFullYear(), last.getMonth() - 11, 1)
        const start = new Date(windowStart)
        start.setDate(start.getDate() - ((windowStart.getDay() + 6) % 7)) // 对齐周一
        const end = new Date(last)
        end.setDate(end.getDate() + (6 - ((last.getDay() + 6) % 7))) // 对齐周日

        const weeks = []
        const months = []
        let lastMonth = -1
        let lastLabelWeek = -99
        const cursor = new Date(start)
        while (cursor.getTime() <= end.getTime()) {
          const monday = new Date(cursor)
          const col = []
          for (let r = 0; r < 7; r++) {
            const d = new Date(monday)
            d.setDate(d.getDate() + r)
            if (d.getTime() > end.getTime()) { col.push(null); continue }
            const key = keyOfDay(d)
            col.push({
              day: key,
              total: byDay.has(key) ? byDay.get(key) : 0,
              // 窗口开始之前的几天（首周的前半截）不画格子，避免看起来像有范围外数据
              inWindow: d.getTime() >= windowStart.getTime()
            })
          }
          // 月份标签：取该周内第一个「窗口内」日期的月份。不能按周一算——
          // 首周为了对齐周一往往落在窗口起点之前，按周一会把 10 月标成 9 月。
          const anchor = col.find((c) => c !== null && c.inWindow === true)
          if (anchor === undefined) {
            months.push('')
          } else {
            const m = parseDay(anchor.day).getMonth()
            if (m !== lastMonth) {
              if (weeks.length - lastLabelWeek >= 3) {
                months.push(`${m + 1}月`)
                lastLabelWeek = weeks.length
              } else {
                months.push('')
              }
              lastMonth = m
            } else {
              months.push('')
            }
          }
          weeks.push(col)
          cursor.setDate(cursor.getDate() + 7)
        }
        return { weeks, months, max }
      }, [days])

      if (days.length === 0) return h('div', { className: 'dshts-empty' }, '还没有数据')

      const { weeks, months, max } = layout
      const count = Math.max(weeks.length, 1)
      // 格子宽度跟着容器走：塞得下就铺满，塞不下就退到下限并横向滚动
      const avail = Math.max(width || 0, 240)
      const cell = Math.max(
        HEAT_MIN_CELL,
        Math.min(HEAT_MAX_CELL, Math.floor((avail - (count - 1) * HEAT_GAP) / count))
      )
      const radius = Math.max(2, Math.round(cell * 0.22))
      const innerWidth = count * (cell + HEAT_GAP) - HEAT_GAP
      const cellStyle = { width: cell + 'px', height: cell + 'px', borderRadius: radius + 'px' }

      const legend = h('div', { className: 'dshts-heatFoot' },
        h('span', null, '少'),
        h('div', { className: 'dshts-heatLegendCells' },
          [null, 0, 1, 2, 3, 4].map((i, idx) => h('span', {
            key: idx,
            className: 'dshts-heatCell',
            style: { background: i === null ? HEAT_EMPTY : heatColor((i + 0.5) / HEAT_STOPS.length) }
          }))),
        h('span', null, '多'))

      const grid = h('div', { className: 'dshts-heatGrid' },
        weeks.map((col, wi) => h('div', { className: 'dshts-heatCol', key: wi },
          col.map((c, ri) => {
            if (c === null || c.inWindow !== true) {
              return h('div', { key: ri, className: 'dshts-heatCell dshts-heatCellVoid', style: cellStyle })
            }
            return h('div', {
              key: ri,
              className: 'dshts-heatCell',
              title: `${c.day} · ${c.total > 0 ? fmtTokens(c.total) + ' tokens' : '无记录'}`,
              style: Object.assign({}, cellStyle, {
                background: heatColor(max > 0 ? c.total / max : 0) || HEAT_EMPTY
              })
            })
          }))))

      return h('div', { ref: wrapRef },
        h('div', { className: 'dshts-heat' },
          h('div', { className: 'dshts-heatInner', style: { width: innerWidth + 'px' } },
            grid,
            // 月份标签在网格下方（对齐宿主里同类热力图的排法）
            h('div', { className: 'dshts-heatMonths', style: { width: innerWidth + 'px' } },
              months.map((label, i) => label === '' ? null : h('span', {
                key: i,
                className: 'dshts-heatMonth',
                style: { left: (i * (cell + HEAT_GAP)) + 'px' }
              }, label))))),
        legend)
    }

    // ------------------------------------------------------------------ 趋势图

    function TrendChart(props) {
      const days = props.days
      const models = props.models
      const hidden = props.hidden
      const toggle = props.onToggle
      const [wrapRef, width] = useWidth()
      const [hoverIndex, setHoverIndex] = useState(-1)
      const height = 280
      const pad = { top: 16, right: 18, bottom: 30, left: 56 }
      const innerW = Math.max(60, width - pad.left - pad.right)
      const innerH = height - pad.top - pad.bottom

      const series = useMemo(() => models.map((m) => ({
        model: m.model,
        color: m.color,
        values: days.map((d) => {
          const entry = d.models ? d.models[m.model] : null
          return entry ? entry.total : 0
        })
      })), [days, models])

      const visible = series.filter((s) => !hidden.has(s.model))

      const maxValue = useMemo(() => {
        let max = 0
        for (const s of visible) for (const v of s.values) if (v > max) max = v
        return max === 0 ? 1 : max
      }, [visible])

      // 纵向留 8% 余量，峰值不贴顶；刻度文字仍按真实最大值标。
      const yMax = maxValue * 1.08
      const xOf = (i) => pad.left + (days.length <= 1 ? innerW / 2 : (i / (days.length - 1)) * innerW)
      const yOf = (v) => pad.top + innerH - (v / yMax) * innerH

      const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ v: maxValue * f, y: yOf(maxValue * f) }))

      // x 轴标签：均匀取点；最后一天若与前一个标签挨得太近，就用它替换掉前一个，
      // 避免出现「9/29/30」这种叠在一起的标签。
      const labelSet = useMemo(() => {
        const n = days.length
        if (n === 0) return new Set()
        const step = Math.max(1, Math.ceil(n / 8))
        const idxs = []
        for (let i = 0; i < n; i += step) idxs.push(i)
        const last = n - 1
        if (idxs[idxs.length - 1] !== last) {
          if (last - idxs[idxs.length - 1] < step * 0.6) idxs.pop()
          idxs.push(last)
        }
        return new Set(idxs)
      }, [days.length])

      const onMove = (ev) => {
        if (days.length === 0) return
        const rect = ev.currentTarget.getBoundingClientRect()
        const t = ((ev.clientX - rect.left) - pad.left) / (innerW || 1)
        const idx = Math.round(t * (days.length - 1))
        setHoverIndex(Math.max(0, Math.min(days.length - 1, idx)))
      }

      if (days.length === 0) return h('div', { className: 'dshts-empty' }, '所选范围内没有数据')

      const hoverDay = hoverIndex >= 0 ? days[hoverIndex] : null
      const tipLeft = hoverIndex >= 0 ? Math.min(Math.max(xOf(hoverIndex), 100), Math.max(width - 100, 100)) : 0

      const tipRows = hoverDay === null ? [] : visible
        .map((s) => ({ s, v: s.values[hoverIndex] }))
        .filter((row) => row.v > 0)
        .sort((a, b) => b.v - a.v)

      return h('div', { className: 'dshts-chartWrap', ref: wrapRef },
        h('div', { className: 'dshts-legend' },
          series.map((s) => h('button', {
            key: s.model,
            type: 'button',
            className: 'dshts-legendItem',
            'data-off': hidden.has(s.model) ? '1' : '0',
            onClick: () => toggle(s.model),
            title: hidden.has(s.model) ? '点击显示' : '点击隐藏'
          },
          h('span', { className: 'dshts-legendDot', style: { background: s.color } }),
          s.model))),
        h('svg', {
          className: 'dshts-svg',
          height,
          viewBox: `0 0 ${Math.max(width, 1)} ${height}`,
          onMouseMove: onMove,
          onMouseLeave: () => setHoverIndex(-1)
        },
        ticks.map((t, i) => h('g', { key: 'tick' + i },
          h('line', { className: 'dshts-gridLine', x1: pad.left, x2: pad.left + innerW, y1: t.y, y2: t.y }),
          h('text', { className: 'dshts-axisText', x: pad.left - 8, y: t.y + 4, textAnchor: 'end' }, fmtTokens(t.v)))),
        days.map((d, i) => labelSet.has(i)
          ? h('text', {
              key: 'x' + i,
              className: 'dshts-axisText',
              x: xOf(i),
              y: height - 8,
              textAnchor: i === 0 ? 'start' : (i === days.length - 1 ? 'end' : 'middle')
            }, fmtDayShort(d.day))
          : null),
        visible.map((s) => {
          const pts = s.values.map((v, i) => [Number(xOf(i).toFixed(2)), Number(yOf(v).toFixed(2))])
          return h('path', {
            key: s.model,
            d: monotonePath(pts),
            fill: 'none',
            stroke: s.color,
            strokeWidth: 2,
            strokeLinecap: 'round',
            strokeLinejoin: 'round'
          })
        }),
        hoverIndex >= 0 ? h('g', null,
          h('line', {
            className: 'dshts-cursorLine',
            x1: xOf(hoverIndex), x2: xOf(hoverIndex), y1: pad.top, y2: pad.top + innerH
          }),
          visible.map((s) => h('circle', {
            key: s.model,
            cx: xOf(hoverIndex),
            cy: yOf(s.values[hoverIndex]),
            r: 3.5,
            fill: s.color,
            stroke: 'var(--dsw-alias-bg-layer-1)',
            strokeWidth: 1.5
          }))) : null),
        hoverDay !== null ? h('div', { className: 'dshts-tip', style: { left: tipLeft + 'px', top: '8px' } },
          h('div', { className: 'dshts-tipDay' }, `${fmtDay(hoverDay.day)} · ${fmtTokens(hoverDay.total)} tokens`),
          tipRows.map((row) => h('div', { className: 'dshts-tipRow', key: row.s.model },
            h('span', { className: 'dshts-tipDot', style: { background: row.s.color } }),
            h('span', { className: 'dshts-tipName' }, row.s.model),
            h('span', { className: 'dshts-tipVal' }, fmtTokens(row.v))))) : null)
    }

    // ------------------------------------------------------------------ 模型用量

    const DONUT_SIZE = 220
    const DONUT_STROKE = 32
    const DONUT_HOVER_GROW = 5

    /**
     * 圆环几何。**外沿必须留在 viewBox 以内**：`r + 描边/2 < size/2`，
     * 否则圆环会被正方形 viewBox 裁成平口（外沿正好相切时，裁掉 1px 就会切出
     * 一段几像素高的竖直平口；悬浮加粗后更明显）。这里按「悬浮时的最大描边」
     * 再留 3px 余量算半径。
     */
    function donutRing(size, stroke, grow) {
      const hoverStroke = stroke + grow
      const radius = size / 2 - (hoverStroke / 2 + 3)
      return { radius, hoverStroke, circumference: 2 * Math.PI * radius }
    }

    function Donut(props) {
      const models = props.models
      const total = props.total
      const size = DONUT_SIZE
      const stroke = DONUT_STROKE
      const ring = donutRing(size, stroke, DONUT_HOVER_GROW)
      const hoverStroke = ring.hoverStroke
      const r = ring.radius
      const circumference = ring.circumference
      const [wrapRef, width] = useWidth()
      const [hover, setHover] = useState(-1)
      const boxSize = Math.max(120, Math.min(size, width || size))

      let offset = 0
      const arcs = models.map((m, i) => {
        const frac = total > 0 ? m.total / total : 0
        const len = Math.max(0, frac * circumference - 2)
        const arc = { model: m.model, color: m.color, dash: `${len} ${circumference - len}`, offset: -offset, index: i }
        offset += frac * circumference
        return arc
      })

      const focus = hover >= 0 && hover < models.length ? models[hover] : null

      return h('div', { className: 'dshts-donutWrap', ref: wrapRef },
        h('svg', { width: boxSize, height: boxSize, viewBox: `0 0 ${size} ${size}` },
          h('g', { transform: `rotate(-90 ${size / 2} ${size / 2})` },
            h('circle', {
              cx: size / 2, cy: size / 2, r,
              fill: 'none',
              stroke: 'var(--dsw-alias-bg-layer-2)',
              strokeWidth: stroke
            }),
            arcs.map((a) => h('circle', {
              key: a.model,
              cx: size / 2,
              cy: size / 2,
              r,
              fill: 'none',
              stroke: a.color,
              strokeWidth: hover === a.index ? hoverStroke : stroke,
              strokeDasharray: a.dash,
              strokeDashoffset: a.offset,
              style: { transition: 'stroke-width .12s ease' },
              onMouseEnter: () => setHover(a.index),
              onMouseLeave: () => setHover(-1)
            })))),
        h('div', { className: 'dshts-donutCenter' },
          h('div', { className: 'dshts-donutValue' }, fmtTokens(focus ? focus.total : total)),
          h('div', { className: 'dshts-donutLabel' }, focus ? fmtPct(focus.total, total) : 'tokens')))
    }

    function ModelUsage(props) {
      const models = props.models
      const total = props.total
      if (models.length === 0) return h('div', { className: 'dshts-empty' }, '所选范围内没有数据')
      return h('div', { className: 'dshts-usage' },
        h(Donut, { models, total }),
        h('div', { className: 'dshts-usageList' },
          models.map((m) => h('div', { className: 'dshts-usageRow', key: m.model },
            h('span', { className: 'dshts-usageDot', style: { background: m.color } }),
            h('span', { className: 'dshts-usageName', title: m.model }, m.model),
            h('span', { className: 'dshts-usagePct' }, fmtPct(m.total, total)),
            h('span', { className: 'dshts-usageVal' }, `${fmtTokens(m.total)} tokens`),
            h('span', { className: 'dshts-usageSteps' }, `${fmtCount(m.steps)} 次`)))))
    }

    // ------------------------------------------------------------------ 页面

    function buildView(data, range) {
      const days = data.days
      const spec = RANGES.find((r) => r.id === range) || RANGES[1]
      const slice = spec.days > 0 ? days.slice(Math.max(0, days.length - spec.days)) : days

      const totals = { input: 0, output: 0, cache: 0, total: 0, steps: 0, sessions: 0 }
      const modelMap = new Map()
      for (const d of slice) {
        totals.input += d.input
        totals.output += d.output
        totals.cache += d.cache
        totals.total += d.total
        totals.steps += d.steps
        const entries = d.models || {}
        for (const name of Object.keys(entries)) {
          const src = entries[name]
          let entry = modelMap.get(name)
          if (entry === undefined) {
            const allTimeIndex = data.models.findIndex((m) => m.model === name)
            const meta = allTimeIndex >= 0 ? data.models[allTimeIndex] : null
            entry = {
              model: name,
              provider: meta ? meta.provider : 'unknown',
              input: 0,
              output: 0,
              cache: 0,
              total: 0,
              steps: 0,
              // 颜色固定在全量排名上（不是当前范围的排名）：否则切一次时间范围，
              // 同一个模型就会换一种颜色，图表前后对不上。
              color: colorOf(allTimeIndex < 0 ? 0 : allTimeIndex)
            }
            modelMap.set(name, entry)
          }
          entry.input += src.input
          entry.output += src.output
          entry.cache += src.cache
          entry.total += src.total
          entry.steps += src.steps
        }
      }
      const models = [...modelMap.values()].sort((a, b) => b.total - a.total)
      const activeDays = slice.filter((d) => d.total > 0).length
      return { days: slice, totals, models, activeDays }
    }

    function TokenStatsPage() {
      const [state, load] = useSummary()
      const [range, setRange] = useState('30')
      const [hidden, setHidden] = useState(() => new Set())
      const inited = useRef(false)
      const rootRef = useRef(null)
      const staleRetry = useRef(0)

      const data = state.data

      // 缓存过期时宿主先回旧数据、再在后台重扫。隔几秒自动再拉一次，让
      // 「打开面板 → 数据自己变新」闭环；否则那条「正在后台重新扫描」会一直挂着
      // 等人手点刷新。最多重试两次，避免扫描失败时无限轮询。
      useEffect(() => {
        if (state.stale !== true) { staleRetry.current = 0; return undefined }
        if (staleRetry.current >= 2) return undefined
        staleRetry.current += 1
        const timer = setTimeout(() => load(false), 8000)
        return () => clearTimeout(timer)
      }, [state.stale, load])

      // 面板打开后把内容滚回顶部：宿主切到本面板时可能把焦点给到页面里第一个
      // 控件（时间范围按钮），浏览器会顺手把滚动容器滚到中部，看起来像「页面
      // 打开就停在半截」。这里在首帧之后主动置顶。
      useEffect(() => {
        if (state.loading) return undefined
        const raf = requestAnimationFrame(() => {
          const el = rootRef.current
          if (el !== null) el.scrollIntoView({ block: 'start' })
        })
        return () => cancelAnimationFrame(raf)
      }, [state.loading])

      // 首次拿到数据时，把靠后的模型收进图例（默认只画前几个，避免 10 条线糊成一团）
      useEffect(() => {
        if (data === null || inited.current) return
        inited.current = true
        const extra = data.models.slice(DEFAULT_SERIES).map((m) => m.model)
        if (extra.length > 0) setHidden(new Set(extra))
      }, [data])

      const view = useMemo(() => (data === null ? null : buildView(data, range)), [data, range])

      const toggleModel = useCallback((model) => {
        setHidden((prev) => {
          const next = new Set(prev)
          if (next.has(model)) next.delete(model)
          else next.add(model)
          return next
        })
      }, [])

      const header = h('div', { className: 'dshts-head' },
        h('span', { className: 'dshts-headIcon' }, h(StatsGlyph, { size: 16 })),
        h('div', null,
          h('div', { className: 'dshts-title' }, 'Token 用量统计'),
          h('div', { className: 'dshts-sub' },
            data === null
              ? '正在读取会话日志…'
              : `${fmtCount(data.source.sessions)} 个会话 · ${fmtCount(data.source.steps)} 次调用 · ${data.days.length > 0 ? fmtDay(data.days[0].day) + ' 起' : '暂无数据'}`)),
        h('span', { className: 'dshts-spacer' }),
        h('div', { className: 'dshts-seg' },
          RANGES.map((r) => h('button', {
            key: r.id,
            type: 'button',
            className: 'dshts-segBtn',
            'data-on': range === r.id ? '1' : '0',
            onClick: () => setRange(r.id)
          }, r.label))),
        h('button', {
          type: 'button',
          className: 'dshts-btn',
          disabled: state.refreshing === true,
          onClick: () => load(true)
        }, h(RefreshGlyph), state.refreshing ? '刷新中…' : '刷新'))

      if (state.loading) {
        return h('div', { className: 'dshts-root' }, header,
          h('div', { className: 'dshts-empty' }, '正在扫描会话日志，首次约需数秒…'))
      }

      if (state.error !== null && data === null) {
        return h('div', { className: 'dshts-root' }, header,
          h('div', { className: 'dshts-note' }, '读取失败：' + state.error))
      }

      if (data === null || view === null) {
        return h('div', { className: 'dshts-root' }, header, h('div', { className: 'dshts-empty' }, '没有数据'))
      }

      return h('div', { className: 'dshts-root', ref: rootRef },
        header,
        state.error !== null ? h('div', { className: 'dshts-note' }, '刷新失败（仍显示上次数据）：' + state.error) : null,
        state.stale ? h('div', { className: 'dshts-banner' }, '数据已过期，正在后台重新扫描…') : null,
        h(KpiRow, { totals: view.totals, activeDays: view.activeDays }),
        h('div', { className: 'dshts-card' },
          h('div', { className: 'dshts-cardHead' },
            h('span', { className: 'dshts-cardTitle' }, 'Token 活跃度'),
            h('span', { className: 'dshts-cardNote' }, '最近 12 个月 · 每格一天，颜色越深用量越大 · 不受上方范围影响')),
          h(Heatmap, { days: data.days })),
        h('div', { className: 'dshts-card' },
          h('div', { className: 'dshts-cardHead' },
            h('span', { className: 'dshts-cardTitle' }, '每日 Token 趋势'),
            h('span', { className: 'dshts-cardNote' }, '点击图例可隐藏模型')),
          h(TrendChart, { days: view.days, models: view.models, hidden, onToggle: toggleModel })),
        h('div', { className: 'dshts-card' },
          h('div', { className: 'dshts-cardHead' },
            h('span', { className: 'dshts-cardTitle' }, '模型用量')),
          h(ModelUsage, { models: view.models, total: view.totals.total })))
    }

    // ------------------------------------------------------------------ 注册

    return {
      inject: ['slots'],
      apply(ctx) {
        // 侧栏图标 + 主面板共用 PANEL_ID：外壳据此把图标和面板对上。
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID
        }, TokenStatsPage))

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 40,
          label: () => 'Token 统计'
        }, () => h(StatsGlyph, { size: 16 })))
      }
    }
  }
})
