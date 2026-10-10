/**
 * dsh-message-edit — 「撤回 / 编辑已发送消息」的客户端半边。
 *
 * 做两件事：
 *  1. **加按钮**：遮蔽官方 `conversation.chat.node` 的 `user` 渲染器（priority -1），
 *     外面套一层 `<Orig {...props} />` + 编辑/撤回按钮。
 *     依据：slot 的 catalog 明说 "Registering an already-occupied key replaces that
 *     occupant"，slot core 的规则是**同 key 不同 priority 共存、priority 最小者渲染**
 *     （官方是 0），所以 -1 即遮蔽；渲染器把合并好的 props 当**一个对象**传给组件，
 *     因此 `{...props}` 原样转发就能做到外观零妥协。
 *
 *     ⚠️ 关键坑（真机实测得出）：遮蔽条必须**复制官方条目的 `locale` 与 `inject`**。
 *     `kit.t` 只在条目声明了 `locale` 时才注入，`inject` 提供的 props（如 `useHostInfo`）
 *     同理；不复制就会让官方组件在渲染时抛 `t is not a function` /
 *     `useHostInfo is not a function`，条目被 slot 让位（abdicated），按钮也就不出现。
 *
 *  2. **隐藏被遮蔽的轮次**：客户端的对话记录是**原始日志视图**——表面替换（压缩也一样）
 *     只改变模型上下文，不会让旧气泡消失。本插件按"被遮蔽的轮次"隐藏对应的行。
 *
 *     这里不用"wrap 每个 chat node 渲染器"的做法：官方有几种节点（`tool-call`、`turn-tail`、
 *     `command`）自己声明了 children slot，而同一个 child slot 不能声明两次；不声明就拿不到
 *     官方 kit 里的 `renderSlot`，转发 props 后官方组件会崩。所以改为：按行上的
 *     `data-chat-turn` 做一次作用域内的显示过滤（被遮蔽的轮次是一个**后缀块**，
 *     因此可以取"第一个到最后一个命中行"的连续区间，天然覆盖区间内没有 turn 属性的行）。
 *
 * 与宿主半边的通道：GET/POST /message-edit-api/*（与 btw / sysmon 同一套 webServer 约定）。
 * 客户端插件只能 require 真正的 __ModuleLoader__ 模块（react），不能 require app 内部 ESM 库，
 * 所以按钮与编辑框的样式都在这里自己写。
 */

window.__ModuleLoader__.load({
  id: 'dsh-message-edit',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    const ID = 'dsh-message-edit'
    const API = '/message-edit-api'
    const SLOT = 'conversation.chat.node'
    const HIDDEN_ATTR = 'data-msg-edit-hidden'
    const ROW_SELECTOR = '[data-chat-flow-key]'

    const CN = !/^en/i.test((typeof navigator !== 'undefined' && navigator.language) || '')
    const COPY = {
      edit: CN ? '编辑' : 'Edit',
      retract: CN ? '撤回' : 'Recall',
      save: CN ? '保存并重新发送' : 'Save & resend',
      cancel: CN ? '取消编辑' : 'Cancel editing',
      editing: CN ? '编辑这条消息' : 'Edit this message',
      confirm: (turn) => (CN
        ? `撤回后，这条消息及其之后的对话（第 ${turn} 轮起）将不再进入模型上下文。\n\n原始会话日志仍会保留，但这一段会从当前对话视图里隐藏。\n\n确定撤回吗？`
        : `This message and everything after it (turn ${turn}+) leaves the model context.\n\nThe raw session log keeps them; this chat view hides that span.\n\nRecall anyway?`),
      busy: CN ? '当前轮次还没跑完，等它结束再操作。' : 'The current turn is still running; try again when it finishes.',
      failed: CN ? '操作失败：' : 'Failed: ',
      empty: CN ? '内容不能为空。' : 'Text cannot be empty.',
      done: (action) => (action === 'retract' ? (CN ? '已撤回' : 'Recalled') : (CN ? '已更新' : 'Updated')),
    }

    // ------------------------------------------------------------------ 样式
    //
    // 全部对齐官方 CSS module 的**原始取值**，不另造视觉语言：
    //  - 气泡/编辑态几何抄 `cJsG2q_userStack` + `cJsG2q_bubble`（宽度上限、radius-xl、10px 16px 内边距、
    //    content-font-size 与 22px+delta 行高）；
    //  - 按钮几何抄 `xD_KDq_action`（28px+delta 方钮、radius-sm、label-tertiary、hover 换
    //    interactive-bg-hover + label-secondary、图标 15px+delta）；
    //  - 编辑框按键行为与内联编辑器抄 QueueDock 的 `QueueEditor`（Enter 保存 / Shift+Enter 换行 /
    //    Esc 取消、随内容自增高、纯图标按钮、无自造标题）。

    const CSS = `
[${HIDDEN_ATTR}]{display:none!important}
.me-root{position:relative;display:flex;flex-direction:column;align-items:flex-end;gap:2px;width:100%;min-width:0}
/*
 * 操作行落在**原生操作行内部**：官方 MessageIconActions 的 extraActions 就排在这两个位置
 * （复制键之后、同样 gap 8、同样 28px+delta 的方钮）。气泡那侧的调用点没传 extraActions，
 * 所以这里用"给原生行加 padding-right 挤开、自己的按钮绝对定位补进腾出的空位"复刻它。
 */
.me-root [data-clock="start"]{padding-right:calc(72px + 2 * var(--dsh-content-font-delta,0px))}
.me-actions{position:absolute;right:0;bottom:0;display:flex;align-items:center;justify-content:flex-end;gap:8px;
  height:calc(28px + var(--dsh-content-font-delta,0px));transition:opacity 80ms ease}
/* 与官方一致：非最后一条用户消息的操作行默认隐藏，悬停/聚焦才显形 */
@media (hover:hover){
  [data-chat-flow-kind=user]:has(~ [data-chat-flow-kind=user]) .me-actions{opacity:0}
  [data-chat-flow-kind=user]:has(~ [data-chat-flow-kind=user]):hover .me-actions,
  [data-chat-flow-kind=user]:has(~ [data-chat-flow-kind=user]):focus-within .me-actions{opacity:1}
}
/*
 * 编辑态：**白底 + 蓝色描线**（与气泡的蓝色填充区分开，读作"可编辑的输入框"），
 * 几何与官方用户气泡完全一致（radius-xl、同字号行高、内容盒同为 10px 16px ——
 * 边框 1px 用内边距 9px 15px 抵消，所以整块不位移不跳尺寸）。
 */
.me-editor{box-sizing:border-box;max-width:min(calc(var(--dsh-chat-content-width,748px) * .702),82%);
  background:var(--dsw-alias-bg-base,#fff);
  border:1px solid var(--dsw-alias-state-business-primary,#4d6bfe);
  border-radius:var(--dsw-radius-xl);
  padding:9px 15px;color:var(--dsw-alias-label-primary);
  font-size:var(--dsh-content-font-size,14px);line-height:calc(22px + var(--dsh-content-font-delta,0px));
  display:flex;flex-direction:column;gap:6px}
.me-editor-input{box-sizing:border-box;width:100%;margin:0;padding:0;
  min-height:calc(22px + var(--dsh-content-font-delta,0px));max-height:40vh;overflow-y:auto;resize:none;
  background:0 0;border:0;outline:none;color:inherit;font:inherit;line-height:inherit;
  white-space:pre-wrap;word-break:break-word}
.me-editor-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.me-editor-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;
  height:calc(28px + var(--dsh-content-font-delta,0px))}
/* 方钮几何抄官方 xD_KDq_action：28px+delta、radius-sm、label-tertiary、hover 换色、图标 15px+delta */
.me-icon{box-sizing:border-box;width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));
  border-radius:var(--dsw-radius-sm);border:none;background:0 0;color:var(--dsw-alias-label-tertiary);
  cursor:pointer;padding:6px;display:inline-flex;align-items:center;justify-content:center}
.me-icon svg{width:calc(15px + var(--dsh-content-font-delta,0px));height:calc(15px + var(--dsh-content-font-delta,0px))}
.me-icon:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.me-icon:disabled{cursor:default;opacity:.4}
.me-toast{position:fixed;left:50%;bottom:104px;transform:translateX(-50%);z-index:3000;
  background:var(--dsw-specific-menu,rgba(30,30,30,.92));color:var(--dsw-alias-label-primary,#fff);
  border-radius:var(--dsw-radius-lg,12px);padding:7px 14px;font-size:13px;line-height:20px;
  box-shadow:var(--dsw-elevation-prominent,0 6px 24px rgba(0,0,0,.25));pointer-events:none;opacity:.96}
`

    function ensureCss() {
      const existing = document.querySelector(`style[data-plugin-css="${ID}"]`)
      if (existing !== null) {
        // 别的包可能误认领过，改回自己名下，免得它热更时把我们的样式一起带走。
        if (existing.getAttribute('data-plugin') !== ID) existing.setAttribute('data-plugin', ID)
        return
      }
      const tag = document.createElement('style')
      tag.setAttribute('data-plugin-css', ID)
      tag.setAttribute('data-plugin', ID)
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // ------------------------------------------------------- 被遮蔽轮次的共享状态

    const EMPTY = []
    /** sessionId → hiddenTurns（升序去重数组）。 */
    const hiddenBySession = new Map()
    /** 已经拉过一次 state 的会话。 */
    const loaded = new Set()
    const inflight = new Set()
    const listeners = new Set()
    let version = 0

    function notify() {
      version += 1
      for (const listener of listeners) listener(version)
    }

    function subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }

    function setHidden(sessionId, turns) {
      const next = Array.isArray(turns) ? [...new Set(turns)].filter((n) => Number.isFinite(n)).sort((a, b) => a - b) : EMPTY
      const prev = hiddenBySession.get(sessionId)
      if (prev !== undefined && prev.length === next.length && prev.every((v, i) => v === next[i])) return
      hiddenBySession.set(sessionId, next)
      notify()
    }

    function fetchState(sessionId, force) {
      if (typeof sessionId !== 'string' || sessionId === '') return
      if (force !== true && (loaded.has(sessionId) || inflight.has(sessionId))) return
      inflight.add(sessionId)
      fetch(`${API}/state?sessionId=${encodeURIComponent(sessionId)}`)
        .then((response) => response.json())
        .then((payload) => {
          loaded.add(sessionId)
          if (payload !== null && payload.ok === true) setHidden(sessionId, payload.hiddenTurns ?? EMPTY)
        })
        .catch(() => { loaded.add(sessionId) })
        .finally(() => { inflight.delete(sessionId) })
    }

    /** 把渲染期/请求期的错误报给宿主，真机上才有得查。 */
    function report(where, error) {
      const message = error !== null && error !== undefined && error.message !== undefined ? String(error.message) : String(error)
      try {
        fetch(`${API}/client-error`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            where,
            message,
            stack: error !== null && error !== undefined && error.stack !== undefined ? String(error.stack) : undefined,
          }),
        }).catch(() => {})
      } catch {}
      console.error(`[${ID}] ${where}: ${message}`)
    }

    // ------------------------------------------------------------------ 行过滤

    /**
     * 在给定容器内隐藏"被遮蔽轮次"的行。
     *
     * 被遮蔽的轮次永远是一个后缀块（撤回从某条消息起、遮蔽到操作时的末尾），
     * 所以这里取"第一个命中行 → 最后一个命中行"的连续区间：既覆盖区间内没有
     * `data-chat-turn` 的行，也不会波及之后新建的行（新轮次号更大、排在区间之后）。
     *
     * @param container - 对话流容器（行元素的父节点）。
     * @param turns - 被遮蔽的轮次号数组。
     */
    function applyHiddenRows(container, turns) {
      if (container === null || container === undefined) return
      const rows = [...container.querySelectorAll(ROW_SELECTOR)]
      const set = new Set(Array.isArray(turns) ? turns : EMPTY)
      // 前向填充：没有 data-chat-turn 的行沿用上一行的轮次。
      let current = undefined
      const flags = rows.map((row) => {
        const raw = row.getAttribute('data-chat-turn')
        const parsed = raw === null || raw === '' ? Number.NaN : Number(raw)
        if (Number.isFinite(parsed)) current = parsed
        return Number.isFinite(current) && set.has(current)
      })
      let first = -1
      let last = -1
      flags.forEach((flag, index) => {
        if (!flag) return
        if (first === -1) first = index
        last = index
      })
      rows.forEach((row, index) => {
        if (first !== -1 && index >= first && index <= last) row.setAttribute(HIDDEN_ATTR, '1')
        else row.removeAttribute(HIDDEN_ATTR)
      })
    }

    // ------------------------------------------------------------------ 组件

    function textOf(message) {
      const blocks = message !== null && typeof message === 'object' && Array.isArray(message.content) ? message.content : []
      return blocks
        .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
    }

    /** 一条 node 所属的轮次（与 ChatNodeSeat 的 turnOf 一致）。 */
    function turnOf(node) {
      const location = node === undefined ? undefined : node.location
      return location !== undefined && (location.kind === 'turn' || location.kind === 'step') ? location.turn.turn : undefined
    }

    function toast(text, tone) {
      const el = document.createElement('div')
      el.className = 'me-toast'
      el.textContent = text
      if (tone === 'error') el.style.color = 'var(--dsw-alias-state-error-primary,#ff6b6b)'
      document.body.appendChild(el)
      window.setTimeout(() => { el.remove() }, tone === 'error' ? 4200 : 2000)
    }

    /**
     * 官方 `IconCheckOutlineRegular` 的 art work（viewBox 16、stroke 1、size 15+delta）内联。
     * 客户端插件不能 require app 内部 ESM 库（ui-primitives），所以路径数据只能内联。
     */
    function IconCheck({ className }) {
      return React.createElement('svg', {
        className, width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': 'true', strokeWidth: 1,
      }, React.createElement('path', {
        d: 'M2.25 8.5L5.49732 11.7473C5.90519 12.1552 6.57263 12.1344 6.95426 11.7018L13.75 4',
        stroke: 'currentColor',
      }))
    }

    /** 官方 `IconCloseOutlineRegular` 的 art work，同样内联。 */
    function IconClose({ className }) {
      return React.createElement('svg', {
        className, width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': 'true', strokeWidth: 1,
      },
      React.createElement('path', { d: 'M2.5 2.5L13.5 13.5', stroke: 'currentColor' }),
      React.createElement('path', { d: 'M13.5 2.5L2.5 13.5', stroke: 'currentColor' }))
    }

    /** 官方 `IconEditOutlineRegular`（铅笔）的 art work，同样内联。 */
    function IconEdit({ className }) {
      return React.createElement('svg', {
        className, width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': 'true', strokeWidth: 1,
      },
      React.createElement('path', {
        d: 'M8.85596 2.69971H4.19971C3.37141 2.69971 2.69992 3.37146 2.69971 4.19971V11.8003C2.69992 12.6285 3.37141 13.3003 4.19971 13.3003H11.8003C12.6283 13.2999 13.3001 12.6283 13.3003 11.8003V7.89893H14.3003V11.8003C14.3001 13.1806 13.1806 14.2999 11.8003 14.3003H4.19971C2.81913 14.3003 1.69992 13.1808 1.69971 11.8003V4.19971C1.69992 2.81918 2.81913 1.69971 4.19971 1.69971H8.85596V2.69971Z',
        fill: 'currentColor',
      }), React.createElement('path', { d: 'M7.7849 8.23878L13.888 2.13574', stroke: 'currentColor' }))
    }

    /**
     * 「撤回」= 掉头箭头（↩ 的 U-turn 变体：横线向右、绕半圆折回左下、左端带箭头）。
     *
     * 官方图标库里没有撤销/掉头箭头（只有垃圾桶、×、←、↻），按用户给的参考图形
     * 手绘同形路径，但保持官方图标那套约定：viewBox 16×16、`fill:none`、`stroke:currentColor`、
     * strokeWidth 1，所以和旁边的复制键视觉一致。
     */
    function IconRetract({ className }) {
      return React.createElement('svg', {
        className, width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': 'true', strokeWidth: 1,
      },
      // 横线 → 右侧半圆折回 → 底部回程
      React.createElement('path', { d: 'M2 6.5H10A3 3 0 0 1 10 12.5H6.4', stroke: 'currentColor' }),
      // 左端箭头
      React.createElement('path', { d: 'M5 3.5L2 6.5L5 9.5', stroke: 'currentColor' }))
    }

    /**
     * user 渲染器的遮蔽件：官方气泡 + 编辑 / 撤回按钮；编辑时换成内联编辑框。
     */
    function makeUserShadow(resolveOriginal) {
      return function UserNodeWithRecall(props) {
        const rootRef = React.useRef(null)
        const [, setTick] = React.useState(0)
        const node = props.node
        const data = (node === undefined || node.data === undefined) ? {} : node.data
        const sessionId = props.sessionId
        const [editing, setEditing] = React.useState(false)
        const [draft, setDraft] = React.useState('')
        const [busy, setBusy] = React.useState(false)
        const [editWidth, setEditWidth] = React.useState(null)
        const originalText = React.useMemo(() => textOf(data), [data])
        const inputRef = React.useRef(null)

        // 与官方 QueueEditor 同款：随内容自增高，长到 CSS 上限（40vh）后自己滚。
        React.useLayoutEffect(() => {
          const node = inputRef.current
          if (node === null) return
          node.style.height = 'auto'
          node.style.height = `${node.scrollHeight + node.offsetHeight - node.clientHeight}px`
        }, [draft, editing])

        // 订阅被遮蔽轮次的变化。
        React.useEffect(() => {
          const unsubscribe = subscribe(() => setTick((value) => value + 1))
          return () => { unsubscribe() }
        }, [])

        // 进入会话时拉一次状态。
        React.useEffect(() => {
          if (typeof sessionId === 'string' && sessionId !== '') fetchState(sessionId)
        }, [sessionId])

        // 把行过滤同步到当前对话流容器，并在 DOM 变化后重放。
        React.useEffect(() => {
          const locate = () => {
            const element = rootRef.current
            if (element === null) return null
            const row = element.closest(ROW_SELECTOR)
            return row === null ? null : row.parentElement
          }
          let scheduled = false
          let container = locate()
          const sync = () => {
            scheduled = false
            container = locate() ?? container
            const turns = hiddenBySession.get(sessionId)
            if (turns === undefined || turns.length === 0) {
              // 没有遮蔽时也要清掉本容器里的历史标记（会话切换 / 状态被重置）。
              if (container !== null) for (const row of container.querySelectorAll(`[${HIDDEN_ATTR}]`)) row.removeAttribute(HIDDEN_ATTR)
              return
            }
            applyHiddenRows(container, turns)
          }
          const schedule = () => {
            if (scheduled) return
            scheduled = true
            window.requestAnimationFrame(sync)
          }
          sync()
          const observer = new MutationObserver(schedule)
          observer.observe(document.body, { childList: true, subtree: true })
          return () => { observer.disconnect() }
        }, [sessionId, version])

        const run = async (action, text) => {
          if (busy) return
          setBusy(true)
          try {
            const state = await fetch(`${API}/state?sessionId=${encodeURIComponent(sessionId)}`).then((r) => r.json()).catch(() => null)
            if (state !== null && state.ok === true && state.live === true && state.idle === false) {
              toast(COPY.busy, 'error')
              return
            }
            if (action === 'retract' && !window.confirm(COPY.confirm(turnOf(node) ?? 0))) return
            const response = await fetch(`${API}/apply`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sessionId, seq: data.seq, action, ...(action === 'edit' ? { text } : {}) }),
            })
            const payload = await response.json().catch(() => null)
            if (payload === null || payload.ok !== true) {
              toast(COPY.failed + (payload && payload.error && payload.error.message ? payload.error.message : `HTTP ${response.status}`), 'error')
              return
            }
            setHidden(sessionId, [...(hiddenBySession.get(sessionId) ?? []), ...(payload.hiddenTurns ?? [])])
            setEditing(false)
            if (payload.promptError !== undefined) toast(COPY.failed + payload.promptError, 'error')
            else toast(COPY.done(action))
            fetchState(sessionId, true)
          } catch (error) {
            toast(COPY.failed + (error !== null && error !== undefined && error.message ? error.message : String(error)), 'error')
          } finally {
            setBusy(false)
          }
        }

        const Original = resolveOriginal('user')

        /**
         * 量出当前气泡的实测宽度。
         *
         * 编辑态要"大小位置跟之前一样"，而官方气泡是 shrink-to-fit 的（`.userStack` 限宽、
         * 气泡按内容收缩），所以必须实测，不能靠 max-width 猜。层级取
         * `root > .userRow > .userStack > 最宽的子元素`（最宽的那个就是气泡；
         * 附件行/引用摘要一般不会更宽）。
         */
        const measureBubbleWidth = React.useCallback(() => {
          const root = rootRef.current
          if (root === null) return null
          const row = root.firstElementChild
          const stack = row === null ? null : row.firstElementChild
          if (stack === null) return null
          let width = null
          for (const child of stack.children) {
            const rect = child.getBoundingClientRect()
            if (rect.width > 0 && (width === null || rect.width > width)) width = rect.width
          }
          return width === null ? null : Math.round(width)
        }, [])

        const beginEdit = React.useCallback(() => {
          setEditWidth(measureBubbleWidth())
          setDraft(originalText)
          setEditing(true)
        }, [measureBubbleWidth, originalText])

        if (editing) {
          // 几何与官方用户气泡一致（宽度实测复用原气泡宽度 / radius-xl / 内容盒 10px 16px /
          // 同字号行高），所以点编辑时气泡原地变成输入态：白底 + 蓝描线，不跳、不错位。
          // 按键行为照抄 QueueDock 的 QueueEditor：Enter 保存、Shift+Enter 换行、Esc 取消。
          return React.createElement('div', { className: 'me-root', ref: rootRef },
            React.createElement('div', {
              className: 'me-editor',
              style: editWidth === null ? undefined : { width: `${editWidth}px`, minWidth: '180px' },
            },
              React.createElement('textarea', {
                ref: inputRef,
                className: 'me-editor-input',
                value: draft,
                autoFocus: true,
                rows: 1,
                'aria-label': COPY.editing,
                placeholder: COPY.editing,
                onChange: (event) => setDraft(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    setEditing(false)
                    return
                  }
                  if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
                  event.preventDefault()
                  if (draft.trim() === '') { toast(COPY.empty, 'error'); return }
                  void run('edit', draft)
                },
              }),
              React.createElement('div', { className: 'me-editor-actions' },
                React.createElement('button', {
                  type: 'button', className: 'me-icon', disabled: busy || draft.trim() === '',
                  'aria-label': COPY.save, title: COPY.save,
                  onClick: () => {
                    if (draft.trim() === '') { toast(COPY.empty, 'error'); return }
                    void run('edit', draft)
                  },
                }, React.createElement(IconCheck, {})),
                React.createElement('button', {
                  type: 'button', className: 'me-icon', disabled: busy,
                  'aria-label': COPY.cancel, title: COPY.cancel,
                  onClick: () => setEditing(false),
                }, React.createElement(IconClose, {})),
              ),
            ),
          )
        }

        return React.createElement('div', { className: 'me-root', ref: rootRef },
          Original === undefined ? null : React.createElement(Original, props),
          // 排进原生操作行：给原生行加 padding-right 腾出位置，这两个图标钮补在复制键右侧。
          React.createElement('div', { className: 'me-actions' },
            React.createElement('button', {
              type: 'button', className: 'me-icon', disabled: busy,
              'aria-label': COPY.edit, title: COPY.edit,
              onClick: beginEdit,
            }, React.createElement(IconEdit, {})),
            React.createElement('button', {
              type: 'button', className: 'me-icon', disabled: busy,
              'aria-label': COPY.retract, title: COPY.retract,
              onClick: () => { void run('retract') },
            }, React.createElement(IconRetract, {})),
          ),
        )
      }
    }

    // ------------------------------------------------------------------ 插件

    function apply(ctx) {
      ensureCss()

      /** kind → 我们自己注册的组件，用于从 slot 的 entries 里排除自己。 */
      const ownComponents = new Map()
      /**
       * 注册前抓一份官方条目快照（component + locale + inject）。
       * 优先读原始 entries 并按 priority === 0 过滤；拿不到时退回 entriesOfSlot
       * （后者在"上一次热更遗留的 -1 遮蔽条仍在账本里"时会返回那条遮蔽条，所以只能是兜底）。
       */
      const captured = new Map()
      try {
        const entries = ctx.slots.entries
        if (typeof entries === 'function') {
          for (const entry of entries.call(ctx.slots, SLOT)) {
            if (entry === null || entry === undefined || entry.options === undefined) continue
            if (typeof entry.options.key !== 'string') continue
            if ((entry.options.priority ?? 0) !== 0) continue
            captured.set(entry.options.key, entry)
          }
        }
      } catch (error) {
        report('capture', error)
      }
      if (captured.size === 0) {
        const entriesOfSlot = ctx.slots.entriesOfSlot
        if (typeof entriesOfSlot === 'function') {
          try {
            for (const entry of entriesOfSlot.call(ctx.slots, SLOT)) {
              if (entry !== null && entry !== undefined && entry.options !== undefined && typeof entry.options.key === 'string') {
                captured.set(entry.options.key, entry)
              }
            }
          } catch (error) {
            report('capture', error)
          }
        }
      }

      /**
       * 找官方那条 entry。
       *
       * 两个坑：
       *  1. 不能用 entriesOfSlot —— 它给的是"每个 cell 的胜者"，注册之后就是我们的遮蔽件；
       *     要读原始 entries 视图。
       *  2. 不能只靠 component 身份排除自己 —— 客户端热更后，上一次注册的 -1 遮蔽条可能
       *     还留在账本里，会被误认成"官方条目"，于是 locale / inject 一个字都复制不到。
       *     所以**优先按 priority === 0 定位官方条目**（官方一律用默认优先级 0）。
       */
      function resolveEntry(kind) {
        const collected = []
        const entries = ctx.slots.entries
        if (typeof entries === 'function') {
          try {
            for (const entry of entries.call(ctx.slots, SLOT)) {
              if (entry === null || entry === undefined || entry.options === undefined || entry.options.key !== kind) continue
              collected.push(entry)
            }
          } catch (error) {
            report('entries', error)
          }
        }
        const official = collected.find((entry) => (entry.options.priority ?? 0) === 0)
        if (official !== undefined) return official
        const capturedEntry = captured.get(kind)
        if (capturedEntry !== undefined) return capturedEntry
        const mine = ownComponents.get(kind)
        return collected.find((entry) => entry.component !== mine)
      }

      function resolveOriginal(kind) {
        const entry = resolveEntry(kind)
        return entry === undefined ? undefined : entry.component
      }

      function register(kind, component) {
        const official = resolveEntry(kind)
        ownComponents.set(kind, component)
        // ⚠️ slot core 把 locale / inject / children 存在 **entry 本身**上，
        // 不在 `entry.options` 里（只有 key / id / order / label / priority 进 options）。
        // 复制官方的 locale → kit.t 才有值；复制 inject → 官方 inject 的 props（如 useHostInfo）才有值。
        // 不复制就会让官方组件抛 `t is not a function` / `useHostInfo is not a function`，
        // 条目被 slot 让位（abdicated），按钮也就不出现。
        return ctx.slots.register({
          name: SLOT,
          key: kind,
          // 用远低于官方的优先级：既是遮蔽（slot core：同 key 不同 priority 共存、
          // priority 最小者渲染），也能压过客户端热更遗留的旧 -1 遮蔽条。
          priority: -999,
          ...(official === undefined || official.locale === undefined ? {} : { locale: official.locale }),
          ...(official === undefined || official.inject === undefined ? {} : { inject: official.inject }),
        }, component)
      }

      ctx.slots.inject(SLOT, () => register('user', makeUserShadow(resolveOriginal)))

      const probe = []
      try {
        for (const entry of ctx.slots.entries.call(ctx.slots, SLOT)) {
          if (entry !== null && entry !== undefined && entry.options !== undefined && entry.options.key === 'user') {
            probe.push(`${entry.options.priority ?? 0}/loc:${String(entry.locale)}/inj:${typeof entry.inject}`)
          }
        }
      } catch (error) {
        probe.push('probe-error:' + error.message)
      }
      const official = resolveEntry('user')
      report('ready', new Error(
        `v=5 entries=${typeof ctx.slots.entries} captured=${captured.size} officialUser=${official === undefined ? 'none' : 'ok'}` +
        ` officialLocale=${official === undefined ? '?' : String(official.locale)}` +
        ` userEntries=[${probe.join(' | ')}]`,
      ))
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
