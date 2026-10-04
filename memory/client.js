window.__ModuleLoader__.load({
  id: 'dsh-memory',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    // ------------------------------------------------------------------ 样式
    //
    // 全部照搬宿主自己的规格，不发明新视觉：
    // - 外壳的 `.options` 已经给了 `padding: 0 24px 24px` 与滚动，根元素不能再套一层。
    // - 设置行的宿主惯例（ui-settings-general/DeveloperToolsRow）：
    //     0.5px 下边框 + 纵向留白 + 无卡片底色；标题 14/20，说明 12/18 secondary。
    // - 按钮 / 输入框 / Tag 的尺寸与配色照抄 `dsh-client-ui-primitives` 的
    //     Button.module.css / Input.module.css / Tag.module.css。
    // - 只用 `--dsw-*` token；`--dsw-radius-*` 带兜底值，避免宿主未定义时塌成直角。
    const CSS = [
      '.dshmem-root{display:flex;flex-direction:column;width:100%;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family)}',

      // 页头：图标 + 标题 + 说明（设置面板没有 per-section 标题，页面自己给）
      '.dshmem-head{display:flex;align-items:center;gap:10px;padding:18px 0 14px}',
      '.dshmem-headIcon{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dshmem-headText{min-width:0}',
      '.dshmem-headTitle{font-size:16px;font-weight:500;line-height:24px}',
      '.dshmem-headDesc{margin-top:2px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',

      // 工具栏
      '.dshmem-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-bottom:10px}',
      '.dshmem-search{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;flex:1;min-width:190px;height:32px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-1)}',
      '.dshmem-search:focus-within{border-color:var(--dsw-alias-state-business-primary)}',
      '.dshmem-searchIcon{flex:none;display:inline-flex;color:var(--dsw-alias-label-tertiary)}',
      '.dshmem-searchInput{flex:1;min-width:0;border:none;outline:none;background:transparent;padding:0;font-family:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}',
      '.dshmem-searchInput::placeholder{color:var(--dsw-alias-label-dimmed)}',
      '.dshmem-select{box-sizing:border-box;height:32px;max-width:240px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:22px;outline:none}',
      '.dshmem-select:focus{border-color:var(--dsw-alias-state-business-primary)}',

      // 按钮：primitives/Button.module.css 的 sm 规格
      '.dshmem-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;padding:0 10px;border:none;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:18px;cursor:pointer;white-space:nowrap}',
      '.dshmem-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshmem-btn:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}',
      '.dshmem-btn:disabled{cursor:not-allowed;opacity:.4}',
      '.dshmem-btnOutline{border:.5px solid var(--dsw-alias-border-l3)}',
      '.dshmem-btnPrimary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}',
      '.dshmem-btnPrimary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
      '.dshmem-btnDanger{color:var(--dsw-alias-state-error-primary)}',
      '.dshmem-btnDanger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}',
      '.dshmem-spacer{flex:1}',

      // 状态行
      '.dshmem-facts{display:flex;align-items:center;flex-wrap:wrap;gap:4px 14px;padding:10px 0 14px;border-bottom:.5px solid var(--dsw-alias-border-l2);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.dshmem-fact b{font-weight:500;color:var(--dsw-alias-label-primary)}',
      '.dshmem-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow-wrap:anywhere}',

      // 健康度卡片（体检报告；只在有数据时渲染，失败不挡主流程）
      // 形态照官方 CodeCard / 设置行：底色用官方卡片色（bg-layer-1 是纯白，与页面同色＝等于没有卡片），
      // 圆角与发丝线沿用既有规格；警示用官方 warn（amber），底纹沿用 Tag 的 10% color-mix 惯例。
      '.dshmem-health{margin:12px 0 0;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-markdown-code-block)}',
      '.dshmem-healthWarn{border-color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, var(--dsw-alias-markdown-code-block))}',
      '.dshmem-healthHead{display:flex;align-items:center;flex-wrap:wrap;gap:4px 12px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.dshmem-healthHead b{font-weight:500;color:var(--dsw-alias-label-primary)}',
      '.dshmem-healthWarn .dshmem-healthHead b:first-child{color:var(--dsw-alias-state-warn-label)}',
      '.dshmem-healthSub{margin-top:6px}',
      '.dshmem-healthCmd{display:inline-flex;align-items:baseline;gap:4px;white-space:nowrap}',
      '.dshmem-meter{margin-top:8px;height:4px;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-border-l2);overflow:hidden}',
      '.dshmem-meterFill{display:block;height:100%;background:var(--dsw-alias-state-business-primary)}',
      '.dshmem-meterFull{background:var(--dsw-alias-state-warn-primary)}',
      '.dshmem-healthList{margin-top:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.dshmem-healthList summary{cursor:pointer}',
      '.dshmem-healthList ul{margin:6px 0 0;padding-left:18px}',
      '.dshmem-healthList li{margin:2px 0}',

      // 分组标题与行
      '.dshmem-group{padding:18px 0 2px;font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-secondary)}',
      '.dshmem-row{box-sizing:border-box;display:flex;align-items:center;justify-content:space-between;gap:24px;width:100%;padding:14px 0;border:none;border-bottom:.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;text-align:left;cursor:pointer}',
      '.dshmem-row:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshmem-rowMain{flex:1;min-width:0}',
      '.dshmem-rowTitle{font-size:14px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshmem-rowSum{margin-top:4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
      '.dshmem-rowPath{margin-top:4px;font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',

      // Tag：primitives/Tag.module.css 的 outline 音色
      '.dshmem-tag{flex:none;display:inline-flex;align-items:center;border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px;font-weight:500;white-space:nowrap;border:.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-tertiary)}',

      '.dshmem-empty{padding:52px 0;text-align:center;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}',
      '.dshmem-loading{padding:52px 0;text-align:center;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}',

      // 编辑器
      '.dshmem-editorHead{display:flex;align-items:center;gap:8px;padding:18px 0 6px;flex-wrap:wrap}',
      '.dshmem-editorTitle{font-size:16px;font-weight:500;line-height:24px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshmem-field{display:flex;flex-direction:column;gap:6px;padding:14px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}',
      '.dshmem-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.dshmem-input{box-sizing:border-box;width:100%;height:32px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:14px;line-height:22px;outline:none}',
      '.dshmem-input:focus{border-color:var(--dsw-alias-state-business-primary)}',
      '.dshmem-input:disabled{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}',
      '.dshmem-area{box-sizing:border-box;width:100%;min-height:240px;resize:vertical;padding:8px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:19px;outline:none}',
      '.dshmem-area:focus{border-color:var(--dsw-alias-state-business-primary)}',
      '.dshmem-two{display:grid;grid-template-columns:1fr 1fr;gap:0 16px}',

      // 提示条
      '.dshmem-note{margin:14px 0 0;padding:8px 10px;border-radius:var(--dsw-radius-sm,8px);font-size:12px;line-height:18px}',
      '.dshmem-noteErr{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent)}',
      '.dshmem-noteOk{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent)}'
    ].join('\n')
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="dsh-memory"]') === null) {
      const tag = document.createElement('style')
      tag.dataset.pluginCss = 'dsh-memory'
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // ------------------------------------------------------------------ 图标
    // 自绘的「记忆 / 笔记」字形：16px 网格、currentColor 描边，规格对齐宿主图标。
    function MemoryGlyph(props) {
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
      h('path', { d: 'M3.25 3.1h6.6a1.6 1.6 0 0 1 1.6 1.6v8.2H4.85a1.6 1.6 0 0 1-1.6-1.6z' }),
      h('path', { d: 'M3.25 11.3a1.6 1.6 0 0 1 1.6-1.6h6.6' }),
      h('path', { d: 'M5.9 5.6h3.5M5.9 8h3.5' }))
    }

    function SearchGlyph() {
      return h('svg', {
        viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', focusable: 'false', style: { display: 'block' }
      },
      h('circle', { cx: 7, cy: 7, r: 4.25 }),
      h('path', { d: 'M10.2 10.2 13.5 13.5' }))
    }

    // ------------------------------------------------------------------ 接口
    const TYPES = ['reference', 'feedback', 'project', 'workflow', 'fact']
    const TYPE_LABEL = {
      reference: '参考',
      feedback: '反馈',
      project: '项目',
      workflow: '流程',
      fact: '事实'
    }

    async function api(path, options) {
      const res = await fetch(path, { cache: 'no-store', ...(options || {}) })
      let data = null
      try {
        data = await res.json()
      } catch (_) {
        throw new Error(`响应不是 JSON（HTTP ${res.status}）`)
      }
      if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`)
      return data
    }

    function postJson(path, body) {
      return api(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
    }

    const scopeQuery = (scope, key) =>
      scope === 'project' ? `scope=project&key=${encodeURIComponent(key)}` : 'scope=global'

    function fmtBytes(n) {
      if (!Number.isFinite(n)) return '–'
      return n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`
    }

    // 与 DSH 其它地方一致：当天/昨天说人话，同年省年份，跨年才写全
    function fmtTime(iso) {
      if (!iso) return '–'
      const d = new Date(iso)
      if (Number.isNaN(d.getTime())) return '–'
      const p = (n) => String(n).padStart(2, '0')
      const hm = `${p(d.getHours())}:${p(d.getMinutes())}`
      const now = new Date()
      const day = (x) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`
      const yest = new Date(now.getTime() - 86400000)
      if (day(d) === day(now)) return `今天 ${hm}`
      if (day(d) === day(yest)) return `昨天 ${hm}`
      const md = `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
      return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}年${md}`
    }

    // ------------------------------------------------------------------ 组件
    function Button(props) {
      const { variant, children, ...rest } = props
      const cls = [
        'dshmem-btn',
        variant === 'outline' ? 'dshmem-btnOutline' : '',
        variant === 'primary' ? 'dshmem-btnPrimary' : '',
        variant === 'danger' ? 'dshmem-btnDanger' : ''
      ].filter(Boolean).join(' ')
      return h('button', { type: 'button', className: cls, ...rest }, children)
    }

    function Field(props) {
      return h('label', { className: 'dshmem-field' },
        h('span', { className: 'dshmem-label' }, props.label),
        props.children)
    }

    /**
     * 体检卡片：数据来自 /memory-api/health（宿主侧的 lib/health.js）。
     * 拿不到报告（接口报错、还没回来）时返回 null——体检只是提示，绝不能挡住主流程。
     */
    function HealthCard(props) {
      const data = props && props.health
      const r = data && data.report
      if (!r) return null
      const v = data.verdict || { needsMaintenance: false, reasons: [] }
      const b = r.budget || {}
      const pct = Number.isFinite(b.pct) ? Math.min(100, b.pct) : null
      const mc = r.mergeCandidates || { pairs: [], count: 0, threshold: 0 }
      const stale = r.stale || { count: 0, days: 0 }
      const boundary = r.boundarySuspects || []
      return h('div', { className: 'dshmem-health' + (v.needsMaintenance ? ' dshmem-healthWarn' : '') },
        h('div', { className: 'dshmem-healthHead' },
          h('b', null, v.needsMaintenance ? '该维护了' : '健康'),
          h('span', null, `条目 ${r.counts.global} 全局 / ${r.counts.project} 工作区`),
          h('span', null, `注入区块 ${fmtBytes(b.blockBytes)} / ${fmtBytes(b.maxBlockBytes)}${pct === null ? '' : `（${pct}%）`}`),
          h('span', null, `上次索引改动 ${fmtTime(b.indexUpdatedAt)}`),
          v.reasons.length ? h('span', null, v.reasons.join('；')) : null),
        pct === null ? null : h('div', { className: 'dshmem-meter', title: `${b.blockBytes} / ${b.maxBlockBytes} 字节` },
          h('i', { className: 'dshmem-meterFill' + (b.truncated || pct > 90 ? ' dshmem-meterFull' : ''), style: { width: `${pct}%` } })),
        mc.pairs.length
          ? h('details', { className: 'dshmem-healthList' },
              h('summary', null, `疑似重复 ${mc.count} 对（正文包含度 ≥ ${mc.threshold}，点开看清单）`),
              h('ul', null, mc.pairs.map((p) => h('li', { key: `${p.a}|${p.b}` },
                h('span', { className: 'dshmem-mono' }, p.a), ' ↔ ',
                h('span', { className: 'dshmem-mono' }, p.b), `　${Math.round(p.containment * 100)}%`))))
          : null,
        (stale.count || boundary.length)
          ? h('div', { className: 'dshmem-healthHead dshmem-healthSub' },
              stale.count ? h('span', null, `${stale.count} 条 ${stale.days} 天未更新`) : null,
              boundary.length ? h('span', null, `${boundary.length} 条作用域待确认`) : null)
          : null,
        h('div', { className: 'dshmem-healthHead dshmem-healthSub' },
          h('span', null, '维护：'),
          h('span', { className: 'dshmem-healthCmd' },
            h('span', { className: 'dshmem-mono' }, 'node ~/.dsh/plugins/memory/lintmemory.cjs'),
            h('span', null, '（机械一致性，可判对错）')),
          h('span', { className: 'dshmem-healthCmd' },
            h('span', { className: 'dshmem-mono' }, 'node ~/.dsh/plugins/memory/memcheck.cjs'),
            h('span', null, '（语义信号，只提示）'))))
    }

    function MemorySection() {
      const [status, setStatus] = React.useState(null)
      const [projects, setProjects] = React.useState([])
      const [scope, setScope] = React.useState('global')
      const [key, setKey] = React.useState('')
      const [index, setIndex] = React.useState(null)
      const [query, setQuery] = React.useState('')
      const [editing, setEditing] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [health, setHealth] = React.useState(null)

      const fail = (err) => setError(String((err && err.message) || err))
      const clear = () => { setError(''); setNotice('') }

      const loadStatus = React.useCallback(async () => {
        const s = await api('/memory-api/status')
        setStatus(s)
        return s
      }, [])

      const loadProjects = React.useCallback(async () => {
        const r = await api('/memory-api/projects')
        setProjects(r.projects || [])
        return r.projects || []
      }, [])

      const loadIndex = React.useCallback(async (sc, k) => {
        const r = await api(`/memory-api/list?${scopeQuery(sc, k)}`)
        setIndex(r)
        return r
      }, [])

      // 体检失败只把卡片收起来，不报错——它不是主流程的一部分。
      const loadHealth = React.useCallback(async () => {
        try {
          setHealth(await api('/memory-api/health'))
        } catch (_) {
          setHealth(null)
        }
      }, [])

      const refresh = React.useCallback(async (sc, k) => {
        setBusy(true)
        try {
          clear()
          await Promise.all([loadStatus(), loadProjects(), loadHealth()])
          await loadIndex(sc, k)
        } catch (err) {
          fail(err)
        } finally {
          setBusy(false)
        }
      }, [loadHealth, loadIndex, loadProjects, loadStatus])

      React.useEffect(() => { refresh('global', '') }, [refresh])

      React.useEffect(() => {
        if (scope === 'project' && !key && projects.length > 0) setKey(projects[0].key)
      }, [scope, key, projects])

      const onScopeChange = (next) => {
        setScope(next)
        setEditing(null)
        const nextKey = next === 'project' ? (key || (projects[0] && projects[0].key) || '') : ''
        setKey(nextKey)
        refresh(next, nextKey)
      }

      const onKeyChange = (next) => {
        setKey(next)
        setEditing(null)
        refresh('project', next)
      }

      const openEntry = async (target) => {
        clear()
        setBusy(true)
        try {
          const name = String(target).replace(/\.md$/, '')
          const r = await api(`/memory-api/entry?${scopeQuery(scope, key)}&name=${encodeURIComponent(name)}`)
          if (!r.found) throw new Error(`没找到条目 ${target}`)
          // title 与 section 只存在于索引里（frontmatter 没有），必须从当前索引取回来，
          // 否则保存会把索引标题改掉、甚至把条目挪到别的分组。
          let foundTitle = ''
          let foundSection = ''
          for (const s of (index && index.sections) || []) {
            const hit = s.entries.find((e) => e.target === r.target)
            if (hit) { foundTitle = hit.title; foundSection = s.title; break }
          }
          setEditing({
            mode: 'edit',
            scope: r.scope,
            key: scope === 'project' ? key : '',
            name: r.name,
            target: r.target,
            title: foundTitle,
            type: (r.meta && r.meta.type) || 'reference',
            section: foundSection,
            description: (r.meta && r.meta.description) || '',
            body: r.body || ''
          })
        } catch (err) {
          fail(err)
        } finally {
          setBusy(false)
        }
      }

      const openNew = () => {
        clear()
        setEditing({
          mode: 'new',
          scope,
          key: scope === 'project' ? key : '',
          name: '',
          target: '',
          title: '',
          type: 'reference',
          section: scope === 'project' ? '决策与坑' : '',
          description: '',
          body: ''
        })
      }

      const save = async () => {
        if (!editing) return
        clear()
        if (!editing.name.trim()) { setError('name 不能为空（它是文件名，也是以后检索用的键）'); return }
        if (!editing.description.trim()) { setError('description 不能为空（它是索引里那一行摘要）'); return }
        if (!editing.body.trim()) { setError('正文不能为空'); return }
        setBusy(true)
        try {
          const r = await postJson('/memory-api/save', {
            scope: editing.scope,
            key: editing.key || undefined,
            name: editing.name.trim(),
            title: editing.title.trim() || undefined,
            description: editing.description.trim(),
            type: editing.type,
            section: editing.section.trim() || undefined,
            body: editing.body,
            // 编辑时整条替换；新建时保持 false，撞名会被拒绝而不是静默覆盖
            overwrite: editing.mode === 'edit'
          })
          setNotice(`${r.updated ? '已更新' : '已写入'} ${r.target}，AGENTS.md 的索引区块已同步。`)
          setEditing(null)
          await refresh(scope, key)
        } catch (err) {
          fail(err)
        } finally {
          setBusy(false)
        }
      }

      const remove = async () => {
        if (!editing || editing.mode !== 'edit') return
        clear()
        setBusy(true)
        try {
          const r = await postJson('/memory-api/delete', {
            scope: editing.scope,
            key: editing.key || undefined,
            name: editing.name
          })
          setNotice(`已删除 ${r.target}。`)
          setEditing(null)
          await refresh(scope, key)
        } catch (err) {
          fail(err)
        } finally {
          setBusy(false)
        }
      }

      const resync = async () => {
        clear()
        setBusy(true)
        try {
          const r = await postJson('/memory-api/sync', {})
          setNotice(`已同步 AGENTS.md 的索引区块（${fmtBytes(r.bytes)}）。`)
          await loadStatus()
        } catch (err) {
          fail(err)
        } finally {
          setBusy(false)
        }
      }

      const sections = (index && index.sections) || []
      const needle = query.trim().toLowerCase()
      const filtered = needle
        ? sections.map((s) => ({
            title: s.title,
            entries: s.entries.filter((e) =>
              `${e.title} ${e.summary} ${e.target}`.toLowerCase().includes(needle))
          })).filter((s) => s.entries.length > 0)
        : sections
      const total = sections.reduce((n, s) => n + s.entries.length, 0)

      // ---------- 提示 ----------
      const notes = [
        error ? h('div', { key: 'e', className: 'dshmem-note dshmem-noteErr' }, error) : null,
        notice ? h('div', { key: 'n', className: 'dshmem-note dshmem-noteOk' }, notice) : null
      ]

      // ---------- 编辑器 ----------
      if (editing) {
        return h('div', { className: 'dshmem-root' },
          h('div', { className: 'dshmem-editorHead' },
            h(Button, { variant: 'outline', onClick: () => { setEditing(null); clear() }, disabled: busy }, '← 返回列表'),
            h('span', { className: 'dshmem-editorTitle' },
              editing.mode === 'edit' ? editing.target : '新建记忆条目'),
            h('span', { className: 'dshmem-spacer' }),
            editing.mode === 'edit'
              ? h(Button, { variant: 'danger', onClick: remove, disabled: busy }, '删除')
              : null,
            h(Button, { variant: 'primary', onClick: save, disabled: busy }, busy ? '保存中…' : '保存')),

          h('div', { className: 'dshmem-label', style: { paddingTop: '6px' } },
            editing.scope === 'global' ? '写入全局记忆库' : `写入工作区记忆库 ${editing.key}`),

          h('div', { className: 'dshmem-two' },
            h(Field, { label: 'name（slug，可含 / 分目录；编辑时不可改）' },
              h('input', {
                className: 'dshmem-input',
                value: editing.name,
                disabled: editing.mode === 'edit',
                placeholder: 'tools/my-tool',
                onChange: (e) => setEditing({ ...editing, name: e.target.value })
              })),
            h(Field, { label: 'type' },
              h('select', {
                className: 'dshmem-select',
                style: { width: '100%', maxWidth: 'none' },
                value: editing.type,
                onChange: (e) => setEditing({ ...editing, type: e.target.value })
              }, TYPES.map((t) => h('option', { key: t, value: t }, `${t}（${TYPE_LABEL[t]}）`))))),

          h('div', { className: 'dshmem-two' },
            h(Field, { label: '索引分组 section（留空则用 name 的第一段目录）' },
              h('input', {
                className: 'dshmem-input',
                value: editing.section,
                placeholder: '工具配置',
                onChange: (e) => setEditing({ ...editing, section: e.target.value })
              })),
            h(Field, { label: '标题 title（索引里显示的名字）' },
              h('input', {
                className: 'dshmem-input',
                value: editing.title,
                placeholder: '留空则用 name 末段',
                onChange: (e) => setEditing({ ...editing, title: e.target.value })
              }))),

          h(Field, { label: 'description（一句话摘要，会进索引，决定以后能不能被搜到）' },
            h('input', {
              className: 'dshmem-input',
              value: editing.description,
              onChange: (e) => setEditing({ ...editing, description: e.target.value })
            })),

          h(Field, { label: '正文（Markdown，建议含 **Why:** 与 **How to apply:**）' },
            h('textarea', {
              className: 'dshmem-area',
              value: editing.body,
              onChange: (e) => setEditing({ ...editing, body: e.target.value })
            })),

          notes)
      }

      // ---------- 列表 ----------
      const list = !index
        ? h('div', { className: 'dshmem-loading' }, '加载中…')
        : total === 0
          ? h('div', { className: 'dshmem-empty' },
              scope === 'project'
                ? '这个工作区还没有记忆。用 memory_write 且 scope: "project" 写入，或点「新建条目」。'
                : '记忆库还是空的。点「新建条目」写第一条。')
          : filtered.length === 0
            ? h('div', { className: 'dshmem-empty' }, `没有匹配「${query.trim()}」的条目。`)
            : filtered.map((s) =>
                h('div', { key: s.title },
                  h('div', { className: 'dshmem-group' }, `${s.title}（${s.entries.length}）`),
                  s.entries.map((e) =>
                    h('button', {
                      key: e.target,
                      type: 'button',
                      className: 'dshmem-row',
                      onClick: () => openEntry(e.target)
                    },
                    h('div', { className: 'dshmem-rowMain' },
                      h('div', { className: 'dshmem-rowTitle' }, e.title),
                      e.summary ? h('div', { className: 'dshmem-rowSum' }, e.summary) : null,
                      h('div', { className: 'dshmem-rowPath' }, e.target))))))

      return h('div', { className: 'dshmem-root' },
        // 页头
        h('div', { className: 'dshmem-head' },
          h('span', { className: 'dshmem-headIcon' }, h(MemoryGlyph, { size: 16 })),
          h('div', { className: 'dshmem-headText' },
            h('div', { className: 'dshmem-headTitle' }, '记忆'),
            h('div', { className: 'dshmem-headDesc' },
              '跨会话的长期记忆：全局索引每次会话自动注入 AGENTS.md，模型用 memory_* 工具读写。'))),

        // 工具栏
        h('div', { className: 'dshmem-bar' },
          h('div', { className: 'dshmem-search' },
            h('span', { className: 'dshmem-searchIcon' }, h(SearchGlyph, null)),
            h('input', {
              className: 'dshmem-searchInput',
              placeholder: '按标题、摘要或路径过滤…',
              value: query,
              onChange: (e) => setQuery(e.target.value)
            })),
          h('select', {
            className: 'dshmem-select',
            value: scope,
            onChange: (e) => onScopeChange(e.target.value)
          },
          h('option', { value: 'global' }, '全局记忆'),
          h('option', { value: 'project' }, '工作区记忆')),
          scope === 'project'
            ? h('select', {
                className: 'dshmem-select',
                value: key,
                onChange: (e) => onKeyChange(e.target.value)
              },
              projects.length === 0
                ? h('option', { value: '' }, '（还没有工作区记忆）')
                : projects.map((p) => h('option', { key: p.key, value: p.key }, `${p.key}（${p.entries} 条）`)))
            : null,
          h('span', { className: 'dshmem-spacer' }),
          h(Button, { variant: 'primary', onClick: openNew, disabled: busy }, '新建条目')),

        // 状态行
        h('div', { className: 'dshmem-facts' },
          h('span', null, '记忆根 ',
            h('b', { className: 'dshmem-mono', title: status ? status.home : '' },
              status ? status.home : '…')),
          h('span', null, scope === 'global' ? '全局' : '工作区',
            h('b', null, ` ${total} `), '条'),
          h('span', null, '注入区块 ',
            h('b', null, status ? `${fmtBytes(status.blockBytes)} / ${fmtBytes(status.maxBlockBytes)}` : '–')),
          h('span', null, '工作区库 ',
            h('b', null, status ? status.projects : '–')),
          h('span', { className: 'dshmem-spacer' }),
          h(Button, { variant: 'outline', onClick: () => refresh(scope, key), disabled: busy }, '刷新'),
          h(Button, { variant: 'outline', onClick: resync, disabled: busy }, '重新同步 AGENTS.md')),

        h(HealthCard, { health }),

        notes,
        list)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 导航图标：设置面板的图标由外壳 `dsh-client-ui-settings-general` 的 navIcon(id)
        // 按 id 硬编码（account/models/agent-presets/plugins/archived-sessions），
        // `settings.section` 的注册项只接受 { id, order, label }，没有图标字段，
        // 未知 id 一律落到「设置齿轮」。
        //
        // 因此这里借用外壳已映射、但当前**没有任何包注册**的 `archived-sessions` 座位
        // 来拿到档案盒图标（IconArchiveOutlineMedium）。代价与回退方式见 README §4.2：
        // 若将来 DSH 真的启用 archived-sessions，把下面的 id 改回 'memory' 即可
        // （图标会退回齿轮，功能不受影响）。
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'archived-sessions',
          order: 30,
          label: () => '记忆'
        }, MemorySection))
      }
    }
  }
})
