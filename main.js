'use strict';

const obsidian = require('obsidian');
const {
  Plugin, PluginSettingTab, Setting, Keymap, MarkdownView,
  MarkdownRenderer, MarkdownRenderChild, Notice, TFile, Platform,
  WorkspaceLeaf, TFolder,
  parseLinktext, editorLivePreviewField, editorInfoField,
} = obsidian;

// CM6 模块由 Obsidian 插件加载器的模块映射表提供，可直接 require。
// 拿不到时优雅降级：阅读视图照常行内化，Live Preview 退回原生嵌入＋去卡片样式。
let cm = null;
let cmError = '';
try {
  cm = {
    view: require('@codemirror/view'),
    state: require('@codemirror/state'),
    language: require('@codemirror/language'),
  };
} catch (e) {
  cm = null;
  cmError = String((e && e.message) || e);
}

// 只命中块引用嵌入 ![[路径#^块id]]（可带 |别名）；普通链接 [[…]] 与标题/整页嵌入不匹配。
// 路径部分用 * 而非 +：![[#^id]] / [[#^id]] 是"链接当前文件的块"的合法简写
const REF_EMBED_RE = /!\[\[([^\[\]\n]*?#\^[A-Za-z0-9-]+)(?:\|[^\[\]\n]*)?\]\]/g;
// 块链接 [[…#^…]]：行内引用的载体，前面不能是 !（那是嵌入，由上一条处理）。
// 原生对普通链接只做着色不做替换，本插件的替换装饰在此没有冲突
const REF_LINK_RE = /\[\[([^\[\]\n]*?#\^[A-Za-z0-9-]+)(?:\|[^\[\]\n]*)?\]\]/g;

const DEFAULT_SETTINGS = {
  inlineRefs: true,
  taskRefs: false, // 实验特性，默认关
  clickToJump: true,
  warmupSweep: false, // 实验特性：打开文件时滚动预测量，默认关
  atSearch: true,
  hideBlockIds: true,
  roamCursor: true, // Roam 式光标：行首/行尾上下移动、内容最前面 Enter 进新行
  refCounts: false, // 引用计数需要扫描全库元数据，默认关
  blockLinkMenu: true,
  rememberPosition: true, // 记住光标与滚动位置
};


const BODY_CLASSES = {
  inlineRefs: 'oo-inline-refs',
  refCounts: 'oo-refcounts',
};


// 引用嵌套上限：A 引 B、B 引 C 到此为止；防 A↔B 循环引用把渲染拖死
const MAX_NEST_DEPTH = 2;

// 粗略剥掉行内 markdown 记号，用于缓存命中时的同步先画
// （宽度近似最终结果即可，随后异步富渲染原位替换）
function stripInlineSyntax(text) {
  return text
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/[*_=~`]{1,3}/g, '');
}

// 记住位置：localStorage 键（app.saveLocalStorage 自动加库 id 前缀）、
// 条目上限（超出按最近记录时间淘汰最旧）。eState 里带下列任一键，说明调用方
// 自带定位意图——前进/后退历史、[[链接#锚点]]、搜索命中、联动窗格同步——
// 插件不再往里并入记忆位，让内核按调用方的意思定位
const POS_STORE_KEY = 'oo-positions';
const POS_MAX_ENTRIES = 3000;
const POS_INTENT_KEYS = [
  'scroll', 'cursor', 'line', 'subpath', 'match', 'startLoc', 'endLoc',
  'propertyMatches', 'focusMetadata',
];

/** 原型补丁（monkey-around 同款语义）：返回卸载函数。卸载时若发现别的插件
    已经叠在本补丁之上，不把它一起掀掉——只把本层置为直通并保留外壳 */
function around(obj, method, wrapper) {
  const orig = obj[method];
  const wrapped = wrapper(orig);
  let active = true;
  const patched = function () {
    return (active ? wrapped : orig).apply(this, arguments);
  };
  obj[method] = patched;
  return () => {
    active = false;
    if (obj[method] === patched) obj[method] = orig;
  };
}

/** 阅读视图里的行内引用节点：负责渲染 + 源块修改后自动刷新 */
class InlineRefChild extends MarkdownRenderChild {
  constructor(plugin, containerEl, linktext, sourcePath) {
    super(containerEl);
    this.plugin = plugin;
    this.linktext = linktext;
    this.sourcePath = sourcePath;
    this.targetPath = null;
  }

  onload() {
    this.render();
    this.registerEvent(
      this.plugin.app.metadataCache.on('changed', (file) => {
        if (this.targetPath && file.path === this.targetPath) this.render();
      })
    );
    // 启动竞态自愈：初次渲染失败（targetPath 空）时，缓存 resolved 后重试
    this.registerEvent(
      this.plugin.app.metadataCache.on('resolved', () => {
        if (!this.targetPath) this.render();
      })
    );
  }

  async render() {
    this.targetPath = await this.plugin.renderRefInto(
      this.containerEl, this.linktext, this.sourcePath, this
    );
  }
}

module.exports = class OutlinePlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    // 块文本缓存：key = 目标文件路径#^块id → {mtime, text}。
    // 打开文件时预热、渲染路径回填；LP widget 创建时同步取用先画出正确宽度，
    // 消除"先空后填"的行内回流——滚动跳动归因后插件侧唯一能做的加固
    this.refTextCache = new Map();
    this._pendingRefWarm = new Set();
    this.registerEvent(this.app.metadataCache.on('changed', (file) => {
      let touched = false;
      for (const key of Array.from(this.refTextCache.keys())) {
        if (key.startsWith(file.path + '#^')) {
          this.refTextCache.delete(key);
          this._pendingRefWarm.add(key);
          touched = true;
        }
      }
      // 被引用的文件变了：补热失效键再整体重建，LP 引用随源自动
      // 更新——todo 在原文关闭后，别处引用的复选框随之刷新，不再等滚动/重开
      if (touched) this.scheduleRefRefresh();
    }));
    this.registerEvent(this.app.workspace.on('file-open', async (file) => {
      if (!file) return;
      this._lastEphemeral = 0; // 本次打开的恢复信号从零等起（见 scheduleSweep）
      await this.prewarmFile(file);
      if (this.settings.warmupSweep) this.scheduleSweep();
    }));
    this.app.workspace.onLayoutReady(async () => {
      const active = this.app.workspace.getActiveFile();
      if (active) {
        await this.prewarmFile(active);
        // 启动恢复上次会话时也扫一遍（恢复位置上方全是未测量区域）
        if (this.settings.warmupSweep) this.scheduleSweep();
      }
    });

    // Obsidian 打开文件后会异步调 setEphemeralState 恢复上次滚动位（scroll 为行号）。
    // 预热扫描若抢在恢复之前起跑，扫完按 0 复位，恢复随后落地，页面会从顶部猛跳
    // 到恢复位。这里给 setEphemeralState 打一层不改行为的补丁：为扫描提供
    // "恢复已落地"的起跑信号，并对本插件注入的记忆位做钳位；onunload 还原
    this._lastEphemeral = 0;
    this._origSetEphemeral = MarkdownView.prototype.setEphemeralState;
    const plugin = this;
    MarkdownView.prototype.setEphemeralState = function (state) {
      try {
        if (state && state.scroll != null) {
          plugin._lastEphemeral = Date.now();
        }
        // 记忆位钳位：只对本插件注入的 eState 做。文件在别处改短过
        // （同步、外部编辑）时记忆的光标可能越界，内核 setSelection 会抛
        // RangeError 并中断打开流程；其余调用方的 state 一律不碰
        if (state && plugin._posInjected && plugin._posInjected.has(state)) {
          plugin.clampInjectedState(this, state);
        }
      } catch (e) { /* 只记录，绝不拦 */ }
      return plugin._origSetEphemeral.apply(this, arguments);
    };

    // 记住光标与滚动位置（可关）：文件关闭时的光标/滚动位记下来，重新打开
    // 回到原处；Obsidian 本身不保存这两项，重启后打开的标签页也一并恢复。
    // 实现见 setupPositionMemory
    this.setupPositionMemory();

    // 引用计数索引（功能4）：纯元数据缓存统计，防抖重建，不读文件内容
    this.refCounts = new Map();
    this.pageCounts = new Map();
    this._refCountTimer = null;
    this._refCountSig = '';
    // 失效引用自愈：启动阶段元数据缓存未建完会让 widget 误判失效
    // 并因 eq 相等而永久定格（"显示 block ID"的根因）。改为记下失效项，
    // resolved 时只有确实能解析了才重建。原先"有失效标记就每次 resolved
    // 重建"在引用确实不存在时会随每次自动保存无限重配置编辑器
    this._refEpoch = 0;
    this._deadRefs = new Map();
    // 编辑器重配置闸门：打字中、输入法组合中绝不 updateOptions，
    // 见 requestEditorRefresh；editor-change 记录最近一次改动时刻
    this._lastEditAt = 0;
    this._refreshTimer = null;
    this._refreshEpoch = false;
    this._refreshReasons = new Set();
    this.registerEvent(this.app.workspace.on('editor-change', () => {
      this._lastEditAt = Date.now();
    }));
    this.registerEvent(this.app.metadataCache.on('resolved', () => {
      this.scheduleRefCounts();
      this.healDeadRefs();
    }));
    this.registerEvent(this.app.metadataCache.on('changed', () => this.scheduleRefCounts()));
    this.scheduleRefCounts();

    // @ 全库块搜索（功能2）：懒建行级索引
    this.blockIndex = new Map();
    this.registerEditorSuggest(new BlockSearchSuggest(this));

    this.applyBodyClasses();
    this.addSettingTab(new OutlineSettingTab(this.app, this));

    // 阅读视图（以及一切走 MarkdownRenderer 的内容，含悬停预览、整页嵌入内部）：
    // 把块引用占位节点换成自渲染的行内 span。嵌套引用会经由渲染管线自动再次进入
    // 本处理器，深度由 refDepthOf 用 DOM 祖先链控制。
    this.registerMarkdownPostProcessor((el, ctx) => {
      if (!this.settings.inlineRefs) return;
      this.replaceEmbedsIn(el, ctx.sourcePath, ctx);
    });

    // 引用计数角标（功能4·阅读视图）：挂在含块 id 的区段右上角
    this.registerMarkdownPostProcessor((el, ctx) => {
      if (!this.settings.refCounts) return;
      const info = ctx.getSectionInfo(el);
      if (!info) return;
      const lines = info.text.split('\n').slice(info.lineStart, info.lineEnd + 1);
      const ids = [];
      for (const line of lines) {
        const m = line.match(/\s(\^[A-Za-z0-9-]+)\s*$/);
        if (m) ids.push(m[1].slice(1).toLowerCase());
      }
      if (!ids.length) return;
      let total = 0;
      for (const id of ids) total += this.refCounts.get(ctx.sourcePath + '#^' + id) || 0;
      if (!total) return;
      el.addClass('oo-has-count');
      const badge = el.createSpan({ cls: 'oo-refcount', text: String(total) });
      badge.setAttribute('data-oo-count-search', '"#^' + ids[0] + '"');
    });

    // 页面级计数（阅读视图）：挂在正文第一个区段的行上，随内容滚动——
    // 页面计数随内容滚动，不固定在窗口角落
    this.registerMarkdownPostProcessor((el, ctx) => {
      if (!this.settings.refCounts) return;
      const n = this.pageCounts.get(ctx.sourcePath) || 0;
      if (!n) return;
      const info = ctx.getSectionInfo(el);
      if (!info) return;
      const all = info.text.split('\n');
      let first = 0;
      if (all[0] === '---') {
        for (let i = 1; i < Math.min(all.length, 100); i++) {
          if (all[i] === '---') { first = i + 1; break; }
        }
      }
      while (first < all.length && all[first].trim() === '') first++;
      if (info.lineStart !== first) return;
      el.addClass('oo-has-count');
      const base = (ctx.sourcePath.split('/').pop() || '').replace(/\.md$/, '');
      const badge = el.createSpan({ cls: 'oo-refcount oo-pagecount', text: String(n) });
      badge.setAttribute('data-oo-count-search', '"[[' + base + '"');
    });

    // Live Preview：CM6 replace 装饰。Obsidian 内核自己也用装饰渲染嵌入，
    // 同优先级时先注册者（内核）赢——必须用 Prec.highest 压过它，
    // 否则原生嵌入照旧渲染，本插件的行内引用永远不出场
    if (cm) {
      this.registerEditorExtension(cm.state.Prec.highest(buildLivePreviewExtension(this)));
      // 护锚键位（Enter、Backspace、Delete）：防止隐藏的块 id 被挤到新行、被整段吞掉或合并后失效
      this.registerEditorExtension(cm.state.Prec.highest(buildAnchorKeyGuardExtension(this)));
      // Roam 式光标：行首/行尾上下移动保持行首/行尾；内容最前面 Enter 后光标进新空出的行
      this.registerEditorExtension(cm.state.Prec.highest(buildRoamCursorExtension(this)));
    }

    // Shift+点击 → 跳转原块（Cmd/Ctrl 同按 → 新标签页）；
    // 普通点击 → Live Preview 里把光标送进原文，进入编辑（阅读视图无动作）。
    // capture 阶段拦截，避免编辑器把点击吃成别的。
    // 引用里的任务复选框：复选框沿用官方
    // task-list-item-checkbox 类以吃主题样式，但 Obsidian 阅读视图/LP 对该类
    // 有自己的委托处理（按"宿主文件"的行号翻转）——冒泡层抢不过，出现过
    // "引用处勾了、原文没动"的状态分叉。三个事件都在捕获阶段认领：
    // 翻转只走 toggleRefTask 的直连源文件通道，其余处理器全部不见此点击
    const claimTaskCb = (evt) => {
      const t = evt.target;
      return t instanceof Element ? t.closest('input.oo-ref-task') : null;
    };
    this.registerDomEvent(document, 'pointerdown', (evt) => {
      if (claimTaskCb(evt)) evt.stopPropagation();
    }, { capture: true });
    this.registerDomEvent(document, 'mousedown', (evt) => {
      if (claimTaskCb(evt)) evt.stopPropagation();
    }, { capture: true });
    this.registerDomEvent(document, 'click', (evt) => {
      const cb = claimTaskCb(evt);
      if (!cb) return;
      evt.preventDefault();
      evt.stopPropagation();
      this.toggleRefTask(cb);
    }, { capture: true });

    this.registerDomEvent(document, 'click', (evt) => {
      const target = evt.target;
      if (!(target instanceof Element)) return;
      // 引用内容里的链接、复选框、嵌入自带按钮维持原生行为
      if (target.closest('a, input, textarea, .markdown-embed-link, .edit-block-button')) return;
      // 引用计数角标：点击 → 全局搜索该块 id
      const badge = target.closest('.oo-refcount');
      if (badge) {
        evt.preventDefault();
        evt.stopPropagation();
        try {
          this.app.internalPlugins.getPluginById('global-search')
            .instance.openGlobalSearch(badge.getAttribute('data-oo-count-search') || '');
        } catch (e) {
          // 全局搜索面板不可用则忽略
        }
        return;
      }
      const ref = target.closest('.oo-ref, .internal-embed[src*="#^"]');
      if (!ref) return;

      // 移动端轻点＝进入编辑，跳转仅桌面 Shift+点击
      if (evt.shiftKey && this.settings.clickToJump) {
        // 对应的 mousedown 拦截见下方 registerDomEvent('mousedown')
        if (ref.getAttribute('data-oo-dead')) return; // 失效引用不跳，避免误建新笔记
        const linktext = ref.getAttribute('data-oo-href') || ref.getAttribute('src');
        if (!linktext) return;
        evt.preventDefault();
        evt.stopPropagation();
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        const sourcePath = ref.getAttribute('data-oo-source')
          || (view && view.file && view.file.path) || '';
        // Shift+点击 → 右侧分栏打开原块；Shift+Cmd/Ctrl+点击 → 新标签页
        this.app.workspace.openLinkText(linktext, sourcePath,
          Keymap.isModEvent(evt) ? 'tab' : 'split');
        return;
      }

      // 普通点击：光标进入引用原文（仅编辑器内的自渲染节点）
      if (cm && ref.classList.contains('oo-ref')) {
        const editorDom = ref.closest('.cm-editor');
        if (!editorDom) return;
        const editorView = cm.view.EditorView.findFromDOM(editorDom);
        if (!editorView) return;
        evt.preventDefault();
        const pos = editorView.posAtDOM(ref);
        editorView.focus();
        editorView.dispatch({
          selection: { anchor: Math.min(pos + 2, editorView.state.doc.length) },
          scrollIntoView: false, // 光标就在点击处，禁止聚焦引发的滚动回跳
        });
      }
    }, { capture: true });

    // 复制块链接/嵌入：
    // 命令面板两条命令（可绑快捷键）＋编辑器右键菜单（可关）
    this.addCommand({
      id: 'copy-block-link',
      name: '复制当前块的块链接（无 id 自动生成）',
      editorCallback: (editor, view) => this.copyBlockRef(editor, view, false),
    });
    this.addCommand({
      id: 'copy-block-embed',
      name: '复制当前块的块嵌入（无 id 自动生成）',
      editorCallback: (editor, view) => this.copyBlockRef(editor, view, true),
    });
    this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor, view) => {
      if (!this.settings.blockLinkMenu) return;
      if (!(view instanceof MarkdownView) || !view.file) return;
      menu.addItem((item) => item
        .setTitle('复制块链接')
        .setIcon('link')
        .onClick(() => this.copyBlockRef(editor, view, false)));
      menu.addItem((item) => item
        .setTitle('复制块嵌入')
        .setIcon('copy')
        .onClick(() => this.copyBlockRef(editor, view, true)));
    }));

    // Shift+按在引用上时提前拦截 mousedown 的浏览器默认——否则默认行为是
    // "从旧光标位置扩展选区到点击处"，选区途经的所有引用都会露出原文
    // （"Shift+点击后其他 block 也变编辑状态"的根因）。click 阶段照常跳转
    this.registerDomEvent(document, 'mousedown', (evt) => {
      if (!evt.shiftKey || !this.settings.clickToJump) return;
      const target = evt.target;
      if (!(target instanceof Element)) return;
      if (!target.closest('.oo-ref') || target.closest('.oo-ref-ghost')) return;
      evt.preventDefault();
      evt.stopPropagation();
    }, { capture: true });

    // 插入 @（供移动工具栏与快捷键使用）：光标前非空白时自动补空格以满足触发条件
    this.addCommand({
      id: 'insert-at-search',
      name: '插入 @ 块搜索（可加入移动工具栏）',
      editorCallback: (editor) => {
        const cur = editor.getCursor();
        const before = editor.getLine(cur.line).slice(0, cur.ch);
        editor.replaceSelection(!before || /\s$/.test(before) ? '@' : ' @');
      },
    });
  }

  onunload() {
    this.savePositionsNow(); // 记忆位落盘；原型补丁由 register 的卸载函数还原
    // 还原 setEphemeralState 的记录补丁
    if (this._origSetEphemeral) {
      MarkdownView.prototype.setEphemeralState = this._origSetEphemeral;
      this._origSetEphemeral = null;
    }
    for (const cls of Object.values(BODY_CLASSES)) {
      document.body.classList.remove(cls);
    }
  }

  /* ---------- 记住光标与滚动位置 ---------- */

  /** 三路记录＋一处恢复。记录：CM6 选区变化记光标、markdown-scroll 记滚动
      （两路随手更新内存表，落盘防抖 1s）、onUnloadFile 在关闭/切换文件的
      一刻整体记一次——这才是"最后关闭时"的权威值，前两路兜住退出、崩溃
      时来不及卸载的情形。恢复：补丁 WorkspaceLeaf.setViewState，在 Obsidian
      自己的打开流程里把记忆位并入 eState，由内核 setEphemeralState 一步落
      位，不另起一次滚动（避免"先到顶再跳到恢复位"）。
      存储走 app.saveLocalStorage：按库隔离、只在本机——插件目录里的 json
      会随多设备同步互相覆盖，编辑时每秒一写还会制造同步抖动 */
  setupPositionMemory() {
    this._positions = this.loadPositions();
    this._posInjected = new WeakSet(); // 本插件注入过的 eState 对象，钳位只认它们
    this._posSaveTimer = null;
    this._posDirty = false;
    this._posSavedAt = 0;
    const plugin = this;

    // 恢复。补丁要赶在启动恢复布局之前装好：deferred 视图真正加载时走的
    // 也是 setViewState
    this.register(around(WorkspaceLeaf.prototype, 'setViewState', (orig) =>
      function (viewState, eState) {
        let merged = eState;
        try {
          merged = plugin.rememberedEState(viewState, eState);
        } catch (e) {
          console.error('A outline 记忆位置注入失败', e);
        }
        const result = orig.call(this, viewState, merged);
        if (merged === eState || !result || typeof result.catch !== 'function') return result;
        // 钳位之外的兜底：记忆位引发的越界不影响打开
        return result.catch((err) => {
          if (err instanceof RangeError) {
            console.error('A outline 记忆位置越界，已忽略', err);
            return;
          }
          throw err;
        });
      }));

    // 记录（关闭/切换文件的一刻）：此时 this.file 仍是旧文件、编辑器状态尚在
    this.register(around(MarkdownView.prototype, 'onUnloadFile', (orig) =>
      function (file) {
        try {
          if (file && this.file === file) plugin.notePosition(this, 'both', '关闭');
        } catch (e) { /* 只记录，绝不拦 */ }
        return orig.apply(this, arguments);
      }));

    // 记录（滚动）：内核 MarkdownView.syncScroll 每次滚动都触发此事件，两种
    // 模式、弹出窗口都覆盖，参数即视图
    this.registerEvent(this.app.workspace.on('markdown-scroll', (view) => {
      this.notePosition(view, 'scroll');
    }));
    // 记录（光标）：CM6 选区变化
    if (cm) this.registerEditorExtension(buildCursorMemoExtension(this));

    // 改名/删除跟着走；退出前落盘（quit 不保证触发，触发时同步写完即可）
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) =>
      this.movePosition(oldPath, file.path, file instanceof TFolder)));
    this.registerEvent(this.app.vault.on('delete', (file) =>
      this.movePosition(file.path, null, file instanceof TFolder)));
    this.registerEvent(this.app.workspace.on('quit', () => this.savePositionsNow()));
  }

  /** 恢复：viewState 指向 markdown 文件、调用方没带定位意图、且有记忆时，
      返回并入了记忆位的新 eState；否则原样返回（同一对象） */
  rememberedEState(viewState, eState) {
    if (!this.settings.rememberPosition || !this._positions) return eState;
    if (!viewState || viewState.type !== 'markdown') return eState;
    const path = viewState.state && viewState.state.file;
    if (typeof path !== 'string' || !path) return eState;
    if (eState && typeof eState === 'object'
      && POS_INTENT_KEYS.some((k) => k in eState)) return eState;
    const rec = this._positions.get(path);
    if (!rec || (rec.cursor == null && rec.scroll == null)) return eState;
    const merged = Object.assign({}, eState);
    if (rec.scroll != null) merged.scroll = rec.scroll;
    if (rec.cursor && rec.cursor.from) {
      const to = rec.cursor.to || rec.cursor.from;
      merged.cursor = {
        from: { line: rec.cursor.from.line, ch: rec.cursor.from.ch },
        to: { line: to.line, ch: to.ch },
      };
    }
    this._posInjected.add(merged);
    return merged;
  }

  /** 把注入的 eState 钳进当前文档范围（行号、列号、滚动行）；拿不到编辑器
      时去掉光标只留滚动 */
  clampInjectedState(view, state) {
    const ed = view.editor;
    const lines = ed && typeof ed.lineCount === 'function' ? ed.lineCount() : 0;
    if (!(lines > 0)) {
      delete state.cursor;
      return;
    }
    if (state.cursor && state.cursor.from) {
      const fix = (p) => {
        const line = Math.min(Math.max(0, Math.floor(Number(p && p.line) || 0)), lines - 1);
        const len = ed.getLine(line).length;
        const ch = Math.min(Math.max(0, Math.floor(Number(p && p.ch) || 0)), len);
        return { line, ch };
      };
      state.cursor = { from: fix(state.cursor.from), to: fix(state.cursor.to || state.cursor.from) };
    }
    if (typeof state.scroll === 'number' && state.scroll >= lines) state.scroll = lines - 1;
  }

  /** 记录：从视图取 ephemeral state 写进内存表。cursor 只有编辑模式提供
      （阅读模式的 getEphemeralState 不带它），scroll 两种模式都有；
      what = 'cursor' | 'scroll' | 'both'。预热扫描进行中的那个视图，滚动位
      是扫描造出来的，不记 */
  notePosition(view, what, reason) {
    if (!this.settings.rememberPosition || !this._positions) return;
    if (!(view instanceof MarkdownView) || !view.file) return;
    const wantCursor = what === 'cursor' || what === 'both';
    const wantScroll = (what === 'scroll' || what === 'both') && view !== this._sweepView;
    if (!wantCursor && !wantScroll) return;
    let st;
    try {
      st = view.getEphemeralState() || {};
    } catch (e) {
      return;
    }
    const path = view.file.path;
    const rec = this._positions.get(path) || {};
    let changed = false;
    if (wantCursor && st.cursor && st.cursor.from) {
      const from = st.cursor.from;
      const to = st.cursor.to || from;
      rec.cursor = {
        from: { line: from.line, ch: from.ch },
        to: { line: to.line, ch: to.ch },
      };
      changed = true;
    }
    if (wantScroll && typeof st.scroll === 'number' && isFinite(st.scroll)) {
      rec.scroll = Math.round(st.scroll * 100) / 100;
      changed = true;
    }
    if (!changed) return;
    rec.t = Date.now();
    this._positions.set(path, rec);
    this.schedulePositionSave();
  }

  /** 改名把记录挪到新路径（文件夹改名连同其下全部），删除则清掉 */
  movePosition(oldPath, newPath, isFolder) {
    const map = this._positions;
    if (!map || !oldPath) return;
    let changed = false;
    const move = (from, to) => {
      const rec = map.get(from);
      if (!rec) return;
      map.delete(from);
      if (to) map.set(to, rec);
      changed = true;
    };
    if (isFolder) {
      const prefix = oldPath + '/';
      for (const key of Array.from(map.keys())) {
        if (key.startsWith(prefix)) {
          move(key, newPath ? newPath + '/' + key.slice(prefix.length) : null);
        }
      }
    } else {
      move(oldPath, newPath);
    }
    if (changed) this.schedulePositionSave();
  }

  loadPositions() {
    const map = new Map();
    try {
      const raw = this.app.loadLocalStorage(POS_STORE_KEY);
      if (raw && typeof raw === 'object') {
        for (const path of Object.keys(raw)) {
          const rec = raw[path];
          if (rec && typeof rec === 'object' && (rec.cursor || rec.scroll != null)) map.set(path, rec);
        }
      }
    } catch (e) {
      console.error('A outline 读取记忆位置失败', e);
    }
    return map;
  }

  schedulePositionSave() {
    this._posDirty = true;
    if (this._posSaveTimer) return;
    this._posSaveTimer = window.setTimeout(() => {
      this._posSaveTimer = null;
      this.savePositionsNow();
    }, 1000);
  }

  /** 同步落盘（localStorage 本身同步，退出前调用也来得及）；超上限先淘汰最旧 */
  savePositionsNow() {
    if (this._posSaveTimer) {
      window.clearTimeout(this._posSaveTimer);
      this._posSaveTimer = null;
    }
    const map = this._positions;
    if (!map || !this._posDirty) return;
    this._posDirty = false;
    const excess = map.size - POS_MAX_ENTRIES;
    if (excess > 0) {
      const oldest = Array.from(map.entries()).sort((a, b) => (a[1].t || 0) - (b[1].t || 0));
      for (let i = 0; i < excess; i++) map.delete(oldest[i][0]);
    }
    const obj = {};
    for (const [path, rec] of map) obj[path] = rec;
    try {
      this.app.saveLocalStorage(POS_STORE_KEY, obj);
      this._posSavedAt = Date.now();
    } catch (e) {
      console.error('A outline 写入记忆位置失败', e);
    }
  }

  /* ---------- 核心渲染 ---------- */

  /** 把 rootEl 内的块引用嵌入占位节点与块链接 <a> 替换为自渲染行内 span */
  replaceEmbedsIn(rootEl, sourcePath, component) {
    const targets = [];
    for (const embed of rootEl.findAll('.internal-embed')) {
      targets.push([embed, embed.getAttribute('src')]);
    }
    // 阅读视图里指向 #^ 的普通链接同样渲染为内容
    for (const anchor of rootEl.findAll('a.internal-link')) {
      targets.push([anchor, anchor.getAttribute('data-href') || anchor.getAttribute('href')]);
    }
    for (const [embed, src] of targets) {
      if (!src || !/#\^/.test(src)) continue;
      const span = createSpan({
        cls: 'oo-ref',
        attr: { 'data-oo-href': src, 'data-oo-source': sourcePath },
      });
      const guard = this.refDepthOf(embed, src);
      embed.replaceWith(span);
      if (guard === 'cycle' || guard >= MAX_NEST_DEPTH) {
        span.setText('…');
        span.addClass('oo-ref-missing');
        span.setAttribute('data-oo-dead', '1');
        continue;
      }
      component.addChild(new InlineRefChild(this, span, src, sourcePath));
    }
  }

  /** 沿 DOM 祖先链数出引用嵌套深度；命中同名 linktext 判为循环 */
  refDepthOf(el, src) {
    let depth = 0;
    let cur = el.parentElement;
    while (cur) {
      const anc = cur.closest('.oo-ref');
      if (!anc) break;
      if (anc.getAttribute('data-oo-href') === src) return 'cycle';
      depth++;
      cur = anc.parentElement;
    }
    return depth;
  }

  /** 解析 linktext → 目标文件（同步）；![[#^id]] 视为同文件引用 */
  resolveTargetFile(linktext, sourcePath) {
    const { path } = parseLinktext(linktext);
    if (path) return this.app.metadataCache.getFirstLinkpathDest(path, sourcePath);
    const own = this.app.vault.getAbstractFileByPath(sourcePath);
    return own instanceof TFile ? own : null;
  }

  /**
   * 取块的 markdown 文本，带缓存回填；找不到返回 null。
   * 列表项块只取本行（不带子项）并剥列表/任务标记，块 id 尾巴一律去掉。
   * 任务行的状态字符（[ ]/[x] 里的那一位）在剥除前捕获并随缓存保留，
   * 渲染层据此带出复选框
   */
  async resolveBlockText(linktext, sourcePath) {
    const { subpath } = parseLinktext(linktext);
    const blockId = subpath && subpath.startsWith('#^')
      ? subpath.slice(2).toLowerCase() : '';
    const file = this.resolveTargetFile(linktext, sourcePath);
    if (!file || !blockId) return null;
    const key = file.path + '#^' + blockId;
    const hit = this.refTextCache.get(key);
    if (hit && hit.mtime === file.stat.mtime) {
      return {
        file, blockId, text: hit.text,
        task: hit.task != null ? hit.task : null,
        level: hit.level || 0,
      };
    }

    const cache = this.app.metadataCache.getFileCache(file);
    const block = cache && cache.blocks && cache.blocks[blockId];
    if (!block) return null;
    const raw = await this.app.vault.cachedRead(file);
    let text = raw.slice(block.position.start.offset, block.position.end.offset);
    const firstLine = text.split('\n', 1)[0];
    if (/^\s*(?:[-*+]|\d+[.)])\s/.test(firstLine)) text = firstLine;
    // 标题块：带块 id 的标题行只取题名正文——引用一个标题得到
    // 的是它的题名文字，与"列表项只取正文"同一原则。ATX 记号留着会被渲染成
    // 块级 <h3>，而 Obsidian 的标题样式选择器不限作用域（`h3,
    // .markdown-rendered h3 {…}`、`h1…h6 { margin-block: var(--p-spacing) }`），
    // 行内 span 里的 h3 照吃 16px 上下外边距与 1.318em 字号，裸行引用
    // 前后会出现大片留白。闭合井号按 CommonMark 须有空格前导，
    // 避免把"C#"这类正文尾巴误剥
    let level = 0;
    const hm = firstLine.match(/^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/);
    if (hm) {
      level = hm[1].length;
      text = hm[2];
    }
    // 标题块跳过列表/任务前缀剥除：题名本身可能以"5."、"-"开头（如
    // Living/…_Question.md 的 `##### 1. 问题文本 ^q-1`），单测抓到过误剥序号
    const tm = level ? null : text.match(/^\s*(?:[-*+]|\d+[.)])\s+\[([^\]])\]\s/);
    const task = tm ? tm[1] : null;
    if (!level) text = text.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[^\]]\]\s+)?/, '');
    text = text.replace(/(?:\s|^)\^[A-Za-z0-9-]+\s*$/, '');
    this.refTextCache.set(key, { mtime: file.stat.mtime, text, task, level });
    return { file, blockId, text, task, level };
  }

  /** 同步判断引用能否解析（不读文件内容）；供 LP widget 同步定格失效态 */
  canResolveSync(linktext, sourcePath) {
    const { subpath } = parseLinktext(linktext);
    const blockId = subpath && subpath.startsWith('#^')
      ? subpath.slice(2).toLowerCase() : '';
    const file = this.resolveTargetFile(linktext, sourcePath);
    if (!file || !blockId) return false;
    const cache = this.app.metadataCache.getFileCache(file);
    return !!(cache && cache.blocks && cache.blocks[blockId]);
  }

  /** 缓存的同步读取（预热或渲染过一次后命中）；未命中返回 null */
  getBlockTextSync(linktext, sourcePath) {
    const { subpath } = parseLinktext(linktext);
    const blockId = subpath && subpath.startsWith('#^')
      ? subpath.slice(2).toLowerCase() : '';
    const file = this.resolveTargetFile(linktext, sourcePath);
    if (!file || !blockId) return null;
    const hit = this.refTextCache.get(file.path + '#^' + blockId);
    return hit && hit.mtime === file.stat.mtime ? hit.text : null;
  }

  /** 任务状态的同步读取：命中且为任务行时返回 {task, path, blockId}，
      否则 null——供 LP widget 同步先画复选框，与文本同帧出现不回流 */
  getBlockTaskSync(linktext, sourcePath) {
    const { subpath } = parseLinktext(linktext);
    const blockId = subpath && subpath.startsWith('#^')
      ? subpath.slice(2).toLowerCase() : '';
    const file = this.resolveTargetFile(linktext, sourcePath);
    if (!file || !blockId) return null;
    const hit = this.refTextCache.get(file.path + '#^' + blockId);
    if (!hit || hit.mtime !== file.stat.mtime || hit.task == null) return null;
    return { task: hit.task, path: file.path, blockId };
  }

  /** 在引用 span 最前挂原块的待办复选框。复选框直连源文件：
      点击改写的是原任务行，所有页面的引用同步——待办只需关一次 */
  attachTaskCheckbox(spanEl, task, path, blockId) {
    const cb = spanEl.createEl('input', {
      cls: 'task-list-item-checkbox oo-ref-task',
      attr: {
        type: 'checkbox',
        'data-oo-task-file': path,
        'data-oo-task-block': blockId,
      },
    });
    cb.checked = task !== ' ';
    spanEl.insertBefore(cb, spanEl.firstChild);
    spanEl.classList.toggle('oo-ref-task-done', task !== ' ');
  }

  /** 复选框点击 → 改写源文件的任务状态。目标文件开在编辑器里时走编辑器
      改行（规避未落盘编辑的竞态），否则 vault.process */
  async toggleRefTask(cb) {
    const path = cb.getAttribute('data-oo-task-file');
    const blockId = cb.getAttribute('data-oo-task-block');
    if (!path || !blockId) return;
    const af = this.app.vault.getAbstractFileByPath(path);
    if (!(af instanceof TFile)) return;
    const stateRe = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([^\]])(\])/;
    const idRe = new RegExp('(?:\\s|^)\\^' + blockId + '\\s*$');
    let newState = null;
    const flipLine = (line) => {
      const m = line.match(stateRe);
      if (!m) return null; // 引用的不是任务行（状态或已被改掉）
      newState = m[2] === ' ' ? 'x' : ' ';
      return line.replace(stateRe, '$1' + newState + '$3');
    };
    let done = false;
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const v = leaf.view;
      // 只信 source 模式的编辑器缓冲（预览模式的后备编辑器不一定与盘上同步）
      if (!(v instanceof MarkdownView) || !v.file || v.file.path !== path
        || !v.editor || v.getMode() !== 'source') continue;
      const ed = v.editor;
      for (let i = 0; i < ed.lineCount(); i++) {
        const line = ed.getLine(i);
        if (!idRe.test(line)) continue;
        const flipped = flipLine(line);
        if (flipped != null) {
          ed.setLine(i, flipped);
          done = true;
        }
        break;
      }
      break;
    }
    if (!done && newState == null) {
      await this.app.vault.process(af, (raw) => {
        const lines = raw.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (!idRe.test(lines[i])) continue;
          const flipped = flipLine(lines[i]);
          if (flipped != null) lines[i] = flipped;
          break;
        }
        return lines.join('\n');
      });
    }
    if (newState != null) {
      cb.checked = newState !== ' ';
      const host = cb.closest('.oo-ref');
      if (host) host.classList.toggle('oo-ref-task-done', newState !== ' ');
      // 缓存失效＋全部引用 widget 重建：其他页面立即看到新状态
      this.refTextCache.delete(path + '#^' + blockId);
      this._refEpoch++;
      this.refreshEditorsNow();
    }
  }

  /** 源文件变更后的引用刷新：debounce 合并连续编辑，先把失效的
      缓存键重新解析（widget 重建时同步先画，避免"先空后填"回流——历史
      跳动教训），再 epoch+1 迫使全部 LP 引用 widget 重建取新值 */
  scheduleRefRefresh() {
    if (this._refRefreshTimer) window.clearTimeout(this._refRefreshTimer);
    this._refRefreshTimer = window.setTimeout(async () => {
      const keys = Array.from(this._pendingRefWarm);
      this._pendingRefWarm.clear();
      for (const key of keys) {
        try {
          await this.resolveBlockText(key, '');
        } catch (e) {
          // 单键补热失败无碍，渲染路径自带回退
        }
      }
      this.requestEditorRefresh('源块变更', true);
    }, 400);
  }

  /** 打开文件时预热其中全部块引用的目标文本 */
  async prewarmFile(file) {
    try {
      const raw = await this.app.vault.cachedRead(file);
      const linktexts = [];
      REF_EMBED_RE.lastIndex = 0;
      let m;
      while ((m = REF_EMBED_RE.exec(raw)) !== null) linktexts.push(m[1]);
      for (const linktext of linktexts) {
        await this.resolveBlockText(linktext, file.path);
      }
    } catch (e) {
      // 预热失败无碍，渲染路径自带回退
    }
  }

  /* ---------- 编辑器重配置闸门：打字与输入法组合期间不重配置 ---------- */

  /** 任一 markdown 编辑器是否正处于输入法组合（CM6 EditorView.composing） */
  editorComposing() {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const v = leaf.view;
      const ed = v instanceof MarkdownView && v.editor && v.editor.cm;
      if (ed && ed.composing) return true;
    }
    return false;
  }

  /** updateOptions 的常规出口：打字停下 1.2s、且输入法不在组合中才做；多次
      请求合并成一次；bumpEpoch 让全部引用 widget 重建。持续打字最多等 20s，
      之后只要不在组合中就做——组合中永远不做。
      背景：Workspace.updateOptions 让每个编辑器 reconfigure 一次，桌面端还会
      重设 Electron 会话的拼写检查语言；在打字中频繁调用会打断输入法组合，
      造成候选文字被提前提交或重复输入 */
  requestEditorRefresh(reason, bumpEpoch) {
    if (bumpEpoch) this._refreshEpoch = true;
    this._refreshReasons.add(reason || '?');
    if (this._refreshTimer) return;
    const t0 = Date.now();
    const tick = () => {
      const typing = Date.now() - this._lastEditAt < 1200;
      if (this.editorComposing() || (typing && Date.now() - t0 < 20000)) {
        this._refreshTimer = window.setTimeout(tick, 300);
        return;
      }
      this._refreshTimer = null;
      const bump = this._refreshEpoch;
      this._refreshEpoch = false;
      this._refreshReasons.clear();
      if (bump) this._refEpoch++;
      this.refreshEditorsNow();
    };
    this._refreshTimer = window.setTimeout(tick, 250);
  }

  /** 立即重配置（设置面板、点击待办这类主动操作），标记为本插件发起 */
  refreshEditorsNow() {
    this._ownRefresh = true;
    try {
      this.app.workspace.updateOptions();
    } finally {
      this._ownRefresh = false;
    }
  }

  /** 失效引用自愈：只在确有失效项已能解析时重建一次 */
  healDeadRefs() {
    if (!this._deadRefs || !this._deadRefs.size) return;
    let healed = 0;
    for (const ref of this._deadRefs.values()) {
      if (this.canResolveSync(ref.linktext, ref.sourcePath)) healed++;
    }
    if (!healed) return;
    this._deadRefs.clear();
    this.requestEditorRefresh('自愈' + healed, true);
  }

  /* ---------- 引用计数（功能4） ---------- */

  scheduleRefCounts() {
    if (!this.settings.refCounts) return; // 计数关着时不扫全库；@ 搜索的高频候选按需现算
    if (this._refCountTimer) window.clearTimeout(this._refCountTimer);
    this._refCountTimer = window.setTimeout(() => this.buildRefCounts(), 2000);
  }

  /** 纯缓存统计：全库 links＋embeds 里指向 #^ 的都计入，键为 目标路径#^id */
  buildRefCounts() {
    const counts = new Map();
    for (const file of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(file);
      if (!cache) continue;
      const refs = (cache.links || []).concat(cache.embeds || []);
      for (const ref of refs) {
        if (!ref.link || ref.link.indexOf('#^') < 0) continue;
        const { path, subpath } = parseLinktext(ref.link);
        const id = subpath && subpath.startsWith('#^')
          ? subpath.slice(2).toLowerCase() : '';
        if (!id) continue;
        const target = path
          ? this.app.metadataCache.getFirstLinkpathDest(path, file.path)
          : file;
        if (!target) continue;
        const key = target.path + '#^' + id;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
    this.refCounts = counts;
    // 页面级计数：全库入链合计（含块引用），来自 resolvedLinks
    const pageCounts = new Map();
    const rl = this.app.metadataCache.resolvedLinks || {};
    for (const src of Object.keys(rl)) {
      const targets = rl[src];
      for (const t of Object.keys(targets)) {
        pageCounts.set(t, (pageCounts.get(t) || 0) + targets[t]);
      }
    }
    this.pageCounts = pageCounts;
    // 只有开着计数、且数字确有变化时才让编辑器装饰重建；阅读视图
    // 角标随下次自然渲染更新。不无条件 updateOptions：打字中频繁重配置会打断输入法组合
    if (!this.settings.refCounts) return;
    const sig = counts.size + ':' + pageCounts.size + ':'
      + Array.from(counts.entries()).sort().join(',');
    if (sig === this._refCountSig) return;
    this._refCountSig = sig;
    this.requestEditorRefresh('计数');
  }

  /* ---------- @ 全库块搜索的支撑（功能2） ---------- */

  /** 懒建全库行级索引，mtime 命中则跳过 */
  async ensureBlockIndex() {
    const files = this.app.vault.getMarkdownFiles();
    for (const file of files) {
      if (file.stat.size > 500000) continue;
      const hit = this.blockIndex.get(file.path);
      if (hit && hit.mtime === file.stat.mtime) continue;
      try {
        const raw = await this.app.vault.cachedRead(file);
        const arr = raw.split('\n');
        const lines = [];
        for (let i = 0; i < arr.length; i++) {
          const t = arr[i].trim();
          if (t.length < 2 || t.startsWith('---')) continue;
          lines.push({ text: arr[i], lineNo: i });
        }
        this.blockIndex.set(file.path, { mtime: file.stat.mtime, lines });
      } catch (e) {
        // 单文件读取失败跳过
      }
    }
    const alive = new Set(files.map((f) => f.path));
    for (const key of Array.from(this.blockIndex.keys())) {
      if (!alive.has(key)) this.blockIndex.delete(key);
    }
  }

  /** 给目标行所在块确保块 id：已有则复用，没有则生成并写入块末行 */
  async ensureBlockId(file, lineNo) {
    const cache = this.app.metadataCache.getFileCache(file);
    if (cache && cache.blocks) {
      for (const [id, block] of Object.entries(cache.blocks)) {
        if (block.position.start.line <= lineNo && lineNo <= block.position.end.line) {
          return id;
        }
      }
    }
    // 块 id 必须落在块末行：列表项落在本行，段落落在段末行
    let endLine = lineNo;
    if (cache && cache.sections) {
      for (const sec of cache.sections) {
        if (sec.position.start.line <= lineNo && lineNo <= sec.position.end.line) {
          endLine = sec.type === 'list' ? lineNo : sec.position.end.line;
          break;
        }
      }
    }
    const id = this.newBlockId(cache);
    await this.app.vault.process(file, (data) => {
      const arr = data.split('\n');
      if (endLine < arr.length && !/\s\^[A-Za-z0-9-]+\s*$/.test(arr[endLine])) {
        arr[endLine] = arr[endLine].replace(/\s*$/, '') + ' ^' + id;
      }
      return arr.join('\n');
    });
    return id;
  }

  newBlockId(cache) {
    const used = (cache && cache.blocks) || {};
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    for (;;) {
      let id = '';
      for (let i = 0; i < 6; i++) {
        id += alphabet[Math.floor(Math.random() * alphabet.length)];
      }
      if (!used[id]) return id;
    }
  }

  /**
   * 预热扫描（实验）：打开文件后程序化把滚动位置从头扫到尾，逼编辑器测量
   * 全文每一行的真实高度（CM6 缓存已测行高，直到该行被编辑），替代无法
   * 关闭的虚拟化估算——这是滚动跳动的主因侧唯一可行的插件级对策。
   * 扫描期间内容短暂隐去（.oo-warming）；滚轮/按键立即中止并复位
   */
  /** 扫描起跑闸：等 Obsidian 的滚动恢复（setEphemeralState，行号）
      先落地再起跑，扫描捕获的 origTop 才是恢复后的真位置；900ms 内没等到
      信号（新文件、无历史位）按时限起跑。恢复落地后再缓 150ms，让
      applyScroll 的补投递走完 */
  scheduleSweep() {
    if (!this.settings.warmupSweep) return;
    const t0 = Date.now();
    const tryRun = () => {
      if (this._lastEphemeral) {
        window.setTimeout(() => this.sweepActiveEditor(), 150);
      } else if (Date.now() - t0 >= 900) {
        this.sweepActiveEditor();
      } else {
        window.setTimeout(tryRun, 120);
      }
    };
    window.setTimeout(tryRun, 250);
  }

  async sweepActiveEditor() {
    if (this._sweeping) return;
    if (Platform.isMobile) return; // 手机上扫描与惯性滚动打架，收益也小，直接跳过
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || view.getMode() !== 'source') return;
    const path = (view.file && view.file.path) || '';
    // 同文件短时间内不重复扫（file-open 与启动恢复可能先后触发两次）
    if (path && this._lastSweepPath === path
      && Date.now() - (this._lastSweepTime || 0) < 10000) return;
    let editorView = view.editor && view.editor.cm;
    if (!editorView && cm) {
      const dom = view.containerEl.querySelector('.cm-editor');
      if (dom) editorView = cm.view.EditorView.findFromDOM(dom);
    }
    if (!editorView || !editorView.scrollDOM) return;
    if (editorView.state.doc.lines < 30) return; // 小文件不值得扫
    // 同一编辑器实例×同一文件只扫一次：重新聚焦是
    // 同实例同文件，不重扫——已测行高还在缓存；同一窗格里换文件是全新内容，
    // 实例虽复用也要扫，所以记号按 实例×文件
    if (!this._sweptFiles) this._sweptFiles = new WeakMap();
    let sweptSet = this._sweptFiles.get(editorView);
    if (!sweptSet) {
      sweptSet = new Set();
      this._sweptFiles.set(editorView, sweptSet);
    }
    if (sweptSet.has(path)) return;
    sweptSet.add(path);

    this._sweeping = true;
    this._sweepView = view; // 记忆位：扫描中的视图不记滚动
    this._lastSweepPath = path;
    this._lastSweepTime = Date.now();
    const scroller = editorView.scrollDOM;
    const container = view.containerEl;
    const fileAtStart = view.file;
    const origTop = scroller.scrollTop;
    // 中止语义：扫描期间内容不可见（.oo-warming），任何
    // 输入都以"我看到的还是扫描前那页"为前提——所以中止的唯一正确动作是
    // 当场复位到 origTop 并立刻显形。"点到哪停到哪"对隐形内容恰好
    // 相反：把人丢在扫描进行到一半的随机滚动位，就是"启动后第一次点击
    // 整页跳动"的根因。pointerdown 挂捕获阶段：先复位、再轮到 CM6 的
    // mousedown 计算落点，光标便落在按扫描前视图瞄准的位置，点击不必吞
    let aborted = '';
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      scroller.scrollTop = origTop;
      container.removeClass('oo-warming');
    };
    const abortBy = (reason) => () => {
      if (!aborted) {
        aborted = reason;
        settle();
      }
    };
    const onWheel = abortBy('滚轮');
    const onPointer = abortBy('点击');
    const onKey = abortBy('按键');
    const raf = () => new Promise((resolve) => requestAnimationFrame(resolve));
    scroller.addEventListener('wheel', onWheel, { once: true, passive: true });
    scroller.addEventListener('pointerdown', onPointer, { once: true, capture: true, passive: true });
    window.addEventListener('keydown', onKey, { once: true });
    container.addClass('oo-warming');
    const t0 = Date.now();
    let y = 0;
    let guard = 0;
    try {
      await raf();
      const step = Math.max(200, scroller.clientHeight);
      // scrollHeight 会随测量修正而变化，循环条件每轮重读；4 秒硬上限；
      // 窗格中途换了文件立即让位——否则扫完把旧文件的滚动位套在新文件上
      while (!aborted && view.file === fileAtStart
        && y < scroller.scrollHeight && guard < 300
        && Date.now() - t0 < 4000) {
        scroller.scrollTop = y;
        await raf();
        await raf();
        y += step;
        guard++;
      }
    } finally {
      if (view.file === fileAtStart) {
        settle(); // 完成/超时统一回原位；中止已在事件里复位过，幂等不再动
      } else {
        // 文件已切换：新文件的滚动位归 Obsidian 管，这里只负责显形
        settled = true;
        container.removeClass('oo-warming');
      }
      scroller.removeEventListener('wheel', onWheel);
      scroller.removeEventListener('pointerdown', onPointer, { capture: true });
      window.removeEventListener('keydown', onKey);
      this._sweeping = false;
      this._sweepView = null;
    }
  }

  /**
   * 取块原文并渲染进 spanEl（就地渲染，保证嵌套深度检查能看到祖先链）。
   * 返回目标文件路径（找不到返回 null），供刷新监听使用。
   */
  async renderRefInto(spanEl, linktext, sourcePath, component) {
    const resolved = await this.resolveBlockText(linktext, sourcePath);
    if (!resolved) return this.markDead(spanEl, linktext, sourcePath);
    const file = resolved.file;

    spanEl.empty();
    await MarkdownRenderer.render(this.app, resolved.text, spanEl, file.path, component);
    // 拆包：单段落/单标题输出把 <p> 或 <h1–6> 打开成行内内容（对标题只是
    // 兜底——提取层已剥掉 ATX 记号，这里托住嵌套引用等
    // 绕过路径）；多块级输出（引文等）保持原样
    const p = spanEl.firstElementChild;
    if (p && /^(?:P|H[1-6])$/.test(p.tagName) && p === spanEl.lastElementChild) {
      while (p.firstChild) spanEl.insertBefore(p.firstChild, p);
      p.remove();
    }
    // 任务块：原块的待办状态随引用一起出场，复选框直连源文件
    if (resolved.task != null && this.settings.taskRefs) {
      this.attachTaskCheckbox(spanEl, resolved.task, file.path, resolved.blockId);
    } else {
      spanEl.classList.remove('oo-ref-task-done');
    }
    spanEl.removeClass('oo-ref-missing');
    spanEl.removeAttribute('data-oo-dead');
    return file.path;
  }

  /**
   * 复制当前块的链接/嵌入：已有 id 直接用；没有则生成
   * 并经编辑器写入块末行（列表项落本行，段落落段末行）——用编辑器而非
   * vault.process，规避未落盘编辑的竞态
   */
  async copyBlockRef(editor, view, asEmbed) {
    const file = view.file;
    if (!file) return;
    const lineNo = editor.getCursor().line;
    const cache = this.app.metadataCache.getFileCache(file);
    let endLine = lineNo;
    if (cache && cache.sections) {
      for (const sec of cache.sections) {
        if (sec.position.start.line <= lineNo && lineNo <= sec.position.end.line) {
          endLine = sec.type === 'list' ? lineNo : sec.position.end.line;
          break;
        }
      }
    }
    if (endLine >= editor.lineCount()) endLine = lineNo;
    const endText = editor.getLine(endLine);
    let id;
    const m = endText.match(/\s\^([A-Za-z0-9-]+)\s*$/);
    if (m) {
      id = m[1];
    } else {
      id = this.newBlockId(cache);
      editor.setLine(endLine, endText.replace(/\s*$/, '') + ' ^' + id);
    }
    const linkpath = this.app.metadataCache.fileToLinktext(file, file.path);
    const text = (asEmbed ? '!' : '') + '[[' + linkpath + '#^' + id + ']]';
    await navigator.clipboard.writeText(text);
    new Notice('已复制 ' + text);
  }

  /** 幽灵编辑写回：按块 id 定位行（id 在文件内唯一，免疫缓存过期），
      保留列表/任务前缀与 id 尾巴，只替换正文 */
  async saveBlockEdit(linktext, sourcePath, newText) {
    const { subpath } = parseLinktext(linktext);
    const blockId = subpath && subpath.startsWith('#^')
      ? subpath.slice(2).toLowerCase() : '';
    const file = this.resolveTargetFile(linktext, sourcePath);
    if (!file || !blockId) return;
    const idRe = new RegExp('\\s\\^' + blockId + '\\s*$', 'i');
    await this.app.vault.process(file, (data) => {
      const arr = data.split('\n');
      for (let i = 0; i < arr.length; i++) {
        if (!idRe.test(arr[i])) continue;
        const m = arr[i].match(
          /^(\s*(?:>\s*)?(?:[-*+]|\d+[.)])\s+(?:\[[^\]]\]\s+)?|\s*)(.*?)(\s\^[A-Za-z0-9-]+)\s*$/
        );
        if (m) arr[i] = m[1] + newText + m[3];
        break;
      }
      return arr.join('\n');
    });
    new Notice('已写回原块');
  }

  markDead(spanEl, linktext, sourcePath) {
    spanEl.empty();
    spanEl.setText(linktext);
    spanEl.addClass('oo-ref-missing');
    spanEl.setAttribute('data-oo-dead', '1');
    // 记下失效项，resolved 后由 healDeadRefs 判断是否已能解析
    const src = sourcePath || '';
    if (this._deadRefs) this._deadRefs.set(linktext + '|' + src, { linktext, sourcePath: src });
    return null;
  }

  /* ---------- 设置与杂项 ---------- */

  applyBodyClasses() {
    for (const [key, cls] of Object.entries(BODY_CLASSES)) {
      document.body.classList.toggle(cls, !!this.settings[key]);
    }
  }

  async saveAndApply() {
    await this.saveData(this.settings);
    this.applyBodyClasses();
    // 影响渲染的开关（引用带待办状态等）立即生效：epoch +1 迫使 LP widget
    // 全部重建，免去"改了设置要重开文件"的困惑
    this._refEpoch++;
    this.refreshAllViews();
    this.scheduleRefCounts();
  }

  refreshAllViews() {
    this.refreshEditorsNow();
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.getMode() === 'preview' && view.previewMode) {
        view.previewMode.rerender(true);
      }
    }
  }
};

/* ---------- Live Preview（CM6 装饰） ---------- */

function buildLivePreviewExtension(plugin) {
  const { ViewPlugin, Decoration, WidgetType } = cm.view;
  const { RangeSetBuilder } = cm.state;
  const syntaxTree = cm.language.syntaxTree;

  class RefWidget extends WidgetType {
    constructor(linktext, sourcePath) {
      super();
      this.linktext = linktext;
      this.sourcePath = sourcePath;
      this.epoch = plugin._refEpoch; // 失效自愈：epoch 变化迫使重建
    }

    eq(other) {
      return other.epoch === this.epoch
        && other.linktext === this.linktext && other.sourcePath === this.sourcePath;
    }

    toDOM() {
      const span = createSpan({
        cls: 'oo-ref',
        attr: { 'data-oo-href': this.linktext, 'data-oo-source': this.sourcePath },
      });
      // 缓存命中时同步先画纯文本（宽度≈最终宽度），随后异步富渲染原位替换——
      // 避免"空 span → 填充"造成的行内回流与折行高度变化
      const cached = plugin.getBlockTextSync(this.linktext, this.sourcePath);
      if (cached != null) {
        span.setText(stripInlineSyntax(cached));
        // 任务块的复选框同步先画，与文本同帧出现
        const t = plugin.settings.taskRefs
          && plugin.getBlockTaskSync(this.linktext, this.sourcePath);
        if (t) plugin.attachTaskCheckbox(span, t.task, t.path, t.blockId);
      }
      // 解析不到的引用同步定格为失效态——否则 widget 每次滚回视口重建时
      // 都会走一遍"空→异步填充"，成为反复回流的跳动源
      if (cached == null && !plugin.canResolveSync(this.linktext, this.sourcePath)) {
        plugin.markDead(span, this.linktext, this.sourcePath);
        return span;
      }
      // 生命周期挂在插件上；渲染的是小段文本，随插件卸载一并释放
      plugin.renderRefInto(span, this.linktext, this.sourcePath, plugin);
      return span;
    }

    // 事件全部交还 DOM：跳转/进入编辑由插件的全局点击代理处理
    ignoreEvent() {
      return true;
    }
  }

  /** 幽灵预览（可编辑）：编辑块链接代码时跟在代码后面的
      源文本，直接改动即编辑原块，失焦或 Enter 写回，Escape 放弃 */
  class GhostWidget extends WidgetType {
    constructor(linktext, sourcePath) {
      super();
      this.linktext = linktext;
      this.sourcePath = sourcePath;
      this.epoch = plugin._refEpoch;
    }

    eq(other) {
      return other.epoch === this.epoch
        && other.linktext === this.linktext && other.sourcePath === this.sourcePath;
    }

    toDOM() {
      // 幽灵预览是只读渲染。"贴字边框＋随文折行＋光标进出"需要真正的内嵌
      // 子编辑器：表单控件是原子盒不随文折行，contenteditable 在编辑器树内不可靠。
      // 编辑原块的入口走 Shift+点击跳转。saveBlockEdit 保留备将来立项接线
      const span = createSpan({ cls: 'oo-ref oo-ref-ghost' });
      const cached = plugin.getBlockTextSync(this.linktext, this.sourcePath);
      if (cached != null) {
        span.setText(stripInlineSyntax(cached));
      } else if (!plugin.canResolveSync(this.linktext, this.sourcePath)) {
        span.setText('（未解析）');
        span.addClass('oo-ref-missing');
      } else {
        plugin.renderRefInto(span, this.linktext, this.sourcePath, plugin);
      }
      return span;
    }

    ignoreEvent() {
      return true; // 鼠标/键盘交给幽灵自己，编辑器不接管
    }
  }

  /** 引用计数角标（功能4·编辑器） */
  class CountWidget extends WidgetType {
    constructor(count, id) {
      super();
      this.count = count;
      this.id = id;
    }

    eq(other) {
      return other.count === this.count && other.id === this.id;
    }

    toDOM() {
      const span = createSpan({ cls: 'oo-refcount', text: String(this.count) });
      span.setAttribute('data-oo-count-search', '"#^' + this.id + '"');
      return span;
    }

    ignoreEvent() {
      return true; // 点击走全局代理 → 全局搜索
    }
  }

  /** 页面级计数角标（编辑器）：正文首行行末，随内容滚动 */
  class PageCountWidget extends WidgetType {
    constructor(count, search) {
      super();
      this.count = count;
      this.search = search;
    }

    eq(other) {
      return other.count === this.count && other.search === this.search;
    }

    toDOM() {
      const span = createSpan({ cls: 'oo-refcount oo-pagecount', text: String(this.count) });
      span.setAttribute('data-oo-count-search', this.search);
      return span;
    }

    ignoreEvent() {
      return true;
    }
  }

  const build = (view) => {
    try {
      const s = plugin.settings;
      if (!s.inlineRefs && !s.hideBlockIds && !s.refCounts) return Decoration.none;
      // 仅 Live Preview；源码模式保持原文
      if (!view.state.field(editorLivePreviewField, false)) return Decoration.none;
      const info = view.state.field(editorInfoField, false);
      const sourcePath = (info && info.file && info.file.path) || '';
      const sel = view.state.selection;
      const touchedBy = (from, to) => {
        for (const r of sel.ranges) {
          if (r.from <= to && r.to >= from) return true;
        }
        return false;
      };
      // 代码块/行内代码/公式里的字面文本不动
      const inCode = (pos) =>
        /code|math|frontmatter/i.test(syntaxTree(view.state).resolveInner(pos + 1).type.name);
      const ranges = []; // 收集后统一排序，RangeSetBuilder 要求有序输入
      for (const range of view.visibleRanges) {
        const text = view.state.doc.sliceString(range.from, range.to);
        if (s.inlineRefs) {
          // 嵌入 ![[…#^…]]：保留既有装饰尝试（内核胜则由内核渲染）
          REF_EMBED_RE.lastIndex = 0;
          let m;
          while ((m = REF_EMBED_RE.exec(text)) !== null) {
            const start = range.from + m.index;
            const end = start + m[0].length;
            if (touchedBy(start, end) || inCode(start)) continue;
            ranges.push({
              from: start, to: end,
              deco: Decoration.replace({ widget: new RefWidget(m[1], sourcePath) }),
            });
          }
          // 块链接 [[…#^…]]（方案 A 载体）：未触碰 → 内容替换；
          // 触碰 → 露出代码，代码后追加幽灵预览
          REF_LINK_RE.lastIndex = 0;
          while ((m = REF_LINK_RE.exec(text)) !== null) {
            const start = range.from + m.index;
            const end = start + m[0].length;
            // 前面是 ! 的是嵌入，由上面的嵌入分支处理（不用后行断言：旧版 iOS 不支持）
            if (start > 0 && view.state.doc.sliceString(start - 1, start) === '!') continue;
            if (inCode(start)) continue;
            if (touchedBy(start, end)) {
              ranges.push({
                from: end, to: end,
                deco: Decoration.widget({ widget: new GhostWidget(m[1], sourcePath), side: 1 }),
              });
            } else {
              ranges.push({
                from: start, to: end,
                deco: Decoration.replace({ widget: new RefWidget(m[1], sourcePath) }),
              });
            }
          }
        }
        // 行级处理：块 id 隐藏（功能3）与引用计数角标（功能4）
        if (s.hideBlockIds || s.refCounts) {
          const lines = text.split('\n');
          let offset = 0;
          for (const lineText of lines) {
            const absStart = range.from + offset;
            const m2 = lineText.match(/(\s)(\^[A-Za-z0-9-]+)\s*$/);
            if (m2) {
              const idStart = absStart + m2.index;
              const lineEnd = absStart + lineText.length;
              // 任何情况都不显示 id（含光标行）——露出只有误改风险，
              // 改了 id 引用全断；配合 atomicRanges 光标自动跳过隐藏区
              if (s.hideBlockIds && !inCode(idStart)) {
                ranges.push({ from: idStart, to: lineEnd, deco: Decoration.replace({}) });
              }
              if (s.refCounts) {
                const id = m2[2].slice(1).toLowerCase();
                const n = plugin.refCounts.get(sourcePath + '#^' + id) || 0;
                if (n > 0) {
                  ranges.push({
                    from: lineEnd, to: lineEnd,
                    deco: Decoration.widget({ widget: new CountWidget(n, id), side: 1 }),
                  });
                }
              }
            }
            offset += lineText.length + 1;
          }
        }
      }
      // 页面级计数：正文首行（跳过 frontmatter 与空行）行末
      if (s.refCounts) {
        const pn = plugin.pageCounts.get(sourcePath) || 0;
        if (pn > 0) {
          const doc = view.state.doc;
          let lineNo = 1;
          if (doc.lines >= 1 && doc.line(1).text === '---') {
            for (let i = 2; i <= Math.min(doc.lines, 100); i++) {
              if (doc.line(i).text === '---') {
                lineNo = Math.min(i + 1, doc.lines);
                break;
              }
            }
          }
          while (lineNo < doc.lines && doc.line(lineNo).text.trim() === '') lineNo++;
          const base = (sourcePath.split('/').pop() || '').replace(/\.md$/, '');
          ranges.push({
            from: doc.line(lineNo).to,
            to: doc.line(lineNo).to,
            deco: Decoration.widget({
              widget: new PageCountWidget(pn, '"[[' + base + '"'),
              side: 1,
            }),
          });
        }
      }
      ranges.sort((a, b) => a.from - b.from || a.to - b.to);
      const builder = new RangeSetBuilder();
      for (const r of ranges) builder.add(r.from, r.to, r.deco);
      return builder.finish();
    } catch (e) {
      console.error('a-outline', e);
      return Decoration.none;
    }
  };

  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = build(view);
      }
      update(update) {
        // 输入法组合进行中只随改动映射位置、不重建：重建会让 CM6 比对
        // 装饰集，虽然多数时候无 DOM 变化，但组合期间任何一次重画都可能让
        // 正在组合的文本被提前提交；组合结束后的下一个事务照常重建
        if (update.view.composing) {
          if (update.docChanged) this.decorations = this.decorations.map(update.changes);
          return;
        }
        if (update.docChanged || update.selectionSet
          || update.viewportChanged || update.transactions.length > 0) {
          this.decorations = build(update.view);
        }
      }
    },
    {
      decorations: (v) => v.decorations,
      // 隐藏的块 id 成为原子范围：光标移动直接跳过，不会踏进不可见区
      provide: (viewPlugin) => cm.view.EditorView.atomicRanges.of((view) => {
        const inst = view.plugin(viewPlugin);
        return inst ? inst.decorations : Decoration.none;
      }),
    }
  );
}

/** 护锚键位（Enter、Backspace、Delete）。
    行末 ` ^id` 连同前导空格被隐藏，并且是原子范围：屏幕上"文字末尾"与"行末"是同一处，
    光标可能停在隐藏段之前（idStart）或之后（行末），使用者看不见区别。Obsidian 只认
    "段落最后一行行末、前面有空白"的锚。下面这些按键会让锚露出、被吞掉或失效：
    - Enter：光标在隐藏段之前时，CM6 insertNewlineAndIndent 吃掉光标后的空白，`^id` 顶格落到
      新行露出来；列表里其他列表增强类插件可能把锚搬进新建的空项。段落里即使在行末换行，
      新行紧贴原段，一打字两行就是同一段，锚落在中间一行，Obsidian 不再认
    - Backspace／删词，光标在隐藏段之后：原子范围让删除一次吞掉整段 ` ^id`
    - 行首 Backspace、行尾 Delete 合并两行：下一行接在 `^id` 后面，锚不在行末
    - 删掉两段之间唯一的空行：两段并成一段，锚落在中间一行
    处理：在一切按键映射之前（Obsidian 的 keymap 挂在 Prec.default 的 keydown 上，所以
    Prec.highest 的 keydown 先于其他插件）——段落 Enter 直接插入空行开新段；列表等其它行的
    Enter 与 Backspace 先把光标挪到安全一侧再放行；合并时自己合并，把锚移到合并后那一段的
    末行行末；两处都带锚时拦下并提示（合并必丢一个）。输入法组合中、建议框开着、有选区、
    Cmd 组合键（整行删除是明确意图）、代码与公式里一律不动。
    */
function buildAnchorKeyGuardExtension(plugin) {
  const { EditorView } = cm.view;
  const { EditorSelection } = cm.state;
  const syntaxTree = cm.language.syntaxTree;
  const ID_TAIL_RE = /(\s)(\^[A-Za-z0-9-]+)\s*$/; // 与 buildLivePreviewExtension 行级隐藏同一条
  // 非段落行：列表项、标题、引用、表格、代码围栏、分隔线
  const STRUCT_RE = /^\s*(?:[-*+]|\d+[.)])\s|^\s{0,3}#{1,6}(?:\s|$)|^\s*>|^\s*\||^\s*(?:```|~~~)|^\s*(?:[-*_]\s*){3,}$/;
  const isBlank = (t) => t.trim() === '';
  const isPlain = (t) => !isBlank(t) && !STRUCT_RE.test(t);
  // 后面紧跟普通段落行时会把它吸进来（懒续行）的行：段落、列表项、引用；标题、表格、围栏、分隔线不会
  const SOLID_RE = /^\s{0,3}#{1,6}(?:\s|$)|^\s*\||^\s*(?:```|~~~)|^\s*(?:[-*_]\s*){3,}$/;
  const absorbs = (t) => !isBlank(t) && !SOLID_RE.test(t);
  // 行末有被隐藏的块 id 时返回 {line, idStart, id}，否则 null
  const anchorOf = (state, line) => {
    const m = line.text.match(ID_TAIL_RE);
    if (!m) return null;
    const idStart = line.from + m.index;
    if (/code|math|frontmatter/i.test(syntaxTree(state).resolveInner(idStart + 1).type.name)) return null;
    return { line, idStart, id: m[2] };
  };
  // 从第 n 行起的段落末行（后续行都是普通段落行就一直往下）
  const paraEnd = (doc, n) => {
    while (n < doc.lines && isPlain(doc.line(n + 1).text)) n++;
    return doc.line(n);
  };
  const block = (a, why) => {
    new Notice('两处都有块 id，' + why + '会丢掉其中一个，已阻止。需要时请在源码模式里先处理块 id');
    return true;
  };
  // 统一出口：删掉 [delFrom, delTo)，把锚补到 end 行末，光标落在原文档的 cursorAt（映射后）
  const moveAnchor = (view, a, delFrom, delTo, end, cursorAt, userEvent, what) => {
    const spec = [{ from: delFrom, to: delTo, insert: '' }, { from: end.to, insert: ' ' + a.id }];
    const changes = view.state.changes(spec);
    view.dispatch({
      changes,
      selection: EditorSelection.cursor(changes.mapPos(cursorAt, -1)),
      userEvent,
      scrollIntoView: true,
    });
    return true;
  };
  // a 所在行与下一行 next 合并（next 非空）：next 接到可见末尾，锚移到合并后段落末行
  const joinNext = (view, a, next, userEvent) => {
    const doc = view.state.doc;
    const end = isPlain(next.text) ? paraEnd(doc, next.number) : next;
    if (anchorOf(view.state, end)) return block(a, '合并');
    return moveAnchor(view, a, a.idStart, next.from, end, a.idStart, userEvent, '合并保锚');
  };
  // 删掉 a 与 q 之间唯一的空行 blank：两段并成一段，锚移到 q 所在段落末行
  const mergeAcrossBlank = (view, a, blank, q, cursorAt, userEvent) => {
    const end = paraEnd(view.state.doc, q.number);
    if (anchorOf(view.state, end)) return block(a, '删掉空行把两段并成一段');
    // 一次删掉 [idStart, blank.to)：锚尾巴、它后面的换行和空行内容
    return moveAnchor(view, a, a.idStart, blank.to, end, cursorAt, userEvent, '并段保锚');
  };
  const anchoredPara = (state, line) => (line && absorbs(line.text) ? anchorOf(state, line) : null);
  return EditorView.domEventHandlers({
    keydown(event, view) {
      try {
        const key = event.key;
        if (key !== 'Enter' && key !== 'Backspace' && key !== 'Delete') return false;
        if (event.metaKey) return false;
        if (event.isComposing || event.keyCode === 229 || view.composing) return false;
        if (!plugin.settings.hideBlockIds) return false;
        if (!view.state.field(editorLivePreviewField, false)) return false;
        const es = plugin.app.workspace.editorSuggest;
        const suggesting = es && (typeof es.isShowingSuggestion === 'function'
          ? es.isShowingSuggestion() : es.currentSuggest);
        if (suggesting || document.querySelector('body > .suggestion-container')) {
          return false; // 建议框（[[ 补全、@ 块搜索等）在处理这个键
        }
        const sel = view.state.selection;
        if (sel.ranges.length !== 1 || !sel.main.empty) return false;
        const head = sel.main.head;
        const doc = view.state.doc;
        const line = doc.lineAt(head);
        const lineAt = (n) => (n >= 1 && n <= doc.lines ? doc.line(n) : null);
        const a = anchorOf(view.state, line);

        if (key === 'Enter') {
          if (event.shiftKey || event.altKey || event.ctrlKey) return false;
          if (!a || head < a.idStart) return false;
          if (isPlain(line.text)) {
            // 段落：插入空行开新段，锚留在原段末行
            view.dispatch({
              changes: { from: line.to, insert: '\n\n' },
              selection: EditorSelection.cursor(line.to + 2),
              userEvent: 'input', scrollIntoView: true,
            });
            return true;
          }
          if (head >= line.to) return false;
          view.dispatch({ selection: EditorSelection.cursor(line.to), userEvent: 'select' });
          return false; // 放行：内核或其他插件在行末照常换行
        }

        if (key === 'Backspace') {
          if (a && head > a.idStart && a.idStart > line.from) {
            // 光标在隐藏段之后：挪到之前，默认删除只删可见字符
            view.dispatch({ selection: EditorSelection.cursor(a.idStart), userEvent: 'select' });
            return false;
          }
          if (head !== line.from) return false;
          const prev = lineAt(line.number - 1);
          const pa = prev && anchorOf(view.state, prev);
          if (pa && pa.idStart > prev.from && !isBlank(line.text)) {
            return joinNext(view, pa, line, 'delete.backward');
          }
          // 空行上行首退格：删掉的是 prev 与本空行之间的换行
          const next = lineAt(line.number + 1);
          const ppa = anchoredPara(view.state, prev);
          if (ppa && isBlank(line.text) && next && isPlain(next.text)) {
            return mergeAcrossBlank(view, ppa, line, next, ppa.idStart, 'delete.backward');
          }
          // 段落行首退格，上面是唯一的空行、再上面是带锚段落
          const pprev = lineAt(line.number - 2);
          const pppa = anchoredPara(view.state, pprev);
          if (pppa && prev && isBlank(prev.text) && isPlain(line.text)) {
            return mergeAcrossBlank(view, pppa, prev, line, line.from, 'delete.backward');
          }
          return false;
        }

        // Delete
        if (a && head >= a.idStart && a.idStart > line.from) {
          const next = lineAt(line.number + 1);
          if (!next) {
            // 文末：向前无可删；光标挪到隐藏段之后再放行，默认删除什么也不做
            view.dispatch({ selection: EditorSelection.cursor(line.to), userEvent: 'select' });
            return false;
          }
          if (!isBlank(next.text)) return joinNext(view, a, next, 'delete.forward');
          const after = lineAt(line.number + 2);
          if (absorbs(line.text) && after && isPlain(after.text)) {
            return mergeAcrossBlank(view, a, next, after, a.idStart, 'delete.forward');
          }
          // 下一行是空行、合并后不会并段：只删换行
          return moveAnchor(view, a, a.idStart, next.from, next, a.idStart, 'delete.forward', '删空行保锚');
        }
        // 光标在空行上按 Delete：上面是带锚段落、下面是段落时会并段
        if (isBlank(line.text) && head === line.from) {
          const prev = lineAt(line.number - 1), next = lineAt(line.number + 1);
          const pa = anchoredPara(view.state, prev);
          if (pa && next && isPlain(next.text)) {
            return mergeAcrossBlank(view, pa, line, next, line.from, 'delete.forward');
          }
        }
        return false;
      } catch (e) {
        console.error('a-outline', e);
      }
      return false;
    },
  });
}

/** Roam 式光标（设置「Roam 式光标」）。
    ① 上下移动：光标在内容最前面（列表符号、待办框、引用 `>`、标题 `#` 之后；普通段落是行首）时，
       移到相邻行的内容最前面——默认按横坐标对齐，从有序列表「1. 」之后下移到普通段落会落在第 2 个字后面；
       光标在行尾时移到相邻行的行尾（行末有隐藏块 id 时停在 id 之前，免得接着打字写到锚后面）；
       在中间照旧。只在要离开当前行时接管：一行折成多行显示时，行内上下仍走默认
    ② 内容最前面按 Enter：列表项交给内核（或其他列表插件）照常拆项（序号重排、待办框由它们处理），
       拆完把光标挪到上面新空出的那一项；普通段落由本插件插入新行、光标留在新行，
       行末带块 id 的段落多插一个空行，新写的内容自成一段，不并进被引用的那一段
    建议框开着（上下键在选建议）、输入法组合中、有选区、按着修饰键、代码与公式里一律不动 */
function buildRoamCursorExtension(plugin) {
  const { EditorView } = cm.view;
  const { EditorSelection } = cm.state;
  const syntaxTree = cm.language.syntaxTree;
  const ID_TAIL_RE = /(\s)(\^[A-Za-z0-9-]+)\s*$/; // 与行级隐藏同一条
  const LIST_RE = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[.\]\s+)?/;
  const PREFIX_RE = /^\s*(?:(?:[-*+]|\d+[.)])\s+(?:\[.\]\s+)?|(?:>\s?)+|#{1,6}\s+)?/;
  const EMPTY_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s*(?:\[.\]\s*)?$/;
  const STRUCT_RE = /^\s*(?:[-*+]|\d+[.)])\s|^\s{0,3}#{1,6}(?:\s|$)|^\s*>|^\s*\||^\s*(?:```|~~~|\$\$)|^\s*(?:[-*_]\s*){3,}$|^\s*!\[\[/;
  const inCode = (state, pos) =>
    /code|math|frontmatter/i.test(syntaxTree(state).resolveInner(pos + 1).type.name);
  const contentStart = (line) => line.from + (line.text.match(PREFIX_RE) || [''])[0].length;
  const visibleEnd = (state, line) => {
    if (!plugin.settings.hideBlockIds) return line.to;
    const m = line.text.match(ID_TAIL_RE);
    return m && !inCode(state, line.from + m.index) ? line.from + m.index : line.to;
  };
  // 可以直接落光标的行：空行、普通段落、列表项、标题；表格、代码、引用/callout、嵌入交给默认
  const safeTarget = (state, line) => {
    const t = line.text;
    if (t.trim() === '') return true;
    if (inCode(state, line.from)) return false;
    return !STRUCT_RE.test(t) || LIST_RE.test(t) || /^\s{0,3}#{1,6}\s/.test(t);
  };
  const busy = (event, view) => {
    if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return true;
    if (event.isComposing || event.keyCode === 229 || view.composing) return true;
    if (!plugin.settings.roamCursor) return true;
    if (!view.state.field(editorLivePreviewField, false)) return true;
    const es = plugin.app.workspace.editorSuggest;
    const suggesting = es && (typeof es.isShowingSuggestion === 'function'
      ? es.isShowingSuggestion() : es.currentSuggest);
    if (suggesting || document.querySelector('body > .suggestion-container')) return true;
    const sel = view.state.selection;
    return sel.ranges.length !== 1 || !sel.main.empty;
  };
  return EditorView.domEventHandlers({
    keydown(event, view) {
      try {
        const key = event.key;
        if (key !== 'ArrowUp' && key !== 'ArrowDown' && key !== 'Enter') return false;
        if (busy(event, view)) return false;
        const state = view.state, doc = state.doc;
        const head = state.selection.main.head;
        const line = doc.lineAt(head);
        if (inCode(state, line.from) || !safeTarget(state, line)) return false;
        const cs = contentStart(line);

        if (key === 'Enter') {
          if (head !== cs || line.text.slice(cs - line.from).trim() === '') return false;
          if (LIST_RE.test(line.text)) {
            // 放行给内核拆项；拆完（同一次按键内同步完成）把光标挪到上面的空项
            const L = line.number, rest = line.text.slice(cs - line.from);
            queueMicrotask(() => {
              try {
                const d = view.state.doc, sel = view.state.selection.main;
                if (L + 1 > d.lines || !sel.empty) return;
                const up = d.line(L), down = d.line(L + 1);
                if (d.lineAt(sel.head).number !== L + 1) return;
                if (!EMPTY_ITEM_RE.test(up.text) || !down.text.endsWith(rest)) return;
                // 有的续写实现会删掉空项符号后的空格（`1.`），打字就不成列表了：补回一个
                if (/\s$/.test(up.text)) {
                  view.dispatch({ selection: EditorSelection.cursor(up.to), userEvent: 'select' });
                } else {
                  view.dispatch({ changes: { from: up.to, insert: ' ' },
                    selection: EditorSelection.cursor(up.to + 1), userEvent: 'input' });
                }
              } catch (e) { console.error('a-outline', e); }
            });
            return false;
          }
          if (STRUCT_RE.test(line.text) || cs !== line.from) return false;
          // 普通段落：本插件插入新行，光标留在新行；带块 id 的段落隔一个空行
          const anchored = visibleEnd(state, line) !== line.to;
          view.dispatch({
            changes: { from: line.from, insert: anchored ? '\n\n' : '\n' },
            selection: EditorSelection.cursor(line.from),
            userEvent: 'input', scrollIntoView: true,
          });
          return true;
        }

        // ArrowUp／ArrowDown
        const ve = visibleEnd(state, line);
        const atStart = head === cs || (head === line.from && line.text.trim() === '');
        const atEnd = head === line.to || head === ve;
        if (!atStart && !atEnd) return false;
        const forward = key === 'ArrowDown';
        const moved = view.moveVertically(state.selection.main, forward);
        if (moved.head === head) return false;
        const target = doc.lineAt(moved.head);
        if (target.number === line.number) return false; // 同一行折行内移动，走默认
        if (!safeTarget(state, target)) return false;
        const pos = atStart ? contentStart(target) : visibleEnd(state, target);
        view.dispatch({ selection: EditorSelection.cursor(pos), userEvent: 'select', scrollIntoView: true });
        return true;
      } catch (e) {
        console.error('a-outline', e);
      }
      return false;
    },
  });
}

/* ---------- 记住位置：光标记录（CM6） ---------- */

/** 选区一变就把光标写进内存表（落盘另有防抖）。只认主编辑器：editorInfoField
    在主编辑器里就是 MarkdownView 本身（内核以 owner 初始化该字段），Canvas
    卡片、表格单元格这类内嵌编辑器的 owner 不是它，自然跳过 */
function buildCursorMemoExtension(plugin) {
  const { ViewPlugin } = cm.view;
  return ViewPlugin.fromClass(
    class {
      update(update) {
        if (!update.selectionSet) return;
        const info = update.state.field(editorInfoField, false);
        if (info instanceof MarkdownView) plugin.notePosition(info, 'cursor');
      }
    }
  );
}

/* ---------- 设置面板 ---------- */

class OutlineSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    const toggle = (name, desc, key) => {
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addToggle((t) =>
          t.setValue(this.plugin.settings[key]).onChange(async (value) => {
            this.plugin.settings[key] = value;
            await this.plugin.saveAndApply();
          })
        );
    };

    toggle(
      '行内块引用',
      '块链接 [[笔记#^块]] 由插件自渲染为行内文本：与前后文字同行、自然折行、高度一致。'
        + '标题嵌入与整页嵌入不受影响',
      'inlineRefs'
    );
    toggle(
      '引用带待办状态（实验）',
      '引用的块是待办（- [ ] / - [x]）时，原块的复选框随引用一起显示——'
        + '特殊符号和含义与句子一起被引用。复选框直连源文件：在任何页面点它，'
        + '改写的都是原任务行，全部引用同步，待办只需关一次。'
        + '实验功能，默认关闭',
      'taskRefs'
    );
    toggle(
      'Shift+点击跳转原文',
      'Shift+点击引用在右侧分栏打开原块，Shift+Cmd/Ctrl+点击在新标签页打开；'
        + '普通点击把光标送进原文进入编辑（移动端轻点同此）',
      'clickToJump'
    );
    toggle(
      '打开文件时预热扫描（实验）',
      '打开文件后立即把全文滚动测量一遍，让编辑器记住每一行的真实高度，'
        + '替代虚拟化的估算——以少许打开延迟换取滚动不再跳动。'
        + '扫描期间内容短暂隐去；滚轮/点击/按键立即中止并回到扫描前位置，'
        + '中途切换文件自动让位',
      'warmupSweep'
    );
    toggle(
      '@ 唤起全库块搜索',
      '输入 @ ＋关键词模糊搜索全库的块，Enter 插入块链接 [[文件#^id]]；'
        + '目标块没有 id 时自动生成并写入目标文件（与原生补全建 id 同一行为）',
      'atSearch'
    );
    toggle(
      '隐藏块 id',
      '行尾的 ^块id 在编辑器里完全隐藏（含光标行，光标自动跳过）——露出只有误改风险，'
        + 'id 一改引用全断；阅读视图原生就不显示',
      'hideBlockIds'
    );
    toggle(
      'Roam 式光标',
      '光标在内容最前面（列表符号、待办框之后）时上下移动仍落在内容最前面，在行尾时落在行尾（隐藏块 id 之前）；'
        + '在列表项或段落的内容最前面按 Enter，光标跳到新空出的那一行，接着就能输入',
      'roamCursor'
    );
    toggle(
      '块引用计数',
      '统计全库对每个块的引用数，角标固定在块行最右侧，点击跳全局搜索'
        + '（只统计块，标题与页面计数不在范围内）',
      'refCounts'
    );
    toggle(
      '右键菜单：复制块链接/嵌入',
      '编辑器右键菜单提供「复制块链接」「复制块嵌入」，当前块没有 id 时自动生成'
        + '（命令面板里有同名命令，可绑定快捷键）',
      'blockLinkMenu'
    );
    toggle(
      '记住光标与滚动位置',
      '文件关闭或切换时记下光标与滚动位，重新打开回到原处，Obsidian 重启后的标签页同样恢复'
        + '。记录只存本机、按库隔离，不随同步走；'
        + '前进/后退、[[链接#锚点]]、搜索命中这类自带定位的打开不受影响',
      'rememberPosition'
    );
  }
}

/* ---------- @ 全库块搜索（功能2） ---------- */

class BlockSearchSuggest extends obsidian.EditorSuggest {
  constructor(plugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  onTrigger(cursor, editor) {
    if (!this.plugin.settings.atSearch) return null;
    const before = editor.getLine(cursor.line).slice(0, cursor.ch);
    // @ 紧接在文字后面也触发（中文行文里 @ 前通常没有空格）。
    // 防打邮箱：@ 前是字母/数字/邮箱符号、且 @ 后已出现 . 时（域名），不再触发
    const m = before.match(/@([^\s@]{0,40})$/);
    if (!m) return null;
    const at = before.length - m[1].length - 1;
    const prev = at > 0 ? before[at - 1] : '';
    if (prev === '@') return null;
    if (/[A-Za-z0-9._%+-]/.test(prev) && m[1].includes('.')) return null;
    return {
      start: { line: cursor.line, ch: at },
      end: cursor,
      query: m[1],
    };
  }

  async getSuggestions(context) {
    await this.plugin.ensureBlockIndex();
    const q = context.query.trim();
    if (!q) {
      const first = this.hotSuggestions();
      return first.length ? first : [{ none: true }];
    }
    const fuzzy = obsidian.prepareFuzzySearch(q);
    const out = [];
    for (const [path, entry] of this.plugin.blockIndex) {
      for (const item of entry.lines) {
        const res = fuzzy(item.text);
        if (res) {
          out.push({ path, lineNo: item.lineNo, text: item.text, score: res.score });
        }
      }
    }
    out.sort((a, b) => b.score - a.score);
    // 没有匹配时给一条提示，弹窗照常出现，避免"按了 @ 没反应"
    return out.length ? out.slice(0, 20) : [{ none: true }];
  }

  /** 空查询候选：被引用次数最高的块（"高频"），@ 一按就有 */
  hotSuggestions() {
    if (!this.plugin.settings.refCounts) this.plugin.buildRefCounts();
    const entries = Array.from(this.plugin.refCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30);
    const out = [];
    for (const [key, count] of entries) {
      const idx = key.lastIndexOf('#^');
      if (idx < 0) continue;
      const path = key.slice(0, idx);
      const id = key.slice(idx + 2);
      const file = this.plugin.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) continue;
      const cache = this.plugin.app.metadataCache.getFileCache(file);
      const block = cache && cache.blocks && cache.blocks[id];
      if (!block) continue;
      const entry = this.plugin.blockIndex.get(path);
      if (!entry) continue;
      const lineNo = block.position.start.line;
      const line = entry.lines.find((l) => l.lineNo === lineNo);
      if (!line) continue;
      out.push({ path, lineNo, text: line.text, score: count, count });
      if (out.length >= 20) break;
    }
    // 还没有任何块被引用过时，列出最近修改的文件里的块
    if (out.length < 20) {
      const seen = new Set(out.map((o) => o.path + ':' + o.lineNo));
      const recent = Array.from(this.plugin.blockIndex.entries())
        .sort((a, b) => b[1].mtime - a[1].mtime);
      for (const [path, entry] of recent) {
        let taken = 0;
        for (const l of entry.lines) {
          if (l.text.trim().startsWith('#')) continue; // 标题行跳过，取正文块
          if (seen.has(path + ':' + l.lineNo)) continue;
          out.push({ path, lineNo: l.lineNo, text: l.text, score: 0 });
          if (++taken >= 3 || out.length >= 20) break;
        }
        if (out.length >= 20) break;
      }
    }
    return out;
  }

  renderSuggestion(item, el) {
    if (item.none) {
      el.addClass('oo-block-suggestion');
      el.createDiv({ text: '没有匹配的块' });
      return;
    }
    el.addClass('oo-block-suggestion');
    const text = item.text.trim()
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[^\]]\]\s+)?/, '')
      .replace(/\s*\^[A-Za-z0-9-]+\s*$/, '');
    el.createDiv({ text: text.slice(0, 80) });
    el.createDiv({
      cls: 'oo-block-suggestion-path',
      text: item.path + ':' + (item.lineNo + 1)
        + (item.count ? '　被引 ' + item.count : ''),
    });
  }

  async selectSuggestion(item) {
    const context = this.context;
    if (!context) return;
    if (item.none) {
      this.close();
      return;
    }
    const file = this.plugin.app.vault.getAbstractFileByPath(item.path);
    if (!(file instanceof TFile)) return;
    const id = await this.plugin.ensureBlockId(file, item.lineNo);
    const sourcePath = (context.file && context.file.path) || '';
    const linkpath = this.plugin.app.metadataCache.fileToLinktext(file, sourcePath);
    context.editor.replaceRange('[[' + linkpath + '#^' + id + ']]', context.start, context.end);
  }
}
