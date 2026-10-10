/**
 * dsh-message-edit — 「撤回 / 编辑已发送消息」的客户端半边。
 *
 * 做两件事：
 *  1. **加按钮**：遮蔽官方 `conversation.chat.node` 的 `user` 渲染器（priority -1），
 *     在外面套一层 `<Orig {...props} />` + 编辑/撤回按钮。
 *     依据：slot 的 catalog 明说 "Registering an already-occupied key replaces that
 *     occupant"，slot core 的规则是**同 key 不同 priority 共存、priority 最小者渲染**
 *     （官方是 0），所以 -1 即遮蔽；渲染器把合并好的 props 当**一个对象**传给组件，
 *     因此 `{...props}` 原样转发就能做到外观零妥协。
 *  2. **隐藏被遮蔽的轮次**：客户端的对话记录是**原始日志视图**——表面替换（压缩也一样）
 *     只改变模型上下文，不会让旧气泡消失。所以本插件 wrap 每一个 chat node 渲染器，
 *     当 `node.location.turn.turn ∈ hiddenTurns` 时渲染 null（干净的 React 卸载，不动 DOM）。
 *     hiddenTurns 由宿主半边从会话日志里算出（见 host.js 的 state 路由）。
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

    /** 需要 wrap 的 chat node 种类：被遮蔽轮次里的任何一行都要能隐藏。 */
    const WRAP_KINDS = [
      'user', 'steering', 'context', 'turn-trigger', 'assistant-step', 'tool-call',
      'turn-process', 'turn-tail', 'turn-error', 'turn-max-tokens', 'model-retry',
      'compaction', 'manual-compaction', 'command', 'command-input', 'question-reply',
      'workflow-run', 'system-prompt', 'unknown',
    ]

    const CN = /^zh/i.test((typeof navigator !== 'undefined' && navigator.language) || '') || (typeof navigator !== 'undefined' && navigator.language === undefined)
    const COPY = {
      edit: CN ? '编辑' : 'Edit',
      retract: CN ? '撤回' : 'Recall',
      save: CN ? '保存并重发' : 'Save & resend',
      cancel: CN ? '取消' : 'Cancel',
      editing: CN ? '编辑这条消息（Ctrl+Enter 保存）' : 'Edit this message (Ctrl+Enter to save)',
      confirm: (turn) => (CN
        ? `撤回后，这条消息及其之后的对话（第 ${turn} 轮起）将不再进入模型上下文。\n\n原始会话日志仍会保留，但这一段会从当前对话视图里隐藏。\n\n确定撤回吗？`
        : `This message and everything after it (turn ${turn}+) leaves the model context.\n\nThe raw session log keeps them; this chat view hides that span.\n\nRecall anyway?`),
      busy: CN ? '当前轮次还没跑完，等它结束再操作。' : 'The current turn is still running; try again when it finishes.',
      failed: CN ? '操作失败：' : 'Failed: ',
      empty: CN ? '内容不能为空。' : 'Text cannot be empty.',
      done: (action) => (action === 'retract' ? (CN ? '已撤回' : 'Recalled') : (CN ? '已更新' : 'Updated')),
    }

    // ------------------------------------------------------------------ 样式

    const CSS = `
.me-root{display:flex;flex-direction:column;align-items:flex-end;gap:2px;width:100%;min-width:0}
.me-actions{display:flex;align-items:center;gap:2px;justify-content:flex-end;min-height:22px;opacity:.55;transition:opacity .12s ease}
.me-root:hover .me-actions{opacity:1}
.me-btn{appearance:none;background:0 0;border:0;padding:1px 6px;border-radius:var(--dsw-radius-sm,6px);
  color:var(--dsw-alias-label-tertiary,#8a8f98);font-family:inherit;font-size:12px;line-height:18px;cursor:pointer;
  transition:color .12s ease,background .12s ease}
.me-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,#111)}
.me-btn[disabled]{opacity:.45;cursor:default}
.me-editor{box-sizing:border-box;width:min(560px,88%);border-radius:var(--dsw-radius-xl,14px);
  background:var(--dsw-specific-bubble,rgba(127,127,127,.12));padding:8px 10px 10px;display:flex;flex-direction:column;gap:8px}
.me-editor-title{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a8f98);text-align:right}
.me-editor textarea{box-sizing:border-box;width:100%;min-height:72px;max-height:300px;resize:vertical;
  border-radius:var(--dsw-radius-md,10px);border:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));
  background:var(--dsw-specific-input-major,var(--dsw-alias-bg-base,#fff));color:var(--dsw-alias-label-primary,#111);
  font-family:inherit;font-size:var(--dsh-content-font-size,14px);line-height:1.55;padding:8px 10px;outline:none}
.me-editor textarea:focus{border-color:var(--dsw-alias-state-business-primary,#4d6bfe)}
.me-editor-actions{display:flex;justify-content:flex-end;gap:8px}
.me-primary{appearance:none;border:0;border-radius:var(--dsw-radius-md,10px);padding:5px 12px;
  background:var(--dsw-alias-state-business-primary,#4d6bfe);color:#fff;font-family:inherit;font-size:13px;cursor:pointer}
.me-primary[disabled]{opacity:.5;cursor:default}
.me-ghost{appearance:none;border:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));border-radius:var(--dsw-radius-md,10px);
  padding:5px 12px;background:0 0;color:var(--dsw-alias-label-primary,#111);font-family:inherit;font-size:13px;cursor:pointer}
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
    let snapshot = 0

    function notify() {
      snapshot += 1
      for (const listener of listeners) listener()
    }

    function subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }

    function getSnapshot() {
      return snapshot
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

    /** 订阅共享状态；返回 (sessionId, node) => 是否应隐藏。 */
    function useHidden() {
      React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      return React.useCallback((sessionId, node) => {
        const turns = hiddenBySession.get(sessionId)
        if (turns === undefined || turns.length === 0) return false
        const location = node === undefined ? undefined : node.location
        const turn = location !== undefined && (location.kind === 'turn' || location.kind === 'step') ? location.turn.turn : undefined
        return typeof turn === 'number' && turns.includes(turn)
      }, [snapshot])
    }

    // ------------------------------------------------------------------ 通知条

    function toast(text, tone) {
      const el = document.createElement('div')
      el.className = 'me-toast'
      el.textContent = text
      if (tone === 'error') el.style.color = 'var(--dsw-alias-state-error-primary,#ff6b6b)'
      document.body.appendChild(el)
      window.setTimeout(() => { el.remove() }, tone === 'error' ? 4200 : 2000)
    }

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

    // ------------------------------------------------------------------ 组件

    /** user 渲染器的遮蔽件：官方气泡 + 编辑 / 撤回按钮；编辑时换成内联编辑框。 */
    function makeUserShadow(resolveOriginal) {
      return function UserNodeWithRecall(props) {
        const isHidden = useHidden()
        const Original = resolveOriginal('user')
        const node = props.node
        const data = (node === undefined || node.data === undefined) ? {} : node.data
        const sessionId = props.sessionId
        const [editing, setEditing] = React.useState(false)
        const [draft, setDraft] = React.useState('')
        const [busy, setBusy] = React.useState(false)
        const originalText = React.useMemo(() => textOf(data), [data])

        React.useEffect(() => {
          if (typeof sessionId === 'string' && sessionId !== '') fetchState(sessionId)
        }, [sessionId])

        if (isHidden(sessionId, node)) return null

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

        if (editing) {
          return React.createElement('div', { className: 'me-root' },
            React.createElement('div', { className: 'me-editor' },
              React.createElement('div', { className: 'me-editor-title' }, COPY.editing),
              React.createElement('textarea', {
                value: draft,
                autoFocus: true,
                onChange: (event) => setDraft(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Escape') { event.preventDefault(); setEditing(false) }
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault()
                    if (draft.trim() === '') toast(COPY.empty, 'error')
                    else void run('edit', draft)
                  }
                },
              }),
              React.createElement('div', { className: 'me-editor-actions' },
                React.createElement('button', {
                  type: 'button', className: 'me-ghost',
                  onClick: () => setEditing(false),
                }, COPY.cancel),
                React.createElement('button', {
                  type: 'button', className: 'me-primary', disabled: busy,
                  onClick: () => {
                    if (draft.trim() === '') { toast(COPY.empty, 'error'); return }
                    void run('edit', draft)
                  },
                }, COPY.save),
              ),
            ),
          )
        }

        return React.createElement('div', { className: 'me-root' },
          Original === undefined ? null : React.createElement(Original, props),
          React.createElement('div', { className: 'me-actions' },
            React.createElement('button', {
              type: 'button', className: 'me-btn', disabled: busy, title: COPY.edit,
              onClick: () => { setDraft(originalText); setEditing(true) },
            }, COPY.edit),
            React.createElement('button', {
              type: 'button', className: 'me-btn', disabled: busy, title: COPY.retract,
              onClick: () => { void run('retract') },
            }, COPY.retract),
          ),
        )
      }
    }

    /** 其它种类的遮蔽件：被遮蔽的轮次里渲染 null，否则原样转发。 */
    function makeHider(kind, resolveOriginal) {
      return function HiddenNode(props) {
        const isHidden = useHidden()
        if (isHidden(props.sessionId, props.node)) return null
        const Original = resolveOriginal(kind)
        return Original === undefined ? null : React.createElement(Original, props)
      }
    }

    // ------------------------------------------------------------------ 插件

    function apply(ctx) {
      ensureCss()

      /** kind → 我们自己注册的组件，用于从 slot 的 entries 里排除自己。 */
      const ownComponents = new Map()
      /** 注册前抓一份官方条目快照，作为 ctx.slots.entries 不可用时的兜底。 */
      const captured = new Map()
      const entriesOfSlot = ctx.slots.entriesOfSlot
      if (typeof entriesOfSlot === 'function') {
        try {
          for (const entry of entriesOfSlot.call(ctx.slots, SLOT)) {
            if (entry && entry.options && typeof entry.options.key === 'string') captured.set(entry.options.key, entry.component)
          }
        } catch (error) {
          console.warn(`[${ID}] entriesOfSlot 快照失败：`, error)
        }
      }

      /**
       * 找官方那条 entry 的 component。
       * 不能用 entriesOfSlot（它给的是"每个 cell 的胜者"，注册之后就是我们的遮蔽件），
       * 所以优先走原始 entries 视图，并用 component 身份把自己排除掉。
       */
      function resolveOriginal(kind) {
        const entries = ctx.slots.entries
        if (typeof entries === 'function') {
          try {
            const mine = ownComponents.get(kind)
            for (const entry of entries.call(ctx.slots, SLOT)) {
              if (!entry || !entry.options || entry.options.key !== kind) continue
              if (mine !== undefined && entry.component === mine) continue
              return entry.component
            }
          } catch (error) {
            console.warn(`[${ID}] ctx.slots.entries 读取失败：`, error)
          }
        }
        return captured.get(kind)
      }

      function register(kind, component) {
        ownComponents.set(kind, component)
        return ctx.slots.register({ name: SLOT, key: kind, priority: -1 }, component)
      }

      ctx.slots.inject(SLOT, () => {
        const disposers = []
        disposers.push(register('user', makeUserShadow(resolveOriginal)))
        for (const kind of WRAP_KINDS) {
          if (kind === 'user') continue
          disposers.push(register(kind, makeHider(kind, resolveOriginal)))
        }
        return () => { for (const dispose of disposers) dispose() }
      })

      console.log(`[${ID}] client ready; captured kinds =`, [...captured.keys()].join(','))
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
