window.__ModuleLoader__.load({
  id: 'dsh-pet',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    let react = require('react')

    /* =====================================================================
     * dsh-pet —— 桌面宠物（客户端半边）
     *
     * 一只住在 `shell.overlay` 浮层里的小家伙。它做三件事：
     *
     *   1. 跟随皮肤 —— 用皮肤暴露的 `--dsw-skin-accent` 给自己的 LED / 光晕 /
     *      斑点上色，换皮肤就换气质（不需要跟 dsh-skins 直接耦合，读 CSS 变量）。
     *   2. 跟着 Agent —— 轮询宿主 `/pet-api/activity`，把 running / tool / 等待
     *      授权 / 报错 / 刚收工映射成六种状态与表情（干活、点头、冒烟、撒花…）。
     *   3. 能被养 —— 点击有反应、双击换一只、拖着放任意位置；设置 → 通用里一行
     *      可选 6 种宠物与大小 / 位置 / 静默 / 显示。
     *
     * 所有造型都是内联 SVG（CSP 下不能外链图片），动画走 CSS keyframes，
     * 空闲与页面隐藏时停止轮询与动画。
     * =================================================================== */

    const STYLE_ATTRIBUTE = 'data-plugin-css'
    const STYLE_ID = 'dsh-pet'
    /**
     * 模块系统（dsh-client-modules）按 `data-plugin` 给 <style> 记账：装配某个包时把
     * 当时还没有这个属性的标签统统认领给它，这个包卸载 / 热更时再按属性整批删掉。
     * 官方包注入时就写上自己；我们的标签在 apply() 里注入（晚于装配），必须显式归属，
     * 否则会被下一个装配的包认领走，它一热更就带走宠物的整套样式。
     */
    const STYLE_OWNER_ATTRIBUTE = 'data-plugin'
    const PLUGIN_ID = 'dsh-pet'
    const STORAGE_KEY = 'dsh-pet:prefs'
    const OVERLAY_CLASS = 'dsh-pet-host'
    const ACTIVITY_URL = '/pet-api/activity'
    const POLL_MS = 1200
    const SLEEP_AFTER_MS = 90000
    const DONE_SHOW_MS = 5200
    const ERROR_SHOW_MS = 6500

    /** 尺寸：随便调。滑块范围 + 四个快捷键，值就是宠物本体宽度（px）。 */
    const SCALE = { min: 28, max: 200, step: 2, default: 64 }
    const SIZE_PRESETS = [
      { px: 40, name: '小' },
      { px: 64, name: '中' },
      { px: 96, name: '大' },
      { px: 140, name: '巨大' }
    ]

    /** 四个角落（拖动后进入 free 模式，记绝对坐标）。 */
    const CORNERS = [
      { id: 'br', name: '右下', x: 'right', y: 'bottom' },
      { id: 'bl', name: '左下', x: 'left', y: 'bottom' },
      { id: 'tr', name: '右上', x: 'right', y: 'top' },
      { id: 'tl', name: '左上', x: 'left', y: 'top' }
    ]

    /* ---------------------------------------------------------------------
     * 1. 宠物注册表
     *
     * 一只宠物 = 一个 rig（造型骨架）+ 一组配色参数。加一只新宠物只要往
     * PETS 里加一条、必要时给 rigs 加一个函数，不用碰运行时和样式表。
     * link: true 表示「跟随皮肤」时用皮肤强调色替换自己的主色。
     * ------------------------------------------------------------------- */
    const PETS = [
      {
        id: 'cat',
        name: '像素猫',
        hint: '爱打盹的橘猫',
        rig: 'quad',
        swatch: ['#F3B75C', '#D4933A', '#3A2A18'],
        params: {
          uid: 'cat', fur: '#F3B75C', furLight: '#FBD9A0', furDark: '#D08C2E', belly: '#FFF3DE', ink: '#3A2A18',
          nose: '#F2A0A8', blush: '#EE8F72', inner: '#F5A9A0', ear: 'cat', tail: 'curl',
          stripes: true, mask: false, whisker: true, brow: false, tongue: false
        }
      },
      {
        id: 'shiba',
        name: '柴犬',
        hint: '卷尾巴的狗子',
        rig: 'quad',
        swatch: ['#E4B87E', '#C79A62', '#D8543F'],
        params: {
          uid: 'shiba', fur: '#E9BC7E', furLight: '#F7E0B6', belly: '#FFF8EC', ink: '#3A2A18',
          blush: '#EE9E86', inner: '#EFA096', ear: 'dog', tail: 'shiba',
          mask: true, whisker: false, brow: true, tongue: true, collar: '#D8543F'
        }
      },
      {
        id: 'koi',
        name: '锦鲤',
        hint: '在池子里游',
        rig: 'fish',
        link: true,
        swatch: ['#FBF6EC', '#E2704C', '#2B2B2B'],
        params: { uid: 'koi', body: '#FBF6EC', spot: '#E2704C', fin: '#F6D3C4', ink: '#2B2B2B' }
      },
      {
        id: 'slime',
        name: '史莱姆',
        hint: '一弹一弹的',
        rig: 'blob',
        swatch: ['#6FCF92', '#B6F0CB', '#1F3A2A'],
        params: { uid: 'slime', body: '#6FCF92', bodyLight: '#B6F0CB', shine: '#EAFBF0', ink: '#1F3A2A', blush: '#EE8F72' }
      },
      {
        id: 'robot',
        name: '小机器人',
        hint: '天线 LED 会闪',
        rig: 'bot',
        link: true,
        swatch: ['#9FB4CC', '#CBD9E8', '#22303F'],
        params: { uid: 'robot', body: '#9FB4CC', bodyLight: '#CBD9E8', dark: '#5C7A99', ink: '#22303F', led: '#6FCF7F' }
      }
    ]

    /* ---------------------------------------------------------------------
     * 2. 造型骨架（rig）：每个函数返回一段内联 SVG 内容
     *
     * 约定：可动部位带固定类名，CSS 按状态驱动
     *   .pet-body 整体起伏   .pet-tail 尾巴/鱼尾   .pet-tent 触手
     *   .pet-eye 眨眼        .pet-led 天线灯       .pet-glow 光晕
     * 所有 rig 都画在 44×42 的坐标系里。
     * ------------------------------------------------------------------- */
    const INK = '#2B2B2B'
    const LINE = 'rgba(40,28,14,.16)' // 统一描边：极淡的暖灰，让造型在浅色/深色底上都立得住

    /** 竖向线性渐变（放在 <defs> 里）。 */
    function vgrad(id, from, to, y1, y2) {
      return (
        '<linearGradient id="' + id + '" x1="22" y1="' + y1 + '" x2="22" y2="' + y2 + '" gradientUnits="userSpaceOnUse">' +
        '<stop stop-color="' + from + '"/><stop offset="1" stop-color="' + to + '"/></linearGradient>'
      )
    }

    /** 大眼睛：深色瞳 + 高光点，宠物越小越靠它卖萌。 */
    function eye(cx, cy, r, color, shine) {
      return (
        '<circle class="pet-eye" cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="' + color + '"/>' +
        '<circle cx="' + (cx - r * 0.32) + '" cy="' + (cy - r * 0.42) + '" r="' + (r * 0.36) + '" fill="' + (shine || '#FFFFFF') + '" opacity=".92"/>'
      )
    }

    /** 圆头小鼻子 + 微笑嘴。 */
    function muzzle(cx, cy, color, scale) {
      const s = scale || 1
      return (
        '<path d="M' + (cx - 1.1 * s) + ' ' + cy + ' Q' + cx + ' ' + (cy + 1.5 * s) + ' ' + (cx + 1.1 * s) + ' ' + cy + ' Z" fill="' + color + '"/>' +
        '<path d="M' + cx + ' ' + (cy + 1.2 * s) + ' Q' + (cx - 1.5 * s) + ' ' + (cy + 3.2 * s) + ' ' + (cx - 2.8 * s) + ' ' + (cy + 1.4 * s) + '" fill="none" stroke="' + color + '" stroke-width="' + 0.9 * s + '" stroke-linecap="round"/>' +
        '<path d="M' + cx + ' ' + (cy + 1.2 * s) + ' Q' + (cx + 1.5 * s) + ' ' + (cy + 3.2 * s) + ' ' + (cx + 2.8 * s) + ' ' + (cy + 1.4 * s) + '" fill="none" stroke="' + color + '" stroke-width="' + 0.9 * s + '" stroke-linecap="round"/>'
      )
    }

    /* ---------------------------------------------------------------
     * 四足：猫 / 柴犬。差异全在耳朵、尾巴、口鼻与花色上。
     * ------------------------------------------------------------- */
    function rigQuad(p) {
      const id = p.uid
      const dog = p.ear === 'dog'
      const defs =
        '<defs>' +
        vgrad(id + '-body', p.furLight, p.fur, 14, 36) +
        vgrad(id + '-head', p.furLight, p.fur, 7, 26) +
        '</defs>'

      // 耳朵：猫是立起来的尖三角（略外倾）；狗是宽而圆的三角、向外斜、位置更低更开
      const ears = dog
        ? '<path d="M13.6 14 C10.4 9 8.8 6.2 10.6 5.2 C12.2 4.4 16.6 6.8 18.8 9.6 Z" fill="' + p.fur + '" stroke="' + LINE + '" stroke-width=".8"/>' +
          '<path d="M13.4 11.8 C12 9.2 11.6 7.8 12.4 7.4 C13.2 7 15.4 8.4 16.6 9.9 Z" fill="' + p.inner + '"/>' +
          '<path d="M30.4 14 C33.6 9 35.2 6.2 33.4 5.2 C31.8 4.4 27.4 6.8 25.2 9.6 Z" fill="' + p.fur + '" stroke="' + LINE + '" stroke-width=".8"/>' +
          '<path d="M30.6 11.8 C32 9.2 32.4 7.8 31.6 7.4 C30.8 7 28.6 8.4 27.4 9.9 Z" fill="' + p.inner + '"/>'
        : '<path d="M13.2 12.2 L11.2 3.6 Q11 2.4 12.1 3 L19.8 7.8 Z" fill="' + p.fur + '" stroke="' + LINE + '" stroke-width=".8"/>' +
          '<path d="M13.8 10.1 L12.8 6.1 L17 8 Z" fill="' + p.inner + '"/>' +
          '<path d="M30.8 12.2 L32.8 3.6 Q33 2.4 31.9 3 L24.2 7.8 Z" fill="' + p.fur + '" stroke="' + LINE + '" stroke-width=".8"/>' +
          '<path d="M30.2 10.1 L31.2 6.1 L27 8 Z" fill="' + p.inner + '"/>'

      // 尾巴：猫是粗一点的虎斑卷尾（带环纹 + 白尖）；狗是压在背上的一圈粗卷尾 + 白尖
      const tail = dog
        ? '<path class="pet-tail" d="M30.2 25.8 C38 25.4 39.6 17.6 33.4 13.9 C29 11.2 23.8 13.2 23.2 17.8" fill="none" stroke="' + p.fur + '" stroke-width="6.6" stroke-linecap="round"/>' +
          '<circle cx="23.8" cy="17.9" r="3.4" fill="' + p.belly + '"/>'
        : '<path class="pet-tail" d="M31.6 27.4 C39.8 27 41 18.6 34.8 15.2 C33 14.2 31.2 14.4 30.2 15.2" fill="none" stroke="' + p.fur + '" stroke-width="5.4" stroke-linecap="round"/>' +
          (p.stripes === true
            ? '<g class="pet-tail" stroke="' + p.furDark + '" stroke-width="1.15" stroke-linecap="round" opacity=".5" fill="none">' +
              '<path d="M37.6 25.6 q-1.7 1.1 -1.4 2.9"/><path d="M40 21 q-1.9 .3 -2.6 1.9"/><path d="M38.4 17.2 q-1.6 -.9 -2.9 -.1"/>' +
              '</g>'
            : '') +
          '<ellipse cx="30.4" cy="15.4" rx="3.1" ry="2.7" fill="' + p.belly + '" transform="rotate(-24 30.4 15.4)"/>'

      // 额头虎斑（猫专属）
      const stripes =
        p.stripes === true
          ? '<g stroke="' + p.furDark + '" stroke-width="1.05" stroke-linecap="round" opacity=".5" fill="none">' +
            '<path d="M19.1 11.2 q.5 -2 1.3 -.5"/><path d="M21.5 10.4 q.5 -2.2 1 -.2"/><path d="M24 11.2 q.5 -1.9 1.2 -.4"/>' +
            '</g>'
          : ''

      // 口鼻：猫是粉鼻头 + ω 嘴；狗是向外突出的大口鼻 + 黑鼻头 + 张开的嘴
      const face = dog
        ? '<ellipse cx="22" cy="20.8" rx="5.4" ry="4.1" fill="' + p.belly + '"/>' +
          '<ellipse cx="22" cy="18.5" rx="2" ry="1.5" fill="' + p.ink + '"/>' +
          '<path d="M22 20.1 v1.4" stroke="' + p.ink + '" stroke-width=".9" stroke-linecap="round"/>' +
          '<path d="M19.5 21.8 q2.5 2.3 5 0" fill="none" stroke="' + p.ink + '" stroke-width=".9" stroke-linecap="round"/>' +
          (p.tongue === true ? '<path d="M20.5 22.8 q1.5 2.3 3 0 z" fill="#F08A9A"/>' : '')
        : '<path d="M20.9 18.7 Q22 17.7 23.1 18.7 Q22 20.5 20.9 18.7 Z" fill="' + (p.nose || '#F2A0A8') + '"/>' +
          '<path d="M22 20.4 v1.1" stroke="' + p.ink + '" stroke-width=".85" stroke-linecap="round"/>' +
          '<path d="M22 21.5 q-1.5 1.9 -2.9 .3" fill="none" stroke="' + p.ink + '" stroke-width=".85" stroke-linecap="round"/>' +
          '<path d="M22 21.5 q1.5 1.9 2.9 .3" fill="none" stroke="' + p.ink + '" stroke-width=".85" stroke-linecap="round"/>'

      // 项圈：只有狗戴，是"这是狗不是猫"最省事的一眼信号
      const collar =
        typeof p.collar === 'string'
          ? '<path d="M15.2 23.4 Q22 26.8 28.8 23.4" fill="none" stroke="' + p.collar + '" stroke-width="2.3" stroke-linecap="round"/>' +
            '<circle cx="22" cy="25.7" r="1.6" fill="' + p.collar + '" stroke="#FFFFFF" stroke-opacity=".5" stroke-width=".5"/>'
          : ''

      // 胡须：猫专属，细、短、微弯、贴着口鼻两侧
      const whiskers =
        p.whisker === true
          ? '<g stroke="' + p.ink + '" stroke-width=".45" stroke-linecap="round" opacity=".32" fill="none">' +
            '<path d="M17.6 19.4 q-3 -.5 -5.4 .8"/><path d="M17.4 21 q-3 .3 -5.2 1.8"/><path d="M18 22.6 q-2.6 .8 -4.4 2.4"/>' +
            '<path d="M26.4 19.4 q3 -.5 5.4 .8"/><path d="M26.6 21 q3 .3 5.2 1.8"/><path d="M26 22.6 q2.6 .8 4.4 2.4"/>' +
            '</g>'
          : ''

      const bodyShape = dog
        ? '<ellipse cx="22" cy="26.6" rx="11" ry="9" fill="url(#' + id + '-body)" stroke="' + LINE + '" stroke-width=".9"/>'
        : '<ellipse cx="22" cy="26.4" rx="10.6" ry="9.2" fill="url(#' + id + '-body)" stroke="' + LINE + '" stroke-width=".9"/>'
      const headShape = dog
        ? '<ellipse cx="22" cy="16.8" rx="9.6" ry="8.7" fill="url(#' + id + '-head)" stroke="' + LINE + '" stroke-width=".9"/>'
        : '<circle cx="22" cy="16.6" r="9.3" fill="url(#' + id + '-head)" stroke="' + LINE + '" stroke-width=".9"/>'

      return (
        defs +
        '<g class="pet-body">' +
        tail +
        bodyShape +
        '<ellipse cx="22" cy="28.6" rx="6.2" ry="5.2" fill="' + p.belly + '" opacity=".95"/>' +
        '<ellipse cx="17.4" cy="33.4" rx="3.2" ry="2.3" fill="' + p.belly + '" stroke="' + LINE + '" stroke-width=".7"/>' +
        '<ellipse cx="26.6" cy="33.4" rx="3.2" ry="2.3" fill="' + p.belly + '" stroke="' + LINE + '" stroke-width=".7"/>' +
        // 接地阴影：让小东西"站"在界面上而不是飘着
        '<ellipse cx="22" cy="36.2" rx="8.6" ry="1.9" fill="' + p.ink + '" opacity=".09"/>' +
        headShape +
        ears +
        stripes +
        collar +
        (p.mask === true ? '<ellipse cx="22" cy="19.4" rx="6.8" ry="5.6" fill="' + p.belly + '" opacity="' + (dog ? '.55' : '.9') + '"/>' : '') +
        whiskers +
        '<g class="pet-face">' +
        eye(18.4, 16.2, 1.95, p.ink) +
        eye(25.6, 16.2, 1.95, p.ink) +
        (p.brow === true
          ? '<circle cx="18.2" cy="12.6" r=".9" fill="' + p.ink + '" opacity=".5"/><circle cx="25.8" cy="12.6" r=".9" fill="' + p.ink + '" opacity=".5"/>'
          : '') +
        '<ellipse cx="15.2" cy="19.8" rx="1.9" ry="1.2" fill="' + p.blush + '" opacity=".55"/>' +
        '<ellipse cx="28.8" cy="19.8" rx="1.9" ry="1.2" fill="' + p.blush + '" opacity=".55"/>' +
        face +
        '</g></g>'
      )
    }

    /* ---------------------------------------------------------------
     * 锦鲤：S 形身体 + 双叶尾 + 背鳍腹鳍 + 锦斑。
     * ------------------------------------------------------------- */
    function rigFish(p) {
      const id = p.uid
      const bodyPath =
        'M34 20.2 C34 15.4 29.6 12.2 24.4 12.1 C19 12 14 14.2 10.8 17.8 L10.1 20.2 L10.8 22.6 C14 26.2 19 28.4 24.4 28.3 C29.6 28.2 34 25 34 20.2 Z'
      const defs =
        '<defs>' +
        vgrad(id + '-body', '#FFFFFF', p.body, 12, 29) +
        '<clipPath id="' + id + '-clip"><path d="' + bodyPath + '"/></clipPath>' +
        '</defs>'
      return (
        defs +
        '<g class="pet-body">' +
        // 大尾鳍：两叶展开，比身体还显眼，一眼看出是鱼
        '<path class="pet-tail" d="M10.9 19.2 C5.2 11.6 1.2 14.4 4.1 19.5 C4.9 20.8 4.9 21.6 4.1 22.9 C1.2 28 5.6 30.4 10.9 22.8 Z" fill="' + p.fin + '" stroke="' + LINE + '" stroke-width=".7"/>' +
        // 背鳍 / 胸鳍
        '<path d="M19.8 12.6 C22 8.8 26.8 8.9 28.2 12.3 C25.2 11.6 22.2 11.8 19.8 12.6 Z" fill="' + p.fin + '" stroke="' + LINE + '" stroke-width=".6"/>' +
        '<path d="M24.2 28 C25.4 30.8 29.2 30.8 30.2 27.8 C28.2 28.4 26 28.4 24.2 28 Z" fill="' + p.fin + '" stroke="' + LINE + '" stroke-width=".6"/>' +
        // 身体
        '<path d="' + bodyPath + '" fill="url(#' + id + '-body)" stroke="' + LINE + '" stroke-width=".9"/>' +
        // 锦斑与鳞纹一律裁进身体轮廓里，绝不越界
        '<g clip-path="url(#' + id + '-clip)">' +
        '<path d="M26 11.2 C31.2 11.4 35 14.2 35.4 18.4 C35.6 21.2 33.8 22.8 30.8 22.6 C26.4 22.2 23.2 18.8 23.4 15.2 C23.5 12.8 24.6 11.2 26 11.2 Z" fill="' + p.spot + '" opacity=".92"/>' +
        '<ellipse cx="17.4" cy="22.8" rx="5" ry="3.4" fill="' + p.spot + '" opacity=".85"/>' +
        '<ellipse cx="12.6" cy="19.4" rx="3" ry="2.4" fill="' + p.spot + '" opacity=".7"/>' +
        '<g stroke="' + p.ink + '" stroke-width=".5" fill="none" opacity=".22">' +
        '<path d="M15.4 17.6 q1.5 -1.3 3 -.1"/><path d="M13 21.4 q1.5 -1.3 3 -.1"/>' +
        '<path d="M16.6 25 q1.5 -1.3 3 -.1"/><path d="M21 19.4 q1.5 -1.3 3 -.1"/>' +
        '<path d="M20.6 24.2 q1.5 -1.3 3 -.1"/>' +
        '</g></g>' +
        // 眼睛与嘴
        '<g class="pet-face">' +
        eye(29.6, 18.4, 1.8, p.ink) +
        '<path d="M33.4 22.4 q-1 1.1 -2.1 .3" fill="none" stroke="' + p.ink + '" stroke-width=".8" stroke-linecap="round"/>' +
        '</g></g>'
      )
    }

    /* ---------------------------------------------------------------
     * 史莱姆：软体 + 一滴挂在旁边的小水珠。
     * ------------------------------------------------------------- */
    function rigBlob(p) {
      const id = p.uid
      const defs = '<defs>' + vgrad(id + '-body', p.bodyLight, p.body, 7, 36) + '</defs>'
      return (
        defs +
        '<g class="pet-body">' +
        // 旁边挂着的一小滴
        '<path d="M36.4 29.4 C38.8 31.6 38 36.6 34.6 37 C31.6 37.3 29.4 34.8 30 31.8 C30.4 29.6 32.6 28.4 34.4 29 C35.2 29.2 35.8 29.2 36.4 29.4 Z" fill="' + p.body + '" opacity=".92" stroke="' + LINE + '" stroke-width=".6"/>' +
        '<ellipse cx="34.6" cy="33.8" rx="1.5" ry="1" fill="' + p.shine + '" opacity=".5"/>' +
        // 主体：软体轮廓（顶窄底宽，底边压出一条裙边）
        '<path d="M20.8 7.2 C29.6 7.2 35.4 13.4 35.4 21.2 C35.4 26.8 33.2 30.8 29.8 32.8 C28 33.9 25 34.8 21.8 34.9 C18.8 35 15.8 34.4 13.8 33.5 C10.2 31.7 8.4 27.2 8.4 21.2 C8.4 13.4 12 7.2 20.8 7.2 Z" fill="url(#' + id + '-body)" stroke="' + LINE + '" stroke-width=".9"/>' +
        // 高光与底边裙线
        '<ellipse cx="15.4" cy="14" rx="4.8" ry="3.3" fill="' + p.shine + '" opacity=".55"/>' +
        '<ellipse cx="25.2" cy="16.4" rx="2.1" ry="1.3" fill="' + p.shine + '" opacity=".38"/>' +
        '<path d="M11.4 29.6 C15.6 33.2 26 33.6 31.8 30" fill="none" stroke="' + p.bodyLight + '" stroke-width="1.3" opacity=".38" stroke-linecap="round"/>' +
        '<g class="pet-face">' +
        eye(17.6, 20.8, 2, p.ink) +
        eye(24.8, 20.8, 2, p.ink) +
        '<ellipse cx="13.2" cy="24.2" rx="2" ry="1.3" fill="' + p.blush + '" opacity=".6"/>' +
        '<ellipse cx="29.2" cy="24.2" rx="2" ry="1.3" fill="' + p.blush + '" opacity=".6"/>' +
        '<path d="M19.4 24.4 q1.8 1.9 3.6 0" fill="none" stroke="' + p.ink + '" stroke-width="1.05" stroke-linecap="round"/>' +
        '</g></g>'
      )
    }

    /* ---------------------------------------------------------------
     * 小机器人：金属渐变外壳 + 面罩里的 LED 眼 + 天线球。
     * ------------------------------------------------------------- */
    function rigBot(p) {
      const id = p.uid
      const defs = '<defs>' + vgrad(id + '-shell', p.bodyLight, p.body, 10, 30) + '</defs>'
      return (
        defs +
        '<g class="pet-body">' +
        '<line x1="22" y1="10.8" x2="22" y2="6.4" stroke="' + p.dark + '" stroke-width="1.5" stroke-linecap="round"/>' +
        '<circle cx="22" cy="4.6" r="3.4" fill="' + p.led + '" opacity=".22"/>' +
        '<circle class="pet-led" cx="22" cy="4.6" r="2.2" fill="' + p.led + '"/>' +
        '<rect x="8.6" y="15.4" width="3.6" height="8.4" rx="1.8" fill="' + p.dark + '"/>' +
        '<circle cx="10.4" cy="25.4" r="2.4" fill="' + p.bodyLight + '" stroke="' + LINE + '" stroke-width=".6"/>' +
        '<rect x="31.8" y="15.4" width="3.6" height="8.4" rx="1.8" fill="' + p.dark + '"/>' +
        '<circle cx="33.6" cy="25.4" r="2.4" fill="' + p.bodyLight + '" stroke="' + LINE + '" stroke-width=".6"/>' +
        '<rect x="11" y="10.6" width="22" height="18.6" rx="6.4" fill="url(#' + id + '-shell)" stroke="' + LINE + '" stroke-width=".9"/>' +
        '<rect x="13.6" y="13.4" width="16.8" height="10.4" rx="3.8" fill="' + p.ink + '"/>' +
        '<rect x="15" y="14.4" width="14" height="3" rx="1.5" fill="#FFFFFF" opacity=".07"/>' +
        '<g class="pet-face">' +
        eye(18.2, 18.6, 2, p.led, '#FFFFFF') +
        eye(25.8, 18.6, 2, p.led, '#FFFFFF') +
        '</g>' +
        '<g stroke="' + p.dark + '" stroke-width="1.1" stroke-linecap="round" opacity=".75">' +
        '<path d="M16.4 26.6 H19"/><path d="M20.8 26.6 H23.2"/><path d="M25 26.6 H27.6"/>' +
        '</g>' +
        '<circle cx="31.4" cy="26.6" r="1.1" fill="' + p.led + '" opacity=".8"/>' +
        '<rect x="16" y="30.4" width="4.8" height="5.2" rx="2.4" fill="' + p.dark + '"/>' +
        '<rect x="23.2" y="30.4" width="4.8" height="5.2" rx="2.4" fill="' + p.dark + '"/>' +
        '<ellipse cx="18.4" cy="35.4" rx="3.2" ry="1.8" fill="' + p.dark + '"/>' +
        '<ellipse cx="25.6" cy="35.4" rx="3.2" ry="1.8" fill="' + p.dark + '"/>' +
        '<g class="pet-tent"><path d="M11.2 27.8 q-1.6 3.2 .4 4.6" fill="none" stroke="' + p.dark + '" stroke-width="1.3" stroke-linecap="round"/></g>' +
        '</g>'
      )
    }

    const RIGS = { quad: rigQuad, fish: rigFish, blob: rigBlob, bot: rigBot }

    /**
     * 渲染一只宠物。
     * @param pet 注册表里的一条
     * @param options { accent: string|null } —— 非空时给 link 型宠物换强调色
     */
    /** 把颜色往白色方向提亮（跟随皮肤时用来配渐变色上端）。 */
    function lighten(hex, amount) {
      const raw = String(hex).replace('#', '')
      if (!/^[0-9a-fA-F]{6}$/.test(raw)) return hex
      const num = parseInt(raw, 16)
      const blend = (channel) => Math.round(channel + (255 - channel) * amount)
      const r = blend((num >> 16) & 255)
      const g = blend((num >> 8) & 255)
      const b = blend(num & 255)
      return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)
    }

    function renderPet(pet, options) {
      const opts = options || {}
      const p = Object.assign({}, pet.params)
      if (pet.link === true && typeof opts.accent === 'string' && opts.accent !== '') {
        if (pet.rig === 'fish') p.spot = opts.accent
        if (pet.rig === 'bot') p.led = opts.accent
        if (pet.rig === 'quad' || pet.rig === 'blob') p.blush = opts.accent
      }
      const body = (RIGS[pet.rig] || rigQuad)(p)
      return (
        '<svg class="pet-svg" viewBox="0 0 44 42" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
        body +
        '<g class="pet-fx">' +
        '<path class="pet-spark pet-spark-1" d="M36 8 l1.2 3 3 1.2 -3 1.2 -1.2 3 -1.2 -3 -3 -1.2 3 -1.2 Z" fill="#FFD166"/>' +
        '<path class="pet-spark pet-spark-2" d="M7 10 l1 2.4 2.4 1 -2.4 1 -1 2.4 -1 -2.4 -2.4 -1 2.4 -1 Z" fill="#9BE7A8"/>' +
        '<path class="pet-spark pet-spark-3" d="M34 30 l.9 2.2 2.2.9 -2.2.9 -.9 2.2 -.9 -2.2 -2.2 -.9 2.2 -.9 Z" fill="#8FC7F5"/>' +
        '<g class="pet-smoke">' +
        '<circle cx="17" cy="8" r="3.1" fill="#9AA4B2" opacity=".55"/>' +
        '<circle cx="22" cy="5.6" r="2.5" fill="#9AA4B2" opacity=".42"/>' +
        '<circle cx="26.6" cy="8.2" r="2" fill="#9AA4B2" opacity=".32"/>' +
        '</g>' +
        '<g class="pet-zzz">' +
        '<text x="31" y="12" font-size="9" font-weight="600" fill="#8FA0B5">z</text>' +
        '<text x="35.5" y="6.5" font-size="7" font-weight="600" fill="#8FA0B5">z</text>' +
        '</g>' +
        '<g class="pet-heart">' +
        '<path d="M22 4 q2.4 -3 5 -.8 q2.2 2.2 -5 7 q-7.2 -4.8 -5 -7 q2.6 -2.2 5 .8 Z" fill="#F2707F"/>' +
        '</g>' +
        '</g></svg>'
      )
    }

    /* ---------------------------------------------------------------------
     * 3. 样式表
     *
     * 造型是静态 SVG，所有"活着"的感觉都来自这些 keyframes：
     * 呼吸、甩尾、眨眼、干活抖动、收工撒花、报错冒烟、打盹 Zzz、摸头爱心。
     * 状态由根节点的 data-state 驱动，静默模式与 prefers-reduced-motion 兜底。
     * ------------------------------------------------------------------- */
    const CSS = [
      '.dsh-pet-host{position:relative;pointer-events:none}',
      '#dsh-pet-root{position:fixed;pointer-events:none;z-index:2147482400;--pet-accent:var(--dsw-skin-accent,#4A65E8);will-change:transform}',
      '#dsh-pet-root[data-hidden="true"]{display:none}',
      '.dsh-pet-wrap{position:relative;display:flex;flex-direction:column;align-items:center;pointer-events:auto;cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none}',
      '.dsh-pet-wrap:active{cursor:grabbing}',
      '.pet-art{display:block;line-height:0;will-change:transform}',
      '.pet-svg{display:block;width:100%;height:auto;filter:drop-shadow(0 6px 10px rgba(0,0,0,.22))}',
      '.pet-bubble{position:absolute;bottom:calc(100% + 7px);left:50%;transform:translate(-50%,4px) scale(.94);transform-origin:50% 100%;white-space:nowrap;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#222);border:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.16));border-radius:12px;padding:4px 10px;font-size:11.5px;line-height:16px;box-shadow:0 5px 14px rgba(0,0,0,.16);opacity:0;transition:opacity .18s ease,transform .18s ease;pointer-events:none}',
      '.pet-bubble::after{content:"";position:absolute;left:50%;bottom:-4.5px;width:9px;height:9px;background:inherit;border-right:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.16));border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.16));border-bottom-right-radius:2px;transform:translateX(-50%) rotate(45deg)}',
      '#dsh-pet-root[data-side="below"] .pet-bubble{bottom:auto;top:calc(100% + 7px);transform-origin:50% 0}',
      '#dsh-pet-root[data-side="below"] .pet-bubble::after{bottom:auto;top:-4.5px;border-right:0;border-bottom:0;border-top:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.16));border-left:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.16));border-bottom-right-radius:0;border-top-left-radius:2px}',
      '#dsh-pet-root[data-bubble="on"] .pet-bubble{opacity:1;transform:translate(-50%,0) scale(1)}',
      '.pet-badge{position:absolute;right:-4px;bottom:-2px;min-width:16px;height:16px;padding:0 4px;border-radius:9px;background:var(--pet-accent);color:#fff;font-size:10px;line-height:16px;font-weight:600;text-align:center;box-shadow:0 2px 6px rgba(0,0,0,.2)}',
      '#dsh-pet-root[data-badge="off"] .pet-badge{display:none}',
      '.pet-fx>*{opacity:0}',
      '.pet-body{transform-origin:22px 31px;animation:pet-breathe 3.6s ease-in-out infinite}',
      '.pet-tail{transform-origin:32px 24px;animation:pet-sway 2.8s ease-in-out infinite}',
      '.pet-tent{transform-origin:22px 24px;animation:pet-tent 3.4s ease-in-out infinite}',
      '.pet-eye{transform-origin:center;animation:pet-blink 6.4s step-end infinite}',
      '.pet-led{animation:pet-led 2.4s ease-in-out infinite}',
      '.pet-glow{animation:pet-glow 3.4s ease-in-out infinite}',
      '@keyframes pet-breathe{0%,100%{transform:translateY(0) scaleY(1)}50%{transform:translateY(-1.1px) scaleY(1.03)}}',
      '@keyframes pet-sway{0%,100%{transform:rotate(-7deg)}50%{transform:rotate(9deg)}}',
      '@keyframes pet-tent{0%,100%{transform:translateX(-1px) skewX(3deg)}50%{transform:translateX(1px) skewX(-3deg)}}',
      '@keyframes pet-blink{0%,92%,100%{transform:scaleY(1)}95%{transform:scaleY(.12)}}',
      '@keyframes pet-led{0%,100%{opacity:1}50%{opacity:.35}}',
      '@keyframes pet-glow{0%,100%{opacity:.16}50%{opacity:.34}}',
      /* 干活：抖得快一点，尾巴甩出残影 */
      '#dsh-pet-root[data-state="work"] .pet-body{animation:pet-work .9s ease-in-out infinite}',
      '#dsh-pet-root[data-state="work"] .pet-tail{animation-duration:.55s}',
      '#dsh-pet-root[data-state="work"] .pet-tent{animation-duration:1.1s}',
      '@keyframes pet-work{0%,100%{transform:translateY(0) rotate(-1.4deg)}50%{transform:translateY(-2.2px) rotate(1.4deg)}}',
      /* 等你点头：上下点头 */
      '#dsh-pet-root[data-state="wait"] .pet-body{animation:pet-wait 1.6s ease-in-out infinite}',
      '@keyframes pet-wait{0%,100%{transform:translateY(0)}45%{transform:translateY(1.6px) scaleY(.98)}}',
      /* 收工：跳一下 + 撒花 */
      '#dsh-pet-root[data-state="done"] .pet-body{animation:pet-jump 1s cubic-bezier(.3,-.4,.4,1.4)}',
      '#dsh-pet-root[data-state="done"] .pet-spark{animation:pet-spark 1.1s ease-out both}',
      '#dsh-pet-root[data-state="done"] .pet-spark-2{animation-delay:.09s}',
      '#dsh-pet-root[data-state="done"] .pet-spark-3{animation-delay:.18s}',
      '@keyframes pet-jump{0%{transform:translateY(0)}32%{transform:translateY(-7px) scaleY(1.05)}68%{transform:translateY(0) scaleY(.94)}100%{transform:translateY(0) scaleY(1)}}',
      '@keyframes pet-spark{0%{opacity:0;transform:scale(.4) rotate(-18deg)}35%{opacity:1;transform:scale(1.05) rotate(6deg)}100%{opacity:0;transform:scale(.5) translateY(-7px) rotate(24deg)}}',
      /* 报错：冒烟 + 抖 */
      '#dsh-pet-root[data-state="error"] .pet-body{animation:pet-shake .34s ease-in-out 4}',
      '#dsh-pet-root[data-state="error"] .pet-smoke{animation:pet-smoke 1.4s ease-out both}',
      '@keyframes pet-shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-1.6px) rotate(-2deg)}75%{transform:translateX(1.6px) rotate(2deg)}}',
      '@keyframes pet-smoke{0%{opacity:0;transform:translateY(3px) scale(.7)}40%{opacity:1}100%{opacity:0;transform:translateY(-8px) scale(1.15)}}',
      /* 打盹：闭眼 + Zzz */
      '#dsh-pet-root[data-state="sleep"] .pet-eye{animation:none;transform:scaleY(.12)}',
      '#dsh-pet-root[data-state="sleep"] .pet-body{animation-duration:5.2s}',
      '#dsh-pet-root[data-state="sleep"] .pet-zzz{animation:pet-zzz 2.6s ease-in-out infinite}',
      '@keyframes pet-zzz{0%{opacity:0;transform:translateY(2px)}35%{opacity:1}100%{opacity:0;transform:translateY(-6px)}}',
      /* 摸头 */
      '#dsh-pet-root[data-state="pat"] .pet-heart{animation:pet-heart .9s ease-out both}',
      '#dsh-pet-root[data-state="pat"] .pet-body{animation:pet-jump .9s cubic-bezier(.3,-.4,.4,1.4)}',
      '@keyframes pet-heart{0%{opacity:0;transform:translateY(4px) scale(.5)}30%{opacity:1;transform:translateY(0) scale(1)}100%{opacity:0;transform:translateY(-9px) scale(.85)}}',
      /* 静默与无障碍 */
      '#dsh-pet-root[data-quiet="true"] *{animation:none !important}',
      '@media (prefers-reduced-motion: reduce){#dsh-pet-root *{animation:none !important}}',
      /* 设置行 */
      '.dsh-pet-group{border-bottom:.5px solid var(--dsw-alias-border-l2);flex-direction:column;gap:8px;padding:16px 0;display:flex}',
      '.dsh-pet-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}',
      '.dsh-pet-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.dsh-pet-row{flex-wrap:wrap;align-items:stretch;gap:8px;display:flex}',
      '.dsh-pet-cube{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-xl);font:inherit;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;flex-direction:column;flex:104px;justify-content:center;align-items:center;gap:4px;padding:10px 8px;font-size:13px;line-height:20px;display:flex}',
      '.dsh-pet-cube:hover:not(.dsh-pet-selected){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-pet-selected{background:var(--dsw-alias-bg-module-platform);border-color:var(--dsw-static-neutral-bluish-400)}',
      '.dsh-pet-thumb{width:40px;height:38px;display:block}',
      '.dsh-pet-hint{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}',
      '.dsh-pet-controls{flex-wrap:wrap;align-items:center;gap:16px;display:flex}',
      '.dsh-pet-segrow{align-items:center;gap:6px;display:flex}',
      '.dsh-pet-seglabel{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.dsh-pet-seg{border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);overflow:hidden;display:inline-flex}',
      '.dsh-pet-segbtn{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:0;padding:3px 10px;font-size:12px;line-height:18px}',
      '.dsh-pet-segbtn+.dsh-pet-segbtn{border-left:.5px solid var(--dsw-alias-border-l4)}',
      '.dsh-pet-segbtn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-pet-segbtn-on{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary)}',
      '.dsh-pet-sizerow{align-items:center;gap:8px;display:flex}',
      // 步进胶囊：规格照抄外壳的「正文字号」行（36px 高、圆角 md、module-platform 底、
      // hover/focus 才露出右侧上下小箭头），这样它在通用设置里和原生控件是同一套观感
      '.dsh-pet-stepper{border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);box-sizing:border-box;justify-content:center;align-items:center;min-width:72px;height:36px;display:inline-flex;position:relative}',
      '.dsh-pet-value{text-align:center;font-variant-numeric:tabular-nums;min-width:26px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}',
      '.dsh-pet-unit{color:var(--dsw-alias-label-secondary);font-size:14px;line-height:22px}',
      '.dsh-pet-arrows{opacity:0;flex-direction:column;gap:2px;display:flex;position:absolute;right:8px}',
      '.dsh-pet-stepper:hover .dsh-pet-arrows,.dsh-pet-stepper:focus-within .dsh-pet-arrows{opacity:1}',
      '.dsh-pet-arrow{border-radius:var(--dsw-radius-xs);background:color-mix(in srgb, var(--dsw-alias-bg-layer-1) 75%, transparent);width:17px;height:12px;color:var(--dsw-alias-label-primary);cursor:pointer;border:none;justify-content:center;align-items:center;padding:0;display:inline-flex}',
      '.dsh-pet-arrow:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1)}',
      '.dsh-pet-arrow:disabled{color:var(--dsw-alias-label-caption);cursor:default}',
      '.dsh-pet-toggle{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);align-items:center;gap:6px;padding:3px 8px 3px 10px;font-size:12px;line-height:18px;display:inline-flex}',
      '.dsh-pet-toggle:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-pet-toggle-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-dimmed);flex:none}',
      '.dsh-pet-toggle-on{color:var(--dsw-alias-label-primary);border-color:var(--dsw-static-neutral-bluish-400)}',
      '.dsh-pet-toggle-on .dsh-pet-toggle-dot{background:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary))}',
      '.dsh-pet-stats{color:var(--dsw-alias-label-caption);font-size:12px;line-height:18px}'
    ].join('\n')

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
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /* ---------------------------------------------------------------------
     * 4. 偏好（localStorage）
     * ------------------------------------------------------------------- */
    function defaultPrefs() {
      return { pet: 'cat', scale: SCALE.default, corner: 'br', link: true, quiet: false, hidden: false, roam: true, x: null, y: null }
    }

    /** 旧版存的是 small/medium/large 档位，这里平滑迁移到像素值。 */
    const LEGACY_SIZES = { small: 40, medium: 64, large: 96 }

    function normalizePrefs(raw) {
      const base = defaultPrefs()
      if (raw === null || typeof raw !== 'object') return base
      const pick = (list, value, fallback) => (list.some((item) => item.id === value) ? value : fallback)
      const int = (value) => (typeof value === 'number' && isFinite(value) ? Math.round(value) : null)
      const scale = (() => {
        const candidate = raw.scale !== undefined ? raw.scale : raw.size
        if (typeof candidate === 'string' && LEGACY_SIZES[candidate] !== undefined) return LEGACY_SIZES[candidate]
        const value = Number(candidate)
        if (!isFinite(value) || value <= 0) return base.scale
        return Math.min(SCALE.max, Math.max(SCALE.min, Math.round(value)))
      })()
      return {
        pet: pick(PETS, raw.pet, base.pet),
        scale: scale,
        corner: pick(CORNERS, raw.corner, base.corner),
        link: raw.link !== false,
        quiet: raw.quiet === true,
        hidden: raw.hidden === true,
        roam: raw.roam !== false,
        x: int(raw.x),
        y: int(raw.y)
      }
    }

    function readStored() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        return raw === null ? null : JSON.parse(raw)
      } catch (error) {
        return null
      }
    }

    function writeStored(prefs) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
      } catch (error) {
        /* 隐私模式等写不进去时忽略：偏好只在本次会话内生效 */
      }
    }

    /* ---------------------------------------------------------------------
     * 5. 状态推导：把活动快照映射成六种表情
     * ------------------------------------------------------------------- */
    function deriveState(activity, now, local) {
      const a = activity || {}
      if (local && local.patAt !== null && now - local.patAt < 1500 && a.awaitingApproval !== true && a.running !== true) return 'pat'
      if (a.awaitingApproval === true) return 'wait'
      const error = a.lastError
      if (error && typeof error.at === 'number' && now - error.at < ERROR_SHOW_MS) return 'error'
      if (a.running === true || Number(a.activeTools) > 0) return 'work'
      if (typeof a.lastTurnEndAt === 'number' && now - a.lastTurnEndAt < DONE_SHOW_MS) return 'done'
      const last = Math.max(
        Number(a.lastTurnEndAt) || 0,
        (a.lastTool && Number(a.lastTool.at)) || 0,
        Number(a.startedAt) || 0
      )
      if (last > 0 && now - last > SLEEP_AFTER_MS) return 'sleep'
      return 'idle'
    }

    /**
     * 工具名 → 一句人话。
     * 气泡里绝不直接吐 `read_image` 这种原名：先查表，查不到再按名字里的
     * 关键词归类，最后兜底成「忙活着」。
     */
    const TOOL_LABELS = {
      read: '翻文件',
      read_image: '看图',
      write: '写文件',
      edit: '改代码',
      glob: '翻目录',
      grep: '找东西',
      bash: '敲命令',
      pwsh: '敲命令',
      shell: '敲命令',
      terminal_open: '开终端',
      terminal_read: '看终端',
      terminal_list: '数终端',
      web_search: '搜网页',
      web_fetch: '抓网页',
      subagent: '派小弟',
      subagent_fork: '派小弟',
      send_message: '传话',
      list_agents: '点个名',
      wait_agent: '等小弟',
      workflow: '开流水线',
      todo_write: '列清单',
      ask_user_question: '问你',
      present: '交作业',
      skill: '翻技能',
      job_list: '看任务',
      job_output: '看日志',
      job_kill: '停任务',
      create_goal: '立目标',
      update_goal: '改目标',
      get_goal: '看目标',
      list_subagent_models: '挑模型',
      session_search: '翻旧账',
      session_event_search: '翻旧账',
      schedule_create: '排日程',
      schedule_list: '看日程',
      cordis_inspect_list: '摸插件',
      cordis_inspect_query: '问插件',
      spawn_teammate: '拉队友',
      team_task_create: '派活',
      team_task_list: '看板子'
    }

    function toolLabel(name) {
      const raw = String(name === undefined || name === null ? '' : name).trim()
      if (raw === '') return '忙活着'
      const key = raw.toLowerCase()
      if (TOOL_LABELS[key] !== undefined) return TOOL_LABELS[key]
      // MCP 工具名形如 mcp__server__tool，取最后一段再看一眼
      const tail = key.indexOf('__') >= 0 ? key.slice(key.lastIndexOf('__') + 2) : key
      if (TOOL_LABELS[tail] !== undefined) return TOOL_LABELS[tail]
      if (key.indexOf('image') >= 0 || key.indexOf('vision') >= 0 || key.indexOf('screenshot') >= 0) return '看图'
      if (key.indexOf('web') >= 0 || key.indexOf('fetch') >= 0 || key.indexOf('http') >= 0) return '上网'
      if (key.indexOf('search') >= 0 || key.indexOf('find') >= 0) return '找东西'
      if (key.indexOf('read') >= 0 || key.indexOf('open') >= 0) return '翻文件'
      if (key.indexOf('write') >= 0 || key.indexOf('edit') >= 0 || key.indexOf('patch') >= 0) return '改文件'
      if (key.indexOf('shell') >= 0 || key.indexOf('exec') >= 0 || key.indexOf('command') >= 0) return '敲命令'
      if (key.indexOf('agent') >= 0 || key.indexOf('team') >= 0) return '派小弟'
      return '忙活着'
    }

    /** 状态 → 气泡文案；干活时显示「正在做的事」而不是工具原名。 */
    function bubbleText(state, activity, now) {
      const a = activity || {}
      if (state === 'work') {
        const tool = a.lastTool
        if (tool && typeof tool.at === 'number' && now - tool.at < 12000) return toolLabel(tool.name) + '…'
        return '干活中…'
      }
      if (state === 'wait') return '等你点头'
      if (state === 'done') return '收工啦'
      if (state === 'error') return '呜…出错了'
      if (state === 'sleep') return '呼…呼…'
      if (state === 'pat') return '嘿嘿'
      return ''
    }

    /** 宠物等级：按累计 token 粗算，5 万 token 一级。 */
    function petLevel(activity) {
      const tokens = Number((activity || {}).tokens) || 0
      return 1 + Math.floor(tokens / 50000)
    }

    function petStats(activity) {
      const a = activity || {}
      const tokens = Number(a.tokens) || 0
      const shown = tokens >= 10000 ? (tokens / 1000).toFixed(0) + 'k' : String(tokens)
      return '等级 ' + petLevel(a) + ' · 回合 ' + (Number(a.turns) || 0) + ' · 工具 ' + (Number(a.toolCalls) || 0) + ' · ' + shown + ' token'
    }

    /** 从 body 上读皮肤强调色（dsh-skins 暴露的 --dsw-skin-accent）。 */
    function readAccent(element) {
      if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return null
      const target = element || document.body
      if (!target) return null
      try {
        const value = window.getComputedStyle(target).getPropertyValue('--dsw-skin-accent')
        const trimmed = String(value || '').trim()
        return trimmed === '' ? null : trimmed
      } catch (error) {
        return null
      }
    }

    /* ---------------------------------------------------------------------
     * 6. 运行时
     *
     * 一个实例管一只宠物：挂载 / 轮询 / 摆放 / 交互 / 偏好持久化，
     * 并把 `{ list, get, set, patch, subscribe }` 作为 `pets` 服务对外暴露。
     * ------------------------------------------------------------------- */
    class PetRuntime {
      constructor() {
        this.prefs = normalizePrefs(readStored())
        this.listeners = new Set()
        this.host = null
        this.root = null
        this.art = null
        this.bubble = null
        this.badge = null
        this.activity = null
        this.patAt = null
        this.signature = ''
        this.timer = null
        this.onVisibility = null
        this.drag = null
        // 运动状态：dx/dy 是相对"家"的偏移，facing 用来左右翻面
        this.motion = {
          last: 0,
          dx: 0,
          dy: 0,
          bob: 0,
          facing: 1,
          phase: 'rest',
          restUntil: 0,
          target: null,
          hopFrom: 0,
          hopTo: 0,
          hopStarted: 0
        }
        this.raf = null
        this.reducedMotion = false
      }

      list() {
        return PETS.map((pet) => ({ id: pet.id, name: pet.name, hint: pet.hint, swatch: pet.swatch.slice() }))
      }

      get() {
        return this.prefs.pet
      }

      getPrefs() {
        return Object.assign({}, this.prefs)
      }

      peekAccent() {
        return this.prefs.link ? readAccent() : null
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
            listener(this.prefs)
          } catch (error) {
            /* 单个订阅者出错不影响宠物本身 */
          }
        }
      }

      patch(patch) {
        this.prefs = normalizePrefs(Object.assign({}, this.prefs, patch))
        writeStored(this.prefs)
        this.apply()
        this.notify()
      }

      setPet(id) {
        this.patch({ pet: id })
      }

      /**
       * 尺寸微调：步进胶囊的上下箭头走这里。
       * 基于 this.prefs 现算，所以长按连发也不会踩到过期的闭包值。
       */
      nudgeScale(delta) {
        const next = Math.min(SCALE.max, Math.max(SCALE.min, this.prefs.scale + delta))
        if (next !== this.prefs.scale) this.patch({ scale: next })
        return next
      }

      /** 双击换下一只。 */
      cycle(step) {
        const index = PETS.findIndex((pet) => pet.id === this.prefs.pet)
        const next = PETS[(index + (step || 1) + PETS.length) % PETS.length]
        this.patch({ pet: next.id })
        return next.id
      }

      attach(hostElement) {
        if (this.root !== null) this.detach()
        if (typeof document === 'undefined' || !hostElement) return
        this.host = hostElement

        const root = document.createElement('div')
        root.id = 'dsh-pet-root'
        const wrap = document.createElement('div')
        wrap.className = 'dsh-pet-wrap'
        const bubble = document.createElement('div')
        bubble.className = 'pet-bubble'
        const art = document.createElement('div')
        art.className = 'pet-art'
        const badge = document.createElement('div')
        badge.className = 'pet-badge'
        wrap.appendChild(bubble)
        wrap.appendChild(art)
        wrap.appendChild(badge)
        root.appendChild(wrap)
        hostElement.appendChild(root)

        this.root = root
        this.art = art
        this.bubble = bubble
        this.badge = badge
        this.signature = ''
        this.reducedMotion = this.detectReducedMotion()
        this.bindPointer(wrap)
        this.startPolling()
        this.apply()
        this.startMotion()
      }

      detectReducedMotion() {
        try {
          return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches === true
        } catch (error) {
          return false
        }
      }

      detach() {
        this.stopPolling()
        this.stopMotion()
        if (this.root !== null && this.root.parentNode) this.root.parentNode.removeChild(this.root)
        this.root = null
        this.art = null
        this.bubble = null
        this.badge = null
        this.host = null
      }

      dispose() {
        this.detach()
        this.listeners.clear()
      }

      /** 拖动 + 点击（摸头）+ 双击（换一只）。 */
      bindPointer(wrap) {
        const self = this
        const rect = () => {
          const box = self.root.getBoundingClientRect()
          return { left: box.left, top: box.top, width: box.width, height: box.height }
        }
        const clamp = (value, min, max) => Math.min(Math.max(value, min), max)

        wrap.addEventListener('pointerdown', (event) => {
          if (typeof event.button === 'number' && event.button !== 0) return
          // 先把漂移归零再量位置：否则 getBoundingClientRect 带上了位移，拖起来会跳
          self.motion.dx = 0
          self.motion.dy = 0
          self.motion.bob = 0
          self.motion.phase = 'rest'
          self.motion.restUntil = 0
          self.applyMotion()
          const box = rect()
          self.drag = { id: event.pointerId, x0: event.clientX, y0: event.clientY, left: box.left, top: box.top, width: box.width, height: box.height, moved: false }
          try {
            wrap.setPointerCapture(event.pointerId)
          } catch (error) {
            /* 捕获失败也能靠 window 上的监听继续拖 */
          }
          event.preventDefault()
        })

        wrap.addEventListener('pointermove', (event) => {
          const drag = self.drag
          if (drag === null || drag.id !== event.pointerId) return
          const dx = event.clientX - drag.x0
          const dy = event.clientY - drag.y0
          if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true
          if (!drag.moved) return
          const maxX = Math.max(8, window.innerWidth - drag.width - 8)
          const maxY = Math.max(8, window.innerHeight - drag.height - 8)
          const left = clamp(drag.left + dx, 8, maxX)
          const top = clamp(drag.top + dy, 8, maxY)
          drag.lastX = Math.round(left)
          drag.lastY = Math.round(top)
          self.root.style.left = left + 'px'
          self.root.style.top = top + 'px'
          self.root.style.right = 'auto'
          self.root.style.bottom = 'auto'
        })

        const finish = (event) => {
          const drag = self.drag
          if (drag === null || drag.id !== event.pointerId) return
          self.drag = null
          self.motion.last = 0
          if (drag.moved && typeof drag.lastX === 'number') {
            self.patch({ x: drag.lastX, y: drag.lastY })
          } else {
            self.patAt = Date.now()
            self.apply()
            window.setTimeout(() => self.apply(), 1600)
          }
        }
        wrap.addEventListener('pointerup', finish)
        wrap.addEventListener('pointercancel', () => {
          self.drag = null
        })
        wrap.addEventListener('dblclick', () => {
          self.cycle(1)
        })
      }

      startPolling() {
        if (this.timer !== null || typeof window === 'undefined') return
        const tick = () => {
          if (document.hidden === true) return
          this.refresh()
        }
        tick()
        this.timer = window.setInterval(tick, POLL_MS)
        this.onVisibility = () => {
          if (document.hidden !== true) this.refresh()
        }
        document.addEventListener('visibilitychange', this.onVisibility)
      }

      stopPolling() {
        if (this.timer !== null) {
          window.clearInterval(this.timer)
          this.timer = null
        }
        if (this.onVisibility !== null) {
          document.removeEventListener('visibilitychange', this.onVisibility)
          this.onVisibility = null
        }
      }

      async refresh() {
        try {
          const response = await fetch(ACTIVITY_URL, { cache: 'no-store' })
          if (!response.ok) throw new Error('HTTP ' + response.status)
          this.activity = await response.json()
        } catch (error) {
          this.activity = null
        }
        this.apply()
      }

      /** "家"的像素坐标：角落按边距算，拖动过就用记下的绝对坐标。 */
      anchorFor(prefs, size) {
        const width = size.width
        const height = size.height
        const clampX = (value) => Math.min(Math.max(value, 10), Math.max(10, window.innerWidth - width - 10))
        const clampY = (value) => Math.min(Math.max(value, 8), Math.max(8, window.innerHeight - height - 10))
        if (prefs.x !== null && prefs.y !== null) return { x: clampX(prefs.x), y: clampY(prefs.y) }
        const corner = CORNERS.find((item) => item.id === prefs.corner) || CORNERS[0]
        const marginX = 16
        const marginY = corner.y === 'top' ? 56 : 18
        return {
          x: clampX(corner.x === 'left' ? marginX : window.innerWidth - marginX - width),
          y: clampY(corner.y === 'top' ? marginY : window.innerHeight - marginY - height)
        }
      }

      place(root, prefs) {
        const size = { width: root.offsetWidth || 60, height: root.offsetHeight || 60 }
        const anchor = this.anchorFor(prefs, size)
        root.style.left = anchor.x + 'px'
        root.style.top = anchor.y + 'px'
        root.style.right = 'auto'
        root.style.bottom = 'auto'
      }

      /* ---------------- 运动 ---------------- */

      startMotion() {
        if (this.raf !== null || typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') return
        const tick = (stamp) => {
          this.raf = window.requestAnimationFrame(tick)
          this.stepMotion(typeof stamp === 'number' ? stamp : Date.now())
        }
        this.motion.last = 0
        this.raf = window.requestAnimationFrame(tick)
      }

      stopMotion() {
        if (this.raf !== null) {
          window.cancelAnimationFrame(this.raf)
          this.raf = null
        }
      }

      /** 一帧运动：算偏移与上下浮动，然后写进 transform。 */
      stepMotion(stamp) {
        if (this.root === null) return
        const m = this.motion
        if (m.last === 0) m.last = stamp
        const dt = Math.min(0.064, Math.max(0, (stamp - m.last) / 1000))
        m.last = stamp

        const prefs = this.prefs
        const pet = PETS.find((item) => item.id === prefs.pet) || PETS[0]
        const profile = motionProfile(pet)
        const busy = this.drag !== null || this.patAt !== null
        const allowed = motionEnabled(prefs, {
          reducedMotion: this.reducedMotion,
          hidden: typeof document !== 'undefined' && document.hidden === true,
          busy: busy
        })

        if (!allowed) {
          m.dx = 0
          m.dy = 0
          m.bob = 0
          m.phase = 'rest'
          m.restUntil = 0
          m.target = null
          this.applyMotion()
          return
        }

        const size = { width: this.root.offsetWidth || 60, height: this.root.offsetHeight || 60 }
        const anchor = this.anchorFor(prefs, size)
        const bounds = homeBounds(anchor, size, profile, { width: window.innerWidth, height: window.innerHeight })
        const now = stamp

        if (profile.kind === 'glide') {
          const offset = glideOffset(profile, bounds, now / 1000)
          m.dx = offset.dx
          m.dy = offset.dy
          if (profile.flip === true && Math.abs(offset.vx) > 0.08) m.facing = offset.vx >= 0 ? 1 : -1
        } else if (profile.kind === 'hop') {
          if (m.phase === 'rest') {
            if (now >= m.restUntil) {
              const target = pickTarget(bounds, null)
              m.hopFrom = m.dx
              m.hopTo = target.x
              m.dy = target.y
              m.hopStarted = now
              m.phase = 'hop'
            }
          } else {
            const progress = Math.min(1, (now - m.hopStarted) / profile.hopMs)
            m.dx = m.hopFrom + (m.hopTo - m.hopFrom) * progress
            m.dy = m.dy - (profile.arc || 10) * Math.sin(Math.PI * progress) * 0.5
            if (progress >= 1) {
              m.dx = m.hopTo
              m.phase = 'rest'
              const rest = profile.restMs || [1000, 3000]
              m.restUntil = now + rest[0] + Math.random() * (rest[1] - rest[0])
            }
          }
          if (profile.flip === true && Math.abs(m.hopTo - m.hopFrom) > 4) m.facing = m.hopTo >= m.hopFrom ? 1 : -1
        } else {
          // walk / hover：走到随机目标点，到了就歇一会儿
          if (m.phase === 'rest') {
            if (now >= m.restUntil) {
              m.target = pickTarget(bounds, null)
              m.phase = 'move'
            }
          }
          if (m.phase === 'move' && m.target !== null) {
            const ddx = m.target.x - m.dx
            const ddy = m.target.y - m.dy
            const distance = Math.sqrt(ddx * ddx + ddy * ddy)
            const stride = profile.speed * dt
            if (distance <= Math.max(1.5, stride)) {
              m.dx = m.target.x
              m.dy = m.target.y
              m.phase = 'rest'
              const rest = profile.restMs || [1500, 4000]
              m.restUntil = now + rest[0] + Math.random() * (rest[1] - rest[0])
            } else {
              m.dx += (ddx / distance) * stride
              m.dy += (ddy / distance) * stride
              if (profile.flip === true && Math.abs(ddx) > 3) m.facing = ddx >= 0 ? 1 : -1
            }
          }
        }

        // 上下浮动：走路/游动时更明显一点
        m.bob = profile.bob ? Math.sin((now / profile.bobMs) * Math.PI * 2) * profile.bob : 0
        this.applyMotion()
      }

      applyMotion() {
        if (this.root === null) return
        const m = this.motion
        const moved = Math.abs(m.dx) > 0.05 || Math.abs(m.dy) > 0.05
        this.root.style.transform = moved
          ? 'translate3d(' + m.dx.toFixed(2) + 'px,' + m.dy.toFixed(2) + 'px,0)'
          : ''
        if (this.art !== null) {
          const parts = []
          if (Math.abs(m.bob) > 0.05) parts.push('translateY(' + m.bob.toFixed(2) + 'px)')
          if (m.facing < 0) parts.push('scaleX(-1)')
          const next = parts.join(' ')
          if (this.art.style.transform !== next) this.art.style.transform = next
        }
      }

      apply() {
        if (this.root === null) return
        const prefs = this.prefs
        const now = Date.now()
        const pet = PETS.find((item) => item.id === prefs.pet) || PETS[0]
        const px = prefs.scale
        const accent = prefs.link ? readAccent() : null

        const signature = pet.id + '|' + px + '|' + String(accent)
        if (signature !== this.signature) {
          this.art.innerHTML = renderPet(pet, { accent: accent })
          const svg = this.art.firstChild
          if (svg !== null && svg !== undefined) {
            svg.setAttribute('width', String(px))
            svg.setAttribute('height', String(Math.round((px * 42) / 44)))
          }
          this.signature = signature
        }

        const state = prefs.quiet === true ? 'idle' : deriveState(this.activity, now, { patAt: this.patAt })
        this.root.dataset.state = state
        this.root.dataset.quiet = String(prefs.quiet === true)
        this.root.dataset.hidden = String(prefs.hidden === true)
        // 宠物贴顶时把对话框翻到下方，尾巴朝上，别顶着窗口标题栏
        const nearTop = prefs.x !== null && prefs.y !== null
          ? prefs.y < 150
          : prefs.corner === 'tr' || prefs.corner === 'tl'
        this.root.dataset.side = nearTop ? 'below' : 'above'

        const text = prefs.quiet === true ? '' : bubbleText(state, this.activity, now)
        if (this.bubble.textContent !== text) this.bubble.textContent = text
        this.root.dataset.bubble = text === '' ? 'off' : 'on'

        const subagents = Number((this.activity || {}).subagents) || 0
        const badge = subagents > 0 ? '×' + subagents : ''
        if (this.badge.textContent !== badge) this.badge.textContent = badge
        this.root.dataset.badge = badge === '' ? 'off' : 'on'

        this.root.title = pet.name + ' · ' + petStats(this.activity)
        this.place(this.root, prefs)
      }
    }

    /* ---------------------------------------------------------------------
     * 7. 设置行（「通用」分区，紧跟皮肤之后）
     * ------------------------------------------------------------------- */
    let runtimeRef = null

    function PetCube(props) {
      const pet = props.pet
      const active = props.active
      return react.createElement(
        'button',
        {
          type: 'button',
          className: 'dsh-pet-cube' + (active ? ' dsh-pet-selected' : ''),
          'aria-pressed': active,
          title: pet.hint,
          onClick: props.onPick
        },
        react.createElement('span', {
          className: 'dsh-pet-thumb',
          dangerouslySetInnerHTML: { __html: renderPet(pet, { accent: props.accent }) }
        }),
        react.createElement('span', { className: 'dsh-pet-name' }, pet.name),
        react.createElement('span', { className: 'dsh-pet-hint' }, pet.hint)
      )
    }

    function PetSeg(props) {
      return react.createElement(
        'div',
        { className: 'dsh-pet-segrow' },
        react.createElement('span', { className: 'dsh-pet-seglabel' }, props.label),
        react.createElement(
          'div',
          { className: 'dsh-pet-seg' },
          props.items.map((item) =>
            react.createElement(
              'button',
              {
                key: item.id,
                type: 'button',
                className: 'dsh-pet-segbtn' + (props.value === item.id ? ' dsh-pet-segbtn-on' : ''),
                'aria-pressed': props.value === item.id,
                onClick: () => props.onPick(item.id)
              },
              item.name
            )
          )
        )
      )
    }

    function PetToggle(props) {
      return react.createElement(
        'button',
        {
          type: 'button',
          className: 'dsh-pet-toggle' + (props.on ? ' dsh-pet-toggle-on' : ''),
          'aria-pressed': props.on,
          onClick: props.onToggle
        },
        react.createElement('span', null, props.label),
        react.createElement('span', { className: 'dsh-pet-toggle-dot' })
      )
    }

    /** 9px 的上下箭头，跟外壳 primitives 里的 chevron 图标同款。 */
    function chevron(direction) {
      return react.createElement(
        'svg',
        {
          width: 9,
          height: 9,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true
        },
        react.createElement('path', { d: direction === 'up' ? 'M4 10.2 L8 6 L12 10.2' : 'M4 5.8 L8 10 L12 5.8' })
      )
    }

    /**
     * 步进胶囊（照抄外壳「正文字号」那一行的控件）：
     * 居中的数值 + hover/focus 才出现的上下箭头，按住箭头会连发。
     */
    function PetStepper(props) {
      const timer = react.useRef(null)
      const stop = () => {
        if (timer.current !== null) {
          window.clearTimeout(timer.current)
          window.clearInterval(timer.current)
          timer.current = null
        }
      }
      const begin = (delta) => {
        stop()
        props.onStep(delta)
        timer.current = window.setTimeout(() => {
          timer.current = window.setInterval(() => props.onStep(delta), 90)
        }, 420)
      }
      react.useEffect(() => stop, [])
      const arrow = (direction, delta, disabled, label) =>
        react.createElement(
          'button',
          {
            type: 'button',
            className: 'dsh-pet-arrow',
            'aria-label': label,
            disabled: disabled,
            onPointerDown: () => begin(delta),
            onPointerUp: stop,
            onPointerLeave: stop,
            onPointerCancel: stop,
            onBlur: stop
          },
          chevron(direction)
        )
      return react.createElement(
        'div',
        { className: 'dsh-pet-stepper' },
        react.createElement('span', { className: 'dsh-pet-value' }, String(props.value)),
        react.createElement(
          'span',
          { className: 'dsh-pet-arrows' },
          arrow('up', props.step, props.value >= props.max, '放大一点'),
          arrow('down', -props.step, props.value <= props.min, '缩小一点')
        )
      )
    }

    function PetRow() {
      const runtime = runtimeRef
      const [prefs, setPrefs] = react.useState(runtime === null ? defaultPrefs() : runtime.getPrefs())

      react.useEffect(() => {
        if (runtime === null) return undefined
        setPrefs(runtime.getPrefs())
        return runtime.subscribe(() => setPrefs(runtime.getPrefs()))
      }, [])

      const patch = (value) => {
        if (runtime !== null) runtime.patch(value)
      }
      const accent = runtime === null ? null : runtime.peekAccent()

      return react.createElement(
        'div',
        { className: 'dsh-pet-group' },
        react.createElement('div', { className: 'dsh-pet-title' }, '宠物'),
        react.createElement(
          'div',
          { className: 'dsh-pet-desc' },
          '一只住在浮层里的小家伙：跟着皮肤换色，也跟着 Agent 干活、等待授权、报错和收工换表情。点一下摸摸头，双击换一只，按住可以拖到任意位置。'
        ),
        react.createElement(
          'div',
          { className: 'dsh-pet-row' },
          PETS.map((pet) =>
            react.createElement(PetCube, {
              key: pet.id,
              pet: pet,
              accent: accent,
              active: prefs.pet === pet.id,
              onPick: () => patch({ pet: pet.id })
            })
          )
        ),
        react.createElement(
          'div',
          { className: 'dsh-pet-controls' },
          react.createElement(
            'div',
            { className: 'dsh-pet-sizerow' },
            react.createElement('span', { className: 'dsh-pet-seglabel' }, '大小'),
            react.createElement(PetStepper, {
              value: prefs.scale,
              min: SCALE.min,
              max: SCALE.max,
              step: SCALE.step,
              onStep: (delta) => {
                if (runtime !== null) runtime.nudgeScale(delta)
              }
            }),
            react.createElement('span', { className: 'dsh-pet-unit' }, 'px'),
            react.createElement(
              'div',
              { className: 'dsh-pet-seg' },
              SIZE_PRESETS.map((item) =>
                react.createElement(
                  'button',
                  {
                    key: item.px,
                    type: 'button',
                    className: 'dsh-pet-segbtn' + (prefs.scale === item.px ? ' dsh-pet-segbtn-on' : ''),
                    'aria-pressed': prefs.scale === item.px,
                    onClick: () => patch({ scale: item.px })
                  },
                  item.name
                )
              )
            )
          ),
          react.createElement(PetSeg, {
            label: '位置',
            items: CORNERS.map((item) => ({ id: item.id, name: item.name })),
            value: prefs.x === null ? prefs.corner : '',
            onPick: (id) => patch({ corner: id, x: null, y: null })
          }),
          react.createElement(PetToggle, {
            label: '走动',
            on: prefs.roam,
            onToggle: () => patch({ roam: !prefs.roam })
          }),
          react.createElement(PetToggle, {
            label: '跟随皮肤',
            on: prefs.link,
            onToggle: () => patch({ link: !prefs.link })
          }),
          react.createElement(PetToggle, {
            label: '静默',
            on: prefs.quiet,
            onToggle: () => patch({ quiet: !prefs.quiet })
          }),
          react.createElement(PetToggle, {
            label: '显示',
            on: !prefs.hidden,
            onToggle: () => patch({ hidden: !prefs.hidden })
          })
        ),
        react.createElement(
          'div',
          { className: 'dsh-pet-stats' },
          runtime === null ? '' : petStats(runtime.activity)
        )
      )
    }

    /** 浮层宿主：只渲染一个空容器，宠物的 DOM 由运行时挂进去。 */
    function PetLayer() {
      const ref = react.useRef(null)
      react.useEffect(() => {
        const element = ref.current
        if (element === null || runtimeRef === null) return undefined
        runtimeRef.attach(element)
        return () => {
          if (runtimeRef !== null) runtimeRef.detach()
        }
      }, [])
      return react.createElement('div', { ref: ref, className: OVERLAY_CLASS })
    }

    /* ---------------------------------------------------------------------
     * 6. 运动
     *
     * 空闲时宠物会真的在屏幕上溜达：鱼是滑行（正弦轨迹，所以看起来像在游），
     * 史莱姆是一跳一跳，猫狗是踱几步歇一会儿，机器人是慢慢飘。
     * 运动只是给根节点加一个 transform 偏移，所以"家"（角落 / 拖到的位置）
     * 始终是用户定的那个点，走动范围围着家、贴着视口边。
     * ------------------------------------------------------------------- */
    const RIG_MOTION = {
      quad: { kind: 'walk', speed: 26, spanX: 130, spanY: 8, bob: 1.5, bobMs: 300, restMs: [1600, 5000], flip: true },
      fish: { kind: 'glide', spanX: 150, spanY: 40, rateX: 0.26, rateY: 0.34, bob: 2.2, bobMs: 900, flip: true },
      blob: { kind: 'hop', speed: 34, spanX: 110, spanY: 0, hopMs: 300, arc: 12, restMs: [900, 2600], flip: true },
      bot: { kind: 'hover', speed: 14, spanX: 100, spanY: 26, bob: 2.6, bobMs: 1500, restMs: [2200, 5200], flip: false }
    }

    function motionProfile(pet) {
      const base = RIG_MOTION[pet.rig] || RIG_MOTION.quad
      return Object.assign({}, base, pet.move || {})
    }

    /** 是否允许走动：用户开关 + 静默 + 系统「减少动态效果」+ 页面可见。 */
    function motionEnabled(prefs, context) {
      const option = context || {}
      if (prefs.roam === false) return false
      if (prefs.quiet === true) return false
      if (option.reducedMotion === true) return false
      if (option.hidden === true) return false
      if (option.busy === true) return false
      return true
    }

    /** 以"家"为原点，算出允许漂移的范围（并夹在视口内）。 */
    function homeBounds(anchor, size, profile, viewport) {
      const marginX = 10
      const marginTop = 8
      const marginBottom = 10
      const minDx = Math.max(-profile.spanX, marginX - anchor.x)
      const maxDx = Math.min(profile.spanX, viewport.width - marginX - size.width - anchor.x)
      const minDy = Math.max(-(profile.spanY || 0), marginTop - anchor.y)
      const maxDy = Math.min(profile.spanY || 0, viewport.height - marginBottom - size.height - anchor.y)
      return {
        minDx: Math.min(minDx, maxDx),
        maxDx: Math.max(minDx, maxDx),
        minDy: Math.min(minDy, maxDy),
        maxDy: Math.max(minDy, maxDy)
      }
    }

    /** 滑行轨迹（正弦）：纯函数，便于测试；返回偏移与水平速度方向。 */
    function glideOffset(profile, bounds, seconds) {
      const spanX = (bounds.maxDx - bounds.minDx) / 2
      const spanY = (bounds.maxDy - bounds.minDy) / 2
      const centerX = (bounds.maxDx + bounds.minDx) / 2
      const centerY = (bounds.maxDy + bounds.minDy) / 2
      const dx = centerX + Math.sin(seconds * profile.rateX) * spanX
      const dy = centerY + Math.sin(seconds * profile.rateY + 1.2) * spanY
      const vx = Math.cos(seconds * profile.rateX)
      return { dx: dx, dy: dy, vx: vx }
    }

    /** 取下一个溜达目标（纯函数，传入随机数便于测试）。 */
    function pickTarget(bounds, random) {
      const r = typeof random === 'function' ? random() : Math.random()
      const r2 = typeof random === 'function' ? random() : Math.random()
      return {
        x: bounds.minDx + r * (bounds.maxDx - bounds.minDx),
        y: bounds.minDy + r2 * (bounds.maxDy - bounds.minDy)
      }
    }

    /* __PET_MOTION_RUNTIME__ */

    /* ---------------------------------------------------------------------
     * 8. 插件体
     * ------------------------------------------------------------------- */
    const inject = ['slots']

    function apply(ctx) {
      installStyleSheet()

      const runtime = new PetRuntime()
      runtimeRef = runtime

      ctx.effect(() => ctx.provide('pets', runtime), 'dsh-pet: pets service')
      ctx.effect(() => () => runtime.dispose(), 'dsh-pet: runtime teardown')

      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register({ name: 'shell.overlay', id: 'pet', order: 60, label: '桌面宠物' }, PetLayer)
      )
      ctx.slots.inject('settings.general.item', () =>
        ctx.slots.register({ name: 'settings.general.item', id: 'pet', order: 14, label: '宠物' }, PetRow)
      )
    }

    exports.apply = apply
    exports.inject = inject
    // 测试与二次开发用的内部视图（不参与插件装配）。
    exports.petInternals = {
      PETS: PETS,
      SCALE: SCALE,
      SIZE_PRESETS: SIZE_PRESETS,
      CORNERS: CORNERS,
      CSS: CSS,
      renderPet: renderPet,
      deriveState: deriveState,
      bubbleText: bubbleText,
      toolLabel: toolLabel,
      TOOL_LABELS: TOOL_LABELS,
      RIG_MOTION: RIG_MOTION,
      motionProfile: motionProfile,
      motionEnabled: motionEnabled,
      homeBounds: homeBounds,
      glideOffset: glideOffset,
      pickTarget: pickTarget,
      petLevel: petLevel,
      petStats: petStats,
      normalizePrefs: normalizePrefs,
      defaultPrefs: defaultPrefs,
      readAccent: readAccent,
      PetRuntime: PetRuntime,
      PetRow: PetRow,
      PetStepper: PetStepper,
      PetLayer: PetLayer
    }

    return module.exports
  }
})
