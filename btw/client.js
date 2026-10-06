/**
 * dsh-btw — 「临时提问」(/btw) 的客户端半边。
 *
 * 提供两样东西：
 *  1. 一个右侧栏 tab 类型（kind `btw`），它的 guide 入口就是「开始」页上的第四张卡片；
 *  2. tab 正文：临时提问线程 + 输入框 + 流式渲染。
 *
 * 视觉与主会话对齐，而不是自创一套：
 *  - 用户提问 = 主会话同款气泡（`--dsw-specific-bubble` + `--dsw-radius-xl` + 10/16 内边距、右对齐）；
 *  - 回答 = 轻量 Markdown（代码块/行内代码/粗斜体/列表/标题/引用），配色走 `--dsw-alias-markdown-*`；
 *  - 输入区 = 复刻主 composer 的结构（`--dsw-specific-input-major` + `--dsw-radius-panel` +
 *    `--dsw-elevation-soft` + 同款圆形主按钮）；
 *  - 字号跟随设置里的内容字号（`--dsh-content-font-size` / `--dsh-content-font-delta`），不写死 px；
 *  - 图标是官方 `@deepseek-ai/dsh-client-ui-primitives` 的同一条路径数据（内联，不 require）。
 *
 * 客户端插件只能 require 真正的 `__ModuleLoader__` 模块（react）；app 内部的普通 ESM 库
 * （如 ui-primitives）不是模块，require 它会直接让整个客户端半边加载失败——这正是本文件
 * 内联图标、自带 Markdown 的原因。
 *
 * 线程只存在组件状态里（keepMounted），不写 localStorage、不写会话日志，关掉应用即消失。
 * 与宿主半边的通道：POST /btw-api/ask 返回 SSE（与 sysmon 同一套 webServer 约定）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-btw',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    /** 类型身份：同时是 tab 类型的 id、正文 Slot 的 key。 */
    const ID = 'dsh-btw'
    /** tab 类型 kind：开始页入口按下它打开本页。 */
    const KIND = 'btw'
    /** 本插件拥有的 locale 命名空间。 */
    const NS = 'btw'
    /** 与宿主半边一致的线程上限。 */
    const THREAD_LIMIT = 20
    /** 代码块字体：与主会话代码卡一致的等宽族。 */
    const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'

    // ------------------------------------------------------------------ 文案
    const zh = {
      'type.label': '临时提问',
      'guide.title': '临时提问',
      'guide.description': '不写入历史的旁支提问',
      'empty.hint': '问点关于这个会话的事。',
      'composer.placeholder': '临时提问…',
      'action.send': '发送',
      'action.stop': '停止',
      'action.clear': '清空',
      'action.clear.title': '清空本次临时提问',
      'action.copy': '复制',
      'action.copied': '已复制',
      'action.like': '点赞',
      'action.dislike': '点踩',
      'clock.md': '{m}月{d}日',
      'clock.ymd': '{y}年{m}月{d}日',
      'stats.consumed': '用量 {total}',
      'stats.count': '{count} tok',
      'stats.usageTitle': '本轮用量',
      'error.render': '面板渲染出错：',
      'think.title': '思考',
      'error.noSession': '请先打开一个会话',
    }
    const en = {
      'type.label': 'Aside',
      'guide.title': 'Aside',
      'guide.description': 'Side question, kept out of history',
      'empty.hint': 'Ask something about this conversation.',
      'composer.placeholder': 'Ask aside…',
      'action.send': 'Send',
      'action.stop': 'Stop',
      'action.clear': 'Clear',
      'action.clear.title': 'Clear this aside thread',
      'action.copy': 'Copy',
      'action.copied': 'Copied',
      'action.like': 'Like',
      'action.dislike': 'Dislike',
      'clock.md': '{m}/{d}',
      'clock.ymd': '{y}-{m}-{d}',
      'stats.consumed': 'Usage {total}',
      'stats.count': '{count} tok',
      'stats.usageTitle': 'Turn usage',
      'error.render': 'Panel render error: ',
      'think.title': 'Think',
      'error.noSession': 'Open a session first',
    }

    // ------------------------------------------------------------------ 样式
    //
    // 只用官方 token 与官方布局变量，字号/圆角/底色都跟随主会话与设置。
    const CSS = [
      '.dshbtw-root{display:flex;flex-direction:column;width:100%;height:100%;min-height:0;box-sizing:border-box;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-family:var(--dsw-font-family);font-size:var(--dsh-content-font-size,14px);line-height:calc(24px + var(--dsh-content-font-delta,0px))}',
      '.dshbtw-scroll{flex:1;min-height:0;overflow-y:auto;padding:16px 16px 8px;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}',
      '.dshbtw-empty{height:100%;display:flex;justify-content:center;align-items:center;color:var(--dsw-alias-label-caption);font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(18px + var(--dsh-content-font-delta-secondary,0px))}',
      '.dshbtw-turn{margin-bottom:20px}',
      '.dshbtw-turn:last-child{margin-bottom:4px}',
      '.dshbtw-userRow{display:flex;flex-direction:column;align-items:flex-end;gap:6px;margin-bottom:12px}',
      '.dshbtw-userActions{display:flex;align-items:center;gap:8px;height:calc(28px + var(--dsh-content-font-delta,0px))}',
      // 操作行的显形规则照主会话：
      // - 回答行：`[data-actions-reveal=hover]` → 常态 opacity 0，hover / focus-within 才显形；
      // - 用户行：对应 `:is([user]):has(~ [user]) .actions{opacity:0}` → 只有最后一条提问常显，
      //   更早的提问行同样要 hover。用 opacity 而不是 display，保持 28px 占位不跳动（与官方一致）。
      '@media (hover:hover){.dshbtw-turn .dshbtw-answerActions{opacity:0;transition:opacity 80ms}.dshbtw-turn:hover .dshbtw-answerActions,.dshbtw-turn:focus-within .dshbtw-answerActions{opacity:1}.dshbtw-turn:not([data-last="1"]) .dshbtw-userActions{opacity:0;transition:opacity 80ms}.dshbtw-turn:not([data-last="1"]):hover .dshbtw-userActions,.dshbtw-turn:not([data-last="1"]):focus-within .dshbtw-userActions{opacity:1}}',
      '.dshbtw-timeStart{font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-tertiary);white-space:nowrap;padding-right:12px}',
      '.dshbtw-bubble{max-width:min(calc(var(--dsh-chat-content-width,748px) * .702), 82%);box-sizing:border-box;padding:10px 16px;border-radius:var(--dsw-radius-xl,16px);background:var(--dsw-specific-bubble);color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;font-size:var(--dsh-content-font-size,14px);line-height:calc(22px + var(--dsh-content-font-delta,0px))}',
      '.dshbtw-answer{min-width:0}',

      // 回答下的操作行：照 primitives 的 MessageIconActions.module.css
      // （28px 方钮、15px 图标、gap 8、hover 底色）+ AssistantMarkdown 的
      // .actions{margin-top:16px;margin-left:-6px}，并按主会话那样 hover 才显形。
      // 回答下的操作行：元素与顺序照主会话 turn tail——
      // [复制][点赞][点踩][分支] + TurnUsagePanel 的「🛢 用量 X tok」+ 时间。
      '.dshbtw-actions{margin-top:16px;margin-left:-6px;min-height:calc(28px + var(--dsh-content-font-delta,0px));display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dshbtw-action{display:inline-flex;justify-content:center;align-items:center;width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));padding:6px;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}',
      '.dshbtw-action svg{width:calc(15px + var(--dsh-content-font-delta,0px));height:calc(15px + var(--dsh-content-font-delta,0px))}',
      '.dshbtw-action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '.dshbtw-action[data-on="1"]{color:var(--dsw-alias-state-business-primary)}',

      // 用量 + 时间：照 MessageIconActions 的结构——`.endInfo` 包住 usageAction 与 clockEl，
      // `.endInfo{color: tertiary; gap: 8px; margin-left: 8px}`、时间用 `.timeEnd`
      // （font-size: secondary - 1px、line-height: 24px + delta、color: inherit）。
      '.dshbtw-endInfo{display:inline-flex;align-items:center;gap:8px;margin-left:8px;min-width:0;color:var(--dsw-alias-label-tertiary)}',
      '.dshbtw-usage{min-width:0;display:inline-flex;height:calc(28px + var(--dsh-content-font-delta,0px));align-items:center;gap:4px;padding:6px 8px;border:0;border-radius:var(--dsw-radius-sm,6px);background:0 0;color:inherit;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(24px + var(--dsh-content-font-delta,0px));font-variant-numeric:tabular-nums;white-space:nowrap;cursor:default}',
      '.dshbtw-usage svg{width:calc(15px + var(--dsh-content-font-delta,0px));height:calc(15px + var(--dsh-content-font-delta,0px));flex:none}',
      '.dshbtw-usageLabel{min-width:0;overflow:hidden;text-overflow:ellipsis}',
      '.dshbtw-time{font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:inherit;white-space:nowrap;font-variant-numeric:tabular-nums}',

      // 思考行：逐条照 primitives 的 DisclosureRow.module.css 与 ui-chat 的
      // ReasoningRow.module.css——行高 24px+delta、标题 13/24、leading 是 16px 盒
      // （图标 14px，hover 时图标让位给箭头）、2px 圆点分隔符、13/20 摘要、
      // 流式右侧渐隐 + 微光。
      '.dshbtw-think{display:flex;flex-direction:column;width:100%;min-width:0;margin-bottom:6px}',
      '.dshbtw-thinkRow{position:relative;display:flex;align-items:center;box-sizing:border-box;width:100%;height:calc(24px + var(--dsh-content-font-delta,0px));min-width:0;padding:0;border:0;background:none;color:var(--dsw-alias-label-tertiary);font:inherit;text-align:left;cursor:pointer;overflow:hidden;transition:color 100ms ease}',
      '.dshbtw-thinkRow:hover{color:var(--dsw-alias-label-secondary)}',
      '.dshbtw-thinkLeading{position:relative;flex:none;display:inline-flex;align-items:center;justify-content:center;width:calc(16px + var(--dsh-content-font-delta,0px));height:calc(16px + var(--dsh-content-font-delta,0px));margin-right:6px}',
      '.dshbtw-thinkLeading svg{width:calc(14px + var(--dsh-content-font-delta,0px));height:calc(14px + var(--dsh-content-font-delta,0px))}',
      '.dshbtw-thinkIcon{display:inline-flex;opacity:1;transition:opacity 100ms ease}',
      '.dshbtw-thinkChevron{position:absolute;inset:0;margin:auto;display:inline-flex;opacity:0;transition:opacity 100ms ease,transform .12s}',
      '.dshbtw-thinkRow:hover .dshbtw-thinkIcon{opacity:0}',
      '.dshbtw-thinkRow:hover .dshbtw-thinkChevron{opacity:1}',
      '.dshbtw-think[data-expanded] .dshbtw-thinkIcon{display:none}',
      '.dshbtw-think[data-expanded] .dshbtw-thinkChevron{opacity:1;transform:rotate(180deg)}',
      '.dshbtw-thinkTitle{flex:none;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));font-weight:400;color:inherit}',
      '.dshbtw-thinkSep{flex:none;width:2px;height:2px;margin:0 8px;border-radius:1px;background:var(--dsw-alias-label-caption)}',
      '.dshbtw-thinkSummary{flex:auto;min-width:0;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));white-space:nowrap;overflow:hidden}',
      '.dshbtw-thinkSummary[data-streaming]{mask-image:linear-gradient(90deg,#000 calc(100% - 48px),transparent)}',
      '.dshbtw-thinkSummaryText{display:block;overflow:hidden;text-overflow:ellipsis}',
      '.dshbtw-thinkSummary[data-streaming] .dshbtw-thinkSummaryText{text-overflow:clip;overflow:visible;background-image:linear-gradient(90deg,var(--dsw-alias-label-deep-diving,#8b8f96) 0%,var(--dsw-alias-label-deep-diving-shimmer,var(--dsw-alias-label-primary,#fff)) 50%,var(--dsw-alias-label-deep-diving,#8b8f96) 100%);background-size:200% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:dshbtw-shimmer 1.6s linear infinite}',
      '@keyframes dshbtw-shimmer{from{background-position:200% 0}to{background-position:-200% 0}}',
      '.dshbtw-thinkBody{padding:4px 0 4px calc(22px + var(--dsh-content-font-delta,0px));min-width:0}',

      // Markdown：逐条照 primitives 的 markdown/MarkdownText.module.css，
      // body 变体与 compact 变体都取原值（含 first/last child 的 !important 归零）。
      '.dshbtw-md{min-width:0;overflow-wrap:anywhere;font-size:var(--dsh-content-font-size,14px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-primary)}',
      '.dshbtw-md>*:first-child{margin-top:0!important}',
      '.dshbtw-md>*:last-child{margin-bottom:0!important}',
      '.dshbtw-md strong{font-weight:600}',
      '.dshbtw-md h1{font-size:calc(21px + var(--dsh-content-font-delta,0px));line-height:calc(30px + var(--dsh-content-font-delta,0px));font-weight:700;margin:32px 0 16px}',
      '.dshbtw-md h2{font-size:calc(19px + var(--dsh-content-font-delta,0px));line-height:calc(28px + var(--dsh-content-font-delta,0px));font-weight:700;margin:32px 0 16px}',
      '.dshbtw-md h3{font-size:calc(18px + var(--dsh-content-font-delta,0px));line-height:calc(26px + var(--dsh-content-font-delta,0px));font-weight:700;margin:32px 0 16px}',
      '.dshbtw-md h4{font-size:var(--dsh-content-font-size,14px);line-height:calc(24px + var(--dsh-content-font-delta,0px));font-weight:600;margin:16px 0}',
      '.dshbtw-md h5,.dshbtw-md h6{font-size:var(--dsh-content-font-size,14px);line-height:calc(24px + var(--dsh-content-font-delta,0px));font-weight:600;margin:16px 0}',
      '.dshbtw-md p{margin:16px 0;white-space:pre-wrap;word-break:break-word}',
      '.dshbtw-md ul,.dshbtw-md ol{margin:16px 0;padding-left:18px}',
      '.dshbtw-md li:not(:first-child){margin-top:6px}',
      '.dshbtw-md li::marker{line-height:24px;color:var(--dsw-alias-label-secondary)}',
      '.dshbtw-md blockquote{border-left:2px solid var(--dsw-alias-label-caption);margin:16px 0 0;padding-left:14px}',
      '.dshbtw-md hr{display:block;border:none;height:.5px;margin:32px 0;background:var(--dsw-alias-border-l2)}',
      '.dshbtw-md :not(pre)>code{display:inline-flex;align-items:center;box-sizing:border-box;font-family:var(--ds-font-family-code,' + MONO + ');font-size:.875em;background-color:var(--dsw-alias-markdown-inline-code);border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,6px);padding:0 5px}',
      '.dshbtw-md a{color:var(--dsw-alias-link);font-weight:500;text-decoration:none}',
      '.dshbtw-md[data-compact="1"]{font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));color:var(--dsw-alias-label-tertiary)}',
      '.dshbtw-md[data-compact="1"] :is(p,ul,ol,blockquote){margin:4px 0}',
      '.dshbtw-md[data-compact="1"] blockquote{padding-left:8px}',
      '.dshbtw-md[data-compact="1"] :is(h1,h2,h3,h4,h5,h6){font-size:inherit;line-height:inherit;font-weight:600;margin:8px 0}',
      '.dshbtw-md[data-compact="1"] :not(pre)>code{display:inline;font-size:1em;border-radius:var(--dsw-radius-xs,4px);padding:0 3px}',

      // 代码卡：照 primitives 的 markdown/CodeBlock.module.css。
      '.dshbtw-code{position:relative;margin:16px 0;border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-markdown-code-block);color:var(--dsw-alias-label-primary)}',
      '.dshbtw-codeHead{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:9px 14px;border-radius:var(--dsw-radius-lg,12px) var(--dsw-radius-lg,12px) 0 0;background:var(--dsw-alias-markdown-code-block-banner);font-size:11px;line-height:18px}',
      '.dshbtw-codeLang{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-family:var(--ds-font-family-code,' + MONO + ');font-size:11px;line-height:18px}',
      '.dshbtw-codeCopy{flex:none;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;border:0;border-radius:var(--dsw-radius-xs,4px);background:transparent;color:inherit;cursor:pointer}',
      '.dshbtw-codeCopy:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshbtw-codePre{box-sizing:border-box;margin:0;padding:16px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;border-radius:0 0 var(--dsw-radius-lg,12px) var(--dsw-radius-lg,12px);background:var(--dsw-alias-markdown-code-block);color:var(--dsw-alias-label-primary);font-family:var(--ds-font-family-code,' + MONO + ');font-size:11px;line-height:19px}',
      '.dshbtw-error{margin:0 16px 8px;padding:6px 10px;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-error-primary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(18px + var(--dsh-content-font-delta-secondary,0px));word-break:break-word}',

      // 输入区：复刻主 composer。
      '.dshbtw-composer{flex:none;padding:0 var(--dsh-composer-side-clearance,16px) 12px}',
      '.dshbtw-card{box-sizing:border-box;display:flex;flex-direction:column;gap:12px;padding-top:8px;border-radius:var(--dsw-radius-panel,20px);background:var(--dsw-specific-input-major);box-shadow:var(--dsw-elevation-soft);font-size:var(--dsh-content-font-size,14px);line-height:calc(24px + var(--dsh-content-font-delta,0px))}',
      '.dshbtw-input{box-sizing:border-box;min-height:36px;max-height:var(--dsh-composer-text-max-height,40vh);resize:none;border:0;outline:none;background:transparent;color:var(--dsw-alias-label-primary);caret-color:var(--dsw-alias-state-business-primary);font-family:inherit;font-size:inherit;line-height:inherit;padding:4px 8px 0 14px;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere}',
      '.dshbtw-input::placeholder{color:var(--dsw-alias-label-caption)}',
      '.dshbtw-row{display:flex;justify-content:space-between;align-items:center;gap:12px;min-width:0;padding:2px 8px 6px}',
      '.dshbtw-note{color:var(--dsw-alias-label-caption);font-size:var(--dsh-content-font-size-secondary,13px);line-height:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dshbtw-trailing{flex:none;display:flex;align-items:center;gap:8px;margin-left:auto}',
      '.dshbtw-ghost{display:grid;place-items:center;width:28px;height:28px;padding:0;border:0;border-radius:999px;corner-shape:round;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.dshbtw-ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dshbtw-ghost:disabled{opacity:.35;cursor:default}',
      '.dshbtw-primary{display:grid;place-items:center;flex:none;width:34px;height:34px;padding:0;border:0;border-radius:999px;corner-shape:round;background:var(--dsw-alias-button-info-fill);color:#fff;cursor:pointer;transition:background-color .1s}',
      '.dshbtw-primary:hover:not(:disabled){background:var(--dsw-alias-button-info-hover)}',
      '.dshbtw-primary:disabled{opacity:.4;cursor:default}',
      '.dshbtw-spin{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-business-primary);animation:dshbtw-pulse 1s ease-in-out infinite alternate}',
      '@keyframes dshbtw-pulse{0%{opacity:.35}to{opacity:1}}',
    ].join('')

    function ensureCss() {
      if (typeof document === 'undefined') return
      const tagId = ID + '/btw.css'
      if (document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = ID
      tag.dataset.pluginCss = tagId
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // ------------------------------------------------------------------ 图标
    //
    // 路径数据取自官方 @deepseek-ai/dsh-client-ui-primitives（Regular / 1px 描边），
    // 内联以免 require 一个不是 ModuleLoader 模块的包。
    function Icon({ size = 16, strokeWidth = 1, className, children, viewBox = '0 0 16 16' }) {
      return React.createElement('svg', {
        width: size, height: size, className, viewBox, fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': 'true', strokeWidth,
      }, children)
    }

    function IconSend({ size = 14 }) {
      return Icon({ size, children: [
        React.createElement('path', {
          key: 'a',
          d: 'M6.97211 1.94476C7.55785 1.35914 8.50767 1.35919 9.09343 1.94476L13.921 6.77228L13.2138 7.47939L8.38632 2.65187C8.19108 2.45682 7.87443 2.45677 7.67922 2.65187L2.74397 7.58711L2.03687 6.88L6.97211 1.94476Z',
          fill: 'currentColor',
        }),
        React.createElement('path', { key: 'b', d: 'M7.97571 14.5732L8.02421 2.34139', stroke: 'currentColor' }),
      ] })
    }

    /** 停止字形：与主 composer 完全一致——16×16 里 10×10、rx 3 的当前色圆角方块。 */
    function IconStop({ size = 16 }) {
      return Icon({ size, children: React.createElement('rect', {
        x: '3', y: '3', width: '10', height: '10', rx: '3', fill: 'currentColor',
      }) })
    }

    function IconTrash({ size = 16 }) {
      return Icon({ size, children: [
        React.createElement('path', { key: 'a', d: 'M1.28149 3.88831H14.7187', stroke: 'currentColor' }),
        React.createElement('path', {
          key: 'b',
          d: 'M5.41602 3.88833V2.47962C5.41602 2.29282 5.52492 2.11366 5.71876 1.98157C5.9126 1.84948 6.17551 1.77527 6.44964 1.77527H9.55053C9.82466 1.77527 10.0876 1.84948 10.2814 1.98157C10.4753 2.11366 10.5842 2.29282 10.5842 2.47962V3.88833',
          stroke: 'currentColor',
        }),
        React.createElement('path', {
          key: 'c',
          d: 'M2.57349 3.88831L3.19366 13.2943C3.21937 13.5502 3.33952 13.7872 3.53065 13.9593C3.72178 14.1313 3.97016 14.2259 4.22729 14.2246H11.7728C12.0299 14.2259 12.2783 14.1313 12.4694 13.9593C12.6605 13.7872 12.7807 13.5502 12.8064 13.2943L13.4266 3.88831',
          stroke: 'currentColor',
        }),
      ] })
    }

    function IconCopy({ size = 16 }) {
      return Icon({ size, children: [
        React.createElement('rect', { key: 'a', x: '1.52075', y: '4.07373', width: '10.3932', height: '10.3932', rx: '2', stroke: 'currentColor' }),
        React.createElement('path', {
          key: 'b',
          d: 'M11.9792 1.53296C13.36 1.53296 14.4792 2.65225 14.4792 4.03296V9.42847C14.4792 10.3756 13.9521 11.1987 13.1755 11.6228V10.3298C13.3652 10.0787 13.4792 9.7674 13.4792 9.42847V4.03296C13.4792 3.20453 12.8077 2.53296 11.9792 2.53296H6.58374C6.27966 2.53301 5.99684 2.6235 5.7605 2.77905H4.42358C4.85652 2.03463 5.66056 1.53304 6.58374 1.53296H11.9792Z',
          fill: 'currentColor',
        }),
      ] })
    }

    function IconCheck({ size = 16 }) {
      return Icon({ size, children: React.createElement('path', {
        d: 'M2.25 8.5L5.49732 11.7473C5.90519 12.1552 6.57263 12.1344 6.95426 11.7018L13.75 4',
        stroke: 'currentColor',
      }) })
    }

    /** 思考行的字形（与主会话同一个"套起来的轨道"图形）。 */
    function IconThink({ size = 14 }) {
      return Icon({ size, children: [
        React.createElement('path', {
          key: 'a',
          d: 'M10.2854 5.71481C12.9673 8.39663 14.1182 11.5938 12.8562 12.8559C11.5942 14.1179 8.39706 12.9669 5.71518 10.2851C3.03333 7.60323 1.88236 4.40608 3.14441 3.14403C4.40644 1.882 7.6036 3.03297 10.2854 5.71481Z',
          stroke: 'currentColor',
        }),
        React.createElement('path', {
          key: 'b',
          d: 'M10.2854 10.2851C7.6036 12.9669 4.40644 14.1179 3.14441 12.8559C1.88236 11.5938 3.03333 8.39663 5.71518 5.71481C8.39706 3.03297 11.5942 1.882 12.8562 3.14403C14.1182 4.40608 12.9673 7.60323 10.2854 10.2851Z',
          stroke: 'currentColor',
        }),
        React.createElement('path', {
          key: 'c',
          d: 'M8.86291 8.0002C8.86291 8.47549 8.47762 8.86087 8.00224 8.86087C7.52694 8.86087 7.1416 8.47549 7.1416 8.0002C7.1416 7.52485 7.52694 7.13953 8.00224 7.13953C8.47762 7.13953 8.86291 7.52485 8.86291 8.0002Z',
          fill: 'currentColor',
        }),
      ] })
    }

    /** 点赞/取消赞（官方 outline/fill 同一路径，填充态只换 fill/stroke）。 */
    function IconLike({ size = 16, filled = false }) {
      return Icon({ size, children: React.createElement('path', {
        d: 'M13.537 8.12098L12.3983 12.8455C12.1818 13.7438 11.378 14.3769 10.454 14.3769L9.35595 14.3769H7.43799H5.16577C3.50892 14.3769 2.16577 13.0337 2.16577 11.3769V7.88668C2.16577 7.33439 2.61349 6.88668 3.16577 6.88668H4.02665C5.84943 6.88668 7.38083 3.28711 7.67689 2.54578C7.71259 2.45639 7.73501 2.36373 7.77922 2.27824C7.86506 2.11221 8.08228 1.87578 8.59039 2.07775C10.3291 2.76886 9.23144 6.04071 8.96955 6.75058C8.94502 6.81707 8.99495 6.88668 9.06581 6.88668H12.5648C13.2119 6.88668 13.6886 7.49192 13.537 8.12098Z',
        fill: filled ? 'currentColor' : 'none',
        stroke: 'currentColor',
      }) })
    }

    /** 点踩（官方 outline 路径；填充态同路径换 fill）。 */
    function IconDislike({ size = 16, filled = false }) {
      return Icon({ size, children: React.createElement('path', {
        d: 'M2.46302 8.06749L3.60171 3.34299C3.81822 2.44467 4.62196 1.81162 5.546 1.8116L6.64406 1.81158L8.56202 1.81158L10.8342 1.81158C12.4911 1.81158 13.8342 3.15473 13.8342 4.81158L13.8342 8.3018C13.8342 8.85408 13.3865 9.3018 12.8342 9.3018L11.9734 9.3018C10.1506 9.3018 8.61918 12.9014 8.32311 13.6427C8.28741 13.7321 8.26499 13.8247 8.22078 13.9102C8.13494 14.0763 7.91772 14.3127 7.40961 14.1107C5.67089 13.4196 6.76856 10.1478 7.03045 9.43789C7.05498 9.37141 7.00505 9.3018 6.93419 9.3018L3.43519 9.3018C2.78811 9.3018 2.31141 8.69656 2.46302 8.06749Z',
        fill: filled ? 'currentColor' : 'none',
        stroke: 'currentColor',
      }) })
    }

    /** 数据库/用量（官方 IconDatabaseOutline 几何：四条弧）。 */
    function IconDatabase({ size = 16 }) {
      return Icon({ size, children: React.createElement(React.Fragment, null,
        React.createElement('path', { d: 'M13.1967 5.1869C13.7232 4.77378 14.0003 4.30517 14.0001 3.82819C14.0003 3.3512 13.7232 2.88259 13.1967 2.46947C12.6702 2.05635 11.9128 1.71328 11.0006 1.47475C10.0885 1.23621 9.05371 1.11062 8.00039 1.1106C6.94707 1.11057 5.9123 1.23612 5.00009 1.47461C4.08742 1.71301 3.32948 2.05604 2.80249 2.46919C2.2755 2.88235 1.99805 3.35106 1.99805 3.82819C1.99805 4.30531 2.2755 4.77402 2.80249 5.18718C3.32948 5.60033 4.08742 5.94336 5.00009 6.18176C5.9123 6.42025 6.94707 6.5458 8.00039 6.54578C9.05371 6.54575 10.0885 6.42016 11.0006 6.18163C11.9128 5.94309 12.6702 5.60002 13.1967 5.1869Z', fill: 'none', stroke: 'currentColor' }),
        React.createElement('path', { d: 'M2 3.80371V11.7848', fill: 'none', stroke: 'currentColor' }),
        React.createElement('path', { d: 'M14 3.80371V11.7848', fill: 'none', stroke: 'currentColor' }),
        React.createElement('path', { d: 'M2 7.81396C2 8.60524 2.63214 9.36411 3.75736 9.92363C4.88258 10.4832 6.4087 10.7975 8 10.7975C9.5913 10.7975 11.1174 10.4832 12.2426 9.92363C13.3679 9.36411 14 8.60524 14 7.81396', fill: 'none', stroke: 'currentColor' }),
        React.createElement('path', { d: 'M2 11.7847C2 12.6081 2.63214 13.3977 3.75736 13.98C4.88258 14.5622 6.4087 14.8893 8 14.8893C9.5913 14.8893 11.1174 14.5622 12.2426 13.98C13.3679 13.3977 14 12.6081 14 11.7847', fill: 'none', stroke: 'currentColor' })) })
    }

    /** 展开/收起箭头（官方 chevron 路径，展开时用 CSS 旋转 180°）。 */
    function IconChevronDown({ size = 14 }) {
      return Icon({ size, children: React.createElement('path', {
        d: 'M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6',
        stroke: 'currentColor',
      }) })
    }

    // ------------------------------------------------------------------ Markdown
    //
    // 轻量 GFM 子集：围栏代码、行内代码、粗体/斜体、链接（按文本渲染）、
    // 标题、有序/无序列表、引用。纯函数、不依赖 React，由 selftest.cjs 直接测。
    /* @btw-markdown:start */
    const INLINE_PATTERN = /(`+)([\s\S]*?)\1|\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\*([^*\n]+?)\*|_([^_\n]+?)_/g

    /**
     * 拆一行内的行内标记。
     * @param source - 原始文本。
     * @returns 行内片段数组：text / code / strong / em / link。
     */
    function parseInline(source) {
      const text = String(source)
      const spans = []
      const pattern = new RegExp(INLINE_PATTERN.source, 'g')
      let index = 0
      let match
      while ((match = pattern.exec(text)) !== null) {
        if (match.index > index) spans.push({ type: 'text', text: text.slice(index, match.index) })
        if (match[2] !== undefined) spans.push({ type: 'code', text: match[2] })
        else if (match[4] !== undefined) spans.push({ type: 'link', text: match[3] === '' ? match[4] : match[3], href: match[4] })
        else if (match[5] !== undefined) spans.push({ type: 'strong', text: match[5] })
        else if (match[6] !== undefined) spans.push({ type: 'strong', text: match[6] })
        else if (match[7] !== undefined) spans.push({ type: 'em', text: match[7] })
        else if (match[8] !== undefined) spans.push({ type: 'em', text: match[8] })
        index = pattern.lastIndex
      }
      if (index < text.length) spans.push({ type: 'text', text: text.slice(index) })
      return spans.length > 0 ? spans : [{ type: 'text', text }]
    }

    /**
     * 把 Markdown 切成块。未闭合的围栏按代码块收尾，方便流式渲染。
     * @param source - 原始 Markdown。
     * @returns 块数组：code / heading / list / quote / paragraph。
     */
    function parseMarkdown(source) {
      const lines = String(source).split(/\r?\n/)
      const blocks = []
      let paragraph = []
      let list = null
      let quote = null
      let fence = null

      const flushParagraph = () => {
        if (paragraph.length === 0) return
        blocks.push({ type: 'paragraph', spans: parseInline(paragraph.join('\n')) })
        paragraph = []
      }
      const flushList = () => {
        if (list === null) return
        blocks.push(list)
        list = null
      }
      const flushQuote = () => {
        if (quote === null) return
        blocks.push({ type: 'quote', spans: parseInline(quote.join('\n')) })
        quote = null
      }
      const flushAll = () => { flushParagraph(); flushList(); flushQuote() }

      for (const line of lines) {
        if (fence !== null) {
          if (new RegExp('^\\s*' + fence.char + '{3,}\\s*$').test(line)) {
            blocks.push({ type: 'code', lang: fence.lang, text: fence.lines.join('\n') })
            fence = null
          } else {
            fence.lines.push(line)
          }
          continue
        }

        const fenceStart = /^\s*(`{3,}|~{3,})\s*([\w#+.-]*)\s*$/.exec(line)
        if (fenceStart !== null) {
          flushAll()
          fence = { char: fenceStart[1][0], lang: fenceStart[2] === undefined ? '' : fenceStart[2], lines: [] }
          continue
        }

        if (/^\s*$/.test(line)) { flushAll(); continue }

        const heading = /^(#{1,6})\s+(.*)$/.exec(line)
        if (heading !== null) {
          flushAll()
          blocks.push({ type: 'heading', level: heading[1].length, spans: parseInline(heading[2].trim()) })
          continue
        }

        const quoted = /^\s*>\s?(.*)$/.exec(line)
        if (quoted !== null) {
          flushParagraph(); flushList()
          if (quote === null) quote = []
          quote.push(quoted[1])
          continue
        }

        const item = /^\s*([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(line)
        if (item !== null) {
          flushParagraph(); flushQuote()
          const ordered = /^\d/.test(item[1])
          if (list === null || list.ordered !== ordered) {
            flushList()
            list = { type: 'list', ordered, items: [] }
          }
          list.items.push(parseInline(item[2]))
          continue
        }

        flushList(); flushQuote()
        paragraph.push(line)
      }

      if (fence !== null) blocks.push({ type: 'code', lang: fence.lang, text: fence.lines.join('\n') })
      flushAll()
      return blocks
    }
    /* @btw-markdown:end */

    // ------------------------------------------------------------------ 工具调用文本清理
    //
    // 旁支提问没有工具，但模型有时仍会把工具调用写成文本（DeepSeek 的
    // `<｜｜DSML｜｜ calls>…` 标记、或通用 `<tool_call>…`）。流式阶段就要清掉：
    // 未闭合的开标记一直吃到结尾，否则用户会看到半截标记越滚越长。
    /* @btw-sanitize:start */
    /** 任何"工具调用标记"的开或闭标签（DSMlish 或通用 <tool_call> 家族）。 */
    const TOOL_TAG = /<(?:\|{1,2}|｜{1,2})?DSML(?:\|{1,2}|｜{1,2})?[^>]*>|<\/(?:\|{1,2}|｜{1,2})?DSML(?:\|{1,2}|｜{1,2})?[^>]*>|<tool_call>|<tool_calls>|<function_call>|<\/tool_call>|<\/tool_calls>|<\/function_call>/gi

    /**
     * 剥掉写成文本的工具调用标记。
     *
     * 单遍深度计数，而不是"开标记 + 最近的闭标记"：后者遇到嵌套或名字不配对的
     * 标记会落下孤立闭标记（`</｜｜DSML｜｜ invoke>` 这种会留在屏幕上）。
     * 深度回到 0 之前的内容一律不输出；深度为 0 时出现的闭标记当孤立标记丢掉。
     *
     * 收尾时仍处于未闭合状态（模型输出本身就不配对）：
     *  - `streaming` 为真：截断到那个开标记之前——正在写的调用内部不该给用户看；
     *  - 已完结：把没配对的标记当孤立标签丢掉，保留其后的正文（否则会白掉一段结尾）。
     * @param source - 模型输出。
     * @param streaming - 是否仍在流式生成中。
     * @returns 清理后的文本，以及是否剥掉过东西（调用方据此补一句"未执行"）。
     */
    function sanitizeAnswer(source, streaming) {
      const text = String(source)
      let out = ''
      let depth = 0
      let last = 0
      let regionStart = 0
      let stripped = false
      const pattern = new RegExp(TOOL_TAG.source, 'gi')
      let match
      while ((match = pattern.exec(text)) !== null) {
        const closing = match[0].charAt(1) === '/'
        if (depth === 0) {
          // 深度 0：前面的正文留下；开标记开启一个新区域，孤立的闭标记直接丢掉
          out += text.slice(last, match.index)
          stripped = true
          if (!closing) {
            depth = 1
            regionStart = match.index
          }
          last = match.index + match[0].length
          continue
        }
        // 区域内部：内容整段丢弃，只数深度
        stripped = true
        depth += closing ? -1 : 1
        last = match.index + match[0].length
      }

      if (depth > 0) {
        if (streaming === true) return { text: tidy(out), stripped: true }
        const tail = text.slice(regionStart).replace(new RegExp(TOOL_TAG.source, 'gi'), '')
        return { text: tidy(out + tail), stripped: true }
      }
      if (!stripped) return { text, stripped: false }
      out += text.slice(last)
      return { text: tidy(out), stripped: true }
    }

    /** 剥完后收一下空白。 */
    function tidy(text) {
      return text.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+$/gm, '').trim()
    }
    /* @btw-sanitize:end */

    // ------------------------------------------------------------------ 思考行摘要
    //
    // 与主会话的思考行同一套摘要规则：流式时取"最后一个已完成段落"的首行，
    // 结束后取首行；渲染前去掉 `**` 标记。纯函数，由 selftest.cjs 直接测。
    /* @btw-reasoning:start */
    /** 取文本第一行。 */
    function firstLine(text) {
      const value = String(text)
      const cut = value.indexOf('\n')
      return (cut === -1 ? value : value.slice(0, cut)).trim()
    }

    /**
     * 折叠状态下显示的那一行摘要。
     * @param text - 完整或流式中的思考文本。
     * @param running - 是否仍在生成。
     * @returns 摘要文本（可能为空）。
     */
    function reasoningSummary(text, running) {
      const value = String(text)
      if (!running) return firstLine(value).replaceAll('**', '')
      const paragraphs = value.split(/\n\s*\n/).filter((part) => part.trim() !== '')
      const complete = /\n\s*\n\s*$/.test(value) ? paragraphs : paragraphs.slice(0, -1)
      const source = complete.length > 0 ? complete[complete.length - 1] : value
      return firstLine(source).replaceAll('**', '')
    }
    /* @btw-reasoning:end */

    /** 行内片段 → React 节点。 */
    function renderSpans(spans, keyPrefix) {
      return spans.map((span, index) => {
        const key = keyPrefix + ':' + index
        if (span.type === 'code') return React.createElement('code', { key }, span.text)
        if (span.type === 'strong') return React.createElement('strong', { key }, span.text)
        if (span.type === 'em') return React.createElement('em', { key }, span.text)
        if (span.type === 'link') return React.createElement('a', { title: span.href, key }, span.text)
        return React.createElement(React.Fragment, { key }, span.text)
      })
    }

    /** 代码卡：与主会话一样带语言标签与复制按钮。 */
    function CodeCard(props) {
      const [copied, setCopied] = React.useState(false)
      const t = props.t
      const copy = () => {
        const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
        if (clipboard === undefined || typeof clipboard.writeText !== 'function') return
        clipboard.writeText(props.text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }, () => { /* clipboard denial needs no UI: the button just does nothing */ })
      }
      return React.createElement('div', { className: 'dshbtw-code' },
        React.createElement('div', { className: 'dshbtw-codeHead' },
          React.createElement('span', { className: 'dshbtw-codeLang' }, props.lang === '' ? 'text' : props.lang),
          React.createElement('button', {
            className: 'dshbtw-codeCopy',
            type: 'button',
            title: copied ? t('action.copied') : t('action.copy'),
            'aria-label': copied ? t('action.copied') : t('action.copy'),
            onClick: copy,
          }, copied ? React.createElement(IconCheck, { size: 14 }) : React.createElement(IconCopy, { size: 14 }))),
        React.createElement('pre', { className: 'dshbtw-codePre' }, props.text))
    }

    /* @btw-stats:start */
    /**
     * 占位符插值：插件自己的 locale 座位是纯查表，不做 `{name}` 替换
     * （主会话用的是框架的 `t(key, params)`），所以这里自己补一层。
     */
    function interpolate(text, params) {
      let out = String(text)
      for (const key of Object.keys(params || {})) {
        out = out.split(`{${key}}`).join(String(params[key]))
      }
      return out
    }

    /**
     * 紧凑 token 数，照 ui-chat 的 token-format.js：517 / 12.2K / 517K / 9.9M。
     * 缩放值 ≥100 取整，否则保留一位小数；后缀走 locale（number.thousand/million）。
     */
    function formatTokens(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '0'
      const scaled = (candidate) => (candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10))
      if (value < 1e3) return String(Math.round(value))
      if (value < 1e6) return `${scaled(value / 1e3)}K`
      return `${scaled(value / 1e6)}M`
    }

    /**
     * 时间文案，照 ui-chat 的 formatMessageClock：今天只给 `HH:MM`；
     * 同年更早给 `clock.md` 模板 + 时间；跨年给 `clock.ymd` 模板 + 时间。
     */
    function formatClock(ms, now, t) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return ''
      const date = new Date(ms)
      const reference = new Date(typeof now === 'number' ? now : Date.now())
      const pad2 = (value) => String(value).padStart(2, '0')
      const clock = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
      const sameDay = date.getFullYear() === reference.getFullYear()
        && date.getMonth() === reference.getMonth()
        && date.getDate() === reference.getDate()
      if (sameDay) return clock
      const params = { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() }
      const template = date.getFullYear() === reference.getFullYear() ? t('clock.md') : t('clock.ymd')
      return `${interpolate(template, params)} ${clock}`
    }

    /** 本轮总用量：优先 totalTokens，否则把各桶加总。 */
    function totalTokens(usage) {
      if (usage === undefined || usage === null) return undefined
      if (typeof usage.totalTokens === 'number') return usage.totalTokens
      const parts = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
      let sum = 0
      let seen = false
      for (const key of parts) {
        if (typeof usage[key] === 'number') {
          sum += usage[key]
          seen = true
        }
      }
      return seen ? sum : undefined
    }
    /* @btw-stats:end */

    /**
     * 用户提问下的操作行，照主会话 `clock === 'start'` 的形态：时间在左
     * （`.timeStart`：secondary 字号、tertiary、`padding-right: 12px`），复制在右；
     * 整行靠右（父级 `.dshbtw-userRow` 的 align-items: flex-end）。
     */
    function UserActions(props) {
      const [copied, setCopied] = React.useState(false)
      const t = props.t
      const copy = () => {
        const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
        if (clipboard === undefined || typeof clipboard.writeText !== 'function') return
        clipboard.writeText(props.text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }, () => { /* clipboard denial needs no UI: the button just does nothing */ })
      }
      const clock = formatClock(props.at, undefined, t)
      return React.createElement('div', { className: 'dshbtw-userActions', 'data-clock': 'start' },
        clock === '' ? null : React.createElement('span', { className: 'dshbtw-timeStart' }, clock),
        React.createElement('button', {
          className: 'dshbtw-action',
          type: 'button',
          title: copied ? t('action.copied') : t('action.copy'),
          'aria-label': copied ? t('action.copied') : t('action.copy'),
          onClick: copy,
        }, copied ? React.createElement(IconCheck, { size: 15 }) : React.createElement(IconCopy, { size: 15 })))
    }

    /**
     * 回答下的操作行，元素与顺序照主会话 turn tail：
     * [复制][点赞][点踩] + `.endInfo`（「🛢 用量 X tok」+ 时间）。
     *
     * 点赞/点踩是**本地假状态**（互斥、只切换图标；面板里的回答不是会话消息，
     * 没有可挂靠的反馈对象）。
     */
    function AnswerActions(props) {
      const [copied, setCopied] = React.useState(false)
      const [vote, setVote] = React.useState(0)
      const t = props.t
      const stats = props.stats
      const copy = () => {
        const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
        if (clipboard === undefined || typeof clipboard.writeText !== 'function') return
        clipboard.writeText(props.text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }, () => { /* clipboard denial needs no UI: the button just does nothing */ })
      }
      const voteButton = (kind, icon) => React.createElement('button', {
        className: 'dshbtw-action',
        type: 'button',
        'data-on': vote === kind ? '1' : undefined,
        'aria-pressed': vote === kind,
        title: t(kind === 1 ? 'action.like' : 'action.dislike'),
        'aria-label': t(kind === 1 ? 'action.like' : 'action.dislike'),
        onClick: () => setVote((value) => (value === kind ? 0 : kind)),
      }, icon)
      const total = stats === undefined || stats === null ? undefined : totalTokens(stats.usage)
      const clock = stats === undefined || stats === null ? '' : formatClock(stats.endedAt, undefined, t)
      const endInfo = total === undefined && clock === ''
        ? null
        : React.createElement('span', { className: 'dshbtw-endInfo' },
          total === undefined
            ? null
            : React.createElement('span', { className: 'dshbtw-usage', title: t('stats.usageTitle') },
              React.createElement(IconDatabase, { size: 15 }),
              React.createElement('span', { className: 'dshbtw-usageLabel' },
                interpolate(t('stats.consumed'), {
                  total: interpolate(t('stats.count'), { count: formatTokens(total) }),
                }))),
          clock === '' ? null : React.createElement('span', { className: 'dshbtw-time' }, clock))
      return React.createElement('div', { className: 'dshbtw-actions dshbtw-answerActions' },
        React.createElement('button', {
          className: 'dshbtw-action',
          type: 'button',
          title: copied ? t('action.copied') : t('action.copy'),
          'aria-label': copied ? t('action.copied') : t('action.copy'),
          onClick: copy,
        }, copied ? React.createElement(IconCheck, { size: 15 }) : React.createElement(IconCopy, { size: 15 })),
        voteButton(1, React.createElement(IconLike, { size: 15, filled: vote === 1 })),
        voteButton(-1, React.createElement(IconDislike, { size: 15, filled: vote === -1 })),
        endInfo)
    }

    /** Markdown 块 → React 节点。语义标签 + `.dshbtw-md` 的后代规则，样式与官方同一套值。 */
    function renderBlocks(blocks, t) {
      return blocks.map((block, index) => {
        const key = 'block:' + index
        if (block.type === 'code') return React.createElement(CodeCard, { key, text: block.text, lang: block.lang, t })
        if (block.type === 'heading') {
          const tag = 'h' + Math.min(6, Math.max(1, block.level))
          return React.createElement(tag, { key }, renderSpans(block.spans, key))
        }
        if (block.type === 'list') {
          const items = block.items.map((spans, itemIndex) => React.createElement('li', { key: key + ':' + itemIndex },
            renderSpans(spans, key + ':' + itemIndex)))
          return React.createElement(block.ordered ? 'ol' : 'ul', { key }, items)
        }
        if (block.type === 'quote') {
          return React.createElement('blockquote', { key }, renderSpans(block.spans, key))
        }
        return React.createElement('p', { key }, renderSpans(block.spans, key))
      })
    }

    /** 一段 Markdown → 主会话同款容器：body 变体给回答，compact 变体给思考。 */
    function markdown(text, compact, t) {
      return React.createElement('div', {
        className: 'dshbtw-md',
        'data-compact': compact === true ? '1' : undefined,
      }, renderBlocks(parseMarkdown(text), t))
    }

    /**
     * 渲染兜底：面板里任何一处渲染抛错，都不该让整个 tab 变白板。
     * 出错时只显示一行可读的错误；内容再次变化（resetKey 变）就自动重试。
     */
    class BodyBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidUpdate(previous) {
        if (this.state.error !== null && previous.resetKey !== this.props.resetKey) this.setState({ error: null })
      }

      render() {
        if (this.state.error === null) return this.props.children
        const message = this.state.error !== null && this.state.error.message !== undefined
          ? String(this.state.error.message)
          : String(this.state.error)
        return React.createElement('div', { className: 'dshbtw-root' },
          React.createElement('div', { className: 'dshbtw-error' }, (this.props.t === undefined ? '' : this.props.t('error.render')) + message))
      }
    }

    /**
     * 一轮问答：提问行（时间 + 复制）+ 思考行 + 回答行（操作行 + 用量 + 时间）。
     *
     * memo（自定义比较：忽略 t 的身份，只比 item/streaming/isLast）：流式时每来一个
     * delta 只重渲染 live 这一轮，历史轮次不再跟着重解析 Markdown——长线程下这是
     * 「卡住」的主要来源。
     */
    const Turn = React.memo(function Turn(props) {
      const { item, streaming, isLast, t } = props
      const answer = sanitizeAnswer(item.answer, streaming === true)
      return React.createElement('div', {
        className: 'dshbtw-turn',
        'data-last': isLast === true ? '1' : undefined,
      },
      React.createElement('div', { className: 'dshbtw-userRow' },
        React.createElement('div', { className: 'dshbtw-bubble' }, item.question),
        React.createElement(UserActions, {
          text: item.question,
          at: item.askedAt !== undefined ? item.askedAt : (item.stats === undefined || item.stats === null ? undefined : item.stats.startedAt),
          t,
        })),
      item.reasoning === undefined || item.reasoning === ''
        ? null
        : React.createElement(ReasoningRow, {
          text: item.reasoning,
          running: streaming === true,
          t,
          onToggle: props.onToggle,
        }),
      answer.text === ''
        ? null
        : React.createElement(React.Fragment, null,
          React.createElement('div', { className: 'dshbtw-answer' }, markdown(answer.text, false, t)),
          React.createElement(AnswerActions, { text: answer.text, stats: item.stats, t })))
    }, (previous, next) => previous.item === next.item
      && previous.streaming === next.streaming
      && previous.isLast === next.isLast
      && previous.onToggle === next.onToggle)

    /** 思考行：默认折叠成一行（图标 + 标题 + 末段首行摘要），点一下展开全文。 */
    function ReasoningRow(props) {
      const [open, setOpen] = React.useState(false)
      const summary = reasoningSummary(props.text, props.running === true)
      return React.createElement('div', {
        className: 'dshbtw-think',
        'data-expanded': open || undefined,
      },
      React.createElement('button', {
        className: 'dshbtw-thinkRow',
        type: 'button',
        'aria-expanded': open,
        onClick: () => {
          // 展开/收起是"我要读这一段"的意图：解除跟随尾部，否则流式继续把展开的
          // 正文顶出视口（用户看到的就是"思考过程不停往上滚、翻不回去"）。
          if (typeof props.onToggle === 'function') props.onToggle()
          setOpen((value) => !value)
        },
      },
      React.createElement('span', { className: 'dshbtw-thinkLeading' },
        React.createElement('span', { className: 'dshbtw-thinkIcon' }, React.createElement(IconThink, {})),
        React.createElement('span', { className: 'dshbtw-thinkChevron' }, React.createElement(IconChevronDown, {}))),
      React.createElement('span', { className: 'dshbtw-thinkTitle' }, props.t('think.title')),
      summary === ''
        ? null
        : React.createElement(React.Fragment, null,
          React.createElement('span', { className: 'dshbtw-thinkSep', 'aria-hidden': true }),
          React.createElement('span', {
            className: 'dshbtw-thinkSummary',
            'data-streaming': props.running === true ? '1' : undefined,
          }, React.createElement('span', { className: 'dshbtw-thinkSummaryText' }, summary)))),
      open
        ? React.createElement('div', { className: 'dshbtw-thinkBody' }, markdown(props.text, true, props.t))
        : null)
    }

    // ------------------------------------------------------------------ 开始页卡片插画
    //
    // 36×36、固定配色：与官方 GuideArtworkBrowser / GuideArtworkFiles 同一规格。
    function Artwork({ size = 36, className }) {
      return React.createElement('svg', {
        width: size, height: size, viewBox: '0 0 36 36', fill: 'none', className,
        xmlns: 'http://www.w3.org/2000/svg',
      },
      React.createElement('rect', { x: 4.75, y: 6.75, width: 26.5, height: 20, rx: 6, fill: '#EAF1FE', stroke: '#4C7DF0', strokeWidth: 1.5 }),
      React.createElement('path', { d: 'M13.5 26.75 L13.5 31.5 L19.5 26.75 Z', fill: '#EAF1FE', stroke: '#4C7DF0', strokeWidth: 1.5, strokeLinejoin: 'round' }),
      React.createElement('path', { d: 'M14.6 13.4 C14.6 11.3 16.2 10.1 17.9 10.1 C19.7 10.1 21.2 11.2 21.2 13.2 C21.2 15.4 18.1 15.8 18.1 18', stroke: '#1F3A8A', strokeWidth: 2.1, strokeLinecap: 'round' }),
      React.createElement('circle', { cx: 18.1, cy: 21.4, r: 1.3, fill: '#1F3A8A' }))
    }

    // ------------------------------------------------------------------ 正文
    function useT(props) {
      const t = props && typeof props.t === 'function' ? props.t : undefined
      const dict = props && props.locale === 'en' ? en : zh
      return (key) => {
        if (t !== undefined) {
          const value = t(key)
          if (typeof value === 'string' && value !== '' && value !== key) return value
        }
        return dict[key] !== undefined ? dict[key] : key
      }
    }

    function BtwBody(props) {
      const t = useT(props)
      let sessionId = props && typeof props.sessionId === 'string' ? props.sessionId : undefined
      if (sessionId === undefined && props && typeof props.useTabInfo === 'function') {
        try {
          const info = props.useTabInfo()
          const tab = info && info.tab
          if (tab && typeof tab.sessionId === 'string') sessionId = tab.sessionId
        } catch (error) { /* tab info is optional, ignore */ }
      }

      const [items, setItems] = React.useState([])
      const [draft, setDraft] = React.useState('')
      const [live, setLive] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const scrollRef = React.useRef(null)
      const followRef = React.useRef(true)
      /** 展开思考行 = 用户要读这一段，解除跟随尾部（稳定引用，避免击穿 Turn 的 memo）。 */
      const unpin = React.useCallback(() => { followRef.current = false }, [])
      const inputRef = React.useRef(null)
      const abortRef = React.useRef(null)

      React.useEffect(() => { ensureCss() }, [])

      // 宿主内存里的线程才是真相：重挂载后从这里恢复。
      // 快照里的用量/时间是平铺字段（usage/startedAt/endedAt），实时流里是 stats 包装，
      // 这里统一成 stats，否则重挂载后那行用量+时间会消失。
      React.useEffect(() => {
        if (sessionId === undefined) return
        let cancelled = false
        fetch('/btw-api/thread?sessionId=' + encodeURIComponent(sessionId), { cache: 'no-store' })
          .then((res) => (res.ok ? res.json() : { items: [] }))
          .then((data) => {
            if (cancelled || data === null || data === undefined || !Array.isArray(data.items)) return
            const mapped = data.items.map((item) => {
              const stats = item.stats !== undefined
                ? item.stats
                : (item.usage === undefined && item.startedAt === undefined
                  ? undefined
                  : { usage: item.usage, startedAt: item.startedAt, endedAt: item.endedAt })
              const askedAt = typeof item.askedAt === 'number'
                ? item.askedAt
                : (stats === undefined ? undefined : stats.startedAt)
              return { question: item.question, answer: item.answer, reasoning: item.reasoning, stats, askedAt }
            })
            // 快照为空而本地已有内容时不清屏：宿主刚被重载/线程已被回收时，
            // 一次空快照会把看得见的整段对话抹掉。
            setItems((previous) => (mapped.length === 0 && previous.length > 0 ? previous : mapped))
          })
          .catch(() => { /* an empty thread is a fine fallback */ })
        return () => { cancelled = true }
      }, [sessionId])

      // 跟随尾部：只在"用户本来就在底部附近"时才自动滚。流式每来一个 delta 就强制
      // `scrollTop = scrollHeight` 会把正在往上翻的人一直拽回底部（展开思考行时尤其明显），
      // 主会话也是同一套语义（data-chat-following-tail）。
      React.useEffect(() => {
        const node = scrollRef.current
        if (node === null || !followRef.current) return
        node.scrollTop = node.scrollHeight
      }, [items, live])

      const onScroll = () => {
        const node = scrollRef.current
        if (node === null) return
        followRef.current = node.scrollHeight - node.scrollTop - node.clientHeight <= 48
      }

      const stop = React.useCallback(() => {
        const controller = abortRef.current
        if (controller !== null) controller.abort()
        if (sessionId !== undefined) {
          fetch('/btw-api/stop', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId }),
          }).catch(() => { /* the abort is already local; the host call is best-effort */ })
        }
      }, [sessionId])

      const ask = React.useCallback(async () => {
        const question = draft.trim()
        if (question === '' || busy || sessionId === undefined) return
        setDraft('')
        setError(null)
        setBusy(true)
        const askedAt = Date.now()
        // 新提问把视图拉回尾部跟着走（用户此刻的意图就是看这一问）
        followRef.current = true
        setLive({ question, text: '', reasoning: '', askedAt })
        const controller = new AbortController()
        abortRef.current = controller
        let answer = ''
        let reasoning = ''
        let failure
        let stats = null
        try {
          const res = await fetch('/btw-api/ask', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, question }),
            signal: controller.signal,
          })
          if (!res.ok || res.body === null) {
            const detail = await res.text().catch(() => '')
            throw new Error('HTTP ' + res.status + (detail === '' ? '' : ' ' + detail))
          }
          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          for (;;) {
            const step = await reader.read()
            if (step.done) break
            buffer += decoder.decode(step.value, { stream: true })
            let cut = buffer.indexOf('\n\n')
            while (cut >= 0) {
              const frame = buffer.slice(0, cut)
              buffer = buffer.slice(cut + 2)
              const line = frame.split('\n').find((candidate) => candidate.startsWith('data:'))
              if (line !== undefined) {
                let event
                try {
                  event = JSON.parse(line.slice(5).trim())
                } catch (parseError) {
                  event = undefined
                }
                if (event !== undefined && event.type === 'delta') {
                  answer += event.text
                  setLive({ question, text: answer, reasoning, askedAt })
                } else if (event !== undefined && event.type === 'reasoning') {
                  reasoning += event.text
                  setLive({ question, text: answer, reasoning, askedAt })
                } else if (event !== undefined && event.type === 'usage') {
                  stats = { usage: event.usage, startedAt: event.startedAt, endedAt: event.endedAt }
                  setLive({ question, text: answer, reasoning, stats, askedAt })
                } else if (event !== undefined && event.type === 'error') {
                  failure = event.message
                }
              }
              cut = buffer.indexOf('\n\n')
            }
          }
        } catch (caught) {
          if (caught && caught.name !== 'AbortError') failure = String(caught.message || caught)
        } finally {
          abortRef.current = null
          setBusy(false)
          setLive(null)
          if (failure !== undefined) setError(failure)
          // 只要产生过任何内容（正文或思考）就把这一轮留下。
          // 旧条件只看正文：模型只出思考、没出正文（或中途失败/被停）时，这一轮会
          // setLive(null) 之后既不在 live 也不在 items —— 提问和思考过程整轮凭空消失。
          if (answer.trim().length > 0 || reasoning.trim().length > 0) {
            const clean = sanitizeAnswer(answer).text
            // 思考/用量一起留下，落定后思考行与用量行仍然在
            setItems((previous) => [...previous, { question, answer: clean, reasoning, stats, askedAt }].slice(-THREAD_LIMIT))
          }
          if (inputRef.current !== null) inputRef.current.focus()
        }
      }, [busy, draft, sessionId])

      const clear = React.useCallback(() => {
        setItems([])
        setError(null)
        if (sessionId !== undefined) {
          fetch('/btw-api/clear', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId }),
          }).catch(() => { /* clearing the local view is what the button promises */ })
        }
      }, [sessionId])

      const onKeyDown = (event) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault()
          void ask()
          return
        }
        if (event.key === 'Escape' && busy) {
          event.preventDefault()
          stop()
        }
      }

      const streaming = live === null
        ? null
        : React.createElement(Turn, {
          key: 'live',
          streaming: true,
          isLast: true,
          t,
          onToggle: unpin,
          item: {
            question: live.question,
            answer: live.text,
            reasoning: live.reasoning,
            stats: live.stats,
            askedAt: live.askedAt,
          },
        })
      const empty = items.length === 0 && live === null
        ? React.createElement('div', { className: 'dshbtw-empty' }, t('empty.hint'))
        : null

      // 渲染兜底：任何一处渲染抛错都只显示一行错误，不让整个 tab 变白板；
      // resetKey 随内容变化，出错后下一次内容更新会自动重试。
      const resetKey = `${items.length}:${live === null ? '-' : `${live.text.length}/${live.reasoning.length}`}:${draft === '' ? 0 : 1}`
      return React.createElement('div', { className: 'dshbtw-root' },
        React.createElement(BodyBoundary, { resetKey, t },
        React.createElement('div', { className: 'dshbtw-scroll', ref: scrollRef, onScroll },
          empty,
          items.map((item, index) => React.createElement(Turn, {
            key: index,
            item,
            streaming: false,
            isLast: live === null && index === items.length - 1,
            t,
            onToggle: unpin,
          })),
          streaming),
        error === null ? null : React.createElement('div', { className: 'dshbtw-error' }, error),
        React.createElement('div', { className: 'dshbtw-composer' },
          React.createElement('div', { className: 'dshbtw-card' },
            React.createElement('textarea', {
              className: 'dshbtw-input',
              ref: inputRef,
              rows: 1,
              value: draft,
              placeholder: t('composer.placeholder'),
              disabled: sessionId === undefined,
              onChange: (event) => setDraft(event.target.value),
              onKeyDown,
            }),
            React.createElement('div', { className: 'dshbtw-row' },
              sessionId === undefined
                ? React.createElement('span', { className: 'dshbtw-note' }, t('error.noSession'))
                : null,
              React.createElement('span', { className: 'dshbtw-trailing' },
                busy ? React.createElement('span', { className: 'dshbtw-spin' }) : null,
                React.createElement('button', {
                  className: 'dshbtw-ghost',
                  type: 'button',
                  title: t('action.clear.title'),
                  'aria-label': t('action.clear'),
                  disabled: items.length === 0 && live === null,
                  onClick: clear,
                }, React.createElement(IconTrash, {})),
                busy
                  ? React.createElement('button', {
                    className: 'dshbtw-primary',
                    type: 'button',
                    'data-stop': '1',
                    title: t('action.stop'),
                    'aria-label': t('action.stop'),
                    onClick: stop,
                  }, React.createElement(IconStop, {}))
                  : React.createElement('button', {
                    className: 'dshbtw-primary',
                    type: 'button',
                    title: t('action.send'),
                    'aria-label': t('action.send'),
                    disabled: draft.trim() === '' || sessionId === undefined,
                    onClick: () => { void ask() },
                  }, React.createElement(IconSend, {}))))))))
    }

    // ------------------------------------------------------------------ 插件
    const inject = ['slots', 'locale', 'sidebarRightTabs']

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-btw: copy')

      // tab 类型 + 开始页卡片。kind 新开一个，不与内置的 files/browser/terminal 冲突。
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: ID,
        kind: KIND,
        priority: 'builtin',
        keepMounted: true,
        title: () => t('type.label'),
        guide: [{
          id: 'ask',
          order: 40,
          title: () => t('guide.title'),
          description: () => t('guide.description'),
          icon: Artwork,
        }],
      }), 'dsh-btw: type')

      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: ID,
        locale: NS,
        inject: (sessionId) => ({ sessionId }),
      }, BtwBody)), 'dsh-btw: body')
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
