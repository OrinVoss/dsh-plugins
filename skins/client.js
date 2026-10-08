window.__ModuleLoader__.load({
  id: 'dsh-skins',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    let react = require('react')

    /* =====================================================================
     * dsh-skins — DSH Web GUI 皮肤机制
     *
     * 机制（三层，互不耦合）：
     *
     *   1. 皮肤声明  —— 一个皮肤 = 一份 palette（浅色 / 深色各一套「语义槽位」）
     *                     + 可选的 font（字体栈，连同字号简写一起换）
     *                     + 可选的 css（追加材质，如顶部描边、纸纹）。
     *   2. 槽位展开  —— SLOT_TOKENS 把语义槽位翻译成 --dsw-* 别名 token 层，
     *                     并对少数 token 用 color-mix 做派生。
     *   3. 运行时    —— SkinRuntime 用 ctx.theme.overrideTokens() 把整层叠加在
     *                     当前主题之上：内置的「浅色 / 深色 / 跟随系统」照旧生效，
     *                     皮肤只负责改配色，不接管偏好。
     *
     * 因此「新增一套皮肤」= 往 SKINS 里加一个对象，不需要碰运行时、UI 或样式表。
     *
     * 为什么走 overrideTokens 而不是 ctx.theme.register：
     *   register 出来的是一个 colorScheme 固定的完整主题，会顶掉用户选的
     *   light/dark/system；overrideTokens 是分层的，每个 token 带 { light, dark }
     *   一对值，用户切浅色深色时皮肤跟着换档，两套配色都在。
     * =================================================================== */

    /** body 上标记当前皮肤的属性，皮肤自带的 css 全部以它作前缀。 */
    const SKIN_ATTRIBUTE = 'data-dsh-skin'
    const STYLE_ATTRIBUTE = 'data-plugin-css'
    const STYLE_ID = 'dsh-skins'
    const STORAGE_KEY = 'dsh-skins:active'
    const OVERRIDE_SOURCE = 'dsh-skins'
    /**
     * 模块系统（dsh-client-modules）按 `data-plugin` 给 <style> 记账：装配某个包时，
     * 把当时还没有这个属性的标签统统认领给它（claimStyles），这个包被卸载或热更时
     * 再按属性整批 remove()（removeOwnedStyles）。官方包都在注入时就写上自己。
     *
     * 我们的标签是在 apply() 里注入的——晚于装配，所以必须是显式归属：否则会被
     * 下一个装配的包认领走，那个包一热更，皮肤材质 + 设置行样式就被连带删掉
     * （表现：皮肤方块退化成默认按钮，没有色点、没有选中态、每行按内容宽度排）。
     */
    const STYLE_OWNER_ATTRIBUTE = 'data-plugin'
    const PLUGIN_ID = 'dsh-skins'

    /* ---------------------------------------------------------------------
     * 1. 槽位 → 别名 token
     *
     * 左边是设计系统的别名 token（design-platform.css 的权威层），右边是皮肤
     * 作者要填的语义槽位。皮肤改配色只填槽位，token 名由这里统一维护。
     * ------------------------------------------------------------------- */
    const SLOT_TOKENS = {
      // 画布与表面
      '--dsw-alias-bg-base': 'canvas',
      '--dsw-alias-bg-layer-1': 'surface',
      '--dsw-alias-bg-layer-2': 'surfaceRaised',
      '--dsw-alias-bg-layer-3': 'surfaceSunken',
      '--dsw-alias-bg-overlay': 'overlay',
      '--dsw-alias-bg-document-preview': 'surfaceSunken',
      '--dsw-alias-bg-module-platform': 'selected',
      '--dsw-alias-bg-multi-select': 'selected',
      '--dsw-alias-bg-skeleton': 'skeleton',
      '--dsw-specific-sidebar-fill': 'sidebar',
      '--dsw-specific-sidebar-nav-item-active': 'selected',
      '--dsw-specific-sidebar-nav-item-active-accent': 'accentSoft',
      '--dsw-specific-sidebar-nav-item-hover': 'hoverSolid',
      '--dsw-specific-selector': 'surfaceSunken',
      '--dsw-specific-tip': 'surfaceSunken',
      '--dsw-specific-input-major': 'surfaceRaised',
      '--dsw-specific-login-input': 'surface',
      '--dsw-specific-bubble': 'bubble',
      '--dsw-specific-bubble-highlight': 'bubbleHi',

      // 文字
      '--dsw-alias-label-primary': 'textPrimary',
      '--dsw-alias-label-primary-dimmed': 'textPrimary',
      '--dsw-alias-label-primary-bluish': 'textPrimary',
      '--dsw-alias-label-primary-foreground': 'onAccent',
      '--dsw-alias-label-primary-inverted': 'onAccent',
      '--dsw-alias-label-secondary': 'textSecondary',
      '--dsw-alias-label-tertiary': 'textTertiary',
      '--dsw-alias-label-caption': 'textCaption',
      '--dsw-alias-label-dimmed': 'textCaption',
      '--dsw-alias-menu-icon': 'textPrimary',
      '--dsw-alias-link': 'link',

      // 边框
      '--dsw-alias-border-l1': 'borderSubtle',
      '--dsw-alias-border-l2': 'border',
      '--dsw-alias-border-l2-darkmode-thin': 'borderSubtle',
      '--dsw-alias-border-l3': 'borderStrong',
      '--dsw-alias-border-l4': 'borderHeavy',

      // 品牌与交互
      // brand-primary 是「品牌填充色」，brand-text / -invert 是「品牌色当文字用」，
      // 三者同源；onAccent 只服务于真正叠在品牌填充上的前景文字。
      '--dsw-alias-brand-primary': 'accent',
      '--dsw-alias-brand-primary-invert': 'accent',
      '--dsw-alias-brand-primary-new-colorprimary-new-color': 'accent',
      '--dsw-alias-brand-text': 'accent',
      '--dsw-alias-button-primary-fill': 'accent',
      '--dsw-alias-button-primary-hover': 'accentHover',
      '--dsw-alias-button-primary-dimmed': 'accentSoft',
      '--dsw-alias-button-info-fill': 'accent',
      '--dsw-alias-button-info-hover': 'accentHover',
      '--dsw-alias-button-contrast-fill': 'contrastFill',
      '--dsw-alias-button-elevated-fill': 'surfaceRaised',
      '--dsw-alias-button-floating-fill': 'surfaceRaised',
      '--dsw-alias-button-floating-hover': 'hoverSolid',
      '--dsw-alias-button-ghost-active-fill': 'selected',
      '--dsw-alias-button-ghost-active-hover': 'hoverSolid',
      '--dsw-alias-button-ghost-active-border': 'borderStrong',
      '--dsw-alias-interactive-bg-hover': 'hover',
      '--dsw-alias-interactive-bg-active': 'active',
      '--dsw-alias-interactive-bg-hover-solid': 'hoverSolid',

      // 代码与 Markdown
      '--dsw-alias-markdown-code-block': 'codeBlock',
      '--dsw-alias-markdown-code-block-banner': 'codeBanner',
      '--dsw-alias-markdown-code-segment-selected': 'codeBanner',
      '--dsw-alias-markdown-code-segment-unselected': 'codeBlock',
      '--dsw-alias-markdown-inline-code': 'inlineCode',
      '--dsw-alias-markdown-citation': 'inlineCode',
      '--dsw-alias-markdown-tag': 'codeBlock',
      '--dsw-alias-markdown-placeholder': 'codeBlock',

      // 状态
      '--dsw-alias-state-business-primary': 'accent',
      '--dsw-alias-state-business-tertiary': 'accentSoft',
      '--dsw-alias-state-error-primary': 'error',
      '--dsw-alias-state-success-primary': 'success',
      '--dsw-alias-state-success-tertiary': 'successSoft',
      '--dsw-alias-state-warn-primary': 'warn',
      '--dsw-alias-state-warn-label': 'warn',
      '--dsw-alias-state-warn-tertiary': 'warnSoft',
      '--dsw-alias-state-idle-primary': 'idle',

      // 浮层、反馈与滚动条
      '--dsw-alias-toast-bg': 'toastBg',
      '--dsw-alias-toast-label': 'toastLabel',
      '--dsw-alias-tooltip-bg': 'tooltipBg',
      '--dsw-menu-surface-fill': 'menuFill',
      '--dsw-alias-menu-group-header-fill': 'menuHeader',
      '--dsw-alias-turn-trigger-bg': 'bubble',
      '--dsw-alias-turn-trigger-bg-hover': 'hoverSolid',
      '--dsw-alias-switch-thumb': 'switchThumb',
      '--dsw-alias-scrollbar-bg-l1': 'scrollThumb',
      '--dsw-alias-scrollbar-bg-l2': 'scrollThumb',
      '--dsw-alias-scrollbar-hover-l1': 'scrollThumbHover',
      '--dsw-alias-scrollbar-hover-l2': 'scrollThumbHover'
    }

    /** 槽位清单（报错信息与自检用）。 */
    const SLOTS = Object.keys(SLOT_TOKENS)
      .map((token) => SLOT_TOKENS[token])
      .filter((slot, index, all) => all.indexOf(slot) === index)

    /** 由槽位派生、皮肤作者不用手填的 token。 */
    function derivedTokens(p) {
      return {
        '--dsw-alias-label-deep-diving': mix(p.accent, p.textPrimary, 70),
        '--dsw-alias-label-deep-diving-shimmer': mix(p.accent, p.textPrimary, 30),
        '--dsw-alias-tooltip-key-bg': mix(p.tooltipBg, '#ffffff', 18),
        '--dsw-alias-interactive-bg-hover-accent': mix(p.accent, 'transparent', 14),
        '--dsw-alias-interactive-bg-hover-danger': mix(p.error, 'transparent', 10),
        '--dsw-alias-bg-document-selection': mix(p.accent, 'transparent', 35)
      }
    }

    /** color-mix 包装：a 占 pct%，其余为 b。 */
    function mix(a, b, pct) {
      return 'color-mix(in srgb, ' + a + ' ' + pct + '%, ' + b + ')'
    }

    /* ---------------------------------------------------------------------
     * 2. 两套主题的「通用中性」兜底
     *
     * 悬停层、发丝边框、骨架屏这类值几乎不随色调变化，放这里做兜底；皮肤
     * 想染成有色版本（中国风的暖米色边框）就自己覆盖同名字段。
     * ------------------------------------------------------------------- */
    const SCHEME_DEFAULTS = {
      light: {
        borderSubtle: '#0000000a',
        border: '#0000001a',
        borderStrong: '#0000001f',
        borderHeavy: '#00000029',
        hover: '#2631480f',
        active: '#2631481a',
        hoverSolid: '#f0f0f0',
        skeleton: '#0000000a',
        switchThumb: '#ffffff',
        scrollThumb: '#d4d4d4',
        scrollThumbHover: '#a2a4a6',
        toastLabel: '#ffffff',
        successSoft: '#e6faed',
        warnSoft: '#fef5e7'
      },
      dark: {
        borderSubtle: '#ffffff0f',
        border: '#ffffff1f',
        borderStrong: '#ffffff29',
        borderHeavy: '#ffffff33',
        hover: '#ffffff14',
        active: '#ffffff24',
        hoverSolid: '#292929',
        skeleton: '#ffffff14',
        switchThumb: '#adb2b8',
        scrollThumb: '#3c3c3d',
        scrollThumbHover: '#545557',
        toastLabel: '#ffffff',
        successSoft: '#233c2c',
        warnSoft: '#27241f'
      }
    }

    /* ---------------------------------------------------------------------
     * 2.5 字体栈
     *
     * 整套设计系统的字号简写（--dsw-font-s-14 等）和 markdown 各级标题，
     * 它们的 *-font-family 子项统统写成 `var(--dsw-font-family)`，所以皮肤只改
     * 这一个变量就能全站换字体；代码块走 --ds-font-family-code，不受影响。
     * 字体一律用本机已装的家族名，并给足回退，装不上也不会变成方框。
     * ------------------------------------------------------------------- */
    const FONT_STACKS = {
      serif: '"Noto Serif SC", "Source Han Serif SC", "Songti SC", "宋体", SimSun, serif',
      zhongSong: '"华文中宋", "STZhongsong", "Noto Serif SC", serif',
      kai: '"楷体", KaiTi, "华文楷体", STKaiti, serif',
      hei: '"Noto Sans SC", "Source Han Sans SC", "思源黑体", "Microsoft YaHei UI", "微软雅黑", sans-serif',
      deng: '"等线", DengXian, "Noto Sans SC", "Microsoft YaHei UI", sans-serif',
      xihei: '"华文细黑", STXihei, "Noto Sans SC", "Microsoft YaHei UI", sans-serif'
    }

    /* ---------------------------------------------------------------------
     * 3. 皮肤注册表
     *
     * 加一套皮肤就往这里加一个对象：
     *   id / name / hint / swatch   —— 设置行里的展示信息
     *   light / dark                —— 两套槽位值（缺的槽位由 SCHEME_DEFAULTS 兜底）
     *   font / fontName             —— 可选，字体栈与它的显示名；不填就沿用界面默认字体
     *   css                         —— 可选，追加材质；选择器请自带 body[data-dsh-skin="id"] 前缀
     * ------------------------------------------------------------------- */
    const SKINS = [
      {
        id: 'morandi',
        name: '莫兰迪',
        hint: '低饱和灰调',
        font: FONT_STACKS.hei,
        fontName: '思源黑体',
        swatch: ['#5f6c76', '#c9b8ae', '#e4e1d9'],
        light: {
          canvas: '#f1efea',
          surface: '#f7f5f1',
          surfaceRaised: '#fcfbf8',
          surfaceSunken: '#eae7e0',
          sidebar: '#eeebe4',
          overlay: '#f5f3ee',
          selected: '#e4e1d9',
          bubble: '#ece8df',
          bubbleHi: '#ded8cb',
          textPrimary: '#3f434a',
          textSecondary: '#6b7078',
          textTertiary: '#85898f',
          textCaption: '#a3a7ad',
          onAccent: '#fbfaf7',
          link: '#547185',
          borderSubtle: '#e4e0d6',
          border: '#dad5c9',
          borderStrong: '#cfc9bb',
          borderHeavy: '#c3bcac',
          accent: '#5f6c76',
          accentHover: '#525f68',
          accentSoft: '#e3e7ea',
          contrastFill: '#4a5058',
          hover: '#4a505812',
          active: '#4a50581f',
          hoverSolid: '#eae7e0',
          codeBlock: '#efece5',
          codeBanner: '#e8e4db',
          inlineCode: '#f1eee8',
          success: '#7d9b82',
          successSoft: '#e6ece6',
          warn: '#bf9c63',
          warnSoft: '#f2ebdd',
          error: '#b3807c',
          idle: '#c4c0b7',
          toastBg: '#5b6068',
          toastLabel: '#f8f6f2',
          tooltipBg: '#565b63',
          menuFill: '#f4f2ede6',
          menuHeader: '#f4f2edf2',
          switchThumb: '#ffffff',
          scrollThumb: '#cdc8bd',
          scrollThumbHover: '#b6b0a2',
          skeleton: '#4a50580a'
        },
        dark: {
          canvas: '#1f2124',
          surface: '#26282b',
          surfaceRaised: '#2c2f32',
          surfaceSunken: '#222427',
          sidebar: '#232528',
          overlay: '#303337',
          selected: '#363a3e',
          bubble: '#2d3035',
          bubbleHi: '#3a3e44',
          textPrimary: '#e7e4de',
          textSecondary: '#b4b1aa',
          textTertiary: '#948f88',
          textCaption: '#7d7973',
          onAccent: '#1f2124',
          link: '#9db6c9',
          borderSubtle: '#ffffff12',
          border: '#ffffff1f',
          borderStrong: '#ffffff2b',
          borderHeavy: '#ffffff38',
          accent: '#93a4b1',
          accentHover: '#a3b3bf',
          accentSoft: '#3a4249',
          contrastFill: '#d6d3cc',
          hover: '#ffffff12',
          active: '#ffffff22',
          hoverSolid: '#33363a',
          codeBlock: '#26292c',
          codeBanner: '#2d3134',
          inlineCode: '#2b2e31',
          success: '#8fae93',
          successSoft: '#2b3630',
          warn: '#cbab74',
          warnSoft: '#3a3327',
          error: '#c08d88',
          idle: '#6d6f72',
          toastBg: '#3b3f44',
          toastLabel: '#f2efe9',
          tooltipBg: '#3b3f44',
          menuFill: '#2c2f32e6',
          menuHeader: '#26282bf2',
          switchThumb: '#adb2b8',
          scrollThumb: '#4a4d51',
          scrollThumbHover: '#5e6266',
          skeleton: '#ffffff12'
        },
        css: [
          'body[data-dsh-skin="morandi"]::before{content:"";position:fixed;inset:0 0 auto;height:2px;z-index:2147483000;pointer-events:none;background:linear-gradient(90deg,#9aa8b3,#c6bcae 45%,#9aa8b3);opacity:.8}',
          'body[data-dsh-skin="morandi"]::after{content:"";position:fixed;inset:0;z-index:2147482000;pointer-events:none;background:radial-gradient(circle at 12% 0%,#c9b8ae1f,transparent 42%),radial-gradient(circle at 92% 100%,#8fa3b01a,transparent 46%)}',
          'body[data-dsh-skin="morandi"][data-ds-dark-theme]::after{background:radial-gradient(circle at 12% 0%,#9aa8b314,transparent 44%),radial-gradient(circle at 92% 100%,#c9b8ae14,transparent 48%)}'
        ].join('\n')
      },
      {
        id: 'guofeng',
        name: '中国风',
        hint: '宣纸 · 墨 · 朱砂',
        font: FONT_STACKS.serif,
        fontName: '宋体',
        swatch: ['#a8332a', '#b8892f', '#f4ede0'],
        light: {
          canvas: '#f4ede0',
          surface: '#fbf6ea',
          surfaceRaised: '#fffdf7',
          surfaceSunken: '#ece3d2',
          sidebar: '#efe7d6',
          overlay: '#f8f2e4',
          selected: '#e6d9c2',
          bubble: '#f0e6d2',
          bubbleHi: '#e2d3b6',
          textPrimary: '#2c2721',
          textSecondary: '#5c5348',
          textTertiary: '#857a6a',
          textCaption: '#9d917c',
          onAccent: '#fdf8ee',
          link: '#3f6f74',
          borderSubtle: '#e3d8c1',
          border: '#d6c8ab',
          borderStrong: '#c7b795',
          borderHeavy: '#b7a480',
          accent: '#a8332a',
          accentHover: '#8f2a22',
          accentSoft: '#f0dcd6',
          contrastFill: '#2c2721',
          hover: '#6b5a3a14',
          active: '#6b5a3a22',
          hoverSolid: '#eee2cc',
          codeBlock: '#f0e8d7',
          codeBanner: '#e8ddc6',
          inlineCode: '#f2ebdb',
          success: '#4f7a52',
          successSoft: '#e2ead9',
          warn: '#b5862f',
          warnSoft: '#f3e8cd',
          error: '#a8332a',
          idle: '#c9bda4',
          toastBg: '#3c332a',
          toastLabel: '#fbf5e9',
          tooltipBg: '#3c332a',
          menuFill: '#fbf6eae6',
          menuHeader: '#fbf6eaf2',
          switchThumb: '#fffdf7',
          scrollThumb: '#d3c5a9',
          scrollThumbHover: '#bfae8c',
          skeleton: '#6b5a3a0d'
        },
        dark: {
          canvas: '#191613',
          surface: '#211d19',
          surfaceRaised: '#292420',
          surfaceSunken: '#1e1a17',
          sidebar: '#1e1a16',
          overlay: '#2b2620',
          selected: '#342d25',
          bubble: '#27221d',
          bubbleHi: '#352e26',
          textPrimary: '#ece2cd',
          textSecondary: '#bdb09a',
          textTertiary: '#978b78',
          textCaption: '#7f7464',
          onAccent: '#fdf6ea',
          link: '#86a9ad',
          borderSubtle: '#f0e2c212',
          border: '#f0e2c220',
          borderStrong: '#f0e2c22d',
          borderHeavy: '#f0e2c23a',
          accent: '#bd4a35',
          accentHover: '#b8462f',
          accentSoft: '#462d26',
          contrastFill: '#e6d9bd',
          hover: '#f0e2c214',
          active: '#f0e2c224',
          hoverSolid: '#322b24',
          codeBlock: '#211d19',
          codeBanner: '#2a241e',
          inlineCode: '#262019',
          success: '#7fa477',
          successSoft: '#2a3327',
          warn: '#c9a35c',
          warnSoft: '#372f22',
          error: '#cf7361',
          idle: '#6b6355',
          toastBg: '#352e26',
          toastLabel: '#f3ead6',
          tooltipBg: '#352e26',
          menuFill: '#292420e6',
          menuHeader: '#211d19f2',
          switchThumb: '#b3a68f',
          scrollThumb: '#453d33',
          scrollThumbHover: '#574d40',
          skeleton: '#f0e2c212'
        },
        css: [
          'body[data-dsh-skin="guofeng"]::before{content:"";position:fixed;inset:0 0 auto;height:3px;z-index:2147483000;pointer-events:none;background:linear-gradient(90deg,#a8332a,#b8892f 42%,#a8332a)}',
          'body[data-dsh-skin="guofeng"]::after{content:"";position:fixed;inset:0;z-index:2147482000;pointer-events:none;background:radial-gradient(circle at 8% 0%,#b8892f26,transparent 38%),radial-gradient(circle at 95% 92%,#3f6f741f,transparent 42%)}',
          'body[data-dsh-skin="guofeng"][data-ds-dark-theme]::after{background:radial-gradient(circle at 8% 0%,#b8892f1f,transparent 40%),radial-gradient(circle at 95% 92%,#3f6f7426,transparent 44%)}'
        ].join('\n')
      },
      {
        id: 'porcelain',
        name: '青花瓷',
        hint: '白瓷 · 靛青',
        font: FONT_STACKS.serif,
        fontName: '宋体',
        swatch: ['#2b5d8a', '#dfe9f3', '#f7f8fa'],
        light: {
          canvas: '#f7f8fa',
          surface: '#ffffff',
          surfaceRaised: '#ffffff',
          surfaceSunken: '#eef2f7',
          sidebar: '#eef2f7',
          overlay: '#f9fbfd',
          selected: '#e3ebf4',
          bubble: '#eaf1f8',
          bubbleHi: '#d8e5f1',
          textPrimary: '#1b2733',
          textSecondary: '#55636f',
          textTertiary: '#7a8794',
          textCaption: '#96a1ac',
          onAccent: '#ffffff',
          link: '#2b5d8a',
          borderSubtle: '#e6ebf1',
          border: '#dde4ec',
          borderStrong: '#cfd9e3',
          borderHeavy: '#bfcbd8',
          accent: '#2b5d8a',
          accentHover: '#234d74',
          accentSoft: '#dfe9f3',
          contrastFill: '#1b2733',
          hover: '#1b27330f',
          active: '#1b27331a',
          hoverSolid: '#eef2f7',
          codeBlock: '#f2f5f9',
          codeBanner: '#e9eef4',
          inlineCode: '#f4f7fa',
          success: '#2f7d5a',
          successSoft: '#e2efe8',
          warn: '#a9761c',
          warnSoft: '#f7eeda',
          error: '#b03a35',
          idle: '#c3ccd6',
          toastBg: '#22303d',
          toastLabel: '#f6f9fc',
          tooltipBg: '#22303d',
          menuFill: '#fbfcfeeb',
          menuHeader: '#f9fbfdf5',
          switchThumb: '#ffffff',
          scrollThumb: '#ccd6e0',
          scrollThumbHover: '#b3c0cd',
          skeleton: '#1b273308'
        },
        dark: {
          canvas: '#10161d',
          surface: '#161e27',
          surfaceRaised: '#1a232d',
          surfaceSunken: '#121a22',
          sidebar: '#131a22',
          overlay: '#1b242e',
          selected: '#22303d',
          bubble: '#1a2531',
          bubbleHi: '#24313f',
          textPrimary: '#e8eef4',
          textSecondary: '#9fb0c0',
          textTertiary: '#7e8f9f',
          textCaption: '#6a7a89',
          onAccent: '#0d1218',
          link: '#7fb2dc',
          borderSubtle: '#ffffff0f',
          border: '#ffffff1c',
          borderStrong: '#ffffff2a',
          borderHeavy: '#ffffff38',
          accent: '#6ea8d8',
          accentHover: '#86b8e2',
          accentSoft: '#23374a',
          contrastFill: '#dfe8ef',
          hover: '#ffffff12',
          active: '#ffffff22',
          hoverSolid: '#1f2b36',
          codeBlock: '#141c24',
          codeBanner: '#1a2530',
          inlineCode: '#171f28',
          success: '#6cae8b',
          successSoft: '#1c2f27',
          warn: '#cfa257',
          warnSoft: '#33291a',
          error: '#d9776f',
          idle: '#5b6672',
          toastBg: '#243039',
          toastLabel: '#eef4f9',
          tooltipBg: '#243039',
          menuFill: '#161e27eb',
          menuHeader: '#131a22f5',
          switchThumb: '#9fb0c0',
          scrollThumb: '#33404c',
          scrollThumbHover: '#44535f',
          skeleton: '#ffffff10'
        },
        css: [
          'body[data-dsh-skin="porcelain"]::before{content:"";position:fixed;inset:0 0 auto;height:2px;z-index:2147483000;pointer-events:none;background:linear-gradient(90deg,#2b5d8a,#7fb2dc 45%,#2b5d8a);opacity:.75}',
          'body[data-dsh-skin="porcelain"]::after{content:"";position:fixed;inset:0;z-index:2147482000;pointer-events:none;background:radial-gradient(circle at 6% 0%,#2b5d8a1a,transparent 40%),radial-gradient(circle at 96% 96%,#7fb2dc14,transparent 46%)}',
          'body[data-dsh-skin="porcelain"][data-ds-dark-theme]::after{background:radial-gradient(circle at 6% 0%,#6ea8d81f,transparent 42%),radial-gradient(circle at 96% 96%,#7fb2dc14,transparent 46%)}'
        ].join('\n')
      },
      {
        id: 'tokyo',
        name: '东京夜',
        hint: '深靛 · 蓝紫',
        font: FONT_STACKS.deng,
        fontName: '等线',
        swatch: ['#7aa2f7', '#bb9af7', '#16161e'],
        light: {
          canvas: '#f4f5fa',
          surface: '#ffffff',
          surfaceRaised: '#ffffff',
          surfaceSunken: '#eceef6',
          sidebar: '#eceef6',
          overlay: '#f7f8fc',
          selected: '#e2e5f5',
          bubble: '#e9ecf8',
          bubbleHi: '#d8ddf2',
          textPrimary: '#1f2233',
          textSecondary: '#565b78',
          textTertiary: '#7b809c',
          textCaption: '#979cb5',
          onAccent: '#ffffff',
          link: '#4a5fc1',
          borderSubtle: '#e6e8f2',
          border: '#e0e2ee',
          borderStrong: '#d0d4e6',
          borderHeavy: '#bec3da',
          accent: '#4a5fc1',
          accentHover: '#3d50a8',
          accentSoft: '#e0e4f7',
          contrastFill: '#1f2233',
          hover: '#1f22330f',
          active: '#1f22331a',
          hoverSolid: '#eceef6',
          codeBlock: '#f0f2fa',
          codeBanner: '#e7eaf5',
          inlineCode: '#f2f4fb',
          success: '#2f7d63',
          successSoft: '#e0efe9',
          warn: '#a5761f',
          warnSoft: '#f7eeda',
          error: '#b03a44',
          idle: '#c2c5d6',
          toastBg: '#232838',
          toastLabel: '#f5f6fb',
          tooltipBg: '#232838',
          menuFill: '#f8f9fdeb',
          menuHeader: '#f7f8fcf5',
          switchThumb: '#ffffff',
          scrollThumb: '#c9cde0',
          scrollThumbHover: '#aeb4cc',
          skeleton: '#1f223308'
        },
        dark: {
          canvas: '#16161e',
          surface: '#1a1b26',
          surfaceRaised: '#1f2335',
          surfaceSunken: '#14141b',
          sidebar: '#16161e',
          overlay: '#1e2030',
          selected: '#24283b',
          bubble: '#1f2335',
          bubbleHi: '#292e42',
          textPrimary: '#c0caf5',
          textSecondary: '#9aa5ce',
          textTertiary: '#7f8ab0',
          textCaption: '#6b7595',
          onAccent: '#10121a',
          link: '#7aa2f7',
          borderSubtle: '#ffffff10',
          border: '#ffffff1c',
          borderStrong: '#ffffff2b',
          borderHeavy: '#ffffff3a',
          accent: '#7aa2f7',
          accentHover: '#92b4f9',
          accentSoft: '#242f4d',
          contrastFill: '#c8d3f5',
          hover: '#ffffff12',
          active: '#ffffff22',
          hoverSolid: '#24283b',
          codeBlock: '#1b1e2b',
          codeBanner: '#22263a',
          inlineCode: '#1d2130',
          success: '#73d0a0',
          successSoft: '#1b2f28',
          warn: '#e0af68',
          warnSoft: '#332b1c',
          error: '#f7768e',
          idle: '#565f89',
          toastBg: '#24283b',
          toastLabel: '#e6ecff',
          tooltipBg: '#24283b',
          menuFill: '#1a1b26eb',
          menuHeader: '#16161ef5',
          switchThumb: '#9aa5ce',
          scrollThumb: '#2f3550',
          scrollThumbHover: '#414a6b',
          skeleton: '#ffffff10'
        },
        css: [
          'body[data-dsh-skin="tokyo"]::before{content:"";position:fixed;inset:0 0 auto;height:2px;z-index:2147483000;pointer-events:none;background:linear-gradient(90deg,#7aa2f7,#bb9af7 50%,#7aa2f7);opacity:.85}',
          'body[data-dsh-skin="tokyo"]::after{content:"";position:fixed;inset:0;z-index:2147482000;pointer-events:none;background:radial-gradient(circle at 8% 0%,#7aa2f71f,transparent 42%),radial-gradient(circle at 94% 100%,#bb9af71a,transparent 46%)}',
          'body[data-dsh-skin="tokyo"][data-ds-dark-theme]::after{background:radial-gradient(circle at 8% 0%,#7aa2f726,transparent 44%),radial-gradient(circle at 94% 100%,#bb9af724,transparent 48%)}'
        ].join('\n')
      },
      {
        id: 'ink',
        name: '水墨',
        hint: '墨分五色',
        font: FONT_STACKS.kai,
        fontName: '楷体',
        swatch: ['#2b2b28', '#a0a09a', '#f6f6f4'],
        light: {
          canvas: '#f6f6f4',
          surface: '#fdfdfc',
          surfaceRaised: '#ffffff',
          surfaceSunken: '#eeeeeb',
          sidebar: '#eeeeeb',
          overlay: '#fafaf8',
          selected: '#e6e6e1',
          bubble: '#ecece7',
          bubbleHi: '#dededa',
          textPrimary: '#1c1c1a',
          textSecondary: '#5a5a56',
          textTertiary: '#7e7e79',
          textCaption: '#9a9a94',
          onAccent: '#f6f6f4',
          link: '#3f4a55',
          borderSubtle: '#e6e6e1',
          border: '#dcdcd6',
          borderStrong: '#cccbc4',
          borderHeavy: '#b9b8b0',
          accent: '#2b2b28',
          accentHover: '#141412',
          accentSoft: '#e4e4df',
          contrastFill: '#1c1c1a',
          hover: '#1c1c1a0f',
          active: '#1c1c1a1a',
          hoverSolid: '#eaeae5',
          codeBlock: '#f1f1ee',
          codeBanner: '#e8e8e3',
          inlineCode: '#f3f3f0',
          success: '#4a6b52',
          successSoft: '#e4ebe4',
          warn: '#8a6a2f',
          warnSoft: '#f1ead9',
          error: '#8c3b34',
          idle: '#c6c5bd',
          toastBg: '#2a2a27',
          toastLabel: '#f4f4f1',
          tooltipBg: '#2a2a27',
          menuFill: '#fbfbf9eb',
          menuHeader: '#fafaf8f5',
          switchThumb: '#ffffff',
          scrollThumb: '#cfcfc8',
          scrollThumbHover: '#b6b5ae',
          skeleton: '#1c1c1a08'
        },
        dark: {
          canvas: '#131313',
          surface: '#1a1a1a',
          surfaceRaised: '#202020',
          surfaceSunken: '#151515',
          sidebar: '#161616',
          overlay: '#1e1e1e',
          selected: '#262626',
          bubble: '#222222',
          bubbleHi: '#2c2c2c',
          textPrimary: '#e8e8e4',
          textSecondary: '#a0a09a',
          textTertiary: '#85857f',
          textCaption: '#6e6e69',
          onAccent: '#141414',
          link: '#9fb0bd',
          borderSubtle: '#ffffff0f',
          border: '#ffffff1a',
          borderStrong: '#ffffff28',
          borderHeavy: '#ffffff36',
          accent: '#d8d8d0',
          accentHover: '#ebebe4',
          accentSoft: '#2c2c2c',
          contrastFill: '#e0e0da',
          hover: '#ffffff12',
          active: '#ffffff22',
          hoverSolid: '#232323',
          codeBlock: '#191919',
          codeBanner: '#202020',
          inlineCode: '#1c1c1c',
          success: '#86a88d',
          successSoft: '#1f2a22',
          warn: '#c0a366',
          warnSoft: '#2f2a1d',
          error: '#c98a80',
          idle: '#5f5f5b',
          toastBg: '#242424',
          toastLabel: '#f0f0ec',
          tooltipBg: '#242424',
          menuFill: '#1a1a1aeb',
          menuHeader: '#161616f5',
          switchThumb: '#a0a09a',
          scrollThumb: '#333333',
          scrollThumbHover: '#454545',
          skeleton: '#ffffff10'
        },
        css: [
          'body[data-dsh-skin="ink"]::before{content:"";position:fixed;inset:0 0 auto;height:1px;z-index:2147483000;pointer-events:none;background:linear-gradient(90deg,transparent,#2b2b28 20%,#2b2b28 80%,transparent);opacity:.55}',
          'body[data-dsh-skin="ink"]::after{content:"";position:fixed;inset:0;z-index:2147482000;pointer-events:none;background:radial-gradient(circle at 10% 0%,#1c1c1a0f,transparent 45%),radial-gradient(circle at 92% 98%,#1c1c1a0d,transparent 48%)}',
          'body[data-dsh-skin="ink"][data-ds-dark-theme]::before{background:linear-gradient(90deg,transparent,#e8e8e4 20%,#e8e8e4 80%,transparent);opacity:.28}',
          'body[data-dsh-skin="ink"][data-ds-dark-theme]::after{background:radial-gradient(circle at 10% 0%,#ffffff0d,transparent 46%),radial-gradient(circle at 92% 98%,#ffffff0d,transparent 48%)}'
        ].join('\n')
      },
      {
        id: 'landscape',
        name: '青绿山水',
        hint: '绢黄 · 石绿 · 赭石',
        font: FONT_STACKS.zhongSong,
        fontName: '华文中宋',
        swatch: ['#2f6b5f', '#b8894a', '#f3ecdc'],
        light: {
          canvas: '#f3ecdc',
          surface: '#faf5e9',
          surfaceRaised: '#fffcf3',
          surfaceSunken: '#ece2cd',
          sidebar: '#ece2cd',
          overlay: '#f6efe1',
          selected: '#e3d9c2',
          bubble: '#e8e0cb',
          bubbleHi: '#dbcfb2',
          textPrimary: '#26302c',
          textSecondary: '#5b6660',
          textTertiary: '#7c877f',
          textCaption: '#97a096',
          onAccent: '#f7f4ea',
          link: '#2f6b5f',
          borderSubtle: '#e3d9c4',
          border: '#ded2b8',
          borderStrong: '#cec0a0',
          borderHeavy: '#bdac88',
          accent: '#2f6b5f',
          accentHover: '#27594f',
          accentSoft: '#dfe7de',
          contrastFill: '#26302c',
          hover: '#26302c0f',
          active: '#26302c1c',
          hoverSolid: '#e9e0cc',
          codeBlock: '#f0e9d9',
          codeBanner: '#e7ddc7',
          inlineCode: '#f2ecdd',
          success: '#3f7355',
          successSoft: '#e2ebdf',
          warn: '#9c6f24',
          warnSoft: '#f3e8cd',
          error: '#9b3f33',
          idle: '#c8bda4',
          toastBg: '#2c332e',
          toastLabel: '#f7f4ea',
          tooltipBg: '#2c332e',
          menuFill: '#fbf6ebeb',
          menuHeader: '#f6efe1f5',
          switchThumb: '#fffcf3',
          scrollThumb: '#cdbfa2',
          scrollThumbHover: '#b7a684',
          skeleton: '#26302c08'
        },
        dark: {
          canvas: '#141a18',
          surface: '#1b2320',
          surfaceRaised: '#202a26',
          surfaceSunken: '#161d1a',
          sidebar: '#171e1c',
          overlay: '#1e2724',
          selected: '#27332e',
          bubble: '#1f2825',
          bubbleHi: '#2a3630',
          textPrimary: '#e6e2d4',
          textSecondary: '#a8a795',
          textTertiary: '#8a8977',
          textCaption: '#73725f',
          onAccent: '#101715',
          link: '#7fb3a4',
          borderSubtle: '#ffffff0f',
          border: '#ffffff1c',
          borderStrong: '#ffffff2a',
          borderHeavy: '#ffffff38',
          accent: '#6fa596',
          accentHover: '#85b6a8',
          accentSoft: '#24352f',
          contrastFill: '#ddd8c6',
          hover: '#ffffff12',
          active: '#ffffff22',
          hoverSolid: '#263230',
          codeBlock: '#18201d',
          codeBanner: '#1f2a26',
          inlineCode: '#1b2320',
          success: '#86b48f',
          successSoft: '#1f2c23',
          warn: '#cba55f',
          warnSoft: '#322b1d',
          error: '#cc8073',
          idle: '#5e6055',
          toastBg: '#232c28',
          toastLabel: '#eae6d8',
          tooltipBg: '#232c28',
          menuFill: '#1b2320eb',
          menuHeader: '#171e1cf5',
          switchThumb: '#a8a795',
          scrollThumb: '#35423c',
          scrollThumbHover: '#47564f',
          skeleton: '#ffffff10'
        },
        css: [
          'body[data-dsh-skin="landscape"]::before{content:"";position:fixed;inset:0 0 auto;height:3px;z-index:2147483000;pointer-events:none;background:linear-gradient(90deg,#2f6b5f,#6fa596 28%,#b8894a 62%,#3f6f74)}',
          'body[data-dsh-skin="landscape"]::after{content:"";position:fixed;inset:0;z-index:2147482000;pointer-events:none;background:radial-gradient(circle at 10% 0%,#b8894a26,transparent 40%),radial-gradient(circle at 94% 94%,#2f6b5f1f,transparent 44%)}',
          'body[data-dsh-skin="landscape"][data-ds-dark-theme]::after{background:radial-gradient(circle at 10% 0%,#b8894a1f,transparent 42%),radial-gradient(circle at 94% 94%,#6fa59624,transparent 46%)}'
        ].join('\n')
      },
      {
        id: 'latte',
        name: '卡布奇诺',
        hint: '暖调 · 淡紫',
        font: FONT_STACKS.xihei,
        fontName: '华文细黑',
        swatch: ['#1e66f5', '#cba6f7', '#eff1f5'],
        light: {
          canvas: '#eff1f5',
          surface: '#ffffff',
          surfaceRaised: '#ffffff',
          surfaceSunken: '#e6e9ef',
          sidebar: '#e6e9ef',
          overlay: '#f5f6fa',
          selected: '#dfe3ec',
          bubble: '#eef0f6',
          bubbleHi: '#dfe3ee',
          textPrimary: '#4c4f69',
          textSecondary: '#63667c',
          textTertiary: '#83869c',
          textCaption: '#9ca0b0',
          onAccent: '#ffffff',
          link: '#1e66f5',
          borderSubtle: '#e2e5ec',
          border: '#dce0e8',
          borderStrong: '#ccd0da',
          borderHeavy: '#bcc0cc',
          accent: '#1e66f5',
          accentHover: '#1656d6',
          accentSoft: '#dfe6fb',
          contrastFill: '#4c4f69',
          hover: '#4c4f690f',
          active: '#4c4f691a',
          hoverSolid: '#e6e9ef',
          codeBlock: '#e9ebf2',
          codeBanner: '#e0e3ec',
          inlineCode: '#ebeef4',
          success: '#40a02b',
          successSoft: '#e4f0e0',
          warn: '#df8e1d',
          warnSoft: '#f8eeda',
          error: '#d20f39',
          idle: '#c3c6d4',
          toastBg: '#3b3e52',
          toastLabel: '#f6f7fb',
          tooltipBg: '#3b3e52',
          menuFill: '#fafbfdeb',
          menuHeader: '#f5f6faf5',
          switchThumb: '#ffffff',
          scrollThumb: '#ccd0da',
          scrollThumbHover: '#b3b8c6',
          skeleton: '#4c4f6908'
        },
        dark: {
          canvas: '#11111b',
          surface: '#1e1e2e',
          surfaceRaised: '#24243a',
          surfaceSunken: '#15151f',
          sidebar: '#181825',
          overlay: '#222236',
          selected: '#313244',
          bubble: '#232338',
          bubbleHi: '#313244',
          textPrimary: '#cdd6f4',
          textSecondary: '#a6adc8',
          textTertiary: '#878ba5',
          textCaption: '#717590',
          onAccent: '#1e1e2e',
          link: '#89b4fa',
          borderSubtle: '#ffffff0f',
          border: '#ffffff1c',
          borderStrong: '#ffffff2a',
          borderHeavy: '#ffffff38',
          accent: '#cba6f7',
          accentHover: '#d8bdf9',
          accentSoft: '#33294a',
          contrastFill: '#d5dcf5',
          hover: '#ffffff12',
          active: '#ffffff22',
          hoverSolid: '#2a2a3f',
          codeBlock: '#1a1a28',
          codeBanner: '#222236',
          inlineCode: '#1d1d2c',
          success: '#a6e3a1',
          successSoft: '#23302a',
          warn: '#f9e2af',
          warnSoft: '#332f24',
          error: '#f38ba8',
          idle: '#6c7086',
          toastBg: '#2a2a3f',
          toastLabel: '#e6ecff',
          tooltipBg: '#2a2a3f',
          menuFill: '#1e1e2eeb',
          menuHeader: '#181825f5',
          switchThumb: '#a6adc8',
          scrollThumb: '#33334a',
          scrollThumbHover: '#454560',
          skeleton: '#ffffff10'
        },
        css: [
          'body[data-dsh-skin="latte"]::before{content:"";position:fixed;inset:0 0 auto;height:2px;z-index:2147483000;pointer-events:none;background:linear-gradient(90deg,#1e66f5,#cba6f7 55%,#1e66f5);opacity:.7}',
          'body[data-dsh-skin="latte"]::after{content:"";position:fixed;inset:0;z-index:2147482000;pointer-events:none;background:radial-gradient(circle at 10% 0%,#cba6f721,transparent 42%),radial-gradient(circle at 94% 96%,#1e66f514,transparent 46%)}',
          'body[data-dsh-skin="latte"][data-ds-dark-theme]::after{background:radial-gradient(circle at 10% 0%,#cba6f724,transparent 44%),radial-gradient(circle at 94% 96%,#89b4fa1a,transparent 48%)}'
        ].join('\n')
      }
    ]

    /* ---------------------------------------------------------------------
     * 4. 皮肤 → token 层
     * ------------------------------------------------------------------- */

    /**
     * 把一套皮肤展开成 ctx.theme.overrideTokens 需要的
     * `{ token: { light, dark } }` 层。
     */
    function buildLayer(skin) {
      const light = Object.assign({}, SCHEME_DEFAULTS.light, skin.light)
      const dark = Object.assign({}, SCHEME_DEFAULTS.dark, skin.dark)
      const missing = []
      for (const slot of SLOTS) {
        if (typeof light[slot] !== 'string') missing.push(slot + '.light')
        if (typeof dark[slot] !== 'string') missing.push(slot + '.dark')
      }
      if (missing.length > 0) {
        throw new Error(
          'dsh-skins: skin "' + skin.id + '" 缺少槽位 ' + missing.join(', ')
        )
      }

      const tokens = {}
      for (const token of Object.keys(SLOT_TOKENS)) {
        const slot = SLOT_TOKENS[token]
        tokens[token] = { light: light[slot], dark: dark[slot] }
      }
      const lightDerived = derivedTokens(light)
      const darkDerived = derivedTokens(dark)
      for (const token of Object.keys(lightDerived)) {
        tokens[token] = { light: lightDerived[token], dark: darkDerived[token] }
      }
      // 给别的插件（以及 Inspect）留的标识 token：读到它就知道当前挂着哪套皮肤。
      tokens['--dsw-skin-id'] = { light: skin.id, dark: skin.id }
      tokens['--dsw-skin-accent'] = { light: light.accent, dark: dark.accent }
      // 字体：一个变量换掉全站（字号简写与 markdown 各级都引它）
      if (typeof skin.font === 'string' && skin.font.length > 0) {
        tokens['--dsw-font-family'] = { light: skin.font, dark: skin.font }
        tokens['--dsw-skin-font'] = { light: skin.font, dark: skin.font }
      }
      return tokens
    }

    /* ---------------------------------------------------------------------
     * 5. 样式表（设置行 + 皮肤自带的材质 css）
     * ------------------------------------------------------------------- */

    const ROW_CSS = [
      // 与「外观」「字号」两行同款的分组卡：同一条底边线、同样的间距尺度。
      '.dsh-skins-group{border-bottom:.5px solid var(--dsw-alias-border-l2);flex-direction:column;gap:8px;padding:16px 0;display:flex}',
      '.dsh-skins-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}',
      '.dsh-skins-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.dsh-skins-row{flex-wrap:wrap;align-items:stretch;gap:8px;display:flex}',
      '.dsh-skins-cube{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-xl);font:inherit;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;flex-direction:column;flex:180px;justify-content:center;align-items:center;gap:6px;padding:16px 24px;font-size:14px;line-height:22px;display:flex}',
      '.dsh-skins-cube:hover:not(.dsh-skins-selected){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-skins-selected{background:var(--dsw-alias-bg-module-platform);border-color:var(--dsw-static-neutral-bluish-400)}',
      '.dsh-skins-chips{gap:4px;display:flex}',
      '.dsh-skins-chip{width:14px;height:14px;border-radius:50%;border:.5px solid var(--dsw-alias-border-l4)}',
      '.dsh-skins-name{font-size:14px}',
      '.dsh-skins-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.dsh-skins-font{color:var(--dsw-alias-label-caption);font-size:12px;line-height:18px}'
    ].join('\n')

    /** 把设置行样式与各皮肤自带的材质 css 一次性注入（幂等，且会把标签认回自己名下）。 */
    function installStyleSheet() {
      if (typeof document === 'undefined') return
      const existing = document.querySelector('style[' + STYLE_ATTRIBUTE + '="' + STYLE_ID + '"]')
      if (existing !== null) {
        // 早先被别的包误认领过：改回自己名下，免得它热更时把我们的样式一起删掉。
        if (existing.getAttribute(STYLE_OWNER_ATTRIBUTE) !== PLUGIN_ID) {
          existing.setAttribute(STYLE_OWNER_ATTRIBUTE, PLUGIN_ID)
        }
        return
      }
      const tag = document.createElement('style')
      tag.setAttribute(STYLE_ATTRIBUTE, STYLE_ID)
      tag.setAttribute(STYLE_OWNER_ATTRIBUTE, PLUGIN_ID)
      tag.textContent = ROW_CSS + '\n' + SKINS.map((skin) => skin.css || '').join('\n')
      document.head.appendChild(tag)
    }

    /* ---------------------------------------------------------------------
     * 6. 运行时：注册表 + 应用 + 持久化 + 订阅
     * ------------------------------------------------------------------- */

    function readStored() {
      try {
        return window.localStorage.getItem(STORAGE_KEY)
      } catch (error) {
        return null
      }
    }

    function writeStored(id) {
      try {
        if (id === null) window.localStorage.removeItem(STORAGE_KEY)
        else window.localStorage.setItem(STORAGE_KEY, id)
      } catch (error) {
        /* 无持久化环境（如非回环页面）时静默降级为进程内状态 */
      }
    }

    /** 皮肤机制对外的门面；同时以 `skins` 服务提供给其他插件。 */
    class SkinRuntime {
      constructor(theme) {
        this.theme = theme
        this.active = 'default'
        this.layerDisposer = null
        this.listeners = new Set()
      }

      /** 已注册的皮肤（不含「默认」）。 */
      list() {
        return SKINS.map((skin) => ({
          id: skin.id,
          name: skin.name,
          hint: skin.hint,
          fontName: skin.fontName || '',
          swatch: skin.swatch.slice()
        }))
      }

      /** 当前皮肤 id；`default` 表示不叠加任何层。 */
      get() {
        return this.active
      }

      /** 切换皮肤：重挂 token 层、写 body 标记、持久化并通知订阅者。 */
      set(id) {
        if (id !== 'default' && !SKINS.some((skin) => skin.id === id)) {
          throw new Error('dsh-skins: 未注册的皮肤 "' + id + '"')
        }
        if (this.active === id) return
        this.active = id
        this.applyLayer()
        writeStored(id === 'default' ? null : id)
        this.notify()
      }

      subscribe(listener) {
        this.listeners.add(listener)
        return () => {
          this.listeners.delete(listener)
        }
      }

      notify() {
        for (const listener of Array.from(this.listeners)) {
          try {
            listener(this.active)
          } catch (error) {
            /* 单个订阅者出错不影响切换本身 */
          }
        }
      }

      applyLayer() {
        if (this.layerDisposer !== null) {
          this.layerDisposer()
          this.layerDisposer = null
        }
        const skin = SKINS.find((item) => item.id === this.active)
        const body = typeof document === 'undefined' ? null : document.body
        if (skin === undefined) {
          if (body !== null) body.removeAttribute(SKIN_ATTRIBUTE)
          return
        }
        this.layerDisposer = this.theme.overrideTokens(
          OVERRIDE_SOURCE + '/' + skin.id,
          buildLayer(skin)
        )
        if (body !== null) body.setAttribute(SKIN_ATTRIBUTE, skin.id)
      }

      dispose() {
        if (this.layerDisposer !== null) {
          this.layerDisposer()
          this.layerDisposer = null
        }
        this.listeners.clear()
        if (typeof document !== 'undefined' && document.body !== null && document.body !== undefined) {
          document.body.removeAttribute(SKIN_ATTRIBUTE)
        }
      }
    }

    /* ---------------------------------------------------------------------
     * 7. 设置行 UI（「通用」分区，紧跟「外观」「字号」之后）
     * ------------------------------------------------------------------- */

    let runtimeRef = null

    const DEFAULT_ITEM = {
      id: 'default',
      name: '默认',
      hint: '跟随内置配色',
      fontName: '内置字体',
      swatch: ['#f5f5f5', '#4176e6', '#0f0f0f']
    }

    function SkinRow() {
      const runtime = runtimeRef
      const [active, setActive] = react.useState(runtime === null ? 'default' : runtime.get())

      react.useEffect(() => {
        if (runtime === null) return undefined
        setActive(runtime.get())
        return runtime.subscribe((id) => setActive(id))
      }, [])

      const items = [DEFAULT_ITEM].concat(
        runtime === null
          ? []
          : runtime.list().map((skin) => ({
              id: skin.id,
              name: skin.name,
              hint: skin.hint,
              fontName: skin.fontName,
              swatch: skin.swatch
            }))
      )

      return react.createElement(
        'div',
        { className: 'dsh-skins-group' },
        react.createElement('div', { className: 'dsh-skins-title' }, '皮肤'),
        react.createElement(
          'div',
          { className: 'dsh-skins-desc' },
          '在浅色 / 深色之上叠加的一层配色，可随时切回默认。'
        ),
        react.createElement(
          'div',
          { className: 'dsh-skins-row' },
          items.map((item) =>
            react.createElement(
              'button',
              {
                key: item.id,
                type: 'button',
                className:
                  'dsh-skins-cube' + (active === item.id ? ' dsh-skins-selected' : ''),
                'aria-pressed': active === item.id,
                onClick: () => {
                  if (runtime !== null) runtime.set(item.id)
                }
              },
              react.createElement(
                'div',
                { className: 'dsh-skins-chips' },
                item.swatch.map((color, index) =>
                  react.createElement('span', {
                    key: index,
                    className: 'dsh-skins-chip',
                    style: { background: color }
                  })
                )
              ),
              react.createElement('div', { className: 'dsh-skins-name' }, item.name),
              react.createElement('div', { className: 'dsh-skins-hint' }, item.hint),
              item.fontName
                ? react.createElement('div', { className: 'dsh-skins-font' }, item.fontName)
                : null
            )
          )
        )
      )
    }

    /* ---------------------------------------------------------------------
     * 8. 插件体
     * ------------------------------------------------------------------- */

    const inject = ['slots', 'theme']

    function apply(ctx) {
      installStyleSheet()

      const runtime = new SkinRuntime(ctx.theme)
      runtimeRef = runtime

      const stored = readStored()
      if (stored !== null && SKINS.some((skin) => skin.id === stored)) {
        runtime.set(stored)
      }

      ctx.effect(() => ctx.provide('skins', runtime), 'dsh-skins: skins service')
      ctx.effect(() => () => runtime.dispose(), 'dsh-skins: runtime teardown')

      ctx.slots.inject('settings.general.item', () =>
        ctx.slots.register(
          {
            name: 'settings.general.item',
            id: 'skins',
            order: 13,
            label: '皮肤'
          },
          SkinRow
        )
      )
    }

    exports.apply = apply
    exports.inject = inject
    // 测试与二次开发用的内部视图（不参与插件装配）。
    exports.skinInternals = {
      SKINS: SKINS,
      SLOT_TOKENS: SLOT_TOKENS,
      SCHEME_DEFAULTS: SCHEME_DEFAULTS,
      buildLayer: buildLayer,
      SkinRuntime: SkinRuntime
    }
    return module.exports
  }
})
