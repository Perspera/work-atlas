/*!
 * charts.js - 仓库看板轻量图表库（纯原生 JS / 无外部依赖 / 可离线）
 * 只暴露一个全局：window.Charts
 * 所有渲染仅操作传入容器 el 的 DOM；共享 tooltip 与样式表为库内部单例。
 */
(function () {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var FONT = '-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei","PingFang SC",sans-serif';

  var PALETTE = [
    '#1d5fbf', '#0f766e', '#b45309', '#b42318', '#5b6472', '#0e7490',
    '#15803d', '#98a2b3', '#a16207', '#334155', '#0b5f58', '#6b7280'
  ];

  var records = new WeakMap();      // el -> {draw,timer,width,static,observed,...}
  var resizeObserver = null;
  var tipEl = null;
  var uid = 0;

  // ============================================================
  // 一、基础工具 / 单例样式 / tooltip
  // ============================================================
  function ensureStyle() {
    if (document.getElementById('ch-style')) return;
    var css = [
      '.ch-kpi,.ch-wrap,.ch-list,.ch-donut,.ch-table-wrap,.ch-progress,.ch-empty{box-sizing:border-box;font-family:' + FONT + ';color:#101828;-webkit-font-smoothing:antialiased}',
      '.ch-kpi{position:relative;background:transparent;border:0;border-radius:0;padding:2px 2px 2px 14px;overflow:hidden;min-width:0;box-shadow:none}',
      '.ch-kpi::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--ch-accent,#1d5fbf)}',
      '.ch-kpi-top{display:flex;align-items:center;gap:7px;min-width:0}',
      '.ch-kpi-dot{width:7px;height:7px;border-radius:50%;background:var(--ch-accent,#1d5fbf);flex:0 0 auto}',
      '.ch-kpi-label{font-size:calc(12px * var(--ch-kpi-scale,1));color:#6b7280;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.ch-kpi-value{display:flex;align-items:baseline;gap:6px;margin-top:9px;min-width:0;white-space:nowrap}',
      '.ch-kpi-num{font-size:calc(28px * var(--ch-kpi-scale,1));font-weight:600;line-height:1.16;letter-spacing:-.3px;color:#101828;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis}',
      '.ch-kpi-unit{font-size:14px;color:#6b7280;font-weight:500;flex:0 0 auto}',
      '.ch-kpi-masked{font-size:calc(21px * var(--ch-kpi-scale,1));font-weight:500;color:#a6adb5;letter-spacing:2px}',
      '.ch-kpi-foot{display:flex;align-items:center;gap:10px;margin-top:8px;flex-wrap:wrap}',
      '.ch-kpi-sub{font-size:13px;color:#6b7280;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ch-kpi-trend{font-size:calc(12px * var(--ch-kpi-scale,1));font-weight:600;padding:1px 6px;border-radius:999px;white-space:nowrap}',
      '.ch-kpi-trend.up{color:#166534;background:#e9f8ee}',
      '.ch-kpi-trend.down{color:#991b1b;background:#fdecea}',
      '.ch-kpi-trend.flat{color:#6b7280;background:#f1f5f9}',
      '.ch-wrap{width:100%;min-width:0}',
      '.ch-svg{display:block;width:100%;overflow:visible;font-family:' + FONT + '}',
      '.ch-svg text{font-family:' + FONT + ';pointer-events:none}',
      '.ch-axis{fill:#6b7280;font-size:10px}',
      '.ch-grid{stroke:#e8eef7;stroke-width:1;shape-rendering:crispEdges}',
      '.ch-baseline{stroke:#cbd5e1;stroke-width:1;shape-rendering:crispEdges}',
      '.ch-guide{stroke:#adb5bd;stroke-width:1;stroke-dasharray:3 3;pointer-events:none}',
      '.ch-bar,.ch-slice,.ch-funnel-shape{cursor:default;transition:opacity .12s}',
      '.ch-bar:hover,.ch-slice:hover,.ch-funnel-shape:hover{opacity:.84}',
      '.ch-val{fill:#6b7280;font-size:9px;font-variant-numeric:tabular-nums}',
      '.ch-legend{display:flex;flex-wrap:wrap;align-items:center;gap:5px 14px;margin:0 0 6px;font-size:11px;line-height:16px;color:#6b7280;min-height:0}',
      '.ch-lg{display:inline-flex;align-items:center;gap:5px;max-width:180px;min-width:0}',
      '.ch-lg-dot{width:8px;height:8px;border-radius:2px;flex:0 0 auto;display:inline-block}',
      '.ch-lg-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.ch-tip{position:absolute;z-index:99999;display:none;pointer-events:none;background:rgba(33,37,41,.94);color:#fff;border-radius:7px;padding:7px 10px;font:12px/1.55 ' + FONT + ';max-width:290px;box-shadow:0 6px 24px rgba(0,0,0,.18);white-space:normal}',
      '.ch-tip-title{font-size:11px;color:#ced4da;margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:270px}',
      '.ch-tip-row{display:flex;align-items:center;gap:6px;white-space:nowrap}',
      '.ch-tip-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto;display:inline-block}',
      '.ch-tip-name{color:#dee2e6;font-size:11px;max-width:150px;overflow:hidden;text-overflow:ellipsis}',
      '.ch-tip-val{margin-left:auto;font-variant-numeric:tabular-nums;font-weight:600;padding-left:12px}',
      '.ch-empty{display:flex;align-items:center;justify-content:center;width:100%;min-height:120px;height:100%;box-sizing:border-box;color:#adb5bd;font-size:13px;letter-spacing:.5px}',
      '.ch-empty-mini{min-height:36px;font-size:11px;letter-spacing:0}',
      '.ch-list{width:100%;max-height:420px;overflow:auto;border:1px solid #eef1f4;border-radius:8px;background:#fff}',
      '.ch-li{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid #f1f3f5;font-size:12px;min-width:0}',
      '.ch-li:last-child{border-bottom:none}',
      '.ch-li-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto}',
      '.ch-li-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}',
      '.ch-li-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#1f2933}',
      '.ch-li-sub{font-size:10px;color:#7b8794;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.ch-li-value{flex:0 0 auto;max-width:48%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#495057;font-size:11px;font-variant-numeric:tabular-nums}',
      '.ch-note{font-size:10px;color:#adb5bd;margin-top:2px;text-align:right}',
      '.ch-donut{display:flex;align-items:center;justify-content:center;gap:18px;width:100%;min-width:0}',
      '.ch-donut.narrow{flex-direction:column;align-items:stretch;gap:10px}',
      '.ch-donut.narrow .ch-donut-chart{align-self:center}',
      '.ch-donut-chart{flex:0 0 auto;position:relative}',
      '.ch-donut-legend{flex:1 1 auto;display:flex;flex-direction:column;gap:7px;min-width:0}',
      '.ch-donut.narrow .ch-donut-legend{display:grid;grid-template-columns:1fr;gap:6px 14px;width:100%}',
      '.ch-lg-item{display:flex;align-items:center;gap:7px;min-width:0;font-size:11px;color:#495057}',
      '.ch-lg-item .ch-lg-dot{width:8px;height:8px;border-radius:50%}',
      '.ch-lg-label{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.ch-lg-value{font-weight:600;color:#1f2933;font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.ch-lg-pct{color:#7b8794;font-variant-numeric:tabular-nums;min-width:38px;text-align:right;white-space:nowrap}',
      '.ch-table-wrap{width:100%;max-height:360px;overflow:auto;border:1px solid #e9ecef;border-radius:8px;background:#fff;scrollbar-width:thin}',
      '.ch-table{border-collapse:separate;border-spacing:0;width:100%;font-size:12px;line-height:1.5;color:#1f2933}',
      '.ch-table th{position:sticky;top:0;z-index:2;background:#f8fafc;color:#5b6472;font-weight:600;text-align:left;padding:9px 12px;border-bottom:1px solid #e9ecef;white-space:nowrap}',
      '.ch-table td{padding:8px 12px;border-bottom:1px solid #f1f3f5;vertical-align:middle;background:#fff}',
      '.ch-table tbody tr:last-child td{border-bottom:none}',
      '.ch-table tbody tr:hover td{background:#f8fbff}',
      '.ch-table.zebra tbody tr:nth-child(even) td{background:#fbfcfd}',
      '.ch-table.zebra tbody tr:nth-child(even):hover td{background:#f3f7ff}',
      '.ch-table.compact th{padding:6px 9px;font-size:11px}',
      '.ch-table.compact td{padding:5px 9px;font-size:11px}',
      '.ch-table .ch-row-click{cursor:pointer}',
      '.ch-table .ch-row-click:focus{outline:2px solid #bcd0ff;outline-offset:-2px}',
      '.ch-ta-left{text-align:left}.ch-ta-right{text-align:right}.ch-ta-center{text-align:center}',
      '.ch-progress{width:100%;min-width:0}',
      '.ch-progress-head{display:flex;align-items:baseline;gap:8px;margin-bottom:6px;font-size:12px}',
      '.ch-progress-label{color:#7b8794;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ch-progress-val{margin-left:auto;color:#495057;font-size:12px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.ch-progress-track{height:8px;border-radius:999px;background:#eef1f4;overflow:hidden}',
      '.ch-progress-fill{height:100%;border-radius:999px;background:#1d5fbf;transition:width .3s ease}'
    ].join('\n');
    var style = document.createElement('style');
    style.id = 'ch-style';
    style.type = 'text/css';
    style.appendChild(document.createTextNode(css));
    (document.head || document.documentElement).appendChild(style);
  }

  function el(tag, className) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function clearEl(node) {
    if (!node) return;
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function text(node, value) {
    node.textContent = value == null ? '' : String(value);
    return node;
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function truncate(value, maxChars) {
    var s = value == null ? '' : String(value);
    if (maxChars < 1) maxChars = 1;
    return s.length > maxChars ? s.slice(0, maxChars - 1) + '…' : s;
  }

  function ensureTip() {
    if (tipEl && tipEl.parentNode) return tipEl;
    tipEl = document.getElementById('ch-tip');
    if (!tipEl) {
      tipEl = el('div', 'ch-tip');
      tipEl.id = 'ch-tip';
      tipEl.setAttribute('aria-hidden', 'true');
      (document.body || document.documentElement).appendChild(tipEl);
    }
    return tipEl;
  }

  function showTip(html, pageX, pageY) {
    if (!html) { hideTip(); return; }
    var tip = ensureTip();
    tip.innerHTML = html;
    tip.style.display = 'block';
    var tw = tip.offsetWidth || 160;
    var th = tip.offsetHeight || 44;
    var sx = window.pageXOffset || document.documentElement.scrollLeft || 0;
    var sy = window.pageYOffset || document.documentElement.scrollTop || 0;
    var vw = window.innerWidth || document.documentElement.clientWidth || 0;
    var vh = window.innerHeight || document.documentElement.clientHeight || 0;
    var x = Math.max(sx + 8, Math.min(pageX, sx + vw - tw - 10));
    var y = Math.max(sy + 8, Math.min(pageY, sy + vh - th - 10));
    tip.style.left = Math.round(x) + 'px';
    tip.style.top = Math.round(y) + 'px';
  }

  function hideTip() {
    if (tipEl) tipEl.style.display = 'none';
  }

  function tipHTML(title, rows) {
    var out = '<div class="ch-tip-title">' + esc(title) + '</div>';
    (rows || []).forEach(function (r) {
      out += '<div class="ch-tip-row"><i class="ch-tip-dot" style="background:' + esc(r.color || '#868e96') + '"></i>' +
        '<span class="ch-tip-name">' + esc(r.name) + '</span>' +
        '<b class="ch-tip-val">' + esc(r.value) + '</b></div>';
    });
    return out;
  }

  function eventPoint(evt) {
    var x = evt.pageX, y = evt.pageY;
    if (typeof x !== 'number') x = (evt.clientX || 0) + (window.pageXOffset || 0);
    if (typeof y !== 'number') y = (evt.clientY || 0) + (window.pageYOffset || 0);
    return { x: x, y: y };
  }

  function bindTip(node, htmlGetter) {
    node.addEventListener('mousemove', function (evt) {
      var p = eventPoint(evt);
      showTip(htmlGetter(evt), p.x + 14, p.y + 14);
    });
    node.addEventListener('mouseleave', hideTip);
  }

  // ============================================================
  // 二、数字 / 文本辅助
  // ============================================================
  function num(n, digits) {
    if (n === null || n === undefined || n === '') return '-';
    var x = Number(n);
    if (!isFinite(x)) return '-';
    var d = (digits === undefined || digits === null) ? 0 : Number(digits);
    if (!isFinite(d) || d < 0) d = 0;
    d = Math.min(20, Math.floor(d));
    var s = x.toFixed(d);
    var neg = s.charAt(0) === '-';
    if (neg) s = s.slice(1);
    var parts = s.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    if (neg && Number(parts.join('.')) !== 0) parts[0] = '-' + parts[0];
    return parts.join('.');
  }

  function trim1(x) {
    return x.toFixed(1).replace(/\.0$/, '');
  }

  function trim2(x) {
    return x.toFixed(2).replace(/\.?0+$/, '');
  }

  function wan(n) {
    if (n === null || n === undefined || n === '') return '-';
    var x = Number(n);
    if (!isFinite(x)) return '-';
    var sign = x < 0 ? '-' : '';
    var a = Math.abs(x);
    if (a >= 1e8) return sign + trim2(a / 1e8) + '亿';
    if (a >= 1e4) return sign + trim2(a / 1e4) + '万';
    return num(x);
  }

  function pct(x, digits) {
    if (x === null || x === undefined || x === '') return '-';
    var v = Number(x);
    if (!isFinite(v)) return '-';
    var d = (digits === undefined || digits === null) ? 1 : Number(digits);
    if (!isFinite(d) || d < 0) d = 0;
    return (v * 100).toFixed(Math.min(10, Math.floor(d))) + '%';
  }

  function fmtCell(v) {
    if (v === null || v === undefined) return '-';
    if (typeof v === 'number') return num(v);
    if (typeof v === 'boolean') return String(v);
    if (typeof v === 'object') return String(v);
    return String(v);
  }

  function compact(n) {
    if (n === null || n === undefined || !isFinite(Number(n))) return '-';
    var x = Number(n);
    if (x === 0) return '0';
    var sign = x < 0 ? '-' : '';
    var a = Math.abs(x);
    if (a >= 1e8) return sign + trim1(a / 1e8) + '亿';
    if (a >= 1e4) return sign + trim1(a / 1e4) + '万';
    if (a >= 1e3) return sign + trim1(a / 1e3) + 'k';
    if (a >= 1) return sign + trim1(a);
    return sign + String(Math.round(a * 100) / 100);
  }

  function formatter(opts) {
    return (opts && typeof opts.valueFormat === 'function') ? opts.valueFormat : num;
  }

  function fmtValue(fn, v) {
    try {
      var out = fn(v);
      return (out === null || out === undefined) ? '-' : String(out);
    } catch (e) {
      return num(v);
    }
  }

  function niceTicks(min, max, count) {
    count = count || 4;
    if (!isFinite(min) || !isFinite(max)) { min = 0; max = 1; }
    if (min > max) { var t = min; min = max; max = t; }
    if (max - min < 1e-12) {
      if (max === 0) { min = 0; max = 1; }
      else { var pad = Math.abs(max) * 0.2 || 1; min -= pad; max += pad; }
    }
    var span = max - min;
    var raw = span / count;
    var mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var norm = raw / mag;
    var step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
    step *= mag;
    var lo = Math.floor(min / step) * step;
    var hi = Math.ceil(max / step) * step;
    var ticks = [];
    for (var v = lo; v <= hi + step * 0.5; v += step) {
      ticks.push(Math.abs(v) < 1e-12 ? 0 : Number(v.toFixed(10)));
    }
    return { min: lo, max: hi, ticks: ticks, step: step };
  }

  function makeSvg(width, height) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', String(height));
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.setAttribute('class', 'ch-svg');
    svg.setAttribute('role', 'img');
    return svg;
  }

  function svgNode(tag, attrs, parent) {
    var node = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      for (var k in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, k) && attrs[k] !== null && attrs[k] !== undefined) {
          node.setAttribute(k, String(attrs[k]));
        }
      }
    }
    if (parent) parent.appendChild(node);
    return node;
  }

  function addText(parent, x, y, value, attrs) {
    var a = attrs || {};
    a.x = x;
    a.y = y;
    var node = svgNode('text', a, parent);
    node.textContent = value == null ? '' : String(value);
    return node;
  }

  function addTitle(node, value) {
    var title = document.createElementNS(SVG_NS, 'title');
    title.textContent = value == null ? '' : String(value);
    node.appendChild(title);
  }

  function chartWrap(container) {
    ensureStyle();
    clearEl(container);
    var wrap = el('div', 'ch-wrap');
    container.appendChild(wrap);
    return wrap;
  }

  function makeLegend(series) {
    var box = el('div', 'ch-legend');
    series.forEach(function (s) {
      var item = el('div', 'ch-lg');
      var dot = el('i', 'ch-lg-dot');
      dot.style.background = s.color;
      var name = text(el('span', 'ch-lg-name'), s.name);
      name.title = s.name;
      item.appendChild(dot);
      item.appendChild(name);
      box.appendChild(item);
    });
    return box;
  }

  function showEmpty(container, message, extraClass) {
    ensureStyle();
    if (!container) return null;
    clearEl(container);
    var empty = el('div', 'ch-empty' + (extraClass ? ' ' + extraClass : ''));
    text(empty, message || '暂无数据');
    container.appendChild(empty);
    return empty;
  }

  function emptyChart(container, message, extraClass) {
    var msg = message || '暂无数据';
    showEmpty(container, msg, extraClass);
    // 同时替换旧数据留下的重绘闭包，避免容器尺寸变化时又画出旧图
    register(container, function () { showEmpty(container, msg, extraClass); });
  }

  function renderNarrowList(container, rows, height) {
    ensureStyle();
    clearEl(container);
    var list = el('div', 'ch-list');
    if (height !== undefined && height !== null) {
      list.style.maxHeight = (typeof height === 'number' ? height + 'px' : String(height));
    }
    (rows || []).forEach(function (row) {
      var item = el('div', 'ch-li');
      var dot = el('i', 'ch-li-dot');
      dot.style.background = row.color || PALETTE[0];
      var main = el('div', 'ch-li-main');
      var label = text(el('span', 'ch-li-label'), row.label == null ? '-' : row.label);
      label.title = row.label == null ? '' : String(row.label);
      main.appendChild(label);
      if (row.sub) {
        var sub = text(el('span', 'ch-li-sub'), row.sub);
        sub.title = String(row.sub);
        main.appendChild(sub);
      }
      var value = text(el('span', 'ch-li-value'), row.value == null ? '-' : row.value);
      value.title = row.value == null ? '' : String(row.value);
      item.appendChild(dot);
      item.appendChild(main);
      item.appendChild(value);
      list.appendChild(item);
    });
    container.appendChild(list);
  }

  function prepareSeries(series, length) {
    if (!Array.isArray(series)) return [];
    var out = [];
    for (var si = 0; si < series.length; si++) {
      var s = series[si];
      if (!s || typeof s !== 'object') continue;
      var vals = Array.isArray(s.values) ? s.values : [];
      var values = new Array(length);
      for (var i = 0; i < length; i++) {
        var v = Number(vals[i]);
        values[i] = isFinite(v) ? v : 0;
      }
      out.push({
        name: s.name === null || s.name === undefined ? '系列' + (si + 1) : String(s.name),
        values: values,
        color: s.color || PALETTE[si % PALETTE.length]
      });
    }
    return out;
  }

  // ============================================================
  // 三、尺寸观察 / 重绘注册
  // ============================================================
  function scheduleResize(container) {
    var rec = records.get(container);
    if (!rec || rec.static) return;
    if (rec.timer) clearTimeout(rec.timer);
    rec.timer = setTimeout(function () {
      rec.timer = null;
      runRender(container);
    }, 120);
  }

  function runRender(container) {
    var rec = records.get(container);
    if (!rec || rec.static) return;
    if (rec.timer) { clearTimeout(rec.timer); rec.timer = null; }
    if (rec.poll) { clearInterval(rec.poll); rec.poll = null; }
    var width = container.clientWidth;
    if (width <= 0) return;
    rec.width = width;
    rec.draw(width);
  }

  function register(container, draw) {
    ensureStyle();
    if (!container) return;
    hideTip();
    var rec = records.get(container);
    if (!rec) {
      rec = { draw: draw, timer: null, width: -1, static: false, observed: false };
      records.set(container, rec);
    } else {
      if (rec.timer) { clearTimeout(rec.timer); rec.timer = null; }
      if (rec.poll) { clearInterval(rec.poll); rec.poll = null; }
      rec.draw = draw;
      rec.static = false;
      rec.width = -1; // 允许隐藏期间数据更新后，恢复显示时按同一宽度重绘
    }

    if (!rec.observed && typeof ResizeObserver !== 'undefined') {
      if (!resizeObserver) {
        resizeObserver = new ResizeObserver(function (entries) {
          for (var i = 0; i < entries.length; i++) {
            var entry = entries[i];
            var target = entry.target;
            var r = records.get(target);
            if (!r || r.static) continue;
            var w = target.clientWidth;
            if (w <= 0) continue;
            if (r.width > 0 && Math.abs(w - r.width) < 1) continue;
            scheduleResize(target);
          }
        });
      }
      try {
        resizeObserver.observe(container);
        rec.observed = true;
      } catch (e) { /* 老浏览器忽略 */ }
    }

    if (!rec.observed && !rec.onWinResize) {
      rec.onWinResize = function () {
        if (container.clientWidth > 0) scheduleResize(container);
      };
      window.addEventListener('resize', rec.onWinResize, false);
    }

    if (container.clientWidth > 0) {
      runRender(container);
    } else if (!rec.observed && !rec.poll) {
      // 无 ResizeObserver 时的兜底轮询（最多约 6 秒）
      var tries = 0;
      rec.poll = setInterval(function () {
        if (!container.parentNode) {
          clearInterval(rec.poll); rec.poll = null; return;
        }
        if (container.clientWidth > 0) {
          clearInterval(rec.poll); rec.poll = null;
          runRender(container);
        } else if (++tries > 20) {
          clearInterval(rec.poll); rec.poll = null;
        }
      }, 300);
    }
  }

  function registerStatic(container, draw) {
    ensureStyle();
    if (!container) return;
    hideTip();
    var fn = function () { draw(); };
    var rec = records.get(container);
    if (rec) {
      if (rec.timer) { clearTimeout(rec.timer); rec.timer = null; }
      if (rec.poll) { clearInterval(rec.poll); rec.poll = null; }
      rec.draw = fn;
      rec.static = true;
    } else {
      records.set(container, { draw: fn, timer: null, width: container.clientWidth || 0, static: true, observed: false });
    }
    fn();
  }

  function refresh(container) {
    var rec = records.get(container);
    if (!rec) return;
    if (rec.timer) { clearTimeout(rec.timer); rec.timer = null; }
    if (rec.static) {
      rec.draw(container.clientWidth || 0);
      return;
    }
    var width = container.clientWidth;
    if (width > 0) {
      rec.width = width;
      rec.draw(width);
    }
  }

  // ============================================================
  // 四、KPI / 数据表 / 进度条（HTML）
  // ============================================================
  function kpi(container, opts) {
    ensureStyle();
    if (!container) return;
    opts = opts || {};
    registerStatic(container, function () {
      clearEl(container);
      var accent = opts.color || PALETTE[0];
      var card = el('div', 'ch-kpi');
      card.style.setProperty('--ch-accent', accent);
      var kpiScale = Math.max(0.72, Math.min(2.2, (container.clientHeight || 190) / 190));
      card.style.setProperty('--ch-kpi-scale', kpiScale.toFixed(3));
      var availH = container.clientHeight || 180;
      var availW = container.clientWidth || 220;
      var isScreen = document.body.classList.contains("screen-mode");
      var valuePx = isScreen
        ? Math.max(46, Math.min(76, Math.min(availH * 0.34, availW * 0.24)))
        : Math.max(30, Math.min(56, Math.min(availH * 0.34, availW * 0.27)));

      if (opts.label) {
        var top = el('div', 'ch-kpi-top');
        top.appendChild(el('i', 'ch-kpi-dot'));
        var caption = text(el('span', 'ch-kpi-label'), opts.label);
        caption.title = String(opts.label);
        top.appendChild(caption);
        card.appendChild(top);
      }

      var valueLine = el('div', 'ch-kpi-value');
      if (opts.masked === true) {
        valueLine.appendChild(text(el('span', 'ch-kpi-masked'), '无权限'));
      } else {
        var raw = opts.value;
        var shown = (typeof raw === 'number') ? num(raw) : (raw === null || raw === undefined || raw === '' ? '-' : String(raw));
        var unitLen = opts.unit ? Math.max(2, String(opts.unit).length) * 0.7 : 0;
        var byLen = (availW - 12) / Math.max(1, (String(shown).length + unitLen) * 0.50);
        valuePx = Math.max(isScreen ? 40 : 26, Math.min(valuePx, byLen));
        // 金额/带中文单位的长数字再保守一档，避免“139.52 万元”被省略
        if (opts.unit && String(opts.unit).length >= 2 && String(shown).length >= 5) {
          valuePx = Math.min(valuePx, isScreen ? 66 : 48);
        }
        var big = text(el('span', 'ch-kpi-num'), shown);
        big.title = shown;
        big.style.fontSize = Math.round(valuePx) + "px";
        big.style.fontWeight = "700";
        if (opts.valueColor) big.style.color = opts.valueColor;
        valueLine.appendChild(big);
        if (opts.unit) {
          var unitEl = text(el('span', 'ch-kpi-unit'), opts.unit);
          unitEl.style.fontSize = Math.round(valuePx * 0.34) + "px";
          valueLine.appendChild(unitEl);
        }
      }
      card.appendChild(valueLine);

      var hasTrend = opts.masked !== true && typeof opts.trend === 'number' && isFinite(opts.trend);
      if (opts.sub || hasTrend) {
        var foot = el('div', 'ch-kpi-foot');
        if (opts.sub) {
          var sub = text(el('span', 'ch-kpi-sub'), opts.sub);
          sub.title = String(opts.sub);
          foot.appendChild(sub);
        }
        if (hasTrend) {
          var t = opts.trend;
          var cls = t > 0 ? 'up' : t < 0 ? 'down' : 'flat';
          var arrow = t > 0 ? '▲' : t < 0 ? '▼' : '—';
          var trend = text(el('span', 'ch-kpi-trend ' + cls), arrow + ' ' + Math.abs(t * 100).toFixed(1) + '%');
          foot.appendChild(trend);
        }
        card.appendChild(foot);
      }
      container.appendChild(card);
    });
  }

  function table(container, opts) {
    ensureStyle();
    if (!container) return;
    opts = opts || {};
    var columns = Array.isArray(opts.columns) ? opts.columns.filter(function (c) { return c && c.key !== undefined; }) : [];
    var rows = Array.isArray(opts.rows) ? opts.rows : [];

    registerStatic(container, function () {
      clearEl(container);
      if (!rows.length || !columns.length) {
        showEmpty(container, opts.emptyText || '暂无数据');
        return;
      }
      var box = el('div', 'ch-table-wrap');
      var h = opts.height === undefined || opts.height === null ? 360 : opts.height;
      box.style.maxHeight = (typeof h === 'number' ? h + 'px' : String(h));

      var tbl = document.createElement('table');
      tbl.className = 'ch-table' + (opts.zebra === false ? '' : ' zebra') + (opts.compact ? ' compact' : '');

      var cg = document.createElement('colgroup');
      columns.forEach(function (col) {
        var c = document.createElement('col');
        if (col.width) c.style.width = (typeof col.width === 'number' ? col.width + 'px' : String(col.width));
        cg.appendChild(c);
      });
      tbl.appendChild(cg);

      var thead = document.createElement('thead');
      var htr = document.createElement('tr');
      columns.forEach(function (col) {
        var th = document.createElement('th');
        var align = col.align === 'right' ? 'right' : col.align === 'center' ? 'center' : 'left';
        th.className = 'ch-ta-' + align + (col.className ? ' ' + col.className : '');
        text(th, col.label === undefined ? col.key : col.label);
        htr.appendChild(th);
      });
      thead.appendChild(htr);
      tbl.appendChild(thead);

      var tbody = document.createElement('tbody');
      rows.forEach(function (row, ri) {
        var tr = document.createElement('tr');
        var clickable = typeof opts.onRowClick === 'function';
        if (clickable) {
          tr.className = 'ch-row-click';
          tr.tabIndex = 0;
          tr.addEventListener('click', function (evt) { opts.onRowClick(row, ri, evt); });
          tr.addEventListener('keydown', function (evt) {
            if (evt.key === 'Enter' || evt.key === ' ' || evt.key === 'Spacebar') {
              evt.preventDefault();
              opts.onRowClick(row, ri, evt);
            }
          });
        }
        columns.forEach(function (col) {
          var td = document.createElement('td');
          var align = col.align === 'right' ? 'right' : col.align === 'center' ? 'center' : 'left';
          td.className = 'ch-ta-' + align + (col.className ? ' ' + col.className : '');
          var raw = row && typeof row === 'object' ? row[col.key] : undefined;
          var out;
          try {
            out = typeof col.render === 'function' ? col.render(row, raw) : fmtCell(raw);
          } catch (e) {
            out = '-';
          }
          if (out && out.nodeType) {
            td.appendChild(out);
          } else if (out !== null && out !== undefined) {
            var s = String(out);
            if (/<[a-zA-Z][\s\S]*>/.test(s)) td.innerHTML = s;
            else td.textContent = s;
          } else {
            td.textContent = '-';
          }
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      tbl.appendChild(tbody);
      box.appendChild(tbl);
      container.appendChild(box);
    });
  }

  function progressBar(container, opts) {
    ensureStyle();
    if (!container) return;
    opts = opts || {};
    registerStatic(container, function () {
      clearEl(container);
      var value = Number(opts.value);
      var max = Number(opts.max);
      if (!isFinite(value)) value = 0;
      if (!isFinite(max) || max <= 0) max = 1;
      var ratio = Math.max(0, Math.min(1, value / max));
      var color = opts.color || PALETTE[0];
      var showValue = opts.showValue !== false;

      var root = el('div', 'ch-progress');
      if (opts.label || showValue) {
        var head = el('div', 'ch-progress-head');
        if (opts.label) {
          var label = text(el('span', 'ch-progress-label'), opts.label);
          label.title = String(opts.label);
          head.appendChild(label);
        }
        if (showValue) {
          var pctText = ratio >= 0.9995 ? '100%' : (ratio * 100).toFixed(1).replace(/\.0$/, '') + '%';
          var val = text(el('span', 'ch-progress-val'), pctText);
          val.title = '完成 ' + pctText;
          head.appendChild(val);
        }
        root.appendChild(head);
      }
      var track = el('div', 'ch-progress-track');
      var fill = el('div', 'ch-progress-fill');
      fill.style.width = (ratio * 100).toFixed(1) + '%';
      fill.style.background = color;
      track.appendChild(fill);
      root.appendChild(track);
      root.setAttribute('role', 'progressbar');
      root.setAttribute('aria-valuemin', '0');
      root.setAttribute('aria-valuemax', '100');
      root.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
      container.appendChild(root);
    });
  }

  // ============================================================
  // 五、柱状图 / 条形图
  // ============================================================
  function stackedDomain(series) {
    var n = series[0].values.length;
    var pos = [], neg = [];
    for (var i = 0; i < n; i++) { pos.push(0); neg.push(0); }
    series.forEach(function (s) {
      s.values.forEach(function (v, i) {
        if (v >= 0) pos[i] += v; else neg[i] += v;
      });
    });
    var min = Math.min.apply(null, neg.concat([0]));
    var max = Math.max.apply(null, pos.concat([0]));
    return { min: min, max: max, pos: pos, neg: neg };
  }

  function groupedDomain(series) {
    var min = 0, max = 0;
    series.forEach(function (s) {
      s.values.forEach(function (v) {
        if (v > max) max = v;
        if (v < min) min = v;
      });
    });
    return { min: min, max: max };
  }

  function bar(container, opts) {
    ensureStyle();
    if (!container) return;
    opts = opts || {};
    var cats = Array.isArray(opts.categories) ? opts.categories.slice() : [];
    var series = prepareSeries(opts.series, cats.length);
    if (!cats.length || !series.length) {
      emptyChart(container, '暂无数据');
      return;
    }
    register(container, function (width) {
      width = Math.max(1, Math.round(width));
      hideTip();
      var maxBars = Math.floor(Number(opts.maxBars));
      if (!isFinite(maxBars) || maxBars < 1) maxBars = 60;
      var truncated = false;
      var showCats = cats;
      var showSeries = series;
      if (showCats.length > maxBars) {
        truncated = true;
        showCats = showCats.slice(0, maxBars);
        showSeries = series.map(function (s) {
          return { name: s.name, color: s.color, values: s.values.slice(0, maxBars) };
        });
      }
      var fmt = formatter(opts);

      if (width < 160) {
        var rows = showCats.map(function (cat, i) {
          var parts = showSeries.map(function (s) { return s.name + ' ' + fmtValue(fmt, s.values[i]); });
          return { label: cat, value: parts.join(' / '), color: showSeries[0].color };
        });
        renderNarrowList(container, rows, opts.height);
        return;
      }

      var height = Math.max(100, Number(opts.height) || 280);
      var wrap = chartWrap(container);
      var showLegend = opts.legend === true || (opts.legend !== false && showSeries.length > 1);
      if (showLegend) wrap.appendChild(makeLegend(showSeries));

      var svg = makeSvg(width, height);
      svg.setAttribute('aria-label', '柱状图');
      wrap.appendChild(svg);
      if (opts.horizontal) drawBarH(svg, showCats, showSeries, width, height, !!opts.stacked, fmt);
      else drawBarV(svg, showCats, showSeries, width, height, !!opts.stacked, fmt);

      if (truncated) {
        var note = text(el('div', 'ch-note'), '仅显示前 ' + maxBars + ' 项');
        wrap.appendChild(note);
      }
    });
  }

  function drawBarV(svg, cats, series, width, height, stacked, fmt) {
    var n = cats.length;
    var top = 24, left = 50, right = 16, bottom = 38;
    var prelimW = Math.max(10, width - left - right);
    var band0 = prelimW / n;
    var longest = 0;
    cats.forEach(function (c) { longest = Math.max(longest, String(c == null ? '' : c).length); });
    var rotate = longest * 12 > Math.max(24, band0 - 6);
    if (rotate) bottom = 86;

    var plotW = Math.max(12, width - left - right);
    var plotH = Math.max(20, height - top - bottom);
    var band = plotW / n;

    var domain = stacked ? stackedDomain(series) : groupedDomain(series);
    var min = Math.min(0, domain.min), max = Math.max(0, domain.max);
    var allZero = max === 0 && min === 0;
    var scale = allZero ? { min: 0, max: 1, ticks: [0] } : niceTicks(min, max, 4);
    var range = scale.max - scale.min || 1;
    function y(v) { return top + plotH - ((v - scale.min) / range) * plotH; }

    // 网格与 Y 轴刻度
    scale.ticks.forEach(function (tick) {
      var yy = y(tick);
      if (yy < top - 0.1 || yy > top + plotH + 0.1) return;
      svgNode('line', {
        x1: left, x2: left + plotW, y1: yy, y2: yy,
        'class': tick === 0 ? 'ch-baseline' : 'ch-grid'
      }, svg);
      addText(svg, left - 8, yy, compact(tick), { 'class': 'ch-axis', 'text-anchor': 'end', dy: '0.32em' });
    });

    var zeroY = y(0);
    var groupW = Math.max(1, band * 0.68);
    var barW = stacked ? groupW : groupW / series.length;
    var labelW = barW;
    var showLabels = n <= 12 && (stacked || labelW >= 6);
    var posAcc = [], negAcc = [];
    for (var i = 0; i < n; i++) { posAcc.push(0); negAcc.push(0); }

    series.forEach(function (s, si) {
      s.values.forEach(function (v, i) {
        if (v === 0) return;
        var base = 0;
        if (stacked) base = v >= 0 ? posAcc[i] : negAcc[i];
        var y0 = stacked ? y(base) : zeroY;
        var y1 = stacked ? y(base + v) : y(v);
        var topY = Math.min(y0, y1);
        var barH = Math.abs(y1 - y0);
        var x = left + i * band + (band - groupW) / 2 + (stacked ? 0 : si * barW);
        var drawW = Math.max(0.6, barW);
        var rect = svgNode('rect', {
          x: x, y: topY, width: drawW, height: Math.max(0.6, barH),
          fill: s.color, rx: drawW > 4 && barH > 4 ? 2 : 0, 'class': 'ch-bar'
        }, svg);
        (function (cat, ser, value, idx) {
          bindTip(rect, function () {
            var rows = [{ name: ser.name, value: fmtValue(fmt, value), color: ser.color }];
            if (stacked && series.length > 1) {
              var total = posAcc[idx] + negAcc[idx];
              rows.push({ name: '小计', value: fmtValue(fmt, total), color: '#ced4da' });
            }
            return tipHTML(cat, rows);
          });
        })(cats[i] == null ? '-' : String(cats[i]), s, v, i);

        if (stacked) {
          if (v > 0) posAcc[i] += v;
          else negAcc[i] += v;
        }
      });
    });

    // 柱顶数值
    if (showLabels) {
      if (stacked) {
        for (var j = 0; j < n; j++) {
          var total = posAcc[j] + negAcc[j];
          if (total === 0) continue;
          var ty = total > 0 ? y(total) : y(0);
          var labelY = total > 0 ? ty - 5 : y(total) + 12;
          addText(svg, left + j * band + band / 2, Math.max(10, labelY), fmtValue(fmt, total), {
            'class': 'ch-val', 'text-anchor': 'middle'
          });
        }
      } else {
        series.forEach(function (s, si) {
          s.values.forEach(function (v, i) {
            if (v === 0) return;
            var valueText = barW < 26 ? compact(v) : fmtValue(fmt, v);
            var cx = left + i * band + (band - groupW) / 2 + si * barW + barW / 2;
            var labelY = v > 0 ? y(v) - 5 : y(v) + 12;
            addText(svg, cx, Math.max(10, labelY), valueText, { 'class': 'ch-val', 'text-anchor': 'middle' });
          });
        });
      }
    }

    // X 轴分类标签
    cats.forEach(function (cat, i) {
      var tx = left + i * band + band / 2;
      var ty = top + plotH + 15;
      var full = String(cat == null ? '' : cat);
      var maxChars = rotate ? 10 : Math.max(1, Math.floor((band - 6) / 12));
      var label = truncate(full, maxChars);
      var anchor = rotate ? (tx < left + 60 ? 'start' : tx > left + plotW - 60 ? 'end' : 'middle') : 'middle';
      var node = addText(svg, tx, ty, label, { 'class': 'ch-axis', 'text-anchor': anchor });
      if (rotate) node.setAttribute('transform', 'rotate(-35 ' + tx + ' ' + ty + ')');
      if (label !== full) addTitle(node, full);
    });
  }

  function drawBarH(svg, cats, series, width, height, stacked, fmt) {
    var n = cats.length;
    var longest = 0;
    cats.forEach(function (c) { longest = Math.max(longest, String(c == null ? '' : c).length); });
    var maxLabelW = Math.max(56, Math.min(longest * 12 + 12, width * 0.38));
    var left = Math.min(160, maxLabelW);
    if (left > width - 90) left = Math.max(40, width - 90);
    var right = 18;
    var top = 14, bottom = 30;

    var domain = stacked ? stackedDomain(series) : groupedDomain(series);
    var min = Math.min(0, domain.min), max = Math.max(0, domain.max);
    var allZero = max === 0 && min === 0;
    var scale = allZero ? { min: 0, max: 1, ticks: [0] } : niceTicks(min, max, 4);
    var range = scale.max - scale.min || 1;
    var plotW = Math.max(20, width - left - right);
    var plotH = Math.max(20, height - top - bottom);
    var band = plotH / n;
    var showLabels = n <= 12;
    function x(v) { return left + ((v - scale.min) / range) * plotW; }

    // 纵向网格与 X 轴刻度
    scale.ticks.forEach(function (tick) {
      var xx = x(tick);
      if (xx < left - 0.1 || xx > left + plotW + 0.1) return;
      svgNode('line', {
        x1: xx, x2: xx, y1: top, y2: top + plotH,
        'class': tick === 0 ? 'ch-baseline' : 'ch-grid'
      }, svg);
      addText(svg, xx, top + plotH + 15, compact(tick), { 'class': 'ch-axis', 'text-anchor': 'middle' });
    });

    var zeroX = x(0);
    var groupH = Math.max(1, band * 0.68);
    var barH = stacked ? groupH : groupH / series.length;
    var posAcc = [], negAcc = [];
    for (var i = 0; i < n; i++) { posAcc.push(0); negAcc.push(0); }

    series.forEach(function (s, si) {
      s.values.forEach(function (v, i) {
        if (v === 0) return;
        var base = 0;
        if (stacked) base = v >= 0 ? posAcc[i] : negAcc[i];
        var x0 = stacked ? x(base) : zeroX;
        var x1 = stacked ? x(base + v) : x(v);
        var xLeft = Math.min(x0, x1);
        var w = Math.abs(x1 - x0);
        var yy = top + i * band + (band - groupH) / 2 + (stacked ? 0 : si * barH);
        var drawH = Math.max(0.6, barH);
        var rect = svgNode('rect', {
          x: xLeft, y: yy, width: Math.max(0.6, w), height: drawH,
          fill: s.color, rx: drawH > 4 && w > 4 ? 2 : 0, 'class': 'ch-bar'
        }, svg);
        (function (cat, ser, value, idx) {
          bindTip(rect, function () {
            var rows = [{ name: ser.name, value: fmtValue(fmt, value), color: ser.color }];
            if (stacked && series.length > 1) {
              var total = posAcc[idx] + negAcc[idx];
              rows.push({ name: '小计', value: fmtValue(fmt, total), color: '#ced4da' });
            }
            return tipHTML(cat, rows);
          });
        })(cats[i] == null ? '-' : String(cats[i]), s, v, i);

        if (stacked) {
          if (v > 0) posAcc[i] += v;
          else negAcc[i] += v;
        }
      });
    });

    if (showLabels) {
      if (stacked) {
        for (var j = 0; j < n; j++) {
          var total = posAcc[j] + negAcc[j];
          if (total === 0) continue;
          var endX = x(total);
          var rowY = top + j * band + band / 2;
          var anchor = total >= 0 ? 'start' : 'end';
          var tx = total >= 0 ? endX + 4 : endX - 4;
          if (total >= 0 && tx + 44 > width) { tx = endX - 4; anchor = 'end'; }
          addText(svg, tx, rowY, fmtValue(fmt, total), { 'class': 'ch-val', 'text-anchor': anchor, dy: '0.32em' });
        }
      } else {
        series.forEach(function (s, si) {
          s.values.forEach(function (v, i) {
            if (v === 0) return;
            var endX = x(v);
            var rowY = top + i * band + (band - groupH) / 2 + si * barH + barH / 2;
            var valueText = barH < 20 ? compact(v) : fmtValue(fmt, v);
            var anchor = v >= 0 ? 'start' : 'end';
            var tx = v >= 0 ? endX + 4 : endX - 4;
            if (v >= 0 && tx + 40 > width) { tx = endX - 4; anchor = 'end'; }
            addText(svg, tx, rowY, valueText, { 'class': 'ch-val', 'text-anchor': anchor, dy: '0.32em' });
          });
        });
      }
    }

    // Y 轴分类标签（窄高度时隔行显示，避免重叠）
    var catStep = band >= 14 ? 1 : Math.max(1, Math.ceil(14 / band));
    var maxChars = Math.max(1, Math.floor((left - 12) / 12));
    cats.forEach(function (cat, i) {
      if (i % catStep !== 0 && i !== n - 1) return;
      var full = String(cat == null ? '' : cat);
      var label = truncate(full, maxChars);
      var node = addText(svg, left - 8, top + i * band + band / 2, label, {
        'class': 'ch-axis', 'text-anchor': 'end', dy: '0.32em'
      });
      if (label !== full) addTitle(node, full);
    });
  }

  // ============================================================
  // 六、折线图
  // ============================================================
  function line(el, opts) {
    ensureStyle();
    if (!el) return;
    opts = opts || {};
    var cats = Array.isArray(opts.categories) ? opts.categories.slice() : [];
    var series = prepareSeries(opts.series, cats.length);
    if (!cats.length || !series.length) {
      emptyChart(el, '暂无数据');
      return;
    }
    register(el, function (width) {
      width = Math.max(1, Math.round(width));
      hideTip();
      var fmt = formatter(opts);

      if (width < 160) {
        var rows = series.map(function (s) {
          var last = s.values.length ? s.values[s.values.length - 1] : 0;
          return {
            label: s.name,
            value: fmtValue(fmt, last),
            color: s.color,
            sub: cats.length ? String(cats[cats.length - 1]) : ''
          };
        });
        renderNarrowList(el, rows, opts.height);
        return;
      }

      var height = Math.max(120, Number(opts.height) || 260);
      var n = cats.length;
      var left = 50, right = 20, top = 16, bottom = 36;
      var plotW0 = Math.max(20, width - left - right);
      var maxLabelCount = Math.max(2, Math.floor(plotW0 / 64));
      var labelEvery = n > maxLabelCount ? Math.ceil(n / maxLabelCount) : 1;
      var step0 = n > 1 ? plotW0 / (n - 1) : plotW0;
      var spacing0 = step0 * labelEvery;
      var longest = 0;
      cats.forEach(function (c) { longest = Math.max(longest, String(c == null ? '' : c).length); });
      var rotate = n > 1 && longest * 12 > Math.max(24, spacing0 - 8);
      if (rotate) bottom = 86;

      var plotW = Math.max(20, width - left - right);
      var plotH = Math.max(20, height - top - bottom);
      function px(i) { return n === 1 ? left + plotW / 2 : left + (i * plotW) / (n - 1); }

      var lo = Infinity, hi = -Infinity;
      series.forEach(function (s) {
        s.values.forEach(function (v) { if (v < lo) lo = v; if (v > hi) hi = v; });
      });
      if (!isFinite(lo) || !isFinite(hi)) { showEmpty(el, '暂无数据'); return; }
      if (opts.yFromZero) { lo = Math.min(0, lo); hi = Math.max(0, hi); }
      if (lo === hi) {
        if (lo === 0) { lo = 0; hi = 1; }
        else { var pad = Math.abs(lo) * 0.2 || 1; lo -= pad; hi += pad; }
      }
      var scale = niceTicks(lo, hi, 4);
      var range = scale.max - scale.min || 1;
      function py(v) { return top + plotH - ((v - scale.min) / range) * plotH; }

      var wrap = chartWrap(el);
      var showLegend = opts.legend === true || (opts.legend !== false && series.length > 1);
      if (showLegend) wrap.appendChild(makeLegend(series));
      var svg = makeSvg(width, height);
      svg.setAttribute('aria-label', '折线图');
      wrap.appendChild(svg);

      // 网格 / Y 轴
      scale.ticks.forEach(function (tick) {
        var yy = py(tick);
        if (yy < top - 0.1 || yy > top + plotH + 0.1) return;
        svgNode('line', {
          x1: left, x2: left + plotW, y1: yy, y2: yy,
          'class': tick === 0 ? 'ch-baseline' : 'ch-grid'
        }, svg);
        addText(svg, left - 8, yy, compact(tick), { 'class': 'ch-axis', 'text-anchor': 'end', dy: '0.32em' });
      });

      var defs = null;
      var areaIds = [];
      if (opts.area && n > 1) {
        defs = svgNode('defs', null, svg);
        series.forEach(function (s, si) {
          var id = 'ch-grad-' + (++uid);
          areaIds.push(id);
          var grad = svgNode('linearGradient', { id: id, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
          svgNode('stop', { offset: '0%', 'stop-color': s.color, 'stop-opacity': Math.max(0.06, 0.22 - si * 0.03) }, grad);
          svgNode('stop', { offset: '100%', 'stop-color': s.color, 'stop-opacity': 0 }, grad);
        });
      }

      series.forEach(function (s, si) {
        var points = s.values.map(function (v, i) { return { x: px(i), y: py(v) }; });
        if (opts.area && n > 1 && areaIds[si]) {
          var d = 'M' + points[0].x + ' ' + points[0].y;
          for (var i = 1; i < points.length; i++) d += ' L' + points[i].x + ' ' + points[i].y;
          d += ' L' + points[points.length - 1].x + ' ' + (top + plotH) + ' L' + points[0].x + ' ' + (top + plotH) + ' Z';
          svgNode('path', { d: d, fill: 'url(#' + areaIds[si] + ')', stroke: 'none' }, svg);
        }
        if (points.length > 1) {
          var lineD = 'M' + points.map(function (p) { return p.x + ' ' + p.y; }).join(' L');
          svgNode('path', {
            d: lineD, fill: 'none', stroke: s.color, 'stroke-width': 2,
            'stroke-linecap': 'round', 'stroke-linejoin': 'round'
          }, svg);
        }
        if (n > 1 && n <= 24) {
          points.forEach(function (p) {
            svgNode('circle', { cx: p.x, cy: p.y, r: 3, fill: s.color, stroke: '#fff', 'stroke-width': 1.5 }, svg);
          });
        }
        if (n === 1) {
          svgNode('circle', { cx: points[0].x, cy: points[0].y, r: 3.5, fill: s.color, stroke: '#fff', 'stroke-width': 1.5 }, svg);
        }
        if (opts.showValues !== false && n <= 24) {
          var labelEveryPoint = n <= 12 ? 1 : Math.ceil(n / 8);
          points.forEach(function (p, pi) {
            if (pi % labelEveryPoint !== 0 && pi !== n - 1) return;
            addText(svg, p.x, Math.max(9, p.y - 7), fmtValue(fmt, s.values[pi]), {
              'class': 'ch-val', 'text-anchor': 'middle'
            });
          });
        }
      });

      // X 轴标签（自动抽稀，必要时旋转）
      var idxs = [];
      for (var ix = 0; ix < n; ix += labelEvery) idxs.push(ix);
      if (idxs[idxs.length - 1] !== n - 1 && (n - 1 - idxs[idxs.length - 1]) >= Math.ceil(labelEvery / 2)) {
        idxs.push(n - 1);
      }
      idxs.forEach(function (i) {
        var tx = px(i);
        var ty = top + plotH + 16;
        var full = String(cats[i] == null ? '' : cats[i]);
        var maxChars = rotate ? 10 : Math.max(1, Math.floor(spacing0 / 12));
        var label = truncate(full, maxChars);
        var anchor = rotate ? (tx < left + 60 ? 'start' : tx > left + plotW - 60 ? 'end' : 'middle') : 'middle';
        var node = addText(svg, tx, ty, label, { 'class': 'ch-axis', 'text-anchor': anchor });
        if (rotate) node.setAttribute('transform', 'rotate(-35 ' + tx + ' ' + ty + ')');
        if (label !== full) addTitle(node, full);
      });

      // hover 竖线 + 提示
      var guide = svgNode('line', {
        x1: 0, x2: 0, y1: top, y2: top + plotH, 'class': 'ch-guide', style: 'display:none'
      }, svg);
      var focusGroup = svgNode('g', { style: 'display:none' }, svg);
      var focusDots = series.map(function (s) {
        return svgNode('circle', {
          r: 4, fill: s.color, stroke: '#fff', 'stroke-width': 2, cx: 0, cy: 0
        }, focusGroup);
      });
      var hit = svgNode('rect', {
        x: left, y: top, width: plotW, height: plotH,
        fill: '#fff', opacity: 0, 'pointer-events': 'all', style: 'cursor:crosshair'
      }, svg);

      function hideFocus() {
        guide.style.display = 'none';
        focusGroup.style.display = 'none';
        hideTip();
      }

      hit.addEventListener('mousemove', function (evt) {
        var box = svg.getBoundingClientRect();
        if (!box.width) return;
        var sx = (evt.clientX - box.left) * (width / box.width);
        var idx;
        if (n === 1) idx = 0;
        else idx = Math.round(((sx - left) / plotW) * (n - 1));
        idx = Math.max(0, Math.min(n - 1, idx));
        var gx = px(idx);
        guide.setAttribute('x1', gx);
        guide.setAttribute('x2', gx);
        guide.style.display = 'block';
        focusGroup.style.display = 'block';
        series.forEach(function (s, si) {
          focusDots[si].setAttribute('cx', gx);
          focusDots[si].setAttribute('cy', py(s.values[idx]));
        });
        var rows = series.map(function (s) {
          return { name: s.name, value: fmtValue(fmt, s.values[idx]), color: s.color };
        });
        var p = eventPoint(evt);
        showTip(tipHTML(cats[idx] == null ? '-' : String(cats[idx]), rows), p.x + 14, p.y + 14);
      });
      hit.addEventListener('mouseleave', hideFocus);
    });
  }

  // ============================================================
  // 七、环形图
  // ============================================================
  function donut(container, opts) {
    ensureStyle();
    if (!container) return;
    opts = opts || {};
    var raw = Array.isArray(opts.items) ? opts.items : [];
    var items = [];
    raw.forEach(function (it, i) {
      if (!it) return;
      var v = Number(it.value);
      items.push({
        label: it.label === null || it.label === undefined ? '未命名' : String(it.label),
        value: isFinite(v) ? v : 0,
        color: it.color || PALETTE[i % PALETTE.length]
      });
    });
    if (!items.length) { emptyChart(container, '暂无数据'); return; }
    var total = items.reduce(function (sum, it) { return sum + Math.max(0, it.value); }, 0);
    if (total <= 0) { emptyChart(container, '暂无数据'); return; }

    register(container, function (width) {
      width = Math.max(1, Math.round(width));
      hideTip();
      var fmt = formatter(opts);
      var totalNow = items.reduce(function (sum, it) { return sum + Math.max(0, it.value); }, 0);

      if (width < 160) {
        var rows = items.map(function (it) {
          return {
            label: it.label,
            value: fmtValue(fmt, it.value),
            color: it.color,
            sub: totalNow > 0 ? pct(Math.max(0, it.value) / totalNow, 1) : '-'
          };
        });
        renderNarrowList(container, rows, opts.height);
        return;
      }

      var wide = width >= 420;
      var baseH = Math.max(160, Number(opts.height) || 260);
      var size = wide
        ? Math.min(baseH, Math.max(150, width * 0.46), 300)
        : Math.min(baseH, Math.max(130, width - 10), 300);

      var wrap = chartWrap(container);
      wrap.className = 'ch-wrap ch-donut ' + (wide ? 'wide' : 'narrow');
      var chartDiv = el('div', 'ch-donut-chart');
      chartDiv.style.width = size + 'px';
      chartDiv.style.height = size + 'px';
      wrap.appendChild(chartDiv);

      var svg = makeSvg(240, 240);
      svg.setAttribute('height', '100%');
      svg.setAttribute('aria-label', '环形图');
      chartDiv.appendChild(svg);

      var cx = 120, cy = 120, ro = 88, ri = 56, rmid = (ro + ri) / 2;
      var slices = [];
      var angle = -Math.PI / 2;
      items.forEach(function (it) {
        var v = Math.max(0, it.value);
        if (v <= 0) return;
        var frac = v / totalNow;
        var a0 = angle;
        var a1 = angle + frac * Math.PI * 2;
        angle = a1;
        slices.push({ item: it, frac: frac, a0: a0, a1: a1 });
      });

      function polar(r, a) { return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }; }
      function arcPath(a0, a1) {
        var p0 = polar(ro, a0), p1 = polar(ro, a1), p2 = polar(ri, a1), p3 = polar(ri, a0);
        var large = (a1 - a0) > Math.PI ? 1 : 0;
        return 'M' + p0.x + ' ' + p0.y +
          ' A' + ro + ' ' + ro + ' 0 ' + large + ' 1 ' + p1.x + ' ' + p1.y +
          ' L' + p2.x + ' ' + p2.y +
          ' A' + ri + ' ' + ri + ' 0 ' + large + ' 0 ' + p3.x + ' ' + p3.y + ' Z';
      }

      if (slices.length === 1) {
        var only = slices[0];
        var ring = svgNode('circle', {
          cx: cx, cy: cy, r: rmid, fill: 'none', stroke: only.item.color, 'stroke-width': ro - ri,
          'class': 'ch-slice'
        }, svg);
        bindTip(ring, function () {
          return tipHTML(only.item.label, [
            { name: '数值', value: fmtValue(fmt, only.item.value), color: only.item.color },
            { name: '占比', value: '100%', color: '#ced4da' }
          ]);
        });
        addText(svg, cx, cy - rmid, '100%', {
          fill: '#fff', 'font-size': 10, 'font-weight': 600, 'text-anchor': 'middle', dy: '0.35em'
        });
      } else {
        slices.forEach(function (sl) {
          var gap = Math.min(0.016, (sl.a1 - sl.a0) * 0.12);
          var a0 = sl.a0 + gap;
          var a1 = sl.a1 - gap;
          if (a1 <= a0) { a0 = sl.a0; a1 = sl.a1; }
          var path = svgNode('path', {
            d: arcPath(a0, a1), fill: sl.item.color, 'class': 'ch-slice'
          }, svg);
          bindTip(path, function () {
            return tipHTML(sl.item.label, [
              { name: '数值', value: fmtValue(fmt, sl.item.value), color: sl.item.color },
              { name: '占比', value: pct(sl.frac, 1), color: '#ced4da' }
            ]);
          });
          if (sl.frac >= 0.08) {
            var mid = (sl.a0 + sl.a1) / 2;
            addText(svg, cx + rmid * Math.cos(mid), cy + rmid * Math.sin(mid), pct(sl.frac, 0), {
              fill: '#fff', 'font-size': 10, 'font-weight': 600, 'text-anchor': 'middle', dy: '0.35em'
            });
          }
        });
      }

      // 圆心文字
      var hasCenterValue = opts.centerValue !== undefined && opts.centerValue !== null && opts.centerValue !== '';
      var hasCenterLabel = opts.centerLabel !== undefined && opts.centerLabel !== null && opts.centerLabel !== '';
      if (hasCenterValue || hasCenterLabel) {
        var centerText = hasCenterValue
          ? (typeof opts.centerValue === 'number' ? num(opts.centerValue) : String(opts.centerValue))
          : '';
        var valueSize = centerText.length > 9 ? 15 : 19;
        if (centerText && hasCenterLabel) {
          addText(svg, cx, cy - 2, centerText, {
            fill: '#1f2933', 'font-size': valueSize, 'font-weight': 700, 'text-anchor': 'middle', dy: '0.35em'
          });
          addText(svg, cx, cy + 17, String(opts.centerLabel), {
            fill: '#7b8794', 'font-size': 11, 'text-anchor': 'middle', dy: '0.35em'
          });
        } else if (centerText) {
          addText(svg, cx, cy, centerText, {
            fill: '#1f2933', 'font-size': valueSize, 'font-weight': 700, 'text-anchor': 'middle', dy: '0.35em'
          });
        } else {
          addText(svg, cx, cy, String(opts.centerLabel), {
            fill: '#7b8794', 'font-size': 11, 'text-anchor': 'middle', dy: '0.35em'
          });
        }
      }

      // 图例
      var legend = el('div', 'ch-donut-legend');
      if (!wide && width >= 320) {
        legend.style.display = 'grid';
        legend.style.gridTemplateColumns = 'repeat(2,minmax(0,1fr))';
      }
      items.forEach(function (it) {
        var row = el('div', 'ch-lg-item');
        var dot = el('i', 'ch-lg-dot');
        dot.style.background = it.color;
        var label = text(el('span', 'ch-lg-label'), it.label);
        label.title = it.label;
        var value = text(el('span', 'ch-lg-value'), fmtValue(fmt, it.value));
        var share = totalNow > 0 ? pct(Math.max(0, it.value) / totalNow, 1) : '-';
        var percent = text(el('span', 'ch-lg-pct'), share);
        row.appendChild(dot);
        row.appendChild(label);
        row.appendChild(value);
        row.appendChild(percent);
        legend.appendChild(row);
      });
      wrap.appendChild(legend);
    });
  }

  // ============================================================
  // 八、漏斗图
  // ============================================================
  function funnel(el, opts) {
    ensureStyle();
    if (!el) return;
    opts = opts || {};
    var raw = Array.isArray(opts.items) ? opts.items : [];
    var items = [];
    raw.forEach(function (it) {
      if (!it) return;
      var v = Number(it.value);
      items.push({
        label: it.label === null || it.label === undefined ? '未命名' : String(it.label),
        value: isFinite(v) ? v : 0
      });
    });
    if (!items.length) { emptyChart(el, '暂无数据'); return; }

    register(el, function (width) {
      width = Math.max(1, Math.round(width));
      hideTip();
      var fmt = formatter(opts);
      var first = items[0].value;
      function conv(v) {
        if (!isFinite(first) || first === 0) return '-';
        var x = v / first;
        return pct(x, 1).replace('.0%', '%');
      }

      if (width < 160 || items.length > 10) {
        var rows = items.map(function (it, i) {
          return {
            label: it.label,
            value: fmtValue(fmt, it.value),
            color: PALETTE[i % PALETTE.length],
            sub: '转化 ' + conv(it.value)
          };
        });
        renderNarrowList(el, rows, opts.height);
        return;
      }

      var maxV = 0;
      items.forEach(function (it) { if (Math.max(0, it.value) > maxV) maxV = Math.max(0, it.value); });
      if (maxV <= 0) {
        var zeroRows = items.map(function (it, i) {
          return { label: it.label, value: fmtValue(fmt, it.value), color: PALETTE[i % PALETTE.length], sub: '转化 -' };
        });
        renderNarrowList(el, zeroRows, opts.height);
        return;
      }

      var height = Math.max(160, Number(opts.height) || 280);
      var longest = 0;
      items.forEach(function (it) { longest = Math.max(longest, it.label.length); });
      var leftW = Math.min(150, Math.max(56, Math.min(longest * 12 + 12, width * 0.38)));
      var right = 16, top = 14, bottom = 14;
      var plotW = Math.max(30, width - leftW - right);
      var plotH = Math.max(30, height - top - bottom);
      var n = items.length;
      var rowH = plotH / n;
      var gap = Math.min(8, rowH * 0.16);
      var widths = items.map(function (it) {
        return Math.max(18, plotW * (Math.max(0, it.value) / maxV));
      });
      var centerX = leftW + plotW / 2;

      var wrap = chartWrap(el);
      var svg = makeSvg(width, height);
      svg.setAttribute('aria-label', '漏斗图');
      wrap.appendChild(svg);

      items.forEach(function (it, i) {
        var y0 = top + i * rowH + gap / 2;
        var y1 = top + (i + 1) * rowH - gap / 2;
        var topW = widths[i];
        var botW = i < n - 1 ? widths[i + 1] : topW * 0.88;
        var points = [
          (centerX - topW / 2) + ',' + y0,
          (centerX + topW / 2) + ',' + y0,
          (centerX + botW / 2) + ',' + y1,
          (centerX - botW / 2) + ',' + y1
        ].join(' ');
        var color = PALETTE[i % PALETTE.length];
        var poly = svgNode('polygon', {
          points: points, fill: color, 'class': 'ch-funnel-shape'
        }, svg);
        var conversion = conv(it.value);
        bindTip(poly, function () {
          return tipHTML(it.label, [
            { name: '数值', value: fmtValue(fmt, it.value), color: color },
            { name: '转化率', value: conversion, color: '#ced4da' }
          ]);
        });

        var mid = (y0 + y1) / 2;
        var full = it.label;
        var maxChars = Math.max(1, Math.floor((leftW - 8) / 12));
        var label = truncate(full, maxChars);
        var labelNode = addText(svg, 2, mid - 4, label, {
          'class': 'ch-axis', 'text-anchor': 'start', fill: '#1f2933', 'font-size': 11
        });
        if (label !== full) addTitle(labelNode, full);
        addText(svg, 2, mid + 12, '转化 ' + conversion, {
          'class': 'ch-axis', 'text-anchor': 'start', fill: '#7b8794', 'font-size': 9
        });

        var valueText = fmtValue(fmt, it.value);
        var midW = (topW + botW) / 2;
        var fits = valueText.length * 7 + 12 <= midW;
        var textNode = addText(svg, centerX, mid, valueText, {
          'text-anchor': 'middle', dy: '0.35em', 'font-size': 11, 'font-weight': 600,
          fill: fits ? '#fff' : '#1f2933'
        });
        if (!fits) {
          textNode.setAttribute('stroke', '#fff');
          textNode.setAttribute('stroke-width', '3');
          textNode.setAttribute('paint-order', 'stroke');
          textNode.setAttribute('stroke-linejoin', 'round');
        }
      });
    });
  }

  // ============================================================
  // 九、迷你折线
  // ============================================================
  function sparkline(el, opts) {
    ensureStyle();
    if (!el) return;
    opts = opts || {};
    var source = Array.isArray(opts.values) ? opts.values : [];
    var values = [];
    source.forEach(function (v) {
      var n = Number(v);
      if (isFinite(n)) values.push(n);
    });
    if (!values.length) {
      emptyChart(el, '暂无数据', 'ch-empty-mini');
      return;
    }

    register(el, function (width) {
      width = Math.max(1, Math.round(width));
      hideTip();
      var height = Math.max(18, Number(opts.height) || 36);
      var w = Math.max(24, width);
      clearEl(el);
      var svg = makeSvg(w, height);
      svg.setAttribute('aria-label', '迷你折线');
      el.appendChild(svg);

      var padX = 3, padY = 4;
      var innerW = Math.max(1, w - padX * 2);
      var innerH = Math.max(1, height - padY * 2);
      var lo = Math.min.apply(null, values);
      var hi = Math.max.apply(null, values);
      if (lo === hi) {
        if (lo === 0) { lo = 0; hi = 1; }
        else { var p = Math.abs(lo) * 0.15 || 1; lo -= p; hi += p; }
      }
      var range = hi - lo || 1;
      var px = function (i) { return values.length === 1 ? w / 2 : padX + (i * innerW) / (values.length - 1); };
      var py = function (v) { return padY + innerH - ((v - lo) / range) * innerH; };
      var color = opts.color || PALETTE[1];

      if (values.length > 1) {
        var d = 'M' + values.map(function (v, i) { return px(i) + ' ' + py(v); }).join(' L');
        var areaD = d + ' L' + px(values.length - 1) + ' ' + (height - padY) + ' L' + px(0) + ' ' + (height - padY) + ' Z';
        var gid = 'ch-spark-' + (++uid);
        var defs = svgNode('defs', null, svg);
        var grad = svgNode('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
        svgNode('stop', { offset: '0%', 'stop-color': color, 'stop-opacity': 0.18 }, grad);
        svgNode('stop', { offset: '100%', 'stop-color': color, 'stop-opacity': 0 }, grad);
        svgNode('path', { d: areaD, fill: 'url(#' + gid + ')', stroke: 'none' }, svg);
        svgNode('path', {
          d: d, fill: 'none', stroke: color, 'stroke-width': 1.8,
          'stroke-linecap': 'round', 'stroke-linejoin': 'round'
        }, svg);
      }
      svgNode('circle', {
        cx: px(values.length - 1),
        cy: py(values[values.length - 1]),
        r: 2.4, fill: color, stroke: '#fff', 'stroke-width': 1
      }, svg);
    });
  }

  // ============================================================
  // 十、公开 API
  // ============================================================
  window.Charts = {
    palette: PALETTE,
    num: num,
    wan: wan,
    pct: pct,
    fmtCell: fmtCell,
    isEmpty: function (container) { emptyChart(container, '暂无数据'); },
    kpi: kpi,
    bar: bar,
    line: line,
    donut: donut,
    funnel: funnel,
    table: table,
    progressBar: progressBar,
    sparkline: sparkline,
    refresh: refresh
  };
})();
