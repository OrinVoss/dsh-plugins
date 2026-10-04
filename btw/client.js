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
      'action.liked': '已点赞',
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
      'action.liked': 'Liked',
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
      '.dshbtw-userRow{display:flex;flex-direction:column;align-items:flex-end;margin-bottom:12px}',
      '.dshbtw-bubble{max-width:min(calc(var(--dsh-chat-content-width,748px) * .702), 82%);box-sizing:border-box;padding:10px 16px;border-radius:var(--dsw-radius-xl,16px);background:var(--dsw-specific-bubble);color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;font-size:var(--dsh-content-font-size,14px);line-height:calc(22px + var(--dsh-content-font-delta,0px))}',
      '.dshbtw-answer{min-width:0}',

      // 回答下的操作行：照 primitives 的 MessageIconActions.module.css
      // （28px 方钮、15px 图标、gap 8、hover 底色）+ AssistantMarkdown 的
      // .actions{margin-top:16px;margin-left:-6px}，并按主会话那样 hover 才显形。
      '.dshbtw-actions{margin-top:16px;margin-left:-6px;height:calc(28px + var(--dsh-content-font-delta,0px));display:flex;align-items:center;gap:8px}',
      '.dshbtw-action{display:inline-flex;justify-content:center;align-items:center;width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));padding:6px;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}',
      '.dshbtw-action svg{width:calc(15px + var(--dsh-content-font-delta,0px));height:calc(15px + var(--dsh-content-font-delta,0px))}',
      '.dshbtw-action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '.dshbtw-action[data-on="1"]{color:var(--dsw-alias-state-business-primary)}',
      '@media (hover:hover){.dshbtw-turn .dshbtw-actions{opacity:0;transition:opacity 80ms}.dshbtw-turn:hover .dshbtw-actions,.dshbtw-turn:focus-within .dshbtw-actions{opacity:1}}',

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

    /**
     * 回答下的操作行：复制 + 点赞。
     * 点赞是**本地假状态**（只切换图标，不提交任何反馈、不写任何存储）——面板里的回答
     * 不是会话消息，没有可挂靠的反馈对象。
     */
    function AnswerActions(props) {
      const [copied, setCopied] = React.useState(false)
      const [liked, setLiked] = React.useState(false)
      const t = props.t
      const copy = () => {
        const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
        if (clipboard === undefined || typeof clipboard.writeText !== 'function') return
        clipboard.writeText(props.text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }, () => { /* clipboard denial needs no UI: the button just does nothing */ })
      }
      return React.createElement('div', { className: 'dshbtw-actions' },
        React.createElement('button', {
          className: 'dshbtw-action',
          type: 'button',
          title: copied ? t('action.copied') : t('action.copy'),
          'aria-label': copied ? t('action.copied') : t('action.copy'),
          onClick: copy,
        }, copied ? React.createElement(IconCheck, { size: 15 }) : React.createElement(IconCopy, { size: 15 })),
        React.createElement('button', {
          className: 'dshbtw-action',
          type: 'button',
          'data-on': liked ? '1' : undefined,
          'aria-pressed': liked,
          title: liked ? t('action.liked') : t('action.like'),
          'aria-label': liked ? t('action.liked') : t('action.like'),
          onClick: () => setLiked((value) => !value),
        }, React.createElement(IconLike, { size: 15, filled: liked })))
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
        onClick: () => setOpen((value) => !value),
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
      const inputRef = React.useRef(null)
      const abortRef = React.useRef(null)

      React.useEffect(() => { ensureCss() }, [])

      // 宿主内存里的线程才是真相：重挂载后从这里恢复。
      React.useEffect(() => {
        if (sessionId === undefined) return
        let cancelled = false
        fetch('/btw-api/thread?sessionId=' + encodeURIComponent(sessionId), { cache: 'no-store' })
          .then((res) => (res.ok ? res.json() : { items: [] }))
          .then((data) => { if (!cancelled && data && Array.isArray(data.items)) setItems(data.items) })
          .catch(() => { /* an empty thread is a fine fallback */ })
        return () => { cancelled = true }
      }, [sessionId])

      React.useEffect(() => {
        const node = scrollRef.current
        if (node !== null) node.scrollTop = node.scrollHeight
      }, [items, live])

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
        setLive({ question, text: '', reasoning: '' })
        const controller = new AbortController()
        abortRef.current = controller
        let answer = ''
        let reasoning = ''
        let failure
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
                  setLive({ question, text: answer, reasoning })
                } else if (event !== undefined && event.type === 'reasoning') {
                  reasoning += event.text
                  setLive({ question, text: answer, reasoning })
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
          // 中断时保留已生成的部分：它已经看得见，扔掉反而奇怪。
          if (answer.trim().length > 0) {
            const clean = sanitizeAnswer(answer).text
            // 思考内容一起留下，落定后思考行仍然在（默认折叠）
            setItems((previous) => [...previous, { question, answer: clean, reasoning }].slice(-THREAD_LIMIT))
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

      const turnOf = (item, key, streaming) => {
        const answer = sanitizeAnswer(item.answer, streaming === true)
        return React.createElement('div', { className: 'dshbtw-turn', key },
          React.createElement('div', { className: 'dshbtw-userRow' },
            React.createElement('div', { className: 'dshbtw-bubble' }, item.question)),
          item.reasoning === undefined || item.reasoning === ''
            ? null
            : React.createElement(ReasoningRow, { text: item.reasoning, running: streaming === true, t }),
          answer.text === ''
            ? null
            : React.createElement(React.Fragment, null,
              React.createElement('div', { className: 'dshbtw-answer' }, markdown(answer.text, false, t)),
              React.createElement(AnswerActions, { text: answer.text, t })))
      }

      const streaming = live === null
        ? null
        : turnOf({ question: live.question, answer: live.text, reasoning: live.reasoning }, 'live')
      const empty = items.length === 0 && live === null
        ? React.createElement('div', { className: 'dshbtw-empty' }, t('empty.hint'))
        : null

      return React.createElement('div', { className: 'dshbtw-root' },
        React.createElement('div', { className: 'dshbtw-scroll', ref: scrollRef },
          empty,
          items.map((item, index) => turnOf(item, index)),
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
                  }, React.createElement(IconSend, {})))))))
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
