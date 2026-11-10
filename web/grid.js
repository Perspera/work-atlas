/*!
 * DashGrid —— 12 列、行吸附的中文仓库 BI 看板布局引擎
 * 纯原生浏览器 JavaScript（ES2017），无依赖、无构建步骤、无网络请求。
 * 通过 <script src="grid.js"></script> 加载后，仅暴露一个全局：window.DashGrid。
 */
(function (global) {
  'use strict';

  const STYLE_ID = 'dg-style';

  const DEFAULTS = {
    cols: 12,
    rowHeight: 64,
    gap: 12,
    editable: true,
    minW: 2,
    minH: 2,
    autoLayout: true
  };

  const CSS = `
.dg-container{position:relative;width:100%;box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;color:#1f2933}
.dg-item{position:absolute;box-sizing:border-box;display:flex;flex-direction:column;overflow:hidden;background:#fff;border:1px solid #e6e9ef;border-radius:10px;box-shadow:0 1px 2px rgba(16,24,40,.06);z-index:1;transition:box-shadow .15s ease}
.dg-item:hover{z-index:2}
.dg-item.dg-dragging{opacity:.7;z-index:30;box-shadow:0 12px 28px rgba(16,24,40,.16);transition:none}
.dg-item.dg-resizing{outline:2px dashed #2f6fed;outline-offset:-2px;z-index:30}
.dg-head{flex:0 0 40px;height:40px;display:flex;align-items:center;gap:8px;padding:0 6px 0 12px;box-sizing:border-box;border-bottom:1px solid #eef1f5;background:#fbfcfe;cursor:grab;touch-action:none;-webkit-user-select:none;user-select:none}
.dg-head:focus{outline:none}
.dg-head:focus-visible{outline:2px solid #2f6fed;outline-offset:-3px;border-radius:10px 10px 0 0}
.dg-item.dg-dragging .dg-head{cursor:grabbing}
.dg-title{flex:1 1 auto;min-width:0;font-size:13px;font-weight:600;line-height:20px;color:#1f2933;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dg-actions{flex:0 0 auto;display:flex;align-items:center;gap:2px}
.dg-btn{width:24px;height:24px;margin:0;padding:0;border:0;border-radius:6px;background:transparent;color:#7b8794;font:inherit;font-size:13px;line-height:1;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;-webkit-appearance:none;appearance:none}
.dg-btn:hover{background:#eef2fa;color:#2f6fed}
.dg-btn:active{background:#e2ebfb}
.dg-btn.dg-btn-remove:hover{background:#fdecea;color:#d92d20}
.dg-body{flex:1 1 auto;min-height:0;overflow:auto;padding:12px;box-sizing:border-box;font-size:13px;color:#1f2933}
.dg-resize{position:absolute;right:0;bottom:0;width:18px;height:18px;cursor:nwse-resize;touch-action:none;z-index:3}
.dg-resize::after{content:"";position:absolute;right:3px;bottom:3px;width:7px;height:7px;border-right:2px solid #c3cbd8;border-bottom:2px solid #c3cbd8;border-bottom-right-radius:3px}
.dg-item.dg-locked .dg-resize,.dg-item.dg-locked .dg-btn-remove{display:none}
.dg-item.dg-locked .dg-head{cursor:default}
.dg-container.dg-readonly .dg-head{cursor:default}
.dg-ph{position:absolute;display:none;box-sizing:border-box;border:2px dashed #2f6fed;border-radius:10px;background:rgba(47,111,237,.12);pointer-events:none;z-index:0}
.dg-ph.dg-ph-blocked{border-color:#e03131;background:rgba(224,49,49,.12)}
.dg-container.dg-drag-active{-webkit-user-select:none;user-select:none}
.dg-container.dg-drop-target{outline:2px dashed rgba(47,111,237,.55);outline-offset:6px;border-radius:12px}
`;

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function clamp(value, min, max) {
    return value < min ? min : value > max ? max : value;
  }

  function deepClone(value) {
    if (Array.isArray(value)) return value.map(deepClone);
    if (value && typeof value === 'object') {
      const proto = Object.getPrototypeOf(value);
      if (proto === Object.prototype || proto === null) {
        const copy = {};
        for (const key of Object.keys(value)) copy[key] = deepClone(value[key]);
        return copy;
      }
    }
    return value;
  }

  function overlaps(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function generateId() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return 'w-' + global.crypto.randomUUID();
    }
    return 'w-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function DashGrid(container, options) {
    const host = typeof container === 'string' ? document.querySelector(container) : container;
    if (!host || host.nodeType !== 1) {
      throw new TypeError('DashGrid: 需要一个有效的容器元素');
    }

    injectStyle();

    const config = Object.assign({}, DEFAULTS, options || {});
    const cols = Math.max(1, Math.floor(Number(config.cols)) || DEFAULTS.cols);
    const rowHeight = Math.max(1, Number(config.rowHeight) || DEFAULTS.rowHeight);
    const gap = Math.max(0, Number(config.gap) || 0);
    const minW = clamp(Math.round(Number(config.minW) || DEFAULTS.minW), 1, cols);
    const minH = Math.max(1, Math.round(Number(config.minH) || DEFAULTS.minH));
    // false = 直接删；function = 交给宿主弹窗；其余（含默认/ true）= 原生 confirm
    const confirmRemove = config.confirmRemove === undefined ? true : config.confirmRemove;
    // false = 自由摆放：拖到哪就放哪，不与其它组件挤动；true = 旧行为（重叠就下推+向上吸）
    const autoLayout = config.autoLayout !== false;
    // 无 ResizeObserver 的环境（测试用的无布局 DOM）没有真实宽度，用兜底宽度保证可渲染。
    const supportsResizeObserver = typeof global.ResizeObserver === 'function';

    let editable = config.editable !== false;
    let items = [];
    let drag = null;
    let ph = null;
    let mounted = false;
    let destroyed = false;
    let cellW = 0;
    let lastWidth = -1;
    let resizeObserver = null;

    const els = new Map();
    const prevHeight = host.style.height;

    /* ========================= 几何计算 ========================= */

    // 容器宽度决定单元格宽度：容器左右各留一个 gap，列与列之间也留一个 gap。
    function layoutWidth() {
      const width = host.clientWidth || 0;
      if (width > 0) return width;
      return supportsResizeObserver ? 0 : 1200;
    }

    function measure() {
      const width = layoutWidth();
      cellW = width > 0 ? Math.max(2, (width - gap * (cols + 1)) / cols) : 0;
    }

    function pixelRect(r) {
      return {
        left: gap + r.x * (cellW + gap),
        top: gap + r.y * (rowHeight + gap),
        width: Math.max(1, r.w * cellW + (r.w - 1) * gap),
        height: Math.max(1, r.h * rowHeight + (r.h - 1) * gap)
      };
    }

    function applyRect(el, r) {
      const rect = pixelRect(r);
      el.style.left = rect.left + 'px';
      el.style.top = rect.top + 'px';
      el.style.width = rect.width + 'px';
      el.style.height = rect.height + 'px';
    }

    function updateHeight() {
      let bottom = 0;
      for (const w of items) bottom = Math.max(bottom, w.y + w.h);
      const rows = Math.max(3, bottom);
      host.style.height = rows * (rowHeight + gap) + gap + 'px';
    }

    /* ========================= 布局模型 ========================= */

    function findItem(id) {
      for (const w of items) {
        if (w.id === id) return w;
      }
      return null;
    }

    function signature() {
      return items.map(w => w.id + ':' + w.x + ',' + w.y + ',' + w.w + ',' + w.h).join('|');
    }

    function normalizeWidget(input) {
      const w = (input && typeof input === 'object') ? deepClone(input) : {};
      if (w.id === undefined || w.id === null || w.id === '') w.id = generateId();
      else w.id = String(w.id);
      w.type = w.type === undefined || w.type === null ? 'widget' : w.type;
      w.title = w.title === undefined || w.title === null ? '' : String(w.title);
      if (!w.spec || typeof w.spec !== 'object') w.spec = {};
      w.w = clamp(Math.round(Number(w.w)) || minW, minW, cols);
      w.h = Math.max(minH, Math.round(Number(w.h)) || minH);
      w.x = clamp(Math.round(Number(w.x)) || 0, 0, cols - w.w);
      w.y = Math.max(0, Math.round(Number(w.y)) || 0);
      return w;
    }

    /* ------------------------------------------------------------------
     * 初始布局 / setLayout：按 (y, x) 顺序依次落位。
     * 每落一个组件时，只要它和已经落位的组件仍有重叠，就把它的 y 继续
     * 向下推一行，直到完全不重叠为止。这样可以保证：
     *   - 不会出现任何重叠；
     *   - x 不变，因此 x + w <= cols 始终成立；
     *   - 后加入的组件让位于先加入的组件，顺序稳定。
     * ------------------------------------------------------------------ */
    function packLayout() {
      const placed = [];
      const order = items.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x));
      for (const w of order) {
        let guard = 0;
        while (placed.some(p => overlaps(p, w)) && guard < 10000) {
          w.y += 1;
          guard += 1;
        }
        placed.push(w);
      }
    }

    /* ------------------------------------------------------------------
     * 垂直压缩（compact）：把组件尽可能往上提，但不允许重叠。
     * 处理顺序：按 (y, x) 排序，从最上面的组件开始依次固定；
     * 每个组件在“已固定组件”之上反复试探 y - 1，能放就继续上提，
     * 一遇到重叠立即停止 —— 所以它只会停在第一个空位，不会跳过障碍。
     *
     * protectId：被保护组件的 y 不允许被压缩改变。
     *   - 拖动移动（move）时传 null：所有组件（含被拖组件）都参与压缩；
     *   - 调整大小（resize）时传被调整组件的 id：压缩不会把它拉走，
     *     避免用户刚拉大就整块向上跳动。
     * ------------------------------------------------------------------ */
    function compact(protectId) {
      const placed = [];
      const order = items.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x));
      for (const w of order) {
        if (w.id !== protectId) {
          let ny = w.y;
          while (ny > 0) {
            const probe = { x: w.x, y: ny - 1, w: w.w, h: w.h };
            if (placed.some(p => overlaps(p, probe))) break;
            ny -= 1;
          }
          w.y = ny;
        }
        placed.push(w);
      }
    }

    /* ------------------------------------------------------------------
     * 碰撞消解（下推级联）：调用前 anchor 已经落位（拖动结束/新组件加入）。
     * 从 anchor 出发，凡是和它重叠的组件一律被推到 anchor 的下方
     * （o.y = a.y + a.h），被推下去的组件再继续检查它压到的组件，
     * 用队列实现递归级联。anchor 自身永远不再移动，因此队列只会向下
     * 推进、y 单调增大，过程必然收敛；guard 仅作为极端情况的保险。
     * ------------------------------------------------------------------ */
    function resolveOverlaps(anchor) {
      if (!anchor) return;
      const queue = [anchor];
      let guard = 0;
      while (queue.length && guard < 10000) {
        guard += 1;
        const a = queue.shift();
        for (const o of items) {
          if (o.id === a.id || o.id === anchor.id) continue;
          if (!overlaps(a, o)) continue;
          o.y = a.y + a.h;
          queue.push(o);
        }
      }
    }

    function collides(x, y, w, h) {
      for (const it of items) {
        if (x < it.x + it.w && x + w > it.x && y < it.y + it.h && y + h > it.y) return true;
      }
      return false;
    }

    // 与「除自己以外」的组件是否重叠（自由摆放模式判断目标格是否被占用）
    function collidesOthers(self, x, y, w, h) {
      for (const it of items) {
        if (self && it.id === self.id) continue;
        if (x < it.x + it.w && x + w > it.x && y < it.y + it.h && y + h > it.y) return true;
      }
      return false;
    }

    // 逐行扫描第一个放得下的空位；最差也会落在现有最低点之下（必定为空）。
    function findFreeSlot(w, h) {
      let bottom = 0;
      for (const it of items) bottom = Math.max(bottom, it.y + it.h);
      for (let y = 0; y <= bottom; y += 1) {
        for (let x = 0; x <= cols - w; x += 1) {
          if (!collides(x, y, w, h)) return { x: x, y: y };
        }
      }
      return { x: 0, y: bottom };
    }

    /* ========================= DOM 构建 ========================= */

    function makeBtn(glyph, label, extraClass) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'dg-btn' + (extraClass ? ' ' + extraClass : '');
      btn.textContent = glyph;
      btn.setAttribute('title', label);
      btn.setAttribute('aria-label', label);
      return btn;
    }

    function updateItemShell(w, el) {
      const parts = el.__dg;
      if (!parts) return;
      parts.title.textContent = w.title;
      el.classList.toggle('dg-locked', !!w.locked);
      if (editable) {
        parts.head.setAttribute('aria-label', w.title + (w.locked ? '（已锁定）' : '（可拖动，方向键移动，Shift+方向键调整宽度）'));
      } else {
        parts.head.setAttribute('aria-label', w.title);
      }
    }

    function buildItem(w) {
      const el = document.createElement('div');
      el.className = 'dg-item';
      el.setAttribute('data-id', w.id);
      el.setAttribute('data-type', w.type);

      const head = document.createElement('div');
      head.className = 'dg-head';
      head.tabIndex = editable ? 0 : -1;

      const title = document.createElement('span');
      title.className = 'dg-title';
      title.textContent = w.title;
      head.appendChild(title);

      const parts = { head: head, title: title, body: null };

      if (editable) {
        const actions = document.createElement('span');
        actions.className = 'dg-actions';

        const configureBtn = makeBtn('⚙', '配置', 'dg-btn-config');
        const duplicateBtn = makeBtn('⧉', '复制', 'dg-btn-duplicate');
        const removeBtn = makeBtn('✕', '删除', 'dg-btn-remove');

        configureBtn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          if (typeof config.onConfigure === 'function') config.onConfigure(deepClone(w));
        });
        duplicateBtn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          if (typeof config.onDuplicate === 'function') config.onDuplicate(deepClone(w));
        });
        removeBtn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          requestRemove(w.id);
        });

        actions.appendChild(configureBtn);
        actions.appendChild(duplicateBtn);
        actions.appendChild(removeBtn);
        head.appendChild(actions);

        head.addEventListener('pointerdown', function (ev) {
          startMove(ev, w, el);
        });
        head.addEventListener('keydown', function (ev) {
          onHeadKey(ev, w);
        });
      }

      el.appendChild(head);

      const body = document.createElement('div');
      body.className = 'dg-body';
      el.appendChild(body);
      parts.body = body;

      if (editable) {
        const resizeHandle = document.createElement('div');
        resizeHandle.className = 'dg-resize';
        resizeHandle.setAttribute('title', '拖动调整大小');
        resizeHandle.addEventListener('pointerdown', function (ev) {
          startResize(ev, w, el);
        });
        el.appendChild(resizeHandle);
      }

      el.__dg = parts;
      return el;
    }

    function fillBody(w, el) {
      const parts = el && el.__dg;
      if (!parts) return;
      const body = parts.body;
      while (body.firstChild) body.removeChild(body.firstChild);
      if (typeof config.renderWidget === 'function') config.renderWidget(deepClone(w), body);
    }

    function syncEditableClass() {
      host.classList.toggle('dg-readonly', !editable);
    }

    // mounted 为 false（宽度为 0 / 容器隐藏）时只维护数据，等 ResizeObserver 再来画。
    function render(fillAll) {
      if (destroyed || !mounted) return;
      const live = new Set();
      for (const w of items) {
        live.add(w.id);
        let el = els.get(w.id);
        if (!el) {
          el = buildItem(w);
          els.set(w.id, el);
          host.appendChild(el);
          updateItemShell(w, el);
          applyRect(el, w);
          fillBody(w, el);
        } else {
          updateItemShell(w, el);
          applyRect(el, w);
          if (fillAll) fillBody(w, el);
        }
      }
      for (const entry of Array.from(els)) {
        if (!live.has(entry[0])) {
          entry[1].remove();
          els.delete(entry[0]);
        }
      }
      updateHeight();
    }

    function handleResize() {
      if (destroyed) return;
      const width = layoutWidth();
      if (width <= 0) return;
      if (mounted && Math.abs(width - lastWidth) < 1) return;
      lastWidth = width;
      measure();
      if (!mounted) {
        mounted = true;
        render(true);
      } else {
        render(false);
      }
    }

    function changed(reason) {
      if (destroyed) return;
      if (typeof config.onChange === 'function') config.onChange(getLayout(), reason);
    }

    function getLayout() {
      return items.map(w => deepClone(w));
    }

    /* ========================= 拖拽 / 缩放 ========================= */

    function isButtonTarget(node) {
      return !!(node && node.closest && node.closest('button, .dg-actions'));
    }

    function showPlaceholder(target) {
      if (!ph) return;
      const rect = pixelRect(target);
      ph.style.display = 'block';
      ph.style.left = rect.left + 'px';
      ph.style.top = rect.top + 'px';
      ph.style.width = rect.width + 'px';
      ph.style.height = rect.height + 'px';
    }

    function hidePlaceholder() {
      if (ph) {
        ph.style.display = 'none';
        ph.classList.remove('dg-ph-blocked');
      }
    }

    // 自由摆放模式下目标格被占用 → 占位框变红，松手会被拒绝
    function markPlaceholderBlocked(blocked) {
      if (!ph) return;
      ph.classList.toggle('dg-ph-blocked', !!blocked);
    }

    function beginDragCommon() {
      const d = drag;
      if (!d) return;
      try {
        if (d.captureEl && d.captureEl.setPointerCapture) d.captureEl.setPointerCapture(d.pointerId);
      } catch (err) {
        /* 合成的 pointerId 无法捕获，document 上的监听依旧兜底 */
      }
      if (d.el) {
        d.el.classList.add('dg-dragging');
        if (d.kind === 'resize') d.el.classList.add('dg-resizing');
      }
      host.classList.add('dg-drag-active');
      if (d.kind === 'external') host.classList.add('dg-drop-target');
      document.addEventListener('pointermove', onPointerMove, { passive: false });
      document.addEventListener('pointerup', onPointerUp);
      document.addEventListener('pointercancel', onPointerCancel);
      updateDrag(d.lastX, d.lastY);
      startAutoScroll();
    }

    function startMove(ev, w, el) {
      if (!editable || w.locked || drag || destroyed || !mounted) return;
      if (ev.button !== undefined && ev.button !== 0) return;
      if (isButtonTarget(ev.target)) return;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      ev.preventDefault();
      try {
        el.__dg.head.focus({ preventScroll: true });
      } catch (err) {
        el.__dg.head.focus();
      }
      measure();
      drag = {
        kind: 'move',
        w: w,
        el: el,
        captureEl: el,
        pointerId: ev.pointerId,
        lastX: ev.clientX,
        lastY: ev.clientY,
        offX: ev.clientX - rect.left,
        offY: ev.clientY - rect.top,
        startX: ev.clientX,
        startY: ev.clientY,
        startPxW: rect.width,
        startPxH: rect.height,
        orig: { x: w.x, y: w.y, w: w.w, h: w.h },
        target: { x: w.x, y: w.y, w: w.w, h: w.h },
        raf: 0,
        restoreTouchAction: null
      };
      beginDragCommon();
    }

    function startResize(ev, w, el) {
      if (!editable || w.locked || drag || destroyed || !mounted) return;
      if (ev.button !== undefined && ev.button !== 0) return;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      measure();
      drag = {
        kind: 'resize',
        w: w,
        el: el,
        captureEl: el,
        pointerId: ev.pointerId,
        lastX: ev.clientX,
        lastY: ev.clientY,
        offX: 0,
        offY: 0,
        startX: ev.clientX,
        startY: ev.clientY,
        startPxW: rect.width,
        startPxH: rect.height,
        orig: { x: w.x, y: w.y, w: w.w, h: w.h },
        target: { x: w.x, y: w.y, w: w.w, h: w.h },
        raf: 0,
        restoreTouchAction: null
      };
      beginDragCommon();
    }

    // 把指针位置换算成吸附后的目标格；同时实时更新占位框。
    function updateDrag(clientX, clientY) {
      const d = drag;
      if (!d) return;
      d.lastX = clientX;
      d.lastY = clientY;
      if (!mounted || cellW <= 0 || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return;

      const rect = host.getBoundingClientRect();

      if (d.kind === 'external') {
        const inside = rect.width > 0 &&
          clientX >= rect.left && clientX <= rect.right &&
          clientY >= rect.top && clientY <= rect.bottom;
        const x = clamp(Math.round((clientX - rect.left - gap) / (cellW + gap)), 0, cols - d.w.w);
        const y = Math.max(0, Math.round((clientY - rect.top - gap) / (rowHeight + gap)));
        d.target.x = x;
        d.target.y = y;
        if (inside) {
          showPlaceholder(d.target);
          markPlaceholderBlocked(collides(x, y, d.w.w, d.w.h));
        } else hidePlaceholder();
        return;
      }

      if (d.kind === 'move') {
        const px = clientX - rect.left - d.offX;
        const py = clientY - rect.top - d.offY;
        d.target.x = clamp(Math.round((px - gap) / (cellW + gap)), 0, cols - d.w.w);
        d.target.y = Math.max(0, Math.round((py - gap) / (rowHeight + gap)));
        showPlaceholder(d.target);
        markPlaceholderBlocked(collidesOthers(d.w, d.target.x, d.target.y, d.w.w, d.w.h));
        return;
      }

      // resize
      const maxW = Math.max(minW, cols - d.orig.x);
      const nw = clamp(
        Math.round((d.startPxW + (clientX - d.startX) + gap) / (cellW + gap)),
        minW,
        maxW
      );
      const nh = Math.max(
        minH,
        Math.round((d.startPxH + (clientY - d.startY) + gap) / (rowHeight + gap))
      );
      d.target.w = nw;
      d.target.h = nh;
      showPlaceholder(d.target);
      markPlaceholderBlocked(collidesOthers(d.w, d.orig.x, d.orig.y, nw, nh));
    }

    function onPointerMove(ev) {
      const d = drag;
      if (!d || ev.pointerId !== d.pointerId) return;
      if (ev.cancelable) ev.preventDefault();
      updateDrag(ev.clientX, ev.clientY);
    }

    function onPointerUp(ev) {
      const d = drag;
      if (!d || ev.pointerId !== d.pointerId) return;
      if (ev.cancelable) ev.preventDefault();
      updateDrag(ev.clientX, ev.clientY);
      commitDrag();
    }

    function onPointerCancel(ev) {
      const d = drag;
      if (!d || ev.pointerId !== d.pointerId) return;
      cleanupDrag();
    }

    function cleanupDrag() {
      const d = drag;
      if (!d) return;
      drag = null;
      if (d.raf) {
        cancelAnimationFrame(d.raf);
        d.raf = 0;
      }
      document.removeEventListener('pointermove', onPointerMove, false);
      document.removeEventListener('pointerup', onPointerUp, false);
      document.removeEventListener('pointercancel', onPointerCancel, false);
      try {
        if (d.captureEl && d.captureEl.hasPointerCapture && d.captureEl.hasPointerCapture(d.pointerId)) {
          d.captureEl.releasePointerCapture(d.pointerId);
        }
      } catch (err) {
        /* 指针已经结束时忽略 */
      }
      if (d.el) d.el.classList.remove('dg-dragging', 'dg-resizing');
      host.classList.remove('dg-drag-active', 'dg-drop-target');
      if (typeof d.restoreTouchAction === 'function') d.restoreTouchAction();
      hidePlaceholder();
    }

    // 提交一次拖拽：先写回坐标/尺寸，再消解重叠并做垂直压缩，最后通知宿主。
    function commitDrag() {
      const d = drag;
      if (!d) return;

      if (d.kind === 'external') {
        const rect = host.getBoundingClientRect();
        const inside = rect.width > 0 &&
          d.lastX >= rect.left && d.lastX <= rect.right &&
          d.lastY >= rect.top && d.lastY <= rect.bottom;
        const candidate = d.w;
        const tx = d.target.x;
        const ty = d.target.y;
        cleanupDrag();
        if (inside) commitInsert(candidate, tx, ty);
        return;
      }

      const widget = d.w;
      const kind = d.kind;
      const target = {
        x: kind === 'move' ? d.target.x : d.orig.x,
        y: kind === 'move' ? d.target.y : d.orig.y,
        w: kind === 'resize' ? d.target.w : d.orig.w,
        h: kind === 'resize' ? d.target.h : d.orig.h
      };
      cleanupDrag();
      // 只是点了一下标题/手柄、位置和尺寸都没变：不做压缩，避免无意义的重排。
      if (kind === 'move') {
        if (target.x === d.orig.x && target.y === d.orig.y) return;
      } else if (target.w === d.orig.w && target.h === d.orig.h) {
        return;
      }

      const before = signature();
      if (kind === 'move') {
        if (!autoLayout && collidesOthers(widget, target.x, target.y, widget.w, widget.h)) {
          render(false);
          if (typeof config.onReject === 'function') config.onReject(deepClone(widget), 'occupied');
          return;
        }
        widget.x = target.x;
        widget.y = target.y;
        if (autoLayout) {
          resolveOverlaps(widget);
          compact(null);
        }
      } else {
        if (!autoLayout && collidesOthers(widget, widget.x, widget.y, target.w, target.h)) {
          render(false);
          if (typeof config.onReject === 'function') config.onReject(deepClone(widget), 'occupied');
          return;
        }
        widget.w = target.w;
        widget.h = target.h;
        if (autoLayout) {
          resolveOverlaps(widget);
          compact(widget.id);
        }
      }
      render(false);
      if (kind === 'resize') {
        // 尺寸变了，内容要按新宽高重绘（图表/KPI/表格跟随缩放）
        const resizedEl = els.get(widget.id);
        if (resizedEl) fillBody(widget, resizedEl);
      }
      if (signature() !== before) changed(kind);
    }

    function startAutoScroll() {
      if (!drag || drag.raf) return;
      drag.raf = requestAnimationFrame(autoScrollStep);
    }

    // 距离视口上下边缘 60px 以内时，用 rAF 持续滚动窗口，越近滚得越快。
    function autoScrollStep() {
      const d = drag;
      if (!d) return;
      d.raf = 0;
      const margin = 60;
      const vh = global.innerHeight || 0;
      let dy = 0;
      if (d.lastY < margin) {
        dy = -Math.ceil(((margin - d.lastY) / margin) * 18) - 2;
      } else if (d.lastY > vh - margin) {
        dy = Math.ceil(((d.lastY - (vh - margin)) / margin) * 18) + 2;
      }
      if (dy !== 0) {
        const beforeY = global.scrollY;
        global.scrollBy(0, dy);
        if (global.scrollY !== beforeY) updateDrag(d.lastX, d.lastY);
      }
      d.raf = requestAnimationFrame(autoScrollStep);
    }

    /* ========================= 键盘无障碍 ========================= */

    function onHeadKey(ev, w) {
      if (!editable || w.locked || destroyed || drag) return;
      const deltas = {
        ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]
      };
      const delta = deltas[ev.key];
      if (!delta) return;
      ev.preventDefault();
      const before = signature();
      if (ev.shiftKey) {
        const nextW = clamp(w.w + delta[0], minW, cols - w.x);
        const nextH = Math.max(minH, w.h + delta[1]);
        if (nextW === w.w && nextH === w.h) return;
        if (!autoLayout && collidesOthers(w, w.x, w.y, nextW, nextH)) return;
        w.w = nextW;
        w.h = nextH;
        if (autoLayout) {
          resolveOverlaps(w);
          compact(w.id);
        }
      } else {
        const nextX = clamp(w.x + delta[0], 0, cols - w.w);
        const nextY = Math.max(0, w.y + delta[1]);
        if (nextX === w.x && nextY === w.y) return;
        if (!autoLayout && collidesOthers(w, nextX, nextY, w.w, w.h)) return;
        w.x = nextX;
        w.y = nextY;
        if (autoLayout) {
          resolveOverlaps(w);
          compact(w.id);
        }
      }
      render(false);
      if (signature() !== before) changed(ev.shiftKey ? 'resize' : 'move');
    }

    /* ========================= 宿主 API ========================= */

    function setLayout(layout, setOptions) {
      if (destroyed) return;
      cancelDrag();
      const silent = !!(setOptions && setOptions.silent);
      const list = Array.isArray(layout) ? layout : [];
      items = [];
      const used = new Set();
      for (const raw of list) {
        if (!raw || typeof raw !== 'object') continue;
        const w = normalizeWidget(raw);
        if (used.has(w.id)) w.id = generateId();
        used.add(w.id);
        items.push(w);
      }
      packLayout();
      for (const entry of Array.from(els)) {
        entry[1].remove();
        els.delete(entry[0]);
      }
      render(false);
      updateHeight();
      if (!silent) changed('layout');
    }

    function setEditable(value) {
      if (destroyed) return;
      const next = value !== false;
      if (next === editable) return;
      cancelDrag();
      editable = next;
      syncEditableClass();
      for (const entry of Array.from(els)) {
        entry[1].remove();
        els.delete(entry[0]);
      }
      render(false);
    }

    // 放入一个新组件：按给定格子落位；若压到其它组件，只把对方下推，
    // 不做垂直压缩，保证最终落点和拖拽时显示的占位框一致。
    function commitInsert(w, x, y) {
      if (!w) return;
      w.x = clamp(x, 0, Math.max(0, cols - w.w));
      w.y = Math.max(0, y);
      const before = signature();
      if (!autoLayout && collidesOthers(w, w.x, w.y, w.w, w.h)) {
        const slot = findFreeSlot(w.w, w.h);
        w.x = slot.x;
        w.y = slot.y;
      }
      items.push(w);
      if (autoLayout) resolveOverlaps(w);
      render(false);
      if (signature() !== before) changed('add');
    }

    function addWidget(widget) {
      if (destroyed) return null;
      const w = normalizeWidget(widget);
      if (findItem(w.id)) w.id = generateId();
      const slot = findFreeSlot(w.w, w.h);
      commitInsert(w, slot.x, slot.y);
      return deepClone(w);
    }

    function removeWidget(id) {
      if (destroyed) return false;
      const index = items.findIndex(w => w.id === id);
      if (index < 0 || items[index].locked) return false;
      if (drag && drag.w && drag.w.id === id) cancelDrag();
      const removed = items.splice(index, 1)[0];
      const el = els.get(id);
      if (el) {
        el.remove();
        els.delete(id);
      }
      if (autoLayout) compact(null);
      render(false);
      changed('remove');
      if (typeof config.onRemove === 'function') config.onRemove(deepClone(removed));
      return true;
    }

    // ✕ 按钮的确认逻辑（供用户手动删除）；removeWidget 是纯 API，不弹确认框。
    // confirmRemove 支持三种形态：false=直接删；true=原生 confirm；函数=交给宿主（返回 false
    // 表示"我自己弹窗，稍后调用 removeWidget"）。
    function requestRemove(id) {
      const w = findItem(id);
      if (!w || w.locked) return;
      if (typeof confirmRemove === 'function') {
        confirmRemove(deepClone(w));
        return;
      }
      if (confirmRemove && typeof global.confirm === 'function') {
        const ok = global.confirm('删除组件「' + w.title + '」？');
        if (!ok) return;
      }
      removeWidget(id);
    }

    function updateWidget(id, patch) {
      if (destroyed) return null;
      const w = findItem(id);
      if (!w) return null;
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return deepClone(w);

      let geometryChanged = false;
      for (const key of Object.keys(patch)) {
        if (key === 'id') continue;
        if (key === 'x' || key === 'y' || key === 'w' || key === 'h') geometryChanged = true;
        w[key] = deepClone(patch[key]);
      }
      w.title = w.title === undefined || w.title === null ? '' : String(w.title);
      w.type = w.type === undefined || w.type === null ? 'widget' : w.type;
      if (!w.spec || typeof w.spec !== 'object') w.spec = {};

      if (geometryChanged) {
        w.w = clamp(Math.round(Number(w.w)) || minW, minW, cols);
        w.h = Math.max(minH, Math.round(Number(w.h)) || minH);
        w.x = clamp(Math.round(Number(w.x)) || 0, 0, cols - w.w);
        w.y = Math.max(0, Math.round(Number(w.y)) || 0);
        resolveOverlaps(w);
        compact(w.id);
      }

      const el = els.get(id);
      render(false);
      if (el) fillBody(w, el);
      changed('update');
      return deepClone(w);
    }

    function refresh(id) {
      if (destroyed) return;
      if (id === undefined || id === null) {
        for (const w of items) {
          const el = els.get(w.id);
          if (el) fillBody(w, el);
        }
        return;
      }
      const w = findItem(id);
      if (!w) return;
      const el = els.get(w.id);
      if (el) fillBody(w, el);
    }

    // 返回一个“拖拽手柄”：宿主在调色板按钮的 pointerdown 上调用它，
    // 之后松手落在容器内 => 以最近的格子位置新增组件；落在容器外 => 取消。
    function beginExternalDrag(widget) {
      return function handleExternalPointerDown(ev) {
        if (!ev || ev.type !== 'pointerdown') return;
        if (!editable || drag || destroyed || !mounted) return;
        if (ev.button !== undefined && ev.button !== 0) return;
        if (!Number.isFinite(ev.clientX) || !Number.isFinite(ev.clientY)) return;
        measure();
        if (cellW <= 0) return;
        ev.preventDefault();

        const candidate = normalizeWidget(widget);
        if (findItem(candidate.id)) candidate.id = generateId();

        const captureEl = (ev.currentTarget && ev.currentTarget.setPointerCapture)
          ? ev.currentTarget
          : ((ev.target && ev.target.setPointerCapture) ? ev.target : host);

        let restoreTouchAction = null;
        if (captureEl && captureEl.style) {
          const previous = captureEl.style.touchAction;
          if (previous !== 'none') {
            captureEl.style.touchAction = 'none';
            restoreTouchAction = function () {
              captureEl.style.touchAction = previous;
            };
          }
        }

        drag = {
          kind: 'external',
          w: candidate,
          el: null,
          captureEl: captureEl,
          pointerId: ev.pointerId,
          lastX: ev.clientX,
          lastY: ev.clientY,
          offX: 0,
          offY: 0,
          startX: ev.clientX,
          startY: ev.clientY,
          startPxW: 0,
          startPxH: 0,
          orig: { x: 0, y: 0, w: candidate.w, h: candidate.h },
          target: { x: 0, y: 0, w: candidate.w, h: candidate.h },
          raf: 0,
          restoreTouchAction: restoreTouchAction
        };
        beginDragCommon();
      };
    }

    function compactAll() {
      if (destroyed) return false;
      const before = signature();
      compact(null);
      render(false);
      if (signature() !== before) {
        changed('compact');
        return true;
      }
      return false;
    }

    function isEmpty() {
      return items.length === 0;
    }

    function cancelDrag() {
      if (drag) cleanupDrag();
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelDrag();
      if (resizeObserver) {
        resizeObserver.disconnect();
        resizeObserver = null;
      } else {
        global.removeEventListener('resize', handleResize);
      }
      for (const entry of Array.from(els)) {
        entry[1].remove();
        els.delete(entry[0]);
      }
      items = [];
      if (ph && ph.parentNode) ph.parentNode.removeChild(ph);
      ph = null;
      host.classList.remove('dg-container', 'dg-readonly', 'dg-drag-active', 'dg-drop-target');
      host.style.height = prevHeight;
    }

    /* ========================= 初始化 ========================= */

    host.classList.add('dg-container');
    syncEditableClass();

    ph = document.createElement('div');
    ph.className = 'dg-ph';
    host.appendChild(ph);

    const initialLayout = Array.isArray(config.layout) ? config.layout : [];
    const initialIds = new Set();
    for (const raw of initialLayout) {
      if (!raw || typeof raw !== 'object') continue;
      const w = normalizeWidget(raw);
      if (initialIds.has(w.id)) w.id = generateId();
      initialIds.add(w.id);
      items.push(w);
    }
    packLayout();

    if (supportsResizeObserver) {
      resizeObserver = new global.ResizeObserver(handleResize);
      resizeObserver.observe(host);
    } else {
      global.addEventListener('resize', handleResize);
    }
    handleResize();

    return {
      setLayout: setLayout,
      getLayout: getLayout,
      setEditable: setEditable,
      addWidget: addWidget,
      removeWidget: removeWidget,
      updateWidget: updateWidget,
      refresh: refresh,
      compactAll: compactAll,
      beginExternalDrag: beginExternalDrag,
      isEmpty: isEmpty,
      destroy: destroy
    };
  }

  global.DashGrid = DashGrid;
})(window);
