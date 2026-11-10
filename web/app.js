/* ============================================================
   单量与作业进度看板 — 前端应用
   依赖（同目录）：charts.js（图表）、grid.js（拖拽栅格）
   ============================================================ */
(function () {
  "use strict";

  var editorKeyHandler = null;

  var state = {
    me: null,
    meta: null,
    date: null,
    page: "overview",
    dashboards: [],
    currentDashId: null,
    grid: null,
    editing: false,
    catalog: null,
    online: true,
    lastUpdate: "",
    refreshTimer: null,
    dateManual: false,
    editing: false,
    routeToken: 0
  };

  var PAGES = [
    { key: "overview", title: "今日总览", perm: "page.overview" },
    { key: "volume", title: "单量分析", perm: "page.volume" },
    { key: "labor", title: "人工作业量", perm: "page.labor" },
    { key: "orders", title: "订单组登记", perm: "page.orders" },
    { key: "battery", title: "动力电池登记", perm: "page.battery" },
    { key: "waves", title: "波次登记", perm: "page.waves" },
    { key: "alerts", title: "预警中心", perm: "page.alerts" },
    { key: "dashboard", title: "看板总台", perm: "page.dashboard" },
    { key: "sources", title: "数据源", perm: "page.sources" },
    { key: "outbound", title: "出库归档", perm: "page.sources" },
    { key: "admin", title: "用户与权限", perm: "page.users" },
    { key: "audit", title: "审计日志", perm: "page.audit" }
  ];

  // 可拖拽编辑的导航页（对应 /api/pages/{key}）
  var DASH_PAGE_KEYS = ["overview", "labor"];
  var batteryView = null;
  var PAGE_META = {
    overview: { title: "今日总览", sub: "今日订单量 / 登记 / 拣货 / 复核 / 出库 / 完成率；可拖拽编辑并发布为全员默认" },
    volume: { title: "单量分析", sub: "今日 / 本周 / 本月 / 本季度的单量与环比、同比" },
    labor: { title: "人工作业量", sub: "拣货人 / 复核人的行次、组数、工时、人效；工时支持人工校正" }
  };

  // 组件级配色：默认单色，马卡龙/多巴胺为可选色系
  var COLOR_SCHEMES = {
    "": ["#1d5fbf"],
    "macaron": ["#b25c7a", "#4a7ba7", "#4f8f6a", "#b3832e", "#7c67a8", "#3f8e93"],
    "dopamine": ["#ff5d8f", "#ff9f1c", "#e0b100", "#2ec4b6", "#3a86ff", "#8e44ad"]
  };
  function paletteFor(spec) {
    spec = spec || {};
    if (!spec.color_scheme && !spec.color) return null;
    var colors = COLOR_SCHEMES[spec.color_scheme || ""] || null;
    if (spec.color) {
      if (colors) return [spec.color].concat(colors.filter(function (c) { return c !== spec.color; }));
      return [spec.color];
    }
    return colors;
  }

  // ---------------------------------------------------------------- 工具
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function setText(sel, value, root) {
    var el = $(sel, root || document);
    if (el) el.textContent = value;
    return el;
  }
  function esc(value) {
    return String(value === null || value === undefined ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function has(perm) {
    return !!(state.me && state.me.permissions && state.me.permissions.indexOf(perm) >= 0);
  }
  function num(value, digits) {
    if (window.Charts && Charts.num) return Charts.num(value, digits);
    return value === null || value === undefined ? "-" : String(value);
  }
  function wan(value) {
    if (window.Charts && Charts.wan) return Charts.wan(value);
    return num(value);
  }
  function pct(value, digits) {
    if (window.Charts && Charts.pct) return Charts.pct(value, digits);
    return (Number(value || 0) * 100).toFixed(digits === undefined ? 1 : digits) + "%";
  }
  function clock() {
    var d = new Date();
    function p(n) { return n < 10 ? "0" + n : "" + n; }
    return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }
  function toast(message, kind) {
    var box = $("#toasts");
    if (!box) return;
    var el = document.createElement("div");
    el.className = "toast " + (kind || "");
    el.textContent = message;
    box.appendChild(el);
    setTimeout(function () { el.remove(); }, kind === "err" ? 6000 : 3200);
  }

  async function api(path, options) {
    options = options || {};
    var headers = { "Content-Type": "application/json", "X-Dashboard-Client": "1" };
    var res = await fetch(path, {
      method: options.method || "GET",
      headers: headers,
      credentials: "same-origin",
      body: options.body
    });
    var type = res.headers.get("content-type") || "";
    var data = type.indexOf("json") >= 0 ? await res.json() : await res.text();
    if (res.status === 401) {
      if (data && data.error === "系统尚未初始化，请先创建管理员账号") {
        location.reload();
        return new Promise(function () {});
      }
      // 只有“未登录”才是会话过期；登录失败/锁定要按原样提示，不能悄悄重绘登录页
      if (data && data.error === "未登录") {
        state.me = null;
        boot();
        throw new Error("登录已过期，请重新登录");
      }
    }
    if (!res.ok) {
      throw new Error((data && data.error) || ("请求失败 " + res.status));
    }
    return data;
  }

  function startLoading(el, text) {
    el.innerHTML = '<div class="loading"><span class="spinner"></span>' + esc(text || "加载中") + "</div>";
  }
  function showError(el, error, retry) {
    el.innerHTML =
      '<div class="empty">加载失败：' + esc(error.message || error) +
      (retry ? ' <button class="btn btn-sm" data-retry>重试</button>' : "") + "</div>";
    if (retry) {
      var btn = $("[data-retry]", el);
      if (btn) btn.addEventListener("click", retry);
    }
  }
  function emptyHtml(text) { return '<div class="empty">' + esc(text || "暂无数据") + "</div>"; }

  // ---------------------------------------------------------------- 弹窗
  function modal(options) {
    var mask = document.createElement("div");
    mask.className = "modal-mask";
    mask.innerHTML =
      '<div class="modal ' + (options.wide ? "wide" : "") + '">' +
        '<div class="modal-head"><div class="modal-title">' + esc(options.title || "") + "</div>" +
        '<button class="modal-close" aria-label="关闭">×</button></div>' +
        '<div class="modal-body">' + (options.body || "") + "</div>" +
        (options.footer ? '<div class="modal-foot">' + options.footer + "</div>" : "") +
      "</div>";
    document.body.appendChild(mask);
    $(".modal-close", mask).addEventListener("click", close);
    mask.addEventListener("click", function (event) { if (event.target === mask) close(); });
    function onKey(event) {
      if (event.key === "Escape") { close(); }
    }
    document.addEventListener("keydown", onKey);
    function close() {
      document.removeEventListener("keydown", onKey);
      mask.remove();
    }
    return { el: mask, close: close };
  }

  function confirmDialog(title, text, okText) {
    return new Promise(function (resolve) {
      var m = modal({
        title: title,
        body: '<div class="small">' + esc(text || "") + "</div>",
        footer: '<button class="btn" data-cancel>取消</button>' +
                '<button class="btn btn-primary" data-ok>' + esc(okText || "确定") + "</button>"
      });
      $("[data-cancel]", m.el).addEventListener("click", function () { m.close(); resolve(false); });
      $("[data-ok]", m.el).addEventListener("click", function () { m.close(); resolve(true); });
    });
  }

  // ---------------------------------------------------------------- 登录 / 初始化
  function authShell(inner) {
    document.body.innerHTML =
      '<div class="auth-wrap"><div class="auth-card">' +
        '<div class="auth-title">单量与作业进度看板</div>' +
        '<div class="auth-sub" id="auth-sub"></div>' +
        '<div class="auth-err" id="auth-err"></div>' + inner +
        '<div class="auth-foot">局域网内部系统 · 请使用管理员分配的账号</div>' +
      "</div></div><div id=\"toasts\"></div>";
  }

  function renderSetup() {
    authShell(
      '<div class="field"><label>管理员账号</label><input class="input" id="f-user" autocomplete="username" placeholder="3-32 位字母数字"></div>' +
      '<div class="field"><label>显示名称</label><input class="input" id="f-display" placeholder="如：张三"></div>' +
      '<div class="field"><label>密码</label><input class="input" id="f-pwd" type="password" autocomplete="new-password" placeholder="至少 8 位，含字母和数字"></div>' +
      '<div class="field"><label>确认密码</label><input class="input" id="f-pwd2" type="password" autocomplete="new-password"></div>' +
      '<button class="btn btn-primary" id="f-go">创建管理员并开始使用</button>'
    );
    $("#auth-sub").textContent = "首次启动：创建管理员账号";
    function submit() {
      var username = $("#f-user").value.trim();
      var display = $("#f-display").value.trim();
      var pwd = $("#f-pwd").value;
      var pwd2 = $("#f-pwd2").value;
      var errBox = $("#auth-err");
      errBox.style.display = "none";
      if (pwd !== pwd2) { errBox.textContent = "两次输入的密码不一致"; errBox.style.display = "block"; return; }
      api("/api/setup", { method: "POST", body: JSON.stringify({ username: username, display_name: display, password: pwd }) })
        .then(function () { return boot(); })
        .catch(function (error) { errBox.textContent = error.message; errBox.style.display = "block"; });
    }
    $("#f-go").addEventListener("click", submit);
    $("#f-pwd2").addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });
  }

  function renderLogin() {
    authShell(
      '<div class="field"><label>账号</label><input class="input" id="f-user" autocomplete="username"></div>' +
      '<div class="field"><label>密码</label><input class="input" id="f-pwd" type="password" autocomplete="current-password"></div>' +
      '<button class="btn btn-primary" id="f-go">登录</button>'
    );
    $("#auth-sub").textContent = "请登录后查看";
    function submit() {
      var errBox = $("#auth-err");
      var btn = $("#f-go");
      errBox.style.display = "none";
      btn.disabled = true;
      btn.textContent = "登录中…";
      api("/api/login", {
        method: "POST",
        body: JSON.stringify({ username: $("#f-user").value.trim(), password: $("#f-pwd").value })
      }).then(function (me) {
        state.me = me;
        if (me.user && me.user.must_change_pwd) return forceChangePassword();
        return boot();
      }).catch(function (error) {
        btn.disabled = false;
        btn.textContent = "登录";
        errBox.textContent = error.message || "登录失败，请重试";
        errBox.style.display = "block";
      });
    }
    $("#f-go").addEventListener("click", submit);
    $("#f-pwd").addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });
    $("#f-user").focus();
  }

  function forceChangePassword() {
    authShell(
      '<div class="field"><label>原密码</label><input class="input" id="f-old" type="password"></div>' +
      '<div class="field"><label>新密码</label><input class="input" id="f-new" type="password" placeholder="至少 8 位，含字母和数字"></div>' +
      '<button class="btn btn-primary" id="f-go">设置新密码</button>'
    );
    $("#auth-sub").textContent = "首次登录，请修改密码";
    $("#f-go").addEventListener("click", function () {
      api("/api/change-password", {
        method: "POST",
        body: JSON.stringify({ old_password: $("#f-old").value, new_password: $("#f-new").value })
      }).then(function () { toast("密码已更新", "ok"); return boot(); })
        .catch(function (error) { toast(error.message, "err"); });
    });
  }

  // ---------------------------------------------------------------- 外壳
  function navHtml() {
    return PAGES.filter(function (page) { return has(page.perm); }).map(function (page) {
      return '<a href="#/' + page.key + '" data-nav="' + page.key + '">' + esc(page.title) + "</a>";
    }).join("");
  }

  function todayStr() {
    return (state.meta && state.meta.today) || state.date;
  }

  function dateOptions() {
    var dates = (state.meta && state.meta.biz_dates) || [];
    var today = todayStr();
    if (!dates.length) {
      return '<option value="' + esc(state.date) + '">' + esc(state.date) + "</option>";
    }
    return dates.map(function (item) {
      var bits = [];
      if (item.biz_date === today || item.is_today) bits.push("今天");
      if (item.waves) bits.push("登记 " + item.waves);
      if (item.archived) bits.push("已存档");
      if (!item.waves && item.data_lines) bits.push("有数据 " + num(item.data_lines));
      var label = item.biz_date + (bits.length ? "（" + bits.join(" · ") + "）" : "");
      return '<option value="' + esc(item.biz_date) + '"' + (item.biz_date === state.date ? " selected" : "") + ">" +
        esc(label) + "</option>";
    }).join("");
  }

  function refreshDateSelect() {
    var select = $("#date-select");
    if (select) select.innerHTML = dateOptions();
    var back = $("#btn-today");
    if (back) back.style.display = state.date === todayStr() ? "none" : "";
  }

  function goToday() {
    state.date = todayStr();
    state.dateManual = false;
    refreshDateSelect();
    route();
  }

  /** 非今天时给登记类页面的醒目提示 */
  function dateBanner() {
    var today = todayStr();
    if (state.date === today) return "";
    return '<div class="panel" style="margin-bottom:12px;border-color:#ffd8a8;background:#fff9db">' +
      '<div class="panel-body small">当前业务日：<b>' + esc(state.date) + "</b>（不是今天 " + esc(today) + "）。" +
      "在这里新增/删除的波次、订单组改动与存档都会记到这一天。" +
      ' <a href="#" data-back-today>切回今天</a></div></div>';
  }

  function bindDateBanner(view) {
    var link = $("[data-back-today]", view);
    if (link) {
      link.addEventListener("click", function (event) {
        event.preventDefault();
        goToday();
      });
    }
  }

  function renderShell() {
    var user = state.me.user || {};
    document.body.innerHTML =
      '<div class="topbar">' +
        '<div class="brand"><span class="brand-mark">量</span><span class="brand-text">' + esc(state.me.site_title || "单量与作业进度看板") + "</span></div>" +
        '<nav class="nav">' + navHtml() + "</nav>" +
        '<div class="topbar-right">' +
          '<select class="select" id="date-select" style="height:30px;min-width:150px">' + dateOptions() + "</select>" +
          '<button class="btn btn-sm" id="btn-today" style="display:none;height:26px">回到今天</button>' +
          (has("page.screen") ? '<button class="btn btn-sm" id="btn-screen" title="大屏轮播模式" style="height:26px">大屏</button>' : "") +
          (has("page.alerts") ? '<button class="btn btn-sm" id="btn-bell" title="预警消息" aria-label="预警消息" style="height:26px;position:relative">' +
            '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2a3.5 3.5 0 0 0-3.5 3.5c0 3-1.5 4-1.5 4h10s-1.5-1-1.5-4A3.5 3.5 0 0 0 8 2Z"></path><path d="M6.6 12.5a1.5 1.5 0 0 0 2.8 0"></path></svg>' +
            '<span id="bell-dot" class="bell-dot" style="display:none">0</span></button>' : "") +
          '<span class="meta"><span class="dot" id="online-dot"></span> <span id="update-time">' + esc(clock()) + "</span></span>" +
          '<div class="user-chip" id="user-chip">' + esc(user.display_name || user.username || "") + "</div>" +
        "</div>" +
      "</div>" +
      '<div class="page" id="view"></div>' +
      '<div id="toasts"></div>';

    $("#date-select").addEventListener("change", function (event) {
      state.date = event.target.value;
      state.dateManual = true;
      refreshDateSelect();
      route();
    });
    $("#btn-today").addEventListener("click", goToday);
    $("#btn-screen") && $("#btn-screen").addEventListener("click", function () {
      location.hash = "#/screen";
    });
    $("#btn-bell") && $("#btn-bell").addEventListener("click", function (event) {
      event.stopPropagation();
      toggleBell();
    });
    updateBell();
    $("#user-chip").addEventListener("click", openUserMenu);
    window.addEventListener("hashchange", route);
  }

  // ---------------------------------------------------------------- 预警铃铛
  function updateBell() {
    var dot = $("#bell-dot");
    if (!dot) return;
    api("/api/alerts?unread=1&limit=1")
      .then(function (data) {
        var count = data.unread || 0;
        dot.style.display = count ? "" : "none";
        dot.textContent = count > 99 ? "99+" : String(count);
      })
      .catch(function () { /* 忽略 */ });
  }

  function toggleBell() {
    var existing = $("#bell-menu");
    if (existing) { existing.remove(); return; }
    var menu = document.createElement("div");
    menu.id = "bell-menu";
    menu.className = "bell-menu";
    menu.innerHTML = '<div class="bell-head"><span>预警消息</span>' +
      '<a href="#" id="bell-read-all">全部已读</a></div><div id="bell-list" class="bell-list">加载中…</div>' +
      '<div class="bell-foot"><a href="#/alerts">查看全部 →</a></div>';
    document.body.appendChild(menu);
    menu.addEventListener("click", function (event) { event.stopPropagation(); });
    document.addEventListener("click", function close() {
      var node = $("#bell-menu");
      if (node) node.remove();
      document.removeEventListener("click", close);
    });
    $("#bell-read-all").addEventListener("click", function (event) {
      event.preventDefault();
      api("/api/alerts/read", { method: "POST", body: JSON.stringify({ all: true }) })
        .then(function () { updateBell(); toggleBell(); toggleBell(); })
        .catch(function (e) { toast(e.message, "err"); });
    });
    api("/api/alerts?limit=20").then(function (data) {
      var box = $("#bell-list");
      if (!box) return;
      if (!data.rows.length) { box.innerHTML = '<div class="small muted" style="padding:10px">暂无预警消息</div>'; return; }
      box.innerHTML = data.rows.map(function (row) {
        return '<div class="bell-item' + (row.read_at ? "" : " unread") + '" data-id="' + row.id + '">' +
          '<div class="bell-title"><span class="badge ' + (row.level === "danger" ? "err" : "warn") + '">' +
          (row.level === "danger" ? "超时" : "临近") + "</span> " + esc(row.title) + "</div>" +
          '<div class="small muted">' + esc(row.body || "") + " · " + esc(row.created_at || "") + "</div></div>";
      }).join("");
      $$(".bell-item", box).forEach(function (item) {
        item.addEventListener("click", function () {
          api("/api/alerts/read", {
            method: "POST",
            body: JSON.stringify({ ids: [parseInt(item.getAttribute("data-id"), 10)] })
          }).then(function () {
            item.classList.remove("unread");
            updateBell();
          }).catch(function () { /* 忽略 */ });
        });
      });
    }).catch(function (error) {
      var box = $("#bell-list");
      if (box) box.innerHTML = '<div class="widget-error">' + esc(error.message) + "</div>";
    });
  }

  function openUserMenu() {
    var existing = $(".menu");
    if (existing) { existing.remove(); return; }
    var menu = document.createElement("div");
    menu.className = "menu";
    menu.innerHTML =
      '<div style="padding:6px 10px 8px;color:#7b8794;font-size:12px">' +
        esc((state.me.user && state.me.user.display_name) || "") +
        (state.me.scopes && Object.keys(state.me.scopes).length ? "<br>数据范围：" + esc(JSON.stringify(state.me.scopes)) : "") +
      "</div><div class=\"sep\"></div>" +
      '<button data-act="pwd">修改密码</button>' +
      '<button data-act="logout">退出登录</button>';
    document.body.appendChild(menu);
    menu.addEventListener("click", function (event) {
      var act = event.target.getAttribute("data-act");
      if (act === "logout") {
        api("/api/logout", { method: "POST" }).then(function () { location.reload(); });
      } else if (act === "pwd") {
        menu.remove();
        changePasswordModal();
      }
    });
    setTimeout(function () {
      document.addEventListener("click", function closer() { menu.remove(); document.removeEventListener("click", closer); });
    }, 0);
  }

  function changePasswordModal() {
    var m = modal({
      title: "修改密码",
      body: '<div class="field"><label>原密码</label><input class="input" id="cp-old" type="password"></div>' +
            '<div class="field"><label>新密码</label><input class="input" id="cp-new" type="password" placeholder="至少 8 位，含字母和数字"></div>',
      footer: '<button class="btn" data-cancel>取消</button><button class="btn btn-primary" data-ok>保存</button>'
    });
    $("[data-cancel]", m.el).addEventListener("click", m.close);
    $("[data-ok]", m.el).addEventListener("click", function () {
      api("/api/change-password", {
        method: "POST",
        body: JSON.stringify({ old_password: $("#cp-old", m.el).value, new_password: $("#cp-new", m.el).value })
      }).then(function () { toast("密码已更新", "ok"); m.close(); })
        .catch(function (error) { toast(error.message, "err"); });
    });
  }

  // ---------------------------------------------------------------- 路由
  function route() {
    var raw = location.hash.replace(/^#\/?/, "") || "overview";
    var mark = raw.indexOf("?");
    var qs = mark >= 0 ? raw.slice(mark + 1) : "";
    var hash = mark >= 0 ? raw.slice(0, mark) : raw;
    state.query = {};
    qs.split("&").forEach(function (pair) {
      if (!pair) return;
      var kv = pair.split("=");
      state.query[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || "");
    });
    var parts = hash.split("/");
    var page = parts[0] || "overview";
    state.editing = false;
    state.routeToken += 1;
    // 切页时关掉遗留的弹窗，避免上一个页面的弹窗盖住新页面
    $$(".modal-mask").forEach(function (mask) { mask.remove(); });
    var view = $("#view");
    if (!view) return;
    state.page = page;
    $$("[data-nav]").forEach(function (link) {
      link.classList.toggle("active", link.getAttribute("data-nav") === page);
    });
    var allowed = PAGES.filter(function (item) { return has(item.perm); }).map(function (item) { return item.key; });
    if (page === "print") {
      if (!has("action.export")) { view.innerHTML = emptyHtml("没有导出/打印权限"); return; }
      pagePrint(view);
      return;
    }
    if (page === "screen") {
      if (!has("page.screen")) { view.innerHTML = emptyHtml("没有大屏权限"); return; }
      renderScreen(view);
      return;
    }
    document.body.classList.remove("screen-mode");
    if (page === "board") {
      if (!has("page.dashboard")) { view.innerHTML = emptyHtml("没有看板权限"); return; }
      renderBoardEditor(view, parts[1] || "page", parts[2]);
      return;
    }
    if (allowed.indexOf(page) < 0) {
      if (allowed.length) { location.hash = "#/" + allowed[0]; return; }
      view.innerHTML = emptyHtml("当前账号没有任何页面权限，请联系管理员");
      return;
    }
    if (DASH_PAGE_KEYS.indexOf(page) >= 0) {
      if (page === "labor") pageLabor(view);
      else renderPageDashboard(view, page);
    }
    else if (page === "volume") pageVolume(view);
    else if (page === "orders") pageOrders(view);
    else if (page === "battery") pageBattery(view);
    else if (page === "waves") pageWaves(view);
    else if (page === "alerts") pageAlerts(view);
    else if (page === "dashboard") {
      if (parts[1]) { location.hash = "#/board/dash/" + parts[1]; return; }
      renderBoardHub(view);
    }
    else if (page === "sources") pageSources(view);
    else if (page === "outbound") pageOutboundArchive(view);
    else if (page === "admin") pageAdmin(view, parts[1]);
    else if (page === "audit") pageAudit(view);
    else view.innerHTML = emptyHtml("页面不存在");
  }

  // ---------------------------------------------------------------- 导航页看板（可编辑/可发布）
  /** 组件配置弹窗（页面看板与自定义画布共用） */
  var DATASET_GROUP_ORDER = ["订单与波次", "作业与人效", "ERP 回传", "趋势", "预警"];

  function datasetUiOf(catalog, key) {
    return (catalog.dataset_ui || {})[key] || {};
  }

  function datasetSupports(ui, type) {
    return !ui || !ui.supports || ui.supports.indexOf(type) >= 0;
  }

  function metricKindLabel(kind) {
    return { int: "数量", num: "数值", pct: "比例", money: "金额", hours: "时长" }[kind] || "其他";
  }

  function widgetDefaultSpec(type) {
    if (type === "kpi") return { dataset: "orders", metrics: ["rows"] };
    if (type === "alert") return { dataset: "alerts" };
    if (type === "text") return { text: "说明文字" };
    if (type === "line") return { dataset: "lines", dimension: "hour", metrics: ["rows"], limit: 24 };
    if (type === "pie") return { dataset: "orders", dimension: "zone", metrics: ["rows"], limit: 8 };
    if (type === "progress") return { dataset: "orders", dimension: "route", metrics: ["out_rate", "rows"], limit: 10 };
    if (type === "funnel") return { dataset: "orders", metrics: ["rows"] };
    if (type === "table") return { dataset: "orders", dimension: "route", metrics: ["rows", "checked", "checked_rate"], limit: 12 };
    return { dataset: "orders", dimension: "route", metrics: ["rows"], limit: 10 };
  }

  function newWidget(type, title, spec, w, h) {
    return {
      id: "w" + Date.now().toString(36) + Math.floor(Math.random() * 900 + 100),
      type: type,
      title: title || (type === "kpi" ? "新指标" : "新组件"),
      spec: spec || widgetDefaultSpec(type),
      x: 0, y: 0,
      w: w || (type === "kpi" ? 3 : 6),
      h: h || (type === "kpi" ? 3 : 5)
    };
  }

  function previewHtml(data) {
    if (!data) return emptyHtml("没有返回数据");
    if (data.kind === "value") {
      return '<div class="small muted">当前值</div><div style="font-size:24px;font-weight:600;margin-top:2px">' +
        esc(data.label || data.metric || "指标") + " · " + esc(String(data.value == null ? "-" : data.value)) + "</div>";
    }
    if (data.kind === "text") return '<div class="small">' + esc(data.text || "") + "</div>";
    if (data.kind === "rows") {
      var rows = data.rows || [];
      if (!rows.length) return '<div class="small muted">' + esc(data.empty_text || "当前没有数据") + "</div>";
      var cols = (data.columns || []).slice(0, 6);
      var head = "<tr>" + cols.map(function (col) { return "<th>" + esc(col.label) + "</th>"; }).join("") + "</tr>";
      var body = rows.slice(0, 3).map(function (row) {
        return "<tr>" + cols.map(function (col) {
          var v = row[col.key];
          return "<td>" + esc(v === null || v === undefined ? "-" : String(v)) + "</td>";
        }).join("") + "</tr>";
      }).join("");
      return '<div class="small muted" style="margin-bottom:6px">共 ' + num(data.total != null ? data.total : rows.length) +
        " 条" + (rows.length > 3 ? "，预览前 3 条" : "") + "</div>" +
        '<div class="table-wrap"><table class="tbl"><thead>' + head + "</thead><tbody>" + body + "</tbody></table></div>";
    }
    if (data.kind === "series") {
      var cats = data.categories || [];
      var series = data.series || [];
      if (!cats.length) return '<div class="small muted">当前没有数据</div>';
      var first = series[0] || { values: [], name: "" };
      var maxValue = 0;
      (first.values || []).forEach(function (v) { maxValue = Math.max(maxValue, Number(v) || 0); });
      return '<div class="small muted">共 ' + num(cats.length) + " 类 · 最大 " + esc(first.name || "数值") + " " +
        num(maxValue, first.metric && /_rate/.test(first.metric) ? 1 : 0) + "</div>" +
        '<div class="small" style="margin-top:4px">' + esc(cats.slice(0, 3).join("、")) + (cats.length > 3 ? " …" : "") + "</div>";
    }
    if (data.kind === "funnel") {
      var items = data.items || [];
      return items.length
        ? '<div class="small muted">共 ' + items.length + " 个阶段：" + esc(items.map(function (it) { return it.label + " " + num(it.value); }).join(" · ")) + "</div>"
        : '<div class="small muted">当前没有数据</div>';
    }
    return '<div class="small muted">已取到数据</div>';
  }

  /** 组件配置弹窗（页面看板与专题看板共用）：内置数据说明、默认值、筛选与实时预览。 */
  async function openWidgetConfig(widget, onApply) {
    var catalog = await api("/api/widget-catalog");
    var uiMap = catalog.dataset_ui || {};
    var metricMeta = catalog.metric_meta || {};
    var allowedByDataset = catalog.dataset_metrics || {};
    var date = state.date;
    var original = JSON.parse(JSON.stringify(widget.spec || {}));
    var originalFilter = JSON.parse(JSON.stringify(original.filter || {}));
    var originalDataset = original.dataset || "orders";
    var isText = widget.type === "text";
    var isAlert = widget.type === "alert";

    var datasets = (catalog.datasets || []).filter(function (d) {
      if (widget.type === "alert") return d.key === "alerts";
      if (d.key === "alerts") return false;
      if (widget.type === "funnel") return d.key === "orders";
      if (isText) return false;
      return datasetSupports(uiMap[d.key], widget.type);
    });
    var model = {
      title: widget.title || "",
      dataset: original.dataset && datasets.some(function (d) { return d.key === original.dataset; })
        ? original.dataset : (datasets[0] && datasets[0].key) || "orders",
      dimension: original.dimension || "",
      metrics: (original.metrics || ["rows"]).slice(),
      limit: Number(original.limit) || 10,
      dir: (original.sort && original.sort.dir) === "asc" ? "asc" : "desc",
      filter: JSON.parse(JSON.stringify(original.filter || {})),
      compare: original.compare === true,
      column_widths: Object.assign({}, original.column_widths || {}),
      column_order: (original.column_order || []).slice(),
      hidden_columns: (original.hidden_columns || []).slice(),
      fields: (original.fields || []).slice(),
      show_values: original.show_values !== false,
      color_scheme: original.color_scheme || "",
      color: original.color || ""
    };
    if (!model.dimension) {
      var ui0 = datasetUiOf(catalog, model.dataset);
      model.dimension = ui0.default_dimension || "";
    }

    var modalOpts = {
      title: "组件配置",
      body: "",
      wide: true,
      footer: '<button class="btn" data-cancel>取消</button><button class="btn btn-primary" data-ok>应用</button>'
    };
    var m = modal(modalOpts);
    var bodyEl = $(".modal-body", m.el);

    function dimsOf(key) {
      var found = (catalog.datasets || []).filter(function (d) { return d.key === key; })[0];
      return (found && found.dims) || [];
    }
    function metricsOf(key) {
      var list = allowedByDataset[key] || Object.keys(metricMeta);
      return list.filter(function (x) { return metricMeta[x]; });
    }
    function datasetDefaultModel(key) {
      var ui = datasetUiOf(catalog, key);
      var filter = {};
      (ui.filters || []).forEach(function (f) {
        if (f && typeof f === "object" && f.key) filter[f.key] = f.default;
      });
      model.dataset = key;
      model.dimension = ui.default_dimension || "";
      model.metrics = (ui.default_metrics || ["rows"]).slice();
      model.limit = Number(original.limit) || 10;
      model.dir = "desc";
      model.filter = filter;
    }

    function textFilterKeys(key) {
      var ui = datasetUiOf(catalog, key);
      return (ui.filters || []).filter(function (f) { return typeof f === "string"; });
    }
    function typedFilterDefs(key) {
      var ui = datasetUiOf(catalog, key);
      return (ui.filters || []).filter(function (f) { return f && typeof f === "object" && f.key; });
    }

    function filterHtml() {
      var textKeys = textFilterKeys(model.dataset);
      var typed = typedFilterDefs(model.dataset);
      var html = "";
      if (typed.length) {
        html += typed.map(function (f) {
          return '<div class="field"><label>' + esc(f.label || f.key) + "</label><div class=\"cw-radio\">" +
            (f.options || []).map(function (opt) {
              return '<label class="check"><input type="radio" name="cw-filter-' + esc(f.key) + '" data-filter-key="' +
                esc(f.key) + '" value="' + esc(opt.value) + '"' +
                ((model.filter[f.key] || f.default) === opt.value ? " checked" : "") + "> " + esc(opt.label) + "</label>";
            }).join("") + "</div></div>";
        }).join("");
      }
      if (textKeys.length) {
        html += '<div class="field"><label>固定筛选（可留空）</label><div class="grid cols-3">' +
          textKeys.map(function (key) {
            return '<input class="input" data-filter-key="' + esc(key) + '" placeholder="' + esc(dimensionLabel(key)) +
              '" value="' + esc(model.filter[key] || "") + '">';
          }).join("") + "</div></div>";
      }
      return html;
    }

    function tableColumns() {
      if (widget.type !== "table") return [];
      if (model.dataset === "battery") {
        return [
          ["order_date", "订单日期"], ["reg_date", "登记日期"], ["group_no", "订单组号"],
          ["dealer_short", "经销商"], ["part_code", "备件编码"], ["part_name", "备件名称"],
          ["lines", "行数"], ["qty", "数量"], ["amount", "金额"], ["zone", "库区"],
          ["doc_type", "单据类型"], ["freight_free", "是否免运费"], ["region", "区域"],
          ["carrier", "承运商"], ["dest_city", "送达城市"], ["picked", "拣货行数"],
          ["checked", "复核行数"], ["address", "地址"], ["confirmed", "状态"],
          ["dealer_full", "经销商全称"]
        ];
      }
      if (model.dataset === "overdue") {
        return [["group_no", "订单组号"], ["wave_no", "波次号"], ["dealer", "经销商"],
          ["route", "线路"], ["zone", "库区"], ["lines", "总行数"], ["checked", "已复核"],
          ["remaining", "未复核"], ["amount", "金额(万)"], ["deadline", "截止时间"],
          ["tms_status", "运输单"]];
      }
      if (model.dataset === "erp_detail") {
        return [["seq", "序号"], ["group_no", "订单组号"], ["dealer", "经销商"], ["lines", "行数"],
          ["amount", "金额(元)"], ["zone", "库区"], ["doc_type", "单据类型"], ["freight_free", "免运费"],
          ["region", "区域"], ["route", "承运商"], ["wave_no", "波次号"], ["tms_status", "清洗"],
          ["assignee", "指派"], ["erp_status", "ERP状态"], ["erp_lines", "异常行数"],
          ["erp_message", "回传信息"], ["erp_time", "回传时间"]];
      }
      var cols = [["label", dimensionLabel(model.dimension)]];
      metricsOf(model.dataset).forEach(function (key) {
        cols.push([key, (metricMeta[key] && metricMeta[key].label) || key]);
      });
      return cols;
    }

    function ensureTableLayout() {
      if (widget.type !== "table") return;
      var all = tableColumns().map(function (col) { return col[0]; });
      if (!model.column_order.length) model.column_order = all.slice();
      else all.forEach(function (key) { if (model.column_order.indexOf(key) < 0) model.column_order.push(key); });
      if (!model.fields.length) {
        if (model.dataset === "battery") {
          model.fields = all.filter(function (key) {
            return ["address", "confirmed", "dealer_full"].indexOf(key) < 0;
          });
        } else if (model.dataset === "erp_detail" || model.dataset === "overdue") model.fields = all.slice();
        else model.fields = ["label"].concat(model.metrics.slice());
      }
      model.fields = model.fields.filter(function (key) { return all.indexOf(key) >= 0; });
      var hidden = {};
      model.hidden_columns.forEach(function (key) { hidden[key] = true; });
      all.forEach(function (key) {
        if (model.fields.indexOf(key) < 0) hidden[key] = true;
        else delete hidden[key];
      });
      model.hidden_columns = Object.keys(hidden);
    }

    function visibleTableColumns() {
      ensureTableLayout();
      var hidden = {};
      model.hidden_columns.forEach(function (key) { hidden[key] = true; });
      var order = {};
      model.column_order.forEach(function (key, index) { order[key] = index; });
      var cols = tableColumns().filter(function (col) { return !hidden[col[0]]; });
      cols.sort(function (a, b) {
        return (order[a[0]] === undefined ? 9999 : order[a[0]]) - (order[b[0]] === undefined ? 9999 : order[b[0]]);
      });
      return cols;
    }

    function fieldsHtml() {
      if (widget.type !== "table") return "";
      ensureTableLayout();
      var all = tableColumns();
      var fieldMap = {};
      model.fields.forEach(function (key) { fieldMap[key] = true; });
      return '<div class="field"><label>显示字段 <span class="small muted">（可选择当前数据集全部字段）</span></label>' +
        '<div class="grid cols-3">' + all.map(function (col) {
          return '<label class="check"><input type="checkbox" data-table-field="' + esc(col[0]) + '"' +
            (fieldMap[col[0]] ? " checked" : "") + "> " + esc(col[1]) + "</label>";
        }).join("") + "</div></div>";
    }

    function widthsHtml() {
      if (widget.type !== "table") return "";
      var cols = visibleTableColumns();
      if (!cols.length) return "";
      return '<div class="field"><label>列宽 <span class="small muted">（像素，留空自动）</span></label>' +
        '<div class="grid cols-3">' + cols.map(function (col) {
          var value = model.column_widths[col[0]] || "";
          return '<div class="field"><label>' + esc(col[1]) + '</label><input class="input" type="number" min="40" max="600" step="10" data-col-width="' + esc(col[0]) + '" value="' + esc(value) + '"></div>';
        }).join("") + "</div></div>";
    }

    function metricsHtml() {
      if (model.dataset === "erp_detail" || model.dataset === "alerts") {
        return '<div class="small muted">该数据集的指标固定为“行数/明细”，无需选择。</div>';
      }
      if (model.dataset === "battery") {
        return '<div class="small muted">动力电池明细组件使用固定列：订单组/备件编码/名称/行数/数量/金额/拣货/复核。</div>';
      }
      var list = metricsOf(model.dataset);
      var groups = {};
      list.forEach(function (key) {
        var meta = metricMeta[key];
        var label = metricKindLabel(meta && meta.kind);
        (groups[label] = groups[label] || []).push(key);
      });
      var inputType = widget.type === "kpi" ? "radio" : "checkbox";
      return Object.keys(groups).map(function (label) {
        return '<div class="metric-group"><div class="metric-group-title">' + esc(label) + '</div><div class="metric-checks">' +
          groups[label].map(function (key) {
            var on = model.metrics.indexOf(key) >= 0;
            return '<label class="check"><input type="' + inputType + '" data-metric="' + key + '"' + (on ? " checked" : "") +
              "> " + esc(metricMeta[key].label) + "</label>";
          }).join("") + "</div></div>";
      }).join("");
    }

    function colorHtml() {
      if (["kpi", "bar", "line", "pie", "funnel", "progress"].indexOf(widget.type) < 0) return "";
      var scheme = model.color_scheme || "";
      var colors = COLOR_SCHEMES[scheme] || COLOR_SCHEMES[""];
      var swatches = colors.map(function (color) {
        return '<button type="button" class="cw-swatch' + (model.color === color ? " active" : "") +
          '" data-color="' + esc(color) + '" style="background:' + esc(color) + '" title="' + esc(color) + '"></button>';
      }).join("");
      return '<div class="field"><label>配色 <span class="small muted">（仅影响当前组件）</span></label>' +
        '<div class="grid cols-2" style="margin-bottom:8px"><select class="select" id="cw-color-scheme">' +
          '<option value=""' + (scheme === "" ? " selected" : "") + ">默认（品牌蓝）</option>" +
          '<option value="macaron"' + (scheme === "macaron" ? " selected" : "") + ">马卡龙</option>" +
          '<option value="dopamine"' + (scheme === "dopamine" ? " selected" : "") + ">多巴胺</option>" +
        '</select><button type="button" class="btn btn-sm" id="cw-color-reset">恢复默认</button></div>' +
        '<div class="cw-swatches">' + swatches + "</div></div>";
    }

    function bodyHtml() {
      var ui = datasetUiOf(catalog, model.dataset);
      var textLike = isText;
      if (textLike) {
        return '<div class="field"><label>标题</label><input class="input" id="cw-title" value="' + esc(model.title) + '"></div>' +
          '<div class="field"><label>文本内容</label><textarea class="input" id="cw-text">' + esc(original.text || "") + "</textarea></div>";
      }
      var grouped = {};
      datasets.forEach(function (d) {
        var group = (datasetUiOf(catalog, d.key).group) || "其他";
        (grouped[group] = grouped[group] || []).push(d);
      });
      var order = DATASET_GROUP_ORDER.filter(function (g) { return grouped[g]; });
      Object.keys(grouped).forEach(function (g) { if (order.indexOf(g) < 0) order.push(g); });
      var opts = order.map(function (g) {
        return '<optgroup label="' + esc(g) + '">' + grouped[g].map(function (d) {
          return '<option value="' + d.key + '"' + (d.key === model.dataset ? " selected" : "") + ">" + esc(d.title) + "</option>";
        }).join("") + "</optgroup>";
      }).join("");
      var dims = dimsOf(model.dataset);
      var showDim = widget.type !== "kpi" && widget.type !== "funnel" &&
        model.dataset !== "erp_detail" && model.dataset !== "alerts" && dims.length > 0;
      return '<div class="field"><label>标题</label><input class="input" id="cw-title" value="' + esc(model.title) + '"></div>' +
        '<div class="grid cols-2">' +
          '<div class="field"><label>看什么数据</label><select class="select" id="cw-dataset">' + opts + "</select>" +
          '<div class="help">' + esc(ui.desc || "选择要分析的数据范围") + "</div></div>" +
          (showDim
            ? '<div class="field"><label>按什么分组</label><select class="select" id="cw-dim">' + dims.map(function (dim) {
                return '<option value="' + dim + '"' + (dim === model.dimension ? " selected" : "") + ">" +
                  esc(dimensionLabel(dim)) + "</option>";
              }).join("") + "</select><div class=\"help\">不分组时可用 KPI 或明细表</div></div>"
            : '<div class="field"><label>按什么分组</label><div class="help" style="margin-top:8px">该数据集无需分组：' +
              (widget.type === "kpi" ? "KPI 直接显示一个数" : "按明细行展示") + "</div></div>") +
        "</div>" +
        '<div class="field"><label>看什么指标</label>' + metricsHtml() + "</div>" +
        (widget.type === "kpi"
          ? '<div class="field"><label class="check"><input type="checkbox" id="cw-compare"' +
            (model.compare ? " checked" : "") + "> 显示较上日比较</label>" +
            '<div class="help">以同一指标与上一业务日比较，显示环比百分比</div></div>'
          : "") +
        (model.dataset === "battery" ? "" : filterHtml()) +
        fieldsHtml() +
        widthsHtml() +
        colorHtml() +
        (["bar", "line", "pie", "funnel"].indexOf(widget.type) >= 0
          ? '<div class="field"><label class="check"><input type="checkbox" id="cw-show-values"' +
            (model.show_values ? " checked" : "") + "> 显示数值</label></div>"
          : "") +
        '<div class="grid cols-2"><div class="field"><label>取前 N 项</label><input class="input" id="cw-limit" type="number" min="1" max="200" value="' +
        model.limit + '"></div><div class="field"><label>排序</label><select class="select" id="cw-dir">' +
        '<option value="desc"' + (model.dir !== "asc" ? " selected" : "") + ">从大到小</option>" +
        '<option value="asc"' + (model.dir === "asc" ? " selected" : "") + ">从小到大</option></select></div></div>" +
        '<div class="field"><label>效果预览 <span class="small muted">（当前业务日期 ' + esc(date) + "）</span></label>" +
        '<div class="cw-preview" id="cw-preview"><span class="small muted">预览中…</span></div></div>';
    }

    function collectSpec() {
      var filter = {};
      if (model.dataset === originalDataset) filter = Object.assign({}, originalFilter);
      Object.keys(model.filter).forEach(function (key) {
        var value = model.filter[key];
        if (value !== "" && value !== null && value !== undefined) filter[key] = value;
      });
      textFilterKeys(model.dataset).forEach(function (key) { if (!filter[key]) delete filter[key]; });
      var spec = {
        dataset: model.dataset,
        dimension: model.dimension || "",
        metrics: model.metrics.length ? model.metrics.slice() : ["rows"],
        limit: model.limit,
        sort: { dir: model.dir },
        filter: filter
      };
      if (widget.type === "kpi" && model.compare) spec.compare = true;
      if (model.color_scheme) spec.color_scheme = model.color_scheme;
      if (model.color) spec.color = model.color;
      if (model.show_values === false) spec.show_values = false;
      if (widget.type === "kpi") delete spec.dimension;
      if (model.dataset === "erp_detail") { spec.dimension = ""; spec.metrics = ["rows"]; }
      if (model.dataset === "battery") { spec.dimension = ""; spec.metrics = ["rows"]; }
      if (widget.type === "table") {
        ensureTableLayout();
        if (model.dataset !== "battery" && model.dataset !== "erp_detail") {
          var chosen = model.fields.filter(function (key) { return key !== "label" && metricMeta[key]; });
          spec.metrics = chosen.length ? chosen : ["rows"];
        }
        spec.fields = model.fields.slice();
        spec.column_order = model.column_order.slice();
        spec.hidden_columns = model.hidden_columns.slice();
        var widths = {};
        Object.keys(model.column_widths || {}).forEach(function (key) {
          var px = Number(model.column_widths[key]);
          if (px >= 40 && px <= 600) widths[key] = px;
        });
        if (Object.keys(widths).length) spec.column_widths = widths;
      }
      return spec;
    }

    var previewTimer = null;
    function schedulePreview() {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(refreshPreview, 260);
    }
    async function refreshPreview() {
      var box = $("#cw-preview", m.el);
      if (!box) return;
      try {
        var data = await api("/api/widget", {
          method: "POST",
          body: JSON.stringify({ widget_type: widget.type, date: date, spec: collectSpec() })
        });
        if (widget.type === "text") {
          box.innerHTML = '<span class="small muted">文本组件无需预览</span>';
        } else {
          box.innerHTML = previewHtml(data);
        }
      } catch (error) {
        box.innerHTML = '<span class="small" style="color:var(--danger)">' + esc(error.message) + "</span>";
      }
    }

    function bind() {
      var title = $("#cw-title", m.el);
      if (title) title.addEventListener("input", function () { model.title = title.value; });
      if (isText) {
        var text = $("#cw-text", m.el);
        if (text) text.addEventListener("input", function () { original.text = text.value; });
        return;
      }
      var ds = $("#cw-dataset", m.el);
      if (ds) ds.addEventListener("change", function () {
        datasetDefaultModel(ds.value);
        render();
      });
      var dim = $("#cw-dim", m.el);
      if (dim) dim.addEventListener("change", function () { model.dimension = dim.value; schedulePreview(); });
      $$("[data-metric]", m.el).forEach(function (input) {
        input.addEventListener("change", function () {
          if (widget.type === "kpi") model.metrics = [input.getAttribute("data-metric")];
          else {
            var chosen = $$("[data-metric]:checked", m.el).map(function (el) { return el.getAttribute("data-metric"); });
            model.metrics = chosen.length ? chosen : ["rows"];
          }
          schedulePreview();
        });
      });
      $$("[data-filter-key]", m.el).forEach(function (input) {
        var key = input.getAttribute("data-filter-key");
        var handler = function () {
          if (input.type === "radio") {
            if (input.checked) model.filter[key] = input.value;
          } else if (input.value.trim()) model.filter[key] = input.value.trim();
          else delete model.filter[key];
          schedulePreview();
        };
        input.addEventListener("input", handler);
        input.addEventListener("change", handler);
      });
      var limit = $("#cw-limit", m.el);
      if (limit) limit.addEventListener("input", function () {
        model.limit = Math.max(1, Math.min(200, Number(limit.value) || 10));
        schedulePreview();
      });
      var dir = $("#cw-dir", m.el);
      if (dir) dir.addEventListener("change", function () { model.dir = dir.value; schedulePreview(); });
      var compare = $("#cw-compare", m.el);
      if (compare) compare.addEventListener("change", function () { model.compare = compare.checked; schedulePreview(); });
      $$("[data-col-width]", m.el).forEach(function (input) {
        input.addEventListener("input", function () {
          var key = input.getAttribute("data-col-width");
          var px = Number(input.value);
          if (px >= 40 && px <= 600) model.column_widths[key] = px;
          else delete model.column_widths[key];
          schedulePreview();
        });
      });
      $$("[data-table-field]", m.el).forEach(function (input) {
        input.addEventListener("change", function () {
          var key = input.getAttribute("data-table-field");
          if (input.checked) {
            if (model.fields.indexOf(key) < 0) model.fields.push(key);
            model.hidden_columns = model.hidden_columns.filter(function (x) { return x !== key; });
            if (model.column_order.indexOf(key) < 0) model.column_order.push(key);
          } else {
            model.fields = model.fields.filter(function (x) { return x !== key; });
            if (model.hidden_columns.indexOf(key) < 0) model.hidden_columns.push(key);
          }
          render();
        });
      });
      var scheme = $("#cw-color-scheme", m.el);
      if (scheme) scheme.addEventListener("change", function () { model.color_scheme = scheme.value; model.color = ""; render(); });
      $$("[data-color]", m.el).forEach(function (btn) {
        btn.addEventListener("click", function () { model.color = btn.getAttribute("data-color"); render(); });
      });
      var reset = $("#cw-color-reset", m.el);
      if (reset) reset.addEventListener("click", function () { model.color_scheme = ""; model.color = ""; render(); });
    }

    function render() {
      bodyEl.innerHTML = bodyHtml();
      bind();
      refreshPreview();
    }
    render();

    $("[data-cancel]", m.el).addEventListener("click", m.close);
    $("[data-ok]", m.el).addEventListener("click", function () {
      if (isText) {
        widget.spec = { text: ($("#cw-text", m.el) || {}).value || "" };
        widget.title = ($("#cw-title", m.el) || {}).value || widget.title;
      } else {
        widget.title = ($("#cw-title", m.el) || {}).value.trim() || widget.title;
        widget.spec = collectSpec();
      }
      m.close();
      if (typeof onApply === "function") onApply(widget);
    });
  }

  /** 添加组件：模板库（默认）+ 按类型自定义（高级）。 */
  async function openAddWidgetModal(onAdd) {
    var catalog = await api("/api/widget-catalog");
    var types = [
      ["kpi", "KPI 卡"], ["bar", "柱状图"], ["line", "折线图"], ["pie", "饼/环图"],
      ["funnel", "漏斗"], ["table", "表格"], ["alert", "预警清单"],
      ["progress", "进度条"], ["text", "文本"]
    ].filter(function (t) { return has("widget." + t[0]); });
    var allowed = {};
    types.forEach(function (t) { allowed[t[0]] = 1; });
    var presets = (catalog.presets || []).filter(function (p) {
      if (!allowed[p.type]) return false;
      if (!catalog.with_amount && JSON.stringify(p.spec || {}).indexOf('"amount"') >= 0) return false;
      return true;
    });
    var groups = {};
    presets.forEach(function (p) { (groups[p.group || "模板"] = groups[p.group || "模板"] || []).push(p); });
    var PRESET_GROUP_ORDER = ["今日总览", "作业进度", "作业与人效", "ERP 回传", "趋势", "预警"];
    var order = PRESET_GROUP_ORDER.filter(function (g) { return groups[g]; });
    Object.keys(groups).forEach(function (g) { if (order.indexOf(g) < 0) order.push(g); });
    var body =
      '<div class="preset-grid">' + order.map(function (group) {
        return '<div class="preset-group"><div class="preset-group-title">' + esc(group) + "</div>" +
          groups[group].map(function (p) {
            return '<button class="preset-card" type="button" data-preset="' + esc(p.key) + '">' +
              '<span class="preset-top"><span class="preset-title">' + esc(p.title) + '</span><span class="badge info">' +
              esc((types.filter(function (t) { return t[0] === p.type; })[0] || ["", p.type])[1]) + "</span></span>" +
              '<span class="preset-desc">' + esc(p.desc || "") + "</span></button>";
          }).join("") + "</div>";
      }).join("") + "</div>" +
      '<div class="preset-custom"><div class="preset-group-title">没有合适的？按类型自定义</div><div class="toolbar" style="margin-top:8px">' +
      types.map(function (t) {
        return '<button class="btn btn-sm" type="button" data-type="' + t[0] + '">+ ' + esc(t[1]) + "</button>";
      }).join("") + '</div><div class="small muted" style="margin-top:6px">自定义会打开配置向导：先选数据，再选分组/指标，右侧实时预览。</div></div>';
    var m = modal({ title: "添加组件", body: body, wide: true });
    $$("[data-preset]", m.el).forEach(function (btn) {
      btn.addEventListener("click", function () {
        var preset = presets.filter(function (p) { return p.key === btn.getAttribute("data-preset"); })[0];
        if (!preset) return;
        var widget = newWidget(preset.type, preset.title, JSON.parse(JSON.stringify(preset.spec)), preset.w, preset.h);
        m.close();
        if (typeof onAdd === "function") onAdd(widget);
      });
    });
    $$("[data-type]", m.el).forEach(function (btn) {
      btn.addEventListener("click", function () {
        var type = btn.getAttribute("data-type");
        var widget = newWidget(type, type === "kpi" ? "新指标" : "新组件", widgetDefaultSpec(type));
        m.close();
        openWidgetConfig(widget, function (updated) {
          if (typeof onAdd === "function") onAdd(updated);
        });
      });
    });
  }

  async function renderPageDashboard(view, key) {
    var meta = PAGE_META[key] || { title: key, sub: "" };
    var canEdit = has("action.dashboard.edit");
    var canPublish = has("action.dashboard.publish");
    var editing = false;
    var grid = null;
    var layout = { widgets: [] };
    var pageInfo = null;
    var dirty = false;
    var saveTimer = null;

    view.innerHTML =
      '<div class="page-head"><div><div class="page-title">' + esc(meta.title) + "</div>" +
        '<div class="page-sub" id="pg-sub">' + esc(meta.sub) + "</div></div>" +
        '<div class="toolbar" id="pg-actions">' +
          '<span class="small muted" id="pg-source"></span>' +
          (canEdit ? '<button class="btn" id="pg-edit">编辑布局</button>' : "") +
          (canPublish ? '<button class="btn" id="pg-publish" style="display:none">发布为全员默认</button>' : "") +
          (canEdit ? '<button class="btn" id="pg-reset" style="display:none">恢复默认</button>' : "") +
          (key === "overview" ? '<button class="btn" id="pg-print">打印单量表</button>' : "") +
          (canEdit ? '<button class="btn" id="pg-tidy" title="把所有组件往上紧凑排列">整理布局</button>' : "") +
          '<button class="btn" id="pg-refresh">刷新</button>' +
        "</div></div>" +
      '<div id="pg-hint"></div>' +
      (key === "overview" ? '<div class="small muted" style="margin:0 0 10px">已登记行数/金额按波次登记日归属，包含该波次内其它订单日期的行；系统订单量/金额仍按订单日期统计。</div>' : "") +
      '<div class="palette" id="pg-palette" style="display:none"></div>' +
      '<div id="pg-canvas"></div>';

    var viewEl = $("#pg-canvas", view);
    var paletteEl = $("#pg-palette", view);

    function setSource() {
      var text = "";
      if (pageInfo) {
        text = pageInfo.source === "personal"
          ? "当前：我的布局 v" + pageInfo.personal_version
          : "当前：公共默认 v" + pageInfo.public_version;
      }
      var el = $("#pg-source", view);
      if (el) el.textContent = text;
    }

    async function load() {
      pageInfo = await api("/api/pages/" + key);
      layout = pageInfo.layout || { widgets: [] };
      viewEl.innerHTML = "";
      grid = DashGrid(viewEl, {
        cols: 12,
        rowHeight: 64,
        editable: editing,
        autoLayout: false,
        onReject: function () {
          toast("该位置已被占用：换个空位，或点「整理布局」自动排列", "err");
        },
        layout: (layout.widgets || []).slice(),
        renderWidget: function (widget, body) {
          renderWidgetBody(widget, body, {
            editable: editing,
            onSpecChange: function (spec) {
              if (grid && grid.updateWidget) grid.updateWidget(widget.id, { spec: spec });
              syncLayout();
              queueSave();
            }
          });
        },
        onConfigure: function (widget) {
          openWidgetConfig(widget, function (updated) {
            if (grid && grid.updateWidget) {
              grid.updateWidget(updated.id, { title: updated.title, spec: updated.spec });
            }
            syncLayout();
            queueSave();
          });
        },
        onDuplicate: function () { syncLayout(); queueSave(); },
        onRemove: function () { syncLayout(); queueSave(); },
        confirmRemove: function (widget) {
          confirmDialog("删除组件", "确定删除「" + (widget.title || widget.type) + "」？", "删除")
            .then(function (ok) {
              if (ok && grid) { grid.removeWidget(widget.id); syncLayout(); queueSave(); }
            });
        },
        onChange: function () {
          syncLayout();
          if (editing) queueSave();
        }
      });
      function syncLayout() {
        layout = { widgets: grid.getLayout() };
        dirty = true;
      }
      setSource();
      renderHint();
    }

    function renderHint() {
      var hint = $("#pg-hint", view);
      if (!hint) return;
      if (pageInfo && pageInfo.source === "personal" && pageInfo.public_version > pageInfo.personal_version) {
        hint.innerHTML = '<div class="panel" style="margin-bottom:10px;border-color:#b7d4ff;background:#f0f6ff">' +
          '<div class="panel-body small">公共默认已更新到 v' + pageInfo.public_version +
          "（我的布局 v" + pageInfo.personal_version + "）。" +
          '<a href="#" id="pg-switch" style="margin-left:8px">切换到公共默认</a>' +
          '<a href="#" id="pg-keep" style="margin-left:8px">保留我的布局</a></div></div>';
        var sw = $("#pg-switch", hint);
        if (sw) sw.addEventListener("click", function (ev) {
          ev.preventDefault();
          api("/api/pages/" + key + "/reset", { method: "POST", body: "{}" })
            .then(function () { toast("已切换到公共默认", "ok"); load(); })
            .catch(function (e) { toast(e.message, "err"); });
        });
        var keep = $("#pg-keep", hint);
        if (keep) keep.addEventListener("click", function (ev) {
          ev.preventDefault();
          hint.innerHTML = "";
        });
      } else {
        hint.innerHTML = "";
      }
    }

    function queueSave() {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(function () {
        api("/api/pages/" + key, {
          method: "PUT",
          body: JSON.stringify({ target: "personal", layout: layout })
        }).then(function () {
          dirty = false;
          var el = $("#pg-source", view);
          if (el) el.textContent = "我的布局已保存 " + clock();
        }).catch(function (e) { toast("保存失败：" + e.message, "err"); });
      }, 800);
    }

    function toggleEditing() {
      editing = !editing;
      state.editing = editing;
      var btn = $("#pg-edit", view);
      if (btn) btn.textContent = editing ? "完成编辑" : "编辑布局";
      paletteEl.style.display = editing ? "" : "none";
      var pub = $("#pg-publish", view);
      if (pub) pub.style.display = editing ? "" : "none";
      var rst = $("#pg-reset", view);
      if (rst) rst.style.display = editing ? "" : "none";
      if (grid && grid.setEditable) grid.setEditable(editing);
      if (editing) {
        renderPalette();
        toast("进入编辑：拖动标题移动、拖右下角改大小、点 ⚙ 改数据", "ok");
      }
    }

    function renderPalette() {
      var types = [
        ["kpi", "KPI 卡"], ["bar", "柱状图"], ["line", "折线图"], ["pie", "饼/环图"],
        ["funnel", "漏斗"], ["table", "表格"], ["alert", "预警清单"],
        ["progress", "进度条"], ["text", "文本"]
      ];
      paletteEl.innerHTML = '<button class="btn btn-sm btn-primary" id="pg-add-template">+ 从模板添加</button>' +
        '<span class="small muted" style="align-self:center;margin:0 4px">或按类型：</span>' +
        types.filter(function (t) { return has("widget." + t[0]); }).map(function (t) {
          return '<button class="btn btn-sm" data-add="' + t[0] + '">' + t[1] + "</button>";
        }).join("");
      var templateBtn = $("#pg-add-template", paletteEl);
      if (templateBtn) templateBtn.addEventListener("click", function () {
        openAddWidgetModal(function (widget) { addWidgetObject(widget); });
      });
      $$("[data-add]", paletteEl).forEach(function (button) {
        button.addEventListener("click", function () { addWidget(button.getAttribute("data-add")); });
      });
    }

    function addWidgetObject(widget) {
      layout.widgets.push(widget);
      dirty = true;
      if (grid && grid.addWidget) grid.addWidget(widget);
      else if (grid && grid.setLayout) grid.setLayout(layout.widgets);
      layout = { widgets: grid ? grid.getLayout() : layout.widgets };
      queueSave();
    }

    function addWidget(type) {
      addWidgetObject(newWidget(type, type === "kpi" ? "新指标" : "新组件", widgetDefaultSpec(type),
        type === "kpi" ? 3 : 6, type === "kpi" ? 3 : 5));
    }

    $("#pg-edit") && $("#pg-edit").addEventListener("click", toggleEditing);
    $("#pg-refresh").addEventListener("click", function () { load(); toast("已刷新", "ok"); });
    $("#pg-tidy", view) && $("#pg-tidy", view).addEventListener("click", function () {
      if (grid && grid.compactAll && grid.compactAll()) {
        layout = { widgets: grid.getLayout() };
        queueSave();
        toast("已整理布局", "ok");
      } else {
        toast("已经是紧凑的，无需整理", "ok");
      }
    });
    $("#pg-print") && $("#pg-print").addEventListener("click", function () { location.hash = "#/print"; });
    var publishBtn = $("#pg-publish", view);
    if (publishBtn) publishBtn.addEventListener("click", function () {
      confirmDialog("发布为全员默认",
        "会把当前布局发布给所有人（已自建布局的同事保留自己的，可一键切换）。确定？").then(function (ok) {
        if (!ok) return;
        api("/api/pages/" + key, {
          method: "PUT",
          body: JSON.stringify({ target: "public", layout: layout })
        }).then(function () {
          toast("已发布为全员默认", "ok");
          load();
        }).catch(function (e) { toast(e.message, "err"); });
      });
    });
    var resetBtn = $("#pg-reset", view);
    if (resetBtn) resetBtn.addEventListener("click", function () {
      confirmDialog("恢复默认", "会删除我的布局，回到公共默认。确定？").then(function (ok) {
        if (!ok) return;
        api("/api/pages/" + key + "/reset", { method: "POST", body: "{}" })
          .then(function () { toast("已恢复公共默认", "ok"); load(); })
          .catch(function (e) { toast(e.message, "err"); });
      });
    });

    try {
      await load();
    } catch (error) {
      viewEl.innerHTML = emptyHtml(error.message || "加载失败");
    }
  }

  // ---------------------------------------------------------------- 人工作业量（按作业日期，拣/复分开）
  async function pageLabor(view) {
    var canEdit = has("action.dashboard.edit");
    var canArchive = has("action.labor.archive");
    var canAdjust = has("action.labor.adjust");
    state.boardMode = "live";
    view.dataset.mode = "live";
    view.innerHTML =
      '<div class="page-head"><div><div class="page-title">人工作业量</div>' +
      '<div class="page-sub">按作业日期统计：拣货/复核分开计数；人效 = 行数 ÷ 有效作业工时（相邻作业间隔累计，自动扣除休息时段）</div></div>' +
      '<div class="toolbar">' +
        '<button class="btn btn-sm btn-primary" data-mode="live">实时</button>' +
        '<button class="btn btn-sm" data-mode="archive">存档</button>' +
        (canArchive ? '<button class="btn" id="lb-archive" style="margin-left:6px">存档本日</button>' : "") +
        (has("action.labor.settings") ? '<button class="btn" id="lb-settings">作业设置</button>' : "") +
        (canEdit ? '<button class="btn" id="lb-edit">编辑布局</button>' : "") +
        '<button class="btn" id="lb-refresh">刷新</button>' +
      "</div></div>" +
      '<div id="lb-hint"></div>' +
      '<div id="lb-canvas"></div>' +
      '<div id="lb-panel"></div>';

    var canvas = $("#lb-canvas", view);

    async function loadCanvas() {
      var info = await api("/api/pages/labor");
      state.boardMode = view.dataset.mode || "live";
      canvas.innerHTML = "";
      DashGrid(canvas, {
        cols: 12,
        rowHeight: 64,
        editable: false,
        layout: (info.layout && info.layout.widgets) || [],
        confirmRemove: false,
        renderWidget: function (widget, body) { renderWidgetBody(widget, body); }
      });
    }

    function pctOr(value) {
      return value === null || value === undefined ? "-" : num(value, 1);
    }

    async function loadPanel() {
      var mode = view.dataset.mode || "live";
      var data = await api("/api/labor?date=" + encodeURIComponent(state.date) + "&mode=" + mode);
      var totals = data.totals || {};
      $("#lb-hint", view).innerHTML =
        '<div class="panel" style="margin-bottom:10px"><div class="panel-body small">' +
        "作业日期 <b>" + esc(data.date) + "</b> · 拣货 <b>" + num(totals.pick_rows) + "</b> 行 / " +
        num(totals.pick_hours, 1) + "h → 人效 <b>" + pctOr(totals.pick_rate) + "</b> 行/小时 · 复核 <b>" +
        num(totals.check_rows) + "</b> 行 / " + num(totals.check_hours, 1) + "h → 人效 <b>" +
        pctOr(totals.check_rate) + "</b> 行/小时" +
        (mode === "archive"
          ? (data.archived_at
            ? " · 已存档 " + esc(data.archived_at) + "（" + (data.archived_rows || 0) + " 条）"
            : " · 该作业日期还没有存档")
          : "") +
        " · 间隔阈值 " + (data.gap_minutes || 30) + " 分 · 休息 " + (data.break_count || 0) + " 段" +
        "</div></div>";

      var box = $("#lb-panel", view);
      var rows = data.rows || [];
      var adjustMap = data.adjustments || {};
      if (!rows.length) {
        box.innerHTML = '<div class="panel"><div class="panel-body small muted">' +
          (mode === "archive"
            ? "该作业日期还没有人效存档"
            : "该作业日期没有人员作业数据（人员字段从 2026-11-03 起采集）") + "</div></div>";
        return;
      }
      var head = "<th>人员</th><th class=\"num\">拣货行</th><th class=\"num\">拣货小时</th>" +
        "<th class=\"num\">拣货人效</th><th class=\"num\">复核行</th><th class=\"num\">复核小时</th>" +
        "<th class=\"num\">复核人效</th>" +
        (mode === "live" && canAdjust ? "<th>校正（拣货/复核 小时）</th>" : "");
      var body = rows.map(function (row) {
        var pickAdj = adjustMap[row.person + "|pick"];
        var checkAdj = adjustMap[row.person + "|check"] ||
          adjustMap[row.person + "|all"];
        var adjustCell = "";
        if (mode === "live" && canAdjust) {
          adjustCell = '<td class="nowrap">' +
            '<input class="input" style="width:64px;height:24px" data-hours data-role="pick" value="' +
            (row.pick_adjusted === null || row.pick_adjusted === undefined ? "" : num(row.pick_adjusted, 2)) +
            '" placeholder="' + num(row.pick_hours, 2) + '">' +
            ' <input class="input" style="width:64px;height:24px" data-hours data-role="check" value="' +
            (row.check_adjusted === null || row.check_adjusted === undefined ? "" : num(row.check_adjusted, 2)) +
            '" placeholder="' + num(row.check_hours, 2) + '">' +
            ' <button class="btn btn-sm btn-primary" data-save>保存</button>' +
            ' <button class="btn btn-sm btn-ghost" data-clear>恢复自动</button></td>';
        }
        return '<tr data-person="' + esc(row.person) + '"><td>' + esc(row.person) +
          (pickAdj || checkAdj ? ' <span class="badge warn">已校正</span>' : "") + "</td>" +
          '<td class="num">' + row.pick_rows + '</td><td class="num">' + num(row.pick_hours, 2) + "</td>" +
          '<td class="num">' + pctOr(row.pick_rate) + '</td>' +
          '<td class="num">' + row.check_rows + '</td><td class="num">' + num(row.check_hours, 2) + "</td>" +
          '<td class="num">' + pctOr(row.check_rate) + "</td>" + adjustCell + "</tr>";
      }).join("");
      box.innerHTML = '<div class="panel"><div class="panel-head"><div class="panel-title">人员明细与工时校正</div>' +
        '<div class="panel-sub">工时默认 = 该工种当天有作业的小时数；可手工改成实际工时</div></div>' +
        '<div class="panel-body flush"><div class="table-wrap" style="max-height:460px"><table class="tbl"><thead><tr>' +
        head + "</tr></thead><tbody>" + body + "</tbody></table></div></div></div>";

      if (mode === "live" && canAdjust) {
        $$("tr[data-person]", box).forEach(function (tr) {
          var person = tr.getAttribute("data-person");
          var save = $("[data-save]", tr);
          var clear = $("[data-clear]", tr);
          function put(role, hours) {
            return api("/api/labor/adjust", {
              method: "PUT",
              body: JSON.stringify({ date: state.date, person: person, role: role, hours: hours })
            }).then(function () {
              toast("已保存 " + person + " 的工时", "ok");
              loadPanel();
            }).catch(function (e) { toast(e.message, "err"); });
          }
          if (save) save.addEventListener("click", function () {
            var pickInput = $('[data-role="pick"]', tr);
            var checkInput = $('[data-role="check"]', tr);
            var jobs = [];
            if (pickInput && pickInput.value.trim() !== "") {
              jobs.push(put("pick", parseFloat(pickInput.value)));
            } else if (pickInput) {
              jobs.push(api("/api/labor/adjust", {
                method: "PUT",
                body: JSON.stringify({ date: state.date, person: person, role: "pick", hours: null })
              }));
            }
            if (checkInput && checkInput.value.trim() !== "") {
              jobs.push(put("check", parseFloat(checkInput.value)));
            } else if (checkInput) {
              jobs.push(api("/api/labor/adjust", {
                method: "PUT",
                body: JSON.stringify({ date: state.date, person: person, role: "check", hours: null })
              }));
            }
            Promise.all(jobs).then(function () { loadPanel(); })
              .catch(function (e) { toast(e.message, "err"); });
          });
          if (clear) clear.addEventListener("click", function () {
            Promise.all([
              api("/api/labor/adjust", { method: "PUT", body: JSON.stringify({ date: state.date, person: person, role: "pick", hours: null }) }),
              api("/api/labor/adjust", { method: "PUT", body: JSON.stringify({ date: state.date, person: person, role: "check", hours: null }) })
            ]).then(function () { toast("已恢复自动工时", "ok"); loadPanel(); })
              .catch(function (e) { toast(e.message, "err"); });
          });
        });
      }
    }

    function switchMode(mode) {
      view.dataset.mode = mode;
      state.boardMode = mode;
      $$("[data-mode]", view).forEach(function (button) {
        button.classList.toggle("btn-primary", button.getAttribute("data-mode") === mode);
      });
      loadCanvas().then(loadPanel).catch(function (e) { toast(e.message, "err"); });
    }

    $$("[data-mode]", view).forEach(function (button) {
      button.addEventListener("click", function () { switchMode(button.getAttribute("data-mode")); });
    });
    $("#lb-refresh", view).addEventListener("click", function () {
      loadCanvas().then(loadPanel).catch(function (e) { toast(e.message, "err"); });
    });
    $("#lb-edit", view) && $("#lb-edit").addEventListener("click", function () {
      location.hash = "#/board/page/labor";
    });
    $("#lb-settings", view) && $("#lb-settings").addEventListener("click", function () {
      openLaborSettings(function () {
        loadCanvas().then(loadPanel).catch(function (e) { toast(e.message, "err"); });
      });
    });
    $("#lb-archive", view) && $("#lb-archive").addEventListener("click", function () {
      api("/api/labor?date=" + encodeURIComponent(state.date)).then(function (data) {
        var force = data.archived;
        confirmDialog(force ? "重新存档" : "存档本日",
          force ? "会用当前数据覆盖 " + state.date + " 的人效存档（留审计）。确定？"
            : "把 " + state.date + " 的人工作业量按作业日期存档。确定？",
          force ? "覆盖存档" : "存档").then(function (ok) {
          if (!ok) return;
          api("/api/labor/archive", {
            method: "POST",
            body: JSON.stringify({ date: state.date, force: force })
          }).then(function (result) {
            toast("已存档 " + result.count + " 条人效记录", "ok");
            switchMode("archive");
          }).catch(function (e) { toast(e.message, "err"); });
        });
      }).catch(function (e) { toast(e.message, "err"); });
    });

    try {
      await loadCanvas();
      await loadPanel();
    } catch (error) {
      toast(error.message, "err");
    }
  }

  // 作业设置：相邻作业间隔阈值 + 全局休息时段（影响人效工时）
  async function openLaborSettings(onSaved) {
    var data;
    try {
      data = await api("/api/labor/settings");
    } catch (error) {
      toast(error.message, "err");
      return;
    }
    if (!data.can_edit) { toast("没有修改作业设置的权限", "err"); return; }
    var rows = (data.breaks || []).map(function (item) { return item; });
    var m = modal({
      title: "作业设置 · 人效工时口径",
      body:
        '<div class="field"><label>相邻作业间隔阈值（分钟）</label>' +
        '<input class="input" id="ls-gap" type="number" min="1" max="240" value="' + (data.gap_minutes || 30) + '">' +
        '<div class="small muted">两次作业间隔 ≤ 阈值才计入工时；超过视为休息不计。默认 30 分钟。</div></div>' +
        '<div class="field"><label>休息时段（每天适用，可多条）</label>' +
        '<div id="ls-rows"></div>' +
        '<button class="btn btn-sm" id="ls-add">+ 添加休息时段</button>' +
        '<div class="small muted" style="margin-top:4px">这些人效计算时会从有效工时里扣除（例如午休 12:00-13:00）。</div></div>' +
        '<div class="field"><label>历史归档</label>' +
        '<button class="btn btn-sm" id="ls-rearchive">按新口径重新存档全部日期</button>' +
        '<div class="small muted" style="margin-top:4px">已经存档的日期不会自动重算，点这里覆盖（会写审计）。</div></div>',
      footer: '<button class="btn" data-cancel>取消</button><button class="btn btn-primary" data-ok>保存并生效</button>'
    });
    var rowsBox = $("#ls-rows", m.el);

    function renderRows() {
      rowsBox.innerHTML = rows.map(function (item, index) {
        return '<div class="ls-row" data-index="' + index + '" style="display:flex;gap:6px;align-items:center;margin-bottom:6px">' +
          '<input class="input" data-k="start" style="width:80px" placeholder="12:00" value="' + esc(item.start || "") + '">' +
          '<span>—</span>' +
          '<input class="input" data-k="end" style="width:80px" placeholder="13:00" value="' + esc(item.end || "") + '">' +
          '<label class="small"><input type="checkbox" data-k="enabled" ' + (item.enabled ? "checked" : "") + '> 启用</label>' +
          '<input class="input" data-k="note" style="flex:1" placeholder="备注（如 午休）" value="' + esc(item.note || "") + '">' +
          '<button class="btn btn-sm btn-danger" data-del>删除</button></div>';
      }).join("") || '<div class="small muted">还没有休息时段</div>';
      $$(".ls-row", rowsBox).forEach(function (rowEl) {
        var index = parseInt(rowEl.getAttribute("data-index"), 10);
        $$("[data-k]", rowEl).forEach(function (input) {
          input.addEventListener("input", function () {
            var key = input.getAttribute("data-k");
            if (key === "enabled") rows[index].enabled = input.checked;
            else if (key === "note") rows[index].note = input.value;
            else rows[index][key] = input.value;
          });
        });
        var del = $("[data-del]", rowEl);
        if (del) del.addEventListener("click", function () { rows.splice(index, 1); renderRows(); });
      });
    }
    renderRows();
    $("#ls-add", m.el).addEventListener("click", function () {
      rows.push({ start: "17:30", end: "18:00", enabled: true, note: "" });
      renderRows();
    });
    $("#ls-rearchive", m.el).addEventListener("click", function () {
      confirmDialog("重新存档全部日期", "会按当前口径重算所有人效存档，确定？").then(function (ok) {
        if (!ok) return;
        api("/api/labor/rearchive", { method: "POST", body: "{}" }).then(function (result) {
          toast("已重新存档 " + (result.dates || []).length + " 个日期", "ok");
        }).catch(function (e) { toast(e.message, "err"); });
      });
    });
    $("[data-cancel]", m.el).addEventListener("click", m.close);
    $("[data-ok]", m.el).addEventListener("click", function () {
      var payload = {
        gap_minutes: parseInt($("#ls-gap", m.el).value, 10) || 30,
        breaks: rows.map(function (item) {
          return {
            start: (item.start || "").trim(),
            end: (item.end || "").trim(),
            enabled: item.enabled !== false,
            note: item.note || ""
          };
        })
      };
      api("/api/labor/settings", { method: "PUT", body: JSON.stringify(payload) })
        .then(function () {
          m.close();
          toast("已保存，人效按新口径计算", "ok");
          if (typeof onSaved === "function") onSaved();
        }).catch(function (e) { toast(e.message, "err"); });
    });
  }

  // ---------------------------------------------------------------- 看板总台
  function miniPreview(layout) {
    var widgets = (layout && layout.widgets) || [];
    if (!widgets.length) return '<div class="hub-mini"><div class="hub-mini-empty">空看板</div></div>';
    var rows = 0;
    widgets.forEach(function (w) { rows = Math.max(rows, (w.y || 0) + (w.h || 3)); });
    rows = Math.max(rows, 6);
    var cells = widgets.slice(0, 40).map(function (w) {
      var x = ((w.x || 0) / 12) * 100;
      var y = ((w.y || 0) / rows) * 100;
      var wd = ((w.w || 3) / 12) * 100;
      var ht = ((w.h || 3) / rows) * 100;
      return '<span class="hub-cell" style="left:' + x + "%;top:" + y + "%;width:" + wd +
        "%;height:" + ht + '%"></span>';
    }).join("");
    return '<div class="hub-mini">' + cells + "</div>";
  }

  function hubCard(item, screenItems) {
    var isPage = item.kind === "page";
    var target = isPage ? "page/" + item.key : "dash/" + item.id;
    var inScreen = screenItems.indexOf(isPage ? item.key : "dash:" + item.id) >= 0;
    var badges = [];
    if (isPage) badges.push('<span class="badge ok">导航页</span>');
    else if (item.is_public) badges.push('<span class="badge ok">公共专题</span>');
    else badges.push('<span class="badge">我的专题</span>');
    badges.push('<span class="badge">' + item.widgets + " 个组件</span>");
    var versionText = isPage
      ? (item.source === "personal"
        ? "我的 v" + item.personal_version + " / 公共 v" + item.public_version
        : "公共 v" + item.public_version)
      : "v" + item.version;
    var actions = [
      '<button class="btn btn-sm btn-primary" data-act="edit" data-target="' + target + '">编辑</button>'
    ];
    if (isPage || item.is_public) {
      actions.push('<button class="btn btn-sm" data-act="publish" data-target="' + target + '">发布</button>');
    }
    actions.push('<button class="btn btn-sm" data-act="copy" data-target="' + target + '">复制</button>');
    if (!isPage && item.editable) {
      actions.push('<button class="btn btn-sm btn-danger" data-act="delete" data-id="' + item.id + '">删除</button>');
    }
    if (isPage && item.personal_version) {
      actions.push('<button class="btn btn-sm btn-ghost" data-act="reset" data-key="' + item.key + '">恢复默认</button>');
    }
    if (has("action.screen.config")) {
      actions.push('<button class="btn btn-sm btn-ghost" data-act="screen" data-id="' +
        (isPage ? item.key : "dash:" + item.id) + '">' + (inScreen ? "移出大屏" : "加入大屏") + "</button>");
    }
    return '<div class="hub-card">' +
      '<div class="hub-card-head"><span class="hub-name">' + esc(item.name) + "</span></div>" +
      '<div class="hub-badges">' + badges.join(" ") + '<span class="hub-ver">' + esc(versionText) + "</span></div>" +
      miniPreview(item.layout) +
      '<div class="hub-actions">' + actions.join(" ") + "</div></div>";
  }

  async function renderBoardHub(view) {
    view.innerHTML =
      '<div class="page-head"><div><div class="page-title">看板总台</div>' +
      '<div class="page-sub">管理各导航页看板与专题看板：点「编辑」改布局，改完「发布」就更新到对应页面</div></div>' +
      '<div class="toolbar">' +
        '<button class="btn btn-primary" id="hub-new">新建专题看板</button>' +
        '<button class="btn" id="hub-refresh">刷新</button>' +
      "</div></div>" +
      '<div id="hub-body"><div class="small muted">加载中…</div></div>';

    async function load() {
      var data = await api("/api/boards");
      var screenItems = (data.screen && data.screen.items) || [];
      var body = $("#hub-body", view);
      body.innerHTML =
        '<div class="panel" style="margin-bottom:14px"><div class="panel-head"><div class="panel-title">导航页看板</div>' +
        '<div class="panel-sub">编辑后发布，所有人打开该页就是新样式</div></div>' +
        '<div class="hub-grid">' +
        (data.pages || []).map(function (item) { return hubCard(item, screenItems); }).join("") +
        "</div></div>" +
        '<div class="panel" style="margin-bottom:14px"><div class="panel-head"><div class="panel-title">固定分析页</div>' +
        '<div class="panel-sub">已改为固定布局，不在总台编辑</div></div>' +
        '<div class="panel-body"><a class="btn" href="#/volume">打开“单量分析”（今日 / 本周 / 本月 / 本季度）</a></div></div>' +
        '<div class="panel"><div class="panel-head"><div class="panel-title">专题看板</div>' +
        '<div class="panel-sub">自由画布，可发布成公共看板或设为大屏播放</div></div>' +
        '<div class="hub-grid">' +
        ((data.dashboards || []).map(function (item) { return hubCard(item, screenItems); }).join("") ||
          '<div class="small muted" style="padding:10px">还没有专题看板，点右上「新建专题看板」</div>') +
        "</div></div>" +
        ((data.orphans || []).length
          ? '<div class="panel" style="margin-top:14px"><div class="panel-head"><div class="panel-title">待清理的孤儿看板</div>' +
            '<div class="panel-sub">' + data.orphans.length + " 个（所属账号已删除）</div></div>" +
            '<div class="panel-body"><button class="btn btn-danger" id="hub-cleanup">全部清理</button></div></div>'
          : "");

      $$("[data-act]", body).forEach(function (button) {
        button.addEventListener("click", function () { act(button, data); });
      });
      var cleanup = $("#hub-cleanup", body);
      if (cleanup) cleanup.addEventListener("click", function () {
        confirmDialog("清理孤儿看板", "会删除所属账号已不存在的看板，确定？").then(function (ok) {
          if (!ok) return;
          api("/api/boards/cleanup", { method: "POST", body: "{}" })
            .then(function (result) { toast("已清理 " + result.deleted.length + " 个", "ok"); load(); })
            .catch(function (e) { toast(e.message, "err"); });
        });
      });
    }

    function act(button, data) {
      var action = button.getAttribute("data-act");
      var target = button.getAttribute("data-target") || "";
      var mode = target.split("/")[0];
      var ref = target.split("/")[1] || "";
      var pageItem = (data.pages || []).filter(function (p) { return "page/" + p.key === target; })[0];
      var dashItem = (data.dashboards || []).filter(function (d) { return "dash/" + d.id === target; })[0];

      function after(okText) {
        return function () { toast(okText, "ok"); load(); };
      }

      if (action === "edit") { location.hash = "#/board/" + target; return; }
      if (action === "publish") {
        var job = pageItem
          ? api("/api/pages/" + pageItem.key, {
              method: "PUT",
              body: JSON.stringify({ target: "public", layout: pageItem.layout })
            })
          : api("/api/dashboards/" + dashItem.id + "/publish", { method: "POST", body: "{}" });
        confirmDialog("发布", "把该看板当前布局发布给所有人？已自建布局的同事保留自己的。").then(function (ok) {
          if (!ok) return;
          job.then(after("已发布")).catch(function (e) { toast(e.message, "err"); });
        });
        return;
      }
      if (action === "copy") {
        if (pageItem) {
          api("/api/boards/from-page", {
            method: "POST",
            body: JSON.stringify({ key: pageItem.key, name: pageItem.name + " 专题" })
          }).then(after("已复制为专题看板")).catch(function (e) { toast(e.message, "err"); });
        } else if (dashItem) {
          api("/api/dashboards", {
            method: "POST",
            body: JSON.stringify({ name: dashItem.name + " 副本", layout: dashItem.layout })
          }).then(after("已复制")).catch(function (e) { toast(e.message, "err"); });
        }
        return;
      }
      if (action === "delete") {
        confirmDialog("删除专题看板", "删除后不可恢复，确定？").then(function (ok) {
          if (!ok) return;
          api("/api/dashboards/" + button.getAttribute("data-id"), { method: "DELETE" })
            .then(after("已删除")).catch(function (e) { toast(e.message, "err"); });
        });
        return;
      }
      if (action === "reset") {
        confirmDialog("恢复默认", "删除我的布局，回到公共默认？").then(function (ok) {
          if (!ok) return;
          api("/api/pages/" + button.getAttribute("data-key") + "/reset", { method: "POST", body: "{}" })
            .then(after("已恢复公共默认")).catch(function (e) { toast(e.message, "err"); });
        });
        return;
      }
      if (action === "screen") {
        var id = button.getAttribute("data-id");
        var config = data.screen || { items: [], interval: 15 };
        var items = (config.items || []).slice();
        var at = items.indexOf(id);
        if (at >= 0) items.splice(at, 1); else items.push(id);
        api("/api/screen", {
          method: "PUT",
          body: JSON.stringify({ items: items, interval: config.interval, sound: config.sound })
        }).then(after(at >= 0 ? "已移出大屏" : "已加入大屏")).catch(function (e) { toast(e.message, "err"); });
      }
    }

    $("#hub-new", view).addEventListener("click", function () {
      var m = modal({
        title: "新建专题看板",
        body: '<div class="field"><label>名称</label><input class="input" id="hub-new-name" placeholder="例如：承运商专题"></div>',
        footer: '<button class="btn" data-cancel>取消</button><button class="btn btn-primary" data-ok>创建并编辑</button>'
      });
      $("[data-cancel]", m.el).addEventListener("click", m.close);
      $("[data-ok]", m.el).addEventListener("click", function () {
        var name = $("#hub-new-name", m.el).value.trim() || "我的专题看板";
        api("/api/dashboards", {
          method: "POST",
          body: JSON.stringify({ name: name, layout: { widgets: [] } })
        }).then(function (result) {
          m.close();
          location.hash = "#/board/dash/" + result.id;
        }).catch(function (e) { toast(e.message, "err"); });
      });
    });
    $("#hub-refresh", view).addEventListener("click", function () { load(); });

    try {
      await load();
    } catch (error) {
      $("#hub-body", view).innerHTML = emptyHtml(error.message || "加载失败");
    }
  }

  // ---------------------------------------------------------------- 看板编辑器（总台进入）
  async function renderBoardEditor(view, kind, ref) {
    if (!window.DashGrid) {
      view.innerHTML = emptyHtml("grid.js 未加载，无法编辑看板");
      return;
    }
    var target;
    try {
      if (kind === "page") {
        var page = await api("/api/pages/" + ref);
        target = {
          kind: "page", key: ref, name: page.name, layout: page.layout,
          source: page.source, canEdit: page.can_edit, canPublish: page.can_publish
        };
      } else {
        var dash = await api("/api/dashboards/" + ref);
        target = {
          kind: "dash", id: dash.id, name: dash.name, layout: dash.layout,
          source: dash.editable ? "mine" : "shared",
          canEdit: dash.editable && has("action.dashboard.edit"),
          canPublish: dash.can_publish && has("action.dashboard.publish")
        };
      }
    } catch (error) {
      view.innerHTML = emptyHtml(error.message || "加载失败");
      return;
    }

    view.innerHTML =
      '<div class="page-head"><div><div class="page-title">' + esc(target.name) + "</div>" +
      '<div class="page-sub">' + (target.kind === "page" ? "导航页看板" : "专题看板") +
      " · 拖动标题移动、拖右下角改大小、点 ⚙ 改数据；保存后点「发布」更新到对应看板</div></div>" +
      '<div class="toolbar">' +
        '<button class="btn" id="be-back">返回总台</button>' +
        (target.canEdit
          ? '<button class="btn" id="be-undo" disabled title="Ctrl+Z">撤销</button>' +
            '<button class="btn" id="be-redo" disabled title="Ctrl+Shift+Z">重做</button>' +
            '<button class="btn" id="be-tidy" title="把所有组件往上紧凑排列">整理布局</button>'
          : "") +
        '<span class="small muted" id="be-state"></span>' +
        '<button class="btn" id="be-open">打开页面</button>' +
        (target.canPublish ? '<button class="btn btn-primary" id="be-publish">发布</button>' : "") +
      "</div></div>" +
      '<div class="palette" id="be-palette"></div>' +
      '<div id="be-canvas"></div>';

    var palette = $("#be-palette", view);
    var types = [
      ["kpi", "KPI 卡"], ["bar", "柱状图"], ["line", "折线图"], ["pie", "饼/环图"],
      ["funnel", "漏斗"], ["table", "表格"], ["alert", "预警清单"],
      ["progress", "进度条"], ["text", "文本"]
    ];
    palette.innerHTML = target.canEdit
      ? '<button class="btn btn-sm btn-primary" id="be-add-template">+ 从模板添加</button>' +
        '<span class="small muted" style="align-self:center;margin:0 4px">或按类型：</span>' +
        types.filter(function (t) { return has("widget." + t[0]); }).map(function (t) {
          return '<button class="btn btn-sm" data-add="' + t[0] + '">+ ' + t[1] + "</button>";
        }).join("")
      : "";

    var layout = { widgets: (target.layout && target.layout.widgets || []).slice() };
    var saveTimer = null;
    var grid = DashGrid($("#be-canvas", view), {
      cols: 12,
      rowHeight: 56,
      editable: target.canEdit,
      autoLayout: false,
      layout: layout.widgets,
      onReject: function () {
        toast("该位置已被占用：换个空位，或点「整理布局」自动排列", "err");
      },
      renderWidget: function (widget, body) {
        renderWidgetBody(widget, body, {
          editable: true,
          onSpecChange: function (spec) {
            if (grid.updateWidget) grid.updateWidget(widget.id, { spec: spec });
            sync();
            save();
          }
        });
      },
      onConfigure: function (widget) {
        openWidgetConfig(widget, function (updated) {
          if (grid.updateWidget) grid.updateWidget(updated.id, { title: updated.title, spec: updated.spec });
          sync();
          save();
        });
      },
      onRemove: function () { sync(); save(); },
      onDuplicate: function () { sync(); save(); },
      confirmRemove: function (widget) {
        confirmDialog("删除组件", "确定删除「" + (widget.title || widget.type) + "」？", "删除").then(function (ok) {
          if (ok && grid) { grid.removeWidget(widget.id); sync(); save(); }
        });
      },
      onChange: function () { sync(); recordHistory(); if (target.canEdit) scheduleSave(); }
    });

    // ---- 撤销 / 重做 / 整理布局（自由摆放模式下不怕拖乱） ----
    var lastSnap = JSON.stringify({ widgets: layout.widgets });
    var undoStack = [];
    var redoStack = [];
    function snapLayout() { return JSON.stringify({ widgets: grid.getLayout() }); }
    function refreshUndoButtons() {
      var u = $("#be-undo", view);
      var r = $("#be-redo", view);
      if (u) u.disabled = !undoStack.length;
      if (r) r.disabled = !redoStack.length;
    }
    function recordHistory() {
      var current = snapLayout();
      if (current === lastSnap) return;
      undoStack.push(lastSnap);
      if (undoStack.length > 50) undoStack.shift();
      redoStack.length = 0;
      lastSnap = current;
      refreshUndoButtons();
    }
    function applySnap(value) {
      var parsed = JSON.parse(value);
      grid.setLayout(parsed.widgets || [], { silent: true });
      lastSnap = value;
      sync();
      save();
      refreshUndoButtons();
    }
    function undo() {
      if (!undoStack.length) return;
      redoStack.push(lastSnap);
      applySnap(undoStack.pop());
    }
    function redo() {
      if (!redoStack.length) return;
      undoStack.push(lastSnap);
      applySnap(redoStack.pop());
    }
    $("#be-undo", view) && $("#be-undo", view).addEventListener("click", undo);
    $("#be-redo", view) && $("#be-redo", view).addEventListener("click", redo);
    $("#be-tidy", view) && $("#be-tidy", view).addEventListener("click", function () {
      if (grid.compactAll()) {
        recordHistory();
        save();
        toast("已整理布局", "ok");
      } else {
        toast("已经是紧凑的，无需整理", "ok");
      }
    });
    state.editing = true;
    if (editorKeyHandler) document.removeEventListener("keydown", editorKeyHandler);
    editorKeyHandler = function (ev) {
      if (!document.querySelector("#be-canvas")) return;
      if (!(ev.ctrlKey || ev.metaKey)) return;
      var key = String(ev.key || "").toLowerCase();
      if (key === "z") {
        ev.preventDefault();
        if (ev.shiftKey) redo(); else undo();
      } else if (key === "y") {
        ev.preventDefault();
        redo();
      }
    };
    document.addEventListener("keydown", editorKeyHandler);
    refreshUndoButtons();

    function sync() { layout = { widgets: grid.getLayout() }; }
    function scheduleSave() {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(save, 700);
    }
    function save() {
      if (!target.canEdit) return;
      var job = target.kind === "page"
        ? api("/api/pages/" + target.key, {
            method: "PUT",
            body: JSON.stringify({ target: "personal", layout: layout })
          })
        : api("/api/dashboards/" + target.id, {
            method: "PUT",
            body: JSON.stringify({ layout: layout })
          });
      job.then(function () {
        var el = $("#be-state", view);
        if (el) el.textContent = "已保存 " + clock();
      }).catch(function (e) { toast(e.message, "err"); });
    }

    var beTemplateBtn = $("#be-add-template", palette);
    if (beTemplateBtn) beTemplateBtn.addEventListener("click", function () {
      openAddWidgetModal(function (widget) {
        grid.addWidget(widget);
        sync();
        save();
      });
    });
    $$("[data-add]", palette).forEach(function (button) {
      button.addEventListener("click", function () {
        var type = button.getAttribute("data-add");
        var spec = { dataset: "orders", metrics: ["rows"], dimension: "route", limit: 10 };
        if (type === "kpi") spec = { dataset: "orders", metrics: ["rows"] };
        if (type === "alert") spec = { dataset: "alerts" };
        if (type === "text") spec = { text: "说明文字" };
        var widget = {
          id: "w" + Date.now().toString(36) + Math.floor(Math.random() * 900 + 100),
          type: type, title: type === "kpi" ? "新指标" : "新组件", spec: spec,
          x: 0, y: 0, w: type === "kpi" ? 3 : 6, h: type === "kpi" ? 3 : 5
        };
        grid.addWidget(widget);
        sync();
        save();
      });
    });

    $("#be-back", view).addEventListener("click", function () { location.hash = "#/dashboard"; });
    $("#be-open", view).addEventListener("click", function () {
      location.hash = target.kind === "page" ? "#/" + target.key : "#/dashboard";
    });
    var publish = $("#be-publish", view);
    if (publish) publish.addEventListener("click", function () {
      confirmDialog("发布为全员默认",
        "会把当前布局发布到" + (target.kind === "page" ? "导航页「" + target.name + "」" : "公共看板") +
        "，已自建布局的同事保留自己的。确定？").then(function (ok) {
        if (!ok) return;
        sync();
        var job = target.kind === "page"
          ? api("/api/pages/" + target.key, {
              method: "PUT",
              body: JSON.stringify({ target: "public", layout: layout })
            })
          : api("/api/dashboards/" + target.id + "/publish", { method: "POST", body: "{}" });
        job.then(function () { toast("已发布", "ok"); })
          .catch(function (e) { toast(e.message, "err"); });
      });
    });
  }

  // ---------------------------------------------------------------- 预警中心
  async function pageAlerts(view) {
    var canManage = has("action.alerts.manage");
    view.innerHTML =
      '<div class="page-head"><div><div class="page-title">预警中心</div>' +
      '<div class="page-sub">按线路设截止时间；临近/超时自动提醒线路负责人（复核完成率 100% 视为完成）</div></div>' +
      '<div class="toolbar"><button class="btn" id="al-read-all">全部已读</button>' +
      '<button class="btn" id="al-refresh">刷新</button></div></div>' +
      '<div class="kpi-row" id="al-kpis" style="margin-bottom:14px"></div>' +
      '<div class="panel" style="margin-bottom:14px"><div class="panel-head">' +
      '<div class="panel-title">我的预警消息</div><div class="panel-sub" id="al-sub"></div></div>' +
      '<div class="panel-body flush" id="al-list"></div></div>' +
      (canManage ? '<div class="panel"><div class="panel-head">' +
        '<div class="panel-title">线路截止时间与负责人</div>' +
        '<div class="panel-sub" id="al-rules"></div></div>' +
        '<div class="panel-body flush" id="al-routes"></div></div>' : "");

    function fmtMinutes(minutes) {
      if (minutes === null || minutes === undefined) return "-";
      var abs = Math.abs(minutes);
      var text = abs >= 60 ? Math.floor(abs / 60) + "h" + (abs % 60) + "m" : abs + "分钟";
      return minutes >= 0 ? "还剩 " + text : "已超 " + text;
    }

    async function loadMessages() {
      var token = state.routeToken;
      var data = await api("/api/alerts?limit=100");
      if (token !== state.routeToken) return;
      setText("#al-sub", "未读 " + (data.unread || 0) + " 条");
      var rows = data.rows || [];
      if (!rows.length) {
        $("#al-list", view).innerHTML = '<div class="panel-body small muted">暂无消息</div>';
        return;
      }
      $("#al-list", view).innerHTML = '<div class="table-wrap"><table class="tbl"><thead><tr>' +
        "<th>时间</th><th>级别</th><th>线路</th><th>内容</th><th>状态</th></tr></thead><tbody>" +
        rows.map(function (row) {
          return "<tr" + (row.read_at ? "" : ' class="unread-row"') + "><td class=\"nowrap\">" +
            esc(row.created_at || "") + '</td><td><span class="badge ' +
            (row.level === "danger" ? "err" : "warn") + '">' +
            (row.level === "danger" ? "超时" : "临近") + "</span></td><td>" + esc(row.route || "") +
            "</td><td>" + esc(row.title || "") + '<div class="small muted">' + esc(row.body || "") +
            "</div></td><td>" + (row.read_at ? "已读" : "未读") + "</td></tr>";
        }).join("") + "</tbody></table></div>";
    }

    async function loadRoutes() {
      if (!canManage) return;
      var token = state.routeToken;
      var data = await api("/api/alerts/routes?date=" + encodeURIComponent(state.date));
      if (token !== state.routeToken) return;
      setText("#al-rules",
        "提前 " + data.lead_minutes + " 分钟提醒；超时后每 " + data.repeat_minutes + " 分钟重复");
      var rows = data.rows || [];
      $("#al-routes", view).innerHTML = '<div class="table-wrap"><table class="tbl"><thead><tr>' +
        "<th>线路</th><th>截止时间</th><th>负责人</th><th class=\"num\">行数</th>" +
        "<th class=\"num\">已复核</th><th>完成率</th><th>状态</th><th>操作</th></tr></thead><tbody>" +
        rows.map(function (row) {
          var owners = (row.owners || []).map(function (o) { return o.display_name || o.username; }).join("、") || "未指定（兜底管理员）";
          var stateText = {
            overdue: '<span class="badge err">已超时</span>',
            due_soon: '<span class="badge warn">临近</span>',
            done: '<span class="badge ok">已完成</span>',
            running: "进行中",
            disabled: "已停用",
            closed: "非当日",
            no_data: "无数据"
          }[row.state] || "-";
          return "<tr data-route=\"" + esc(row.route) + "\"><td>" + esc(row.route) + "</td>" +
            '<td class="nowrap">' + esc(row.deadline || "-") + "</td><td>" + esc(owners) + "</td>" +
            '<td class="num">' + row.lines + '</td><td class="num">' + row.checked + "</td>" +
            "<td>" + normPct(row.rate) + "</td><td>" + stateText + "</td>" +
            '<td><button class="btn btn-sm btn-ghost" data-edit-route="' + esc(row.route) + '">编辑</button></td></tr>';
        }).join("") + "</tbody></table></div>";

      $$("[data-edit-route]", view).forEach(function (button) {
        button.addEventListener("click", function () {
          var route = button.getAttribute("data-edit-route");
          var item = rows.filter(function (r) { return r.route === route; })[0];
          openRouteEditor(route, item, data.users || []);
        });
      });
    }

    function openRouteEditor(route, item, users) {
      var ownerIds = (item.owners || []).map(function (o) { return o.id; });
      var body = '<div class="field"><label>线路</label><div><b>' + esc(route) + "</b></div></div>" +
        '<div class="field"><label>截止时间（HH:MM）</label>' +
        '<input class="input" id="rt-deadline" value="' + esc(item.deadline || "17:00") + '" placeholder="17:00"></div>' +
        '<div class="field"><label>启用预警</label>' +
        '<label class="small"><input type="checkbox" id="rt-enabled" ' + (item.enabled ? "checked" : "") + "> 启用</label></div>" +
        '<div class="field"><label>负责人（可多选）</label><div class="rt-owners">' +
        users.map(function (u) {
          return '<label class="small" style="display:block"><input type="checkbox" value="' + u.id + '" ' +
            (ownerIds.indexOf(u.id) >= 0 ? "checked" : "") + "> " +
            esc(u.display_name || "") + "（" + esc(u.username) + "）</label>";
        }).join("") + "</div></div>";
      var m = modal({
        title: "线路预警设置 · " + route,
        body: body,
        footer: '<button class="btn" data-cancel>取消</button><button class="btn btn-primary" data-ok>保存</button>'
      });
      $("[data-cancel]", m.el).addEventListener("click", m.close);
      $("[data-ok]", m.el).addEventListener("click", function () {
        var owners = $$(".rt-owners input:checked", m.el).map(function (c) { return parseInt(c.value, 10); });
        api("/api/alerts/routes", {
          method: "PUT",
          body: JSON.stringify({
            route: route,
            deadline: $("#rt-deadline", m.el).value.trim(),
            enabled: $("#rt-enabled", m.el).checked,
            owners: owners
          })
        }).then(function () {
          m.close();
          toast("已保存 " + route, "ok");
          loadRoutes();
        }).catch(function (e) { toast(e.message, "err"); });
      });
    }

    function normPct(value) {
      if (value === null || value === undefined) return "-";
      return pct(value);
    }

    async function loadState() {
      var token = state.routeToken;
      var data = await api("/api/alerts/routes?date=" + encodeURIComponent(state.date));
      if (token !== state.routeToken) return;
      var overdue = (data.rows || []).filter(function (r) { return r.state === "overdue"; }).length;
      var soon = (data.rows || []).filter(function (r) { return r.state === "due_soon"; }).length;
      $("#al-kpis", view).innerHTML =
        kpiCard("未读消息", (data.unread || 0), "条", "点右上铃铛查看明细", null) +
        kpiCard("超时线路", overdue, "条", "已完成复核的不计入", null) +
        kpiCard("临近截止", soon, "条", "距截止 ≤ 30 分钟", null);
    }

    $("#al-refresh", view).addEventListener("click", function () {
      loadMessages().then(loadState).then(loadRoutes).catch(function (e) { toast(e.message, "err"); });
    });
    $("#al-read-all", view).addEventListener("click", function () {
      api("/api/alerts/read", { method: "POST", body: JSON.stringify({ all: true }) })
        .then(function () { updateBell(); loadMessages(); loadState(); })
        .catch(function (e) { toast(e.message, "err"); });
    });

    try {
      await loadState();
      await loadMessages();
      await loadRoutes();
    } catch (error) {
      toast(error.message, "err");
    }
  }

  // ---------------------------------------------------------------- 大屏模式
  var screenState = { items: [], slides: [], index: 0, timer: null, paused: false, sound: false, overdueSeen: 0, date: null };

  function beep() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      var ctx = beep._ctx || (beep._ctx = new Ctx());
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = 880;
      gain.gain.value = 0.08;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.35);
    } catch (ignored) { /* 静默 */ }
  }

  async function renderScreen(view) {
    document.body.classList.add("screen-mode");
    view.innerHTML =
      '<div class="screen-head">' +
        '<div class="screen-title" id="sc-title">单量与作业进度看板</div>' +
        '<div class="screen-banner" id="sc-banner"></div>' +
        '<div class="screen-right">' +
          '<span id="sc-date" class="screen-meta"></span>' +
          '<span id="sc-clock" class="screen-meta">--:--:--</span>' +
          '<button class="btn btn-sm" id="sc-sound">启用声音</button>' +
          '<button class="btn btn-sm" id="sc-pause">暂停</button>' +
          '<button class="btn btn-sm" id="sc-exit">退出</button>' +
        "</div>" +
      "</div>" +
      '<div class="screen-body" id="sc-body"></div>' +
      '<div class="screen-dots" id="sc-dots"></div>';

    var body = $("#sc-body", view);
    var dots = $("#sc-dots", view);

    function tickClock() {
      var el = $("#sc-clock", view);
      if (el) el.textContent = clock(true);
    }
    tickClock();
    var clockTimer = setInterval(tickClock, 1000);
    var screenRefreshTimer = null;

    var SCREEN_GAP = 12;
    var SCREEN_BASE_ROW = 92;

    function screenMetrics() {
      var cs = getComputedStyle(body);
      var padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
      var height = (body.clientHeight || (window.innerHeight - 56)) - padY;
      var maxRows = Math.max(4, Math.floor((height - 2 * SCREEN_GAP - 12) / (SCREEN_BASE_ROW + SCREEN_GAP)));
      return { height: height, maxRows: maxRows };
    }

    // 大屏把 KPI 卡从 3 行压到 2 行，并把 KPI 行下方的组件整体上移
    function compactScreenWidgets(widgets) {
      var kpiRows = {};
      (widgets || []).forEach(function (w) {
        if (w.type !== "kpi") return;
        var y = Math.max(0, Number(w.y) || 0);
        var h = Math.max(1, Number(w.h) || 3);
        if (!kpiRows[y] || kpiRows[y] < h) kpiRows[y] = h;
      });
      var tops = Object.keys(kpiRows).map(Number).sort(function (a, b) { return a - b; });
      function shiftFor(y) {
        var shift = 0;
        tops.forEach(function (top) {
          if (top + kpiRows[top] <= y) shift += Math.max(0, kpiRows[top] - 2);
        });
        return shift;
      }
      return (widgets || []).map(function (w) {
        var copy = JSON.parse(JSON.stringify(w));
        var y = Math.max(0, Number(copy.y) || 0);
        copy.y = Math.max(0, y - shiftFor(y));
        if (copy.type === "kpi") copy.h = Math.min(Math.max(1, Number(copy.h) || 3), 2);
        return copy;
      });
    }

    // 按行分页：整块组件不切半；所有组件至少出现一次
    function paginateScreenWidgets(widgets, maxRows) {
      var sorted = (widgets || []).slice().sort(function (a, b) {
        return (Number(a.y) || 0) - (Number(b.y) || 0) || (Number(a.x) || 0) - (Number(b.x) || 0);
      });
      var pages = [];
      var current = [];
      var start = 0;
      var bottom = 0;
      function flush() {
        if (!current.length) return;
        var maxBottom = 0;
        current.forEach(function (w) { maxBottom = Math.max(maxBottom, w.y + w.h); });
        pages.push({ widgets: current, rows: Math.max(1, maxBottom) });
        current = [];
      }
      sorted.forEach(function (w) {
        var y = Math.max(0, Number(w.y) || 0);
        var h = Math.max(1, Number(w.h) || 1);
        if (!current.length) {
          start = y;
          bottom = y + h;
        } else if (Math.max(bottom, y + h) - start > maxRows) {
          flush(); start = y; bottom = y + h;
        } else {
          bottom = Math.max(bottom, y + h);
        }
        var copy = JSON.parse(JSON.stringify(w));
        copy.y = y - start;
        current.push(copy);
        bottom = Math.max(bottom, y + h);
      });
      flush();
      return pages;
    }

    function buildScreenSlides() {
      var metrics = screenMetrics();
      var slides = [];
      (screenState.items || []).forEach(function (item) {
        var compacted = compactScreenWidgets((item.layout && item.layout.widgets) || []);
        var pages = paginateScreenWidgets(compacted, metrics.maxRows);
        pages.forEach(function (page, index) {
          var rows = Math.max(3, page.rows || 3);
          var rowHeight = Math.max(92, Math.min(140,
            Math.floor((metrics.height - SCREEN_GAP * (rows + 1) - 8) / rows)));
          slides.push({
            key: item.id,
            title: item.title,
            layout: { widgets: page.widgets },
            rows: rows,
            rowHeight: rowHeight,
            pageText: pages.length > 1 ? " · 第 " + (index + 1) + "/" + pages.length + " 页" : ""
          });
        });
      });
      return slides;
    }

    function renderDots() {
      dots.innerHTML = screenState.slides.map(function (item, index) {
        return '<span class="sc-dot' + (index === screenState.index ? " active" : "") +
          '" data-go="' + index + '"></span>';
      }).join("");
      $$("[data-go]", dots).forEach(function (dot) {
        dot.addEventListener("click", function () {
          goTo(parseInt(dot.getAttribute("data-go"), 10));
        });
      });
    }

    function renderBanner(state) {
      var banner = $("#sc-banner", view);
      if (!banner) return;
      var overdue = (state && state.overdue) || [];
      var soon = (state && state.due_soon) || [];
      var text = "";
      if (overdue.length) {
        text = "⚠ 超时未完成：" + overdue.map(function (item) {
          return item.route + "（剩 " + item.remaining + " 行，" + pct(item.rate) + "）";
        }).join("　·　");
      } else if (soon.length) {
        text = "临近截止：" + soon.map(function (item) {
          return item.route + "（剩 " + item.remaining + " 行）";
        }).join("　·　");
      }
      banner.className = "screen-banner " + (overdue.length ? "danger" : soon.length ? "warn" : "");
      banner.innerHTML = text ? '<div class="marquee"><span>' + esc(text) + "</span></div>" : "";
      if (overdue.length > screenState.overdueSeen && screenState.sound) {
        beep();
      }
      screenState.overdueSeen = overdue.length;
    }

    function mountItem() {
      var slide = screenState.slides[screenState.index];
      if (!slide) {
        body.innerHTML = emptyHtml("大屏还没有可播放的看板，请先到「大屏设置」勾选");
        return;
      }
      setText("#sc-title", slide.title + (slide.pageText || ""));
      body.innerHTML = "";
      var host = document.createElement("div");
      host.className = "screen-page-host";
      body.appendChild(host);
      var containerHeight = slide.rows * (slide.rowHeight + SCREEN_GAP) + SCREEN_GAP;
      var cs = getComputedStyle(body);
      var padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
      var spare = (body.clientHeight || window.innerHeight) - padY - containerHeight;
      host.style.marginTop = spare > 8 ? Math.floor(spare / 2) + "px" : "0px";
      DashGrid(host, {
        cols: 12,
        rowHeight: slide.rowHeight,
        editable: false,
        layout: slide.layout.widgets || [],
        confirmRemove: false,
        renderWidget: function (widget, body) {
          drawWidget(body, widget.type, widget.spec);
        }
      });
      body.scrollTop = 0;
    }

    function goTo(index) {
      var total = screenState.slides.length;
      if (!total) return;
      screenState.index = ((index % total) + total) % total;
      renderDots();
      mountItem();
    }

    function startTimer(interval) {
      clearInterval(screenState.timer);
      screenState.timer = setInterval(function () {
        if (!screenState.paused) goTo(screenState.index + 1);
      }, Math.max(5, interval) * 1000);
    }

    async function loadData() {
      var token = state.routeToken;
      var data = await api("/api/screen/data");
      if (token !== state.routeToken) return;
      screenState.items = data.items || [];
      screenState.date = data.date || state.date;
      setText("#sc-date", "业务日期 " + (screenState.date || ""));
      renderBanner(data.state);
      screenState.slides = buildScreenSlides();
      if (!screenState.slides.length) {
        body.innerHTML = emptyHtml("大屏还没有可播放的看板，请先到「大屏设置」勾选");
      } else {
        if (screenState.index >= screenState.slides.length) screenState.index = 0;
        renderDots();
        mountItem();
      }
      startTimer(data.interval || 15);
      if (data.sound) {
        // 浏览器要求交互后才能播放声音，保持静音直到用户点击
      }
    }

    $("#sc-sound", view).addEventListener("click", function () {
      screenState.sound = !screenState.sound;
      this.textContent = screenState.sound ? "声音开" : "启用声音";
      if (screenState.sound) beep();
    });
    $("#sc-pause", view).addEventListener("click", function () {
      screenState.paused = !screenState.paused;
      this.textContent = screenState.paused ? "继续" : "暂停";
    });
    $("#sc-exit", view).addEventListener("click", function () {
      document.body.classList.remove("screen-mode");
      location.hash = "#/overview";
    });

    // 大屏设置（需要 action.screen.config）
    function openScreenConfig(data, reload) {
      var checked = {};
      (data.config.items || []).forEach(function (id) { checked[id] = true; });
      var body = '<div class="field"><label>播放清单（顺序按列表）</label><div class="screen-pick">' +
        data.available.map(function (item) {
          return '<label class="small" style="display:block"><input type="checkbox" value="' +
            esc(item.id) + '" ' + (checked[item.id] ? "checked" : "") + "> " + esc(item.title) + "</label>";
        }).join("") + "</div></div>" +
        '<div class="field"><label>每页停留秒数</label>' +
        '<input class="input" id="sc-interval" type="number" min="5" max="300" value="' +
        (data.config.interval || 15) + '"></div>' +
        '<div class="field"><label><input type="checkbox" id="sc-sound-cfg" ' +
        (data.config.sound ? "checked" : "") + '> 出现新的超时线路时提示音</label></div>';
      var m = modal({
        title: "大屏设置",
        body: body,
        footer: '<button class="btn" data-cancel>取消</button><button class="btn btn-primary" data-ok>保存</button>'
      });
      $("[data-cancel]", m.el).addEventListener("click", m.close);
      $("[data-ok]", m.el).addEventListener("click", function () {
        var items = $$(".screen-pick input:checked", m.el).map(function (c) { return c.value; });
        api("/api/screen", {
          method: "PUT",
          body: JSON.stringify({
            items: items,
            interval: parseInt($("#sc-interval", m.el).value, 10) || 15,
            sound: $("#sc-sound-cfg", m.el).checked
          })
        }).then(function () {
          m.close();
          toast("大屏设置已保存", "ok");
          reload();
        }).catch(function (e) { toast(e.message, "err"); });
      });
    }

    api("/api/screen").then(function (data) {
      if (!data.can_config) return;
      var right = $(".screen-right", view);
      if (!right) return;
      var button = document.createElement("button");
      button.className = "btn btn-sm";
      button.id = "sc-config";
      button.textContent = "设置";
      right.insertBefore(button, $("#sc-sound", view));
      button.addEventListener("click", function () { openScreenConfig(data, loadData); });
    }).catch(function () { /* 忽略 */ });
    function onKey(event) {
      if (event.key === "Escape") { document.body.classList.remove("screen-mode"); location.hash = "#/overview"; }
      else if (event.key === "ArrowRight") goTo(screenState.index + 1);
      else if (event.key === "ArrowLeft") goTo(screenState.index - 1);
      else if (event.code === "Space") { event.preventDefault(); screenState.paused = !screenState.paused; }
    }
    document.addEventListener("keydown", onKey);
    var screenResizeTimer = null;
    function onScreenResize() {
      clearTimeout(screenResizeTimer);
      screenResizeTimer = setTimeout(function () {
        if (!document.querySelector("#sc-body")) return;
        screenState.slides = buildScreenSlides();
        if (!screenState.slides.length) {
          body.innerHTML = emptyHtml("大屏还没有可播放的看板，请先到「大屏设置」勾选");
          return;
        }
        if (screenState.index >= screenState.slides.length) screenState.index = 0;
        renderDots();
        mountItem();
      }, 250);
    }
    window.addEventListener("resize", onScreenResize);
    // 离开页面时清理
    var lastHash = location.hash;
    var cleanupTimer = setInterval(function () {
      if (location.hash !== lastHash && location.hash !== "#/screen") {
        clearInterval(cleanupTimer);
        clearInterval(clockTimer);
        clearInterval(screenState.timer);
        clearInterval(screenRefreshTimer);
        clearTimeout(screenResizeTimer);
        window.removeEventListener("resize", onScreenResize);
        document.removeEventListener("keydown", onKey);
        document.body.classList.remove("screen-mode");
      }
    }, 1000);

    try {
      await loadData();
    } catch (error) {
      body.innerHTML = emptyHtml(error.message || "大屏加载失败");
    }
    screenRefreshTimer = setInterval(loadData, 60000);
  }

  // ---------------------------------------------------------------- 组件绘制
  async function fetchWidget(type, spec) {
    var widgetDate = state.date;
    if (document.body.classList.contains("screen-mode") && screenState.date) {
      widgetDate = screenState.date;
    }
    return api("/api/widget", {
      method: "POST",
      body: JSON.stringify({
        widget_type: type,
        spec: spec || {},
        date: widgetDate,
        mode: state.boardMode || "live"
      })
    });
  }

  function seriesToTable(data, widgetSpec) {
    var series = data.series || [];
    var spec = Object.assign({}, data.spec || {}, widgetSpec || {});
    var perHour = { labor_rate: 1, pick_rate: 1, check_rate: 1 };
    var allCols = [{ key: "label", label: dimensionLabel(data.dimension), numeric: false }].concat(
      series.map(function (s) { return { key: s.metric, label: s.name, numeric: true, series: s }; })
    );
    var cols = orderedTableColumns(allCols, spec);
    var visibleSeries = cols.filter(function (c) { return c.key !== "label"; });
    var colgroup = tableColgroup(cols, spec);
    var head = "<tr>" + cols.map(function (col) {
      return "<th" + (col.key !== "label" ? ' class="num"' : "") + ">" + esc(col.label) + "</th>";
    }).join("") + "</tr>";
    var body = (data.categories || []).map(function (label, index) {
      return "<tr>" + cols.map(function (col) {
        if (col.key === "label") return "<td>" + esc(label) + "</td>";
        var s = col.series || {};
        var value = (s.values || [])[index];
        var metric = String(col.key || "");
        var text;
        if (perHour[metric]) text = value === null || value === undefined ? "-" : num(value, 1);
        else if (metric.indexOf("_rate") >= 0) text = pct(value);
        else text = num(value, metric === "amount" || /_amount$/.test(metric) ? 2 : 0);
        return '<td class="num">' + text + "</td>";
      }).join("") + "</tr>";
    }).join("");
    return {
      allCols: allCols,
      spec: spec,
      html: '<div class="table-wrap"><table class="tbl' + (Object.keys(spec.column_widths || {}).length ? " fixed-cols" : "") + '">' +
        colgroup + "<thead>" + head + "</thead><tbody>" +
        (body || '<tr><td colspan="' + Math.max(1, cols.length) + '">' + emptyHtml() + "</td></tr>") +
        "</tbody></table></div>"
    };
  }

  function dimensionLabel(dim) {
    var map = {
      route: "承运商/线路", zone: "库区", region: "区域", doc_type: "单据类型", dealer: "经销商",
      wave: "波次", carrier_tms: "运输承运商", status: "发运状态", hour: "小时", date: "日期",
      erp_status: "ERP回传状态", person: "人员", pick_person: "拣货人", check_person: "复核人",
      warehouse: "仓库", freight_free: "是否免运费"
    };
    return map[dim] || "维度";
  }

  function alertTable(rows) {
    if (!rows || !rows.length) return emptyHtml("当前没有超时未出库的订单组");
    var head = "<tr><th>订单组号</th><th>经销商</th><th>线路</th><th class=\"num\">未出库</th><th class=\"num\">总行数</th><th class=\"num\">金额(万)</th><th>运输单</th></tr>";
    var body = rows.map(function (row) {
      return '<tr><td class="nowrap">' + esc(row.group_no) + '</td><td class="nowrap">' + esc(row.dealer) +
        '</td><td class="nowrap">' + esc(row.route) +
        '</td><td class="num">' + row.remaining + '</td><td class="num">' + row.lines +
        '</td><td class="num">' + (row.amount === null ? "-" : num(row.amount, 2)) + "</td><td>" +
        '<span class="badge ' + (row.tms_status === "未匹配" ? "warn" : "ok") + '">' + esc(row.tms_status) + "</span></td></tr>";
    }).join("");
    return '<div class="table-wrap"><table class="tbl" style="min-width:560px"><thead>' + head +
      "</thead><tbody>" + body + "</tbody></table></div>";
  }

  function progressList(items) {
    if (!items || !items.length) return emptyHtml();
    return '<div style="display:flex;flex-direction:column;gap:9px">' + items.map(function (item) {
      return '<div><div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:3px">' +
        "<span>" + esc(item.label) + '</span><span class="muted">' + pct(item.value) +
        (item.extra ? " · " + esc(item.extra) : "") + "</span></div>" +
        '<div style="height:8px;background:#eef1f6;border-radius:6px;overflow:hidden">' +
        '<div style="height:100%;width:' + Math.max(0, Math.min(100, item.value * 100)) +
        '%;background:' + (item.value >= 0.999 ? "#12b886" : item.value >= 0.5 ? "#2f6fed" : "#f59f00") + '"></div></div></div>';
    }).join("") + "</div>";
  }

  function widgetHeight(el, fallback) {
    var box = el && el.closest ? el.closest(".dg-body") : null;
    if (box && box.clientHeight > 0) return Math.max(110, box.clientHeight - 4);
    return fallback || 280;
  }

  function orderedTableColumns(cols, spec) {
    spec = spec || {};
    var hidden = {};
    (spec.hidden_columns || []).forEach(function (k) { hidden[k] = true; });
    var order = {};
    (spec.column_order || []).forEach(function (k, i) { if (!(k in order)) order[k] = i; });
    var visible = cols.filter(function (c) { return !hidden[c.key]; });
    visible.sort(function (a, b) {
      var ai = order[a.key] === undefined ? 99999 : order[a.key];
      var bi = order[b.key] === undefined ? 99999 : order[b.key];
      return ai - bi;
    });
    return visible;
  }

  function tableColgroup(cols, spec) {
    var widths = (spec && spec.column_widths) || {};
    if (!Object.keys(widths).length) return "";
    return "<colgroup>" + cols.map(function (col) {
      var width = Number(widths[col.key] || 0);
      return width ? '<col style="width:' + width + 'px">' : "<col>";
    }).join("") + "</colgroup>";
  }

  function bindTableLayout(el, allCols, spec, edit) {
    if (!edit || !edit.editable) return;
    var table = el.querySelector("table");
    if (!table) return;
    var visible = orderedTableColumns(allCols, spec);
    var headers = Array.prototype.slice.call(table.querySelectorAll("thead th"));
    if (!headers.length || headers.length !== visible.length) return;
    var cols = table.querySelectorAll("colgroup col");
    if (!cols.length) {
      var cg = document.createElement("colgroup");
      visible.forEach(function () { cg.appendChild(document.createElement("col")); });
      table.insertBefore(cg, table.firstChild);
      cols = table.querySelectorAll("colgroup col");
    }
    table.classList.add("fixed-cols");
    function notify(next) {
      if (edit && typeof edit.onSpecChange === "function") edit.onSpecChange(next);
    }
    function widths() {
      var out = {};
      visible.forEach(function (col, i) {
        var w = Math.round(cols[i] ? cols[i].getBoundingClientRect().width : 0);
        if (w >= 40) out[col.key] = w;
      });
      return out;
    }
    headers.forEach(function (th, index) {
      var col = visible[index];
      th.draggable = true;
      var handle = document.createElement("span");
      handle.className = "table-col-resize";
      handle.title = "拖动调整列宽";
      th.appendChild(handle);
      handle.addEventListener("pointerdown", function (event) {
        event.preventDefault();
        event.stopPropagation();
        var startX = event.clientX;
        var startWidth = cols[index].getBoundingClientRect().width || 100;
        handle.setPointerCapture && handle.setPointerCapture(event.pointerId);
        function move(ev) {
          var width = Math.max(40, Math.min(600, Math.round(startWidth + ev.clientX - startX)));
          if (cols[index]) cols[index].style.width = width + "px";
        }
        function up(ev) {
          document.removeEventListener("pointermove", move);
          document.removeEventListener("pointerup", up);
          var all = Object.assign({}, spec.column_widths || {}, widths());
          var next = Object.assign({}, spec, { column_widths: all });
          notify(next);
        }
        document.addEventListener("pointermove", move);
        document.addEventListener("pointerup", up);
      });
      th.addEventListener("dragstart", function (event) {
        event.dataTransfer.setData("text/plain", col.key);
        event.dataTransfer.effectAllowed = "move";
      });
      th.addEventListener("dragover", function (event) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      });
      th.addEventListener("drop", function (event) {
        event.preventDefault();
        var fromKey = event.dataTransfer.getData("text/plain");
        if (!fromKey || fromKey === col.key) return;
        var order = (spec.column_order || allCols.map(function (c) { return c.key; })).slice();
        var from = order.indexOf(fromKey);
        var to = order.indexOf(col.key);
        if (from < 0 || to < 0) return;
        order.splice(from, 1);
        order.splice(to, 0, fromKey);
        notify(Object.assign({}, spec, { column_order: order }));
      });
    });
  }

  function drawData(el, type, data) {
    el.innerHTML = "";
    if (!window.Charts) { el.innerHTML = '<div class="widget-error">charts.js 未加载</div>'; return; }
    if (data.kind === "value") {
      var metric = String(data.metric || "");
      var isAmount = metric === "amount" || /_amount$/.test(metric);
      var ratePerHour = metric === "pick_rate" || metric === "check_rate" || metric === "labor_rate";
      var isRate = metric.indexOf("_rate") >= 0 && !ratePerHour;
      var metricUnit = data.unit || "";
      var unit = isAmount ? (metricUnit || "万元") : metricUnit;
      var value;
      if (ratePerHour) {
        value = data.value === null || data.value === undefined ? "-" : num(data.value, 1);
        unit = metricUnit || "行/小时";
      } else if (isRate) {
        value = pct(data.value);
        unit = "";
      } else if (metric === "labor_hours" || metric === "pick_hours" ||
                 metric === "check_hours" || metric === "cycle_avg" ||
                 metric === "cycle_max" || metric === "pick_lag_avg" ||
                 metric === "check_lag_avg" || metric === "out_lag_avg") {
        value = num(data.value, 1);
        unit = metricUnit || "h";
      } else {
        value = num(data.value, isAmount ? 2 : 0);
      }
      var kpiSpec = el.__widgetSpec || {};
      var kpiColors = paletteFor(kpiSpec) || ["#1d5fbf"];
      var accent = kpiSpec.color || kpiColors[0] || "#1d5fbf";
      var opts = { label: data.label || "", value: value, unit: unit, color: accent };
      if (kpiSpec.color || kpiSpec.color_scheme) opts.valueColor = accent;
      if (data.delta !== undefined && data.delta !== null && isFinite(data.delta)) {
        opts.trend = data.delta;
        opts.sub = "较上日";
      }
      el.classList.remove("kpi-clickable");
      el.onclick = null;
      if (!document.body.classList.contains("screen-mode") &&
          (metric === "unregistered_lines" || metric === "unregistered_amount")) {
        el.classList.add("kpi-clickable");
        el.title = "点击查看待组波明细";
        el.onclick = function () { openPendingDetail(state.date); };
      }
      Charts.kpi(el, opts);
      return;
    }
    if (data.kind === "funnel") {
      Charts.funnel(el, {
        items: (data.items || []).map(function (item, index) {
          var colors = paletteFor(el.__widgetSpec || {});
          return {
            label: item.label,
            value: item.value,
            color: colors ? colors[index % colors.length] : undefined
          };
        }),
        height: widgetHeight(el, 280),
        showValues: (el.__widgetSpec || {}).show_values !== false
      });
      return;
    }
    if (data.kind === "text") { el.innerHTML = '<div class="small">' + esc(data.text || "") + "</div>"; return; }
    if (data.kind === "rows") {
      if (type === "alert") { el.innerHTML = alertTable(data.rows); return; }
      var cols = data.columns || Object.keys((data.rows && data.rows[0]) || {}).map(function (key) {
        return { key: key, label: key };
      });
      var tableSpec = Object.assign({}, data.spec || {}, el.__widgetSpec || {});
      var allCols = cols.slice();
      cols = orderedTableColumns(cols, tableSpec);
      var colgroup = tableColgroup(cols, tableSpec);
      var head = "<tr>" + cols.map(function (col) { return "<th>" + esc(col.label) + "</th>"; }).join("") + "</tr>";
      var numberKeys = { amount: 2, qty: 0, lines: 0, picked: 0, checked: 0 };
      var rows = (data.rows || []).map(function (row) {
        var cls = row.incomplete ? ' class="danger-row"' : "";
        return "<tr" + cls + ">" + cols.map(function (col) {
          var value = row[col.key];
          if (value === null || value === undefined) return "<td>-</td>";
          if (numberKeys[col.key] !== undefined) {
            var digits = numberKeys[col.key];
            return '<td class="num' + (row.incomplete ? " danger-text" : "") + '">' + num(value, digits) + "</td>";
          }
          return "<td>" + esc(value) + "</td>";
        }).join("") + "</tr>";
      }).join("");
      var foot = "";
      if (data.summary) {
        var totals = data.summary;
        foot = "<tfoot><tr>" + cols.map(function (col, index) {
          if (index === 0) return "<td><b>合计</b></td>";
          if (numberKeys[col.key] !== undefined && totals[col.key] !== null && totals[col.key] !== undefined) {
            return '<td class="num"><b>' + num(totals[col.key], numberKeys[col.key]) + "</b></td>";
          }
          return "<td></td>";
        }).join("") + "</tr></tfoot>";
      }
      el.innerHTML = '<div class="table-wrap"><table class="tbl' + (Object.keys(tableSpec.column_widths || {}).length ? " fixed-cols" : "") + '">' +
        colgroup + "<thead>" + head + "</thead><tbody>" +
        (rows || '<tr><td colspan="' + cols.length + '">' + emptyHtml(data.empty_text || "暂无数据") + "</td></tr>") +
        "</tbody>" + foot + "</table></div>";
      bindTableLayout(el, allCols, tableSpec, el.__tableEdit);
      return;
    }
    // series
    if (type === "table" || type === "detail") {
      var info = seriesToTable(data, el.__widgetSpec || {});
      el.innerHTML = info.html;
      bindTableLayout(el, info.allCols, info.spec, el.__tableEdit);
      return;
    }
    if (type === "progress") {
      var series = data.series || [];
      var rate = null;
      series.forEach(function (s) { if (s.metric === "out_rate") rate = s; });
      var base = series[0];
      var values = rate ? rate.values : base.values;
      el.innerHTML = progressList(data.categories.map(function (label, index) {
        return {
          label: label,
          value: Number(values[index] || 0),
          extra: rate ? "行数 " + num(base.values[index]) : ""
        };
      }));
      return;
    }
    if (!data.categories || !data.categories.length) { el.innerHTML = emptyHtml(); return; }
    if (type === "pie" || type === "donut") {
      var s0 = (data.series || [])[0] || { values: [] };
      var pieColors = paletteFor(el.__widgetSpec || data.spec || {});
      Charts.donut(el, {
        items: data.categories.map(function (label, index) {
          return {
            label: label,
            value: Number(s0.values[index] || 0),
            color: pieColors ? pieColors[index % pieColors.length] : undefined
          };
        }),
        height: widgetHeight(el, 260),
        showValues: (el.__widgetSpec || {}).show_values !== false
      });
      return;
    }
    var chartColors = paletteFor(el.__widgetSpec || data.spec || {});
    var chartSeries = (data.series || []).map(function (series, index) {
      var copy = Object.assign({}, series);
      if (chartColors) copy.color = chartColors[index % chartColors.length];
      return copy;
    });
    if (type === "bar") {
      Charts.bar(el, {
        categories: data.categories,
        series: chartSeries,
        stacked: false,
        horizontal: data.categories.length > 8,
        height: widgetHeight(el, 280),
        showValues: (el.__widgetSpec || {}).show_values !== false
      });
      return;
    }
    if (type === "line") {
      Charts.line(el, {
        categories: data.categories,
        series: chartSeries,
        area: true,
        height: widgetHeight(el, 280),
        showValues: (el.__widgetSpec || {}).show_values !== false
      });
      return;
    }
    el.innerHTML = emptyHtml("未知组件类型");
  }

  async function openPendingDetail(date) {
    var page = 1;
    var pageSize = 50;
    var m = modal({ title: "待组波明细 · " + (date || state.date), wide: true,
      body: '<div class="small muted">加载中…</div>' });
    function tableHtml(data) {
      var amount = data.amount;
      var summary = "共 " + num(data.lines) + " 行" +
        (amount === null || amount === undefined ? "" : " · 金额 " + num(amount, 2) + " 元") +
        " · " + num(data.groups) + " 个订单组";
      if (!data.rows || !data.rows.length) {
        return '<div class="small muted" style="margin-bottom:8px">' + esc(summary) + "</div>" +
          emptyHtml("这一天没有波次号为空的明细");
      }
      var body = data.rows.map(function (row) {
        return "<tr><td>" + esc(row.order_date || "-") + "</td><td>" + esc(row.group_no || "-") +
          "</td><td>" + esc(row.wms_no || "-") + "</td><td>" + esc(row.dealer_short || "-") +
          "</td><td>" + esc(row.route || "-") + "</td><td>" + esc(row.zone || "-") +
          "</td><td>" + esc(row.doc_type || "-") + '</td><td class="num">' + num(row.qty, 0) +
          '</td><td class="num">' + (row.amount === null || row.amount === undefined ? "-" : num(row.amount, 2)) +
          "</td><td>" + esc(row.status || "-") + "</td></tr>";
      }).join("");
      return '<div class="small muted" style="margin-bottom:8px">' + esc(summary) + "</div>" +
        '<div class="table-wrap" style="max-height:60vh"><table class="tbl"><thead><tr>' +
        "<th>订单日期</th><th>订单组号</th><th>WMS单号</th><th>经销商</th><th>线路</th><th>库区</th>" +
        '<th>单据类型</th><th class="num">数量</th><th class="num">金额(元)</th><th>状态</th></tr></thead><tbody>' +
        body + "</tbody></table></div>" +
        '<div style="display:flex;justify-content:flex-end;align-items:center;gap:8px;margin-top:8px">' +
        '<span class="small muted">第 ' + data.page + "/" + data.pages + " 页</span>" +
        '<button class="btn btn-sm" data-pd-prev ' + (data.page <= 1 ? "disabled" : "") + ">上一页</button>" +
        '<button class="btn btn-sm" data-pd-next ' + (data.page >= data.pages ? "disabled" : "") + ">下一页</button></div>";
    }
    async function render() {
      $(".modal-body", m.el).innerHTML = '<div class="small muted">加载中…</div>';
      try {
        var data = await api("/api/coverage/pending-detail?date=" + encodeURIComponent(date || state.date) +
          "&page=" + page + "&page_size=" + pageSize);
        $(".modal-body", m.el).innerHTML = tableHtml(data);
        var prev = $("[data-pd-prev]", m.el);
        var next = $("[data-pd-next]", m.el);
        if (prev) prev.addEventListener("click", function () { if (page > 1) { page -= 1; render(); } });
        if (next) next.addEventListener("click", function () { if (page < data.pages) { page += 1; render(); } });
      } catch (error) {
        $(".modal-body", m.el).innerHTML = '<div class="widget-error">' + esc(error.message) + "</div>";
      }
    }
    render();
  }

  async function drawWidget(el, type, spec, opts) {
    el.__widgetSpec = spec || {};
    el.__tableEdit = opts || null;
    el.innerHTML = '<div class="widget-loading"><span class="spinner"></span>加载中</div>';
    try {
      var data = await fetchWidget(type, spec);
      el.__widgetData = data;
      drawData(el, type, data);
    } catch (error) {
      el.innerHTML = '<div class="widget-error">' + esc(error.message) + "</div>";
    }
  }

  // 有缓存就按新尺寸重绘（缩放时不再重复请求接口），否则正常取数
  function renderWidgetBody(widget, body, opts) {
    body.__tableEdit = opts || null;
    body.__widgetSpec = widget.spec || {};
    if (body.__widgetData && body.__widgetType === widget.type) {
      drawData(body, widget.type, body.__widgetData);
      return;
    }
    body.__widgetType = widget.type;
    drawWidget(body, widget.type, widget.spec, opts);
  }

  function panel(title, bodyHtml, extraClass) {
    return '<div class="panel ' + (extraClass || "") + '"><div class="panel-head"><div class="panel-title">' +
      esc(title) + '</div></div><div class="panel-body flush" data-panel-body></div></div>';
  }

  function hydratePanels(root, jobs) {
    jobs.forEach(function (job) {
      var body = job.el.querySelector("[data-panel-body]");
      if (!body) return;
      drawWidget(body, job.type, job.spec);
    });
  }

  // ---------------------------------------------------------------- 总览
  async function pageOverview(view) {
    view.innerHTML =
      '<div class="page-head"><div><div class="page-title">今日总览</div>' +
      '<div class="page-sub" id="ov-sub">业务日期 ' + esc(state.date) + "</div></div>" +
      '<div class="toolbar"><button class="btn" id="btn-print" ' + (has("action.export") ? "" : "disabled") + ">打印单量表</button></div></div>" +
      '<div class="kpi-row" id="kpis" style="margin-bottom:14px"></div>' +
      '<div class="grid cols-6">' +
        '<div class="span-3" id="p-funnel"></div>' +
        '<div class="span-3" id="p-hourly"></div>' +
        '<div class="span-2" id="p-status"></div>' +
        '<div class="span-3" id="p-routes"></div>' +
        '<div class="span-1" id="p-zones"></div>' +
      "</div>";
    view.querySelector("#btn-print").addEventListener("click", function () { location.hash = "#/print"; });
    var kpisBox = $("#kpis", view);
    startLoading(kpisBox, "加载指标");
    try {
      var data = await api("/api/overview?date=" + encodeURIComponent(state.date));
      renderKpis(kpisBox, data);
      var range = data.data_range || {};
      if (!data.kpi.lines && data.kpi.pending_waves) {
        var tip = document.createElement("div");
        tip.className = "panel";
        tip.style.marginBottom = "14px";
        tip.innerHTML = '<div class="panel-body"><b>当前业务日还没有可统计的数据。</b>' +
          '<div class="small muted" style="margin-top:6px">已登记 ' + data.kpi.waves + " 个波次，其中 " +
          data.kpi.pending_waves + " 个还在等数据；当前 WMS 导出覆盖 " +
          esc(range.min || "-") + " ~ " + esc(range.max || "-") + "（" + (range.days || 0) +
          " 天）。请下载包含当天的「出库流程节点时间跟踪」导出，系统会自动补全。</div></div>";
        kpisBox.parentNode.insertBefore(tip, kpisBox.nextSibling);
      }
      ["p-funnel", "p-hourly", "p-status", "p-routes", "p-zones"].forEach(function (id) {
        $("#" + id, view).innerHTML = panel("", "");
      });
      drawWidget($("#p-funnel [data-panel-body]", view), "funnel", {});
      var hourlyBox = $("#p-hourly [data-panel-body]", view);
      if (window.Charts && data.hourly && data.hourly.categories.length) {
        Charts.line(hourlyBox, {
          categories: data.hourly.categories.map(function (hour) { return hour + ":00"; }),
          series: data.hourly.series,
          area: true
        });
      } else {
        hourlyBox.innerHTML = emptyHtml("暂无作业时间数据");
      }
      drawWidget($("#p-status [data-panel-body]", view), "pie", { dataset: "lines", dimension: "status", metrics: ["rows"], limit: 8 });
      drawWidget($("#p-routes [data-panel-body]", view), "bar", { dataset: "orders", dimension: "route", metrics: ["rows"], limit: 10 });
      drawWidget($("#p-zones [data-panel-body]", view), "bar", { dataset: "orders", dimension: "zone", metrics: ["rows"], limit: 8 });
      var titles = ["作业进度漏斗", "每小时拣货 / 出库（行）", "发运状态分布", "线路单量排行", "库区分布"];
      $$(".panel", view).forEach(function (p, index) {
        var t = $(".panel-title", p);
        if (t && titles[index]) t.textContent = titles[index];
      });
      $("#ov-sub", view).textContent = "业务日期 " + state.date + " · 自动刷新中";
    } catch (error) {
      showError(kpisBox, error, function () { pageOverview(view); });
    }
  }

  function kpiCard(label, value, unit, sub, trend) {
    var trendHtml = "";
    if (trend !== null && trend !== undefined && !isNaN(trend)) {
      var up = trend >= 0;
      trendHtml = '<span class="' + (up ? "kpi-up" : "kpi-down") + '">' + (up ? "▲" : "▼") +
        pct(Math.abs(trend)) + "</span>";
    }
    return '<div class="kpi-card"><div class="kpi-label">' + esc(label) + '</div>' +
      '<div class="kpi-value">' + esc(value) + (unit ? '<span class="kpi-unit">' + esc(unit) + "</span>" : "") + "</div>" +
      '<div class="kpi-sub">' + (trendHtml ? trendHtml + " " : "") + (sub ? esc(sub) : "&nbsp;") + "</div></div>";
  }

  function renderKpis(box, data) {
    var k = data.kpi;
    var prev = data.prev || {};
    function delta(current, before) {
      if (!before && before !== 0) return null;
      if (!before) return null;
      return (current - before) / before;
    }
    var amountText = k.amount === null || k.amount === undefined ? "无权限" : num(k.amount / 10000, 2);
    box.innerHTML = [
      kpiCard("订单组数", num(k.groups), "组", "较上一业务日", delta(k.groups, prev.groups)),
      kpiCard("发运行数", num(k.lines), "行", "较上一业务日", delta(k.lines, prev.lines)),
      kpiCard("单量金额", amountText, "万元", "较上一业务日", k.amount === null ? null : delta(k.amount, prev.amount)),
      kpiCard("登记波次", num(k.waves), "个",
        "运输单命中 " + k.tms_waves + " 个" + (k.pending_waves ? " · 待数据 " + k.pending_waves + " 个" : ""), null),
      kpiCard("出库完成率", pct(k.out_rate), "", "已出库 " + num(k.out) + " / " + num(k.lines), null),
      kpiCard("运输单释放率", pct(k.tms_rate), "", "已释放 " + k.tms_waves + " / " + k.waves, null)
    ].join("");
  }

  // ---------------------------------------------------------------- 作业进度
  async function pageProgress(view) {
    view.innerHTML =
      '<div class="page-head"><div><div class="page-title">作业进度</div>' +
      '<div class="page-sub">业务日期 ' + esc(state.date) + "</div></div>" +
      '<div class="toolbar"><button class="btn" id="btn-export" ' + (has("action.export") ? "" : "disabled") + ">导出 CSV</button></div></div>" +
      '<div class="kpi-row" id="kpis" style="margin-bottom:14px"></div>' +
      '<div class="grid cols-6">' +
        '<div class="span-6" id="p-waves"></div>' +
        '<div class="span-3" id="p-alerts"></div>' +
        '<div class="span-3" id="p-routes"></div>' +
        '<div class="span-6" id="p-timing"></div>' +
      "</div>";
    var kpisBox = $("#kpis", view);
    startLoading(kpisBox, "加载指标");
    try {
      var data = await api("/api/progress?date=" + encodeURIComponent(state.date));
      kpisBox.innerHTML = [
        kpiCard("已出库行数", num(data.waves.reduce(function (a, w) { return a + w.out; }, 0)), "行", "", null),
        kpiCard("已拣货行数", num(data.waves.reduce(function (a, w) { return a + w.picked; }, 0)), "行", "", null),
        kpiCard("已复核行数", num(data.waves.reduce(function (a, w) { return a + w.checked; }, 0)), "行", "", null),
        kpiCard("未出库行数", num(data.waves.reduce(function (a, w) { return a + (w.lines - w.out); }, 0)), "行",
          data.timing.after_cutoff ? "已过 " + data.timing.cutoff + " 截止时间" : "截止 " + data.timing.cutoff, null),
        kpiCard("平均出库时长", data.timing.avg_hours ? data.timing.avg_hours + " h" : "-", "",
          "中位 " + (data.timing.median_hours || 0) + " h", null),
        kpiCard("运输单未匹配", num(data.tms.unmatched.length), "波次", "已释放 " + data.tms.matched + " / " + data.tms.registered, null)
      ].join("");

      var waveBox = $("#p-waves", view);
      waveBox.innerHTML = panel("波次进度（" + data.waves.length + "）", "");
      var waveBody = $("[data-panel-body]", waveBox);
      var rows = data.waves.map(function (wave) {
        var cls = wave.rate >= 0.999 ? "ok" : wave.rate >= 0.5 ? "info" : "warn";
        var badge = wave.pending
          ? ' <span class="badge warn">待数据</span>'
          : (wave.excluded_all ? ' <span class="badge">已全部移出</span>' : "");
        return "<tr><td>" + esc(wave.wave_no) + badge + '</td><td class="num">' + wave.groups + '</td><td class="num">' + wave.lines +
          '</td><td class="num">' + (wave.amount === null ? "-" : num(wave.amount, 2)) +
          '</td><td style="min-width:120px">' + barHtml(wave.rate) + "</td>" +
          '<td><span class="badge ' + cls + '">' + pct(wave.rate) + "</span></td>" +
          "<td>" + esc(wave.tms_status || (wave.pending ? "-" : "未匹配")) + "</td></tr>";
      }).join("");
      waveBody.innerHTML = '<div class="table-wrap"><table class="tbl"><thead><tr><th>波次号</th>' +
        '<th class="num">订单组</th><th class="num">行数</th><th class="num">金额(万)</th><th>出库进度</th>' +
        '<th>完成率</th><th>运输单</th></tr></thead><tbody>' + (rows || '<tr><td colspan="7">' + emptyHtml() + "</td></tr>") +
        "</tbody></table></div>";

      var alertBox = $("#p-alerts", view);
      alertBox.innerHTML = panel("超时未出库（" + data.alerts.length + "）", "");
      $("[data-panel-body]", alertBox).innerHTML = alertTable(data.alerts);

      var routeBox = $("#p-routes", view);
      routeBox.innerHTML = panel("线路完成率", "");
      $("[data-panel-body]", routeBox).innerHTML = progressList(data.routes.map(function (route) {
        return { label: route.label, value: route.rate, extra: "行数 " + num(route.lines) };
      }));

      var timingBox = $("#p-timing", view);
      timingBox.innerHTML = panel("作业时效", "");
      var t = data.timing;
      $("[data-panel-body]", timingBox).innerHTML =
        '<div class="grid cols-2" style="gap:10px">' +
          timingItem("平均出库时长", (t.avg_hours || 0) + " 小时") +
          timingItem("中位出库时长", (t.median_hours || 0) + " 小时") +
          timingItem("最晚出库时间", t.last_out || "-") +
          timingItem("最后波次生成", t.last_wave_time || "-") +
          timingItem("截止时间", t.cutoff) +
          timingItem("超时预警", data.alerts.length + " 个订单组") +
        "</div>" +
        '<div class="small muted" style="margin-top:10px">未匹配运输单波次：' +
        (data.tms.unmatched.length ? esc(data.tms.unmatched.join("、")) : "无") + "</div>";
      $("#btn-export", view).addEventListener("click", function () {
        window.location.href = "/api/export/summary.csv?date=" + encodeURIComponent(state.date);
      });
    } catch (error) {
      showError(kpisBox, error, function () { pageProgress(view); });
    }
  }

  function timingItem(label, value) {
    return '<div class="panel" style="box-shadow:none"><div class="panel-body">' +
      '<div class="kpi-label">' + esc(label) + '</div><div style="font-size:16px;font-weight:600;margin-top:2px">' +
      esc(value) + "</div></div></div>";
  }

  function barHtml(rate) {
    var value = Math.max(0, Math.min(1, rate || 0));
    var color = value >= 0.999 ? "#12b886" : value >= 0.5 ? "#2f6fed" : "#f59f00";
    return '<div style="display:flex;align-items:center;gap:8px"><div style="flex:1;height:8px;background:#eef1f6;border-radius:6px;overflow:hidden">' +
      '<div style="height:100%;width:' + (value * 100) + "%;background:" + color + '"></div></div>' +
      '<span class="small muted nowrap">' + num(Math.round(value * 100)) + "%</span></div>";
  }

  // ---------------------------------------------------------------- 单量分析
  function changeText(current, base) {
    if (base === null || base === undefined || Number(base) === 0) return "-";
    var rate = (Number(current || 0) - Number(base)) / Number(base) * 100;
    return (rate >= 0 ? "+" : "") + rate.toFixed(1) + "%";
  }

  function changeClass(current, base) {
    if (!base) return "muted";
    return Number(current || 0) >= Number(base) ? "up" : "down";
  }

  function periodLabel(period) {
    return { today: "今日", week: "本周", month: "本月", quarter: "本季度" }[period] || "今日";
  }

  function volumeKpi(title, value, prev, yoy, unit, digits) {
    var shown = num(value, digits === undefined ? 0 : digits);
    return '<div class="panel"><div class="panel-body"><div class="small muted">' + esc(title) + '</div>' +
      '<div style="font-size:26px;font-weight:700;margin:6px 0">' + esc(shown) +
      (unit ? '<span class="small muted" style="font-weight:400;margin-left:4px">' + esc(unit) + "</span>" : "") + "</div>" +
      '<div class="small">环比 <span class="' + changeClass(value, prev) + '">' + changeText(value, prev) +
      '</span> · 同比 <span class="' + changeClass(value, yoy) + '">' + changeText(value, yoy) + "</span></div></div></div>";
  }

  async function pageVolume(view) {
    var period = "today";
    var detailRows = [];
    view.innerHTML =
      '<div class="page-head"><div><div class="page-title">单量分析</div>' +
      '<div class="page-sub">按发运订单日期统计；支持今日、本周、本月、本季度及环比/同比</div></div></div>' +
      '<div class="panel" style="margin-bottom:14px"><div class="panel-body" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">' +
        '<div class="toolbar" id="vol-period">' +
          '<button class="btn btn-sm btn-primary" data-period="today">今日</button>' +
          '<button class="btn btn-sm" data-period="week">本周</button>' +
          '<button class="btn btn-sm" data-period="month">本月</button>' +
          '<button class="btn btn-sm" data-period="quarter">本季度</button>' +
        "</div>" +
        '<span class="small muted" id="vol-range"></span>' +
        '<span class="small muted">对比：环比=上一周期，同比=去年同期</span>' +
      "</div></div>" +
      '<div class="grid cols-4" style="margin-bottom:14px" id="vol-kpis"></div>' +
      '<div class="grid cols-2" style="margin-bottom:14px">' +
        '<div class="panel"><div class="panel-head"><div class="panel-title">线路</div></div><div class="panel-body flush" id="vol-route"></div></div>' +
        '<div class="panel"><div class="panel-head"><div class="panel-title">区域</div></div><div class="panel-body flush" id="vol-region"></div></div>' +
        '<div class="panel"><div class="panel-head"><div class="panel-title">库区</div></div><div class="panel-body flush" id="vol-zone"></div></div>' +
        '<div class="panel"><div class="panel-head"><div class="panel-title">单据类型</div></div><div class="panel-body flush" id="vol-doctype"></div></div>' +
      "</div>" +
      '<div class="panel" style="margin-bottom:14px"><div class="panel-head"><div class="panel-title">经销商</div></div><div class="panel-body flush" id="vol-dealer"></div></div>' +
      '<div class="panel"><div class="panel-head"><div class="panel-title">订单组明细</div>' +
        '<div class="toolbar"><input class="input" id="vol-q" placeholder="搜索订单组号/经销商/线路" style="width:230px;height:30px">' +
        '<button class="btn btn-sm" id="vol-search">搜索</button></div></div>' +
        '<div class="panel-body flush" id="vol-detail"></div></div>';

    function breakdownHtml(items) {
      var rows = (items || []).map(function (item) {
        return "<tr><td>" + esc(item.label) + '</td><td class="num">' + num(item.lines) +
          '</td><td class="num">' + (item.amount === null ? "-" : num(item.amount, 2)) +
          '</td><td class="num ' + changeClass(item.lines, item.prev_lines) + '">' + changeText(item.lines, item.prev_lines) +
          '</td><td class="num ' + changeClass(item.lines, item.yoy_lines) + '">' + changeText(item.lines, item.yoy_lines) + "</td></tr>";
      }).join("");
      return '<div class="table-wrap" style="max-height:310px"><table class="tbl"><thead><tr><th>维度</th>' +
        '<th class="num">本期行数</th><th class="num">本期金额(万)</th><th class="num">环比</th><th class="num">同比</th>' +
        "</tr></thead><tbody>" + (rows || '<tr><td colspan="5">' + emptyHtml() + "</td></tr>") + "</tbody></table></div>";
    }

    function renderDetail() {
      var q = ($("#vol-q", view).value || "").trim().toLowerCase();
      var rows = detailRows.filter(function (row) {
        if (!q) return true;
        return [row.group_no, row.dealer, row.route].join(" ").toLowerCase().indexOf(q) >= 0;
      }).map(function (row) {
        return "<tr><td>" + esc(row.group_no) + "</td><td>" + esc(row.wave_no || "-") + "</td><td>" +
          esc(row.dealer || "-") + "</td><td>" + esc(row.route || "-") + "</td><td>" + esc(row.zone || "-") +
          '</td><td class="num">' + num(row.lines) + '</td><td class="num">' +
          (row.amount === null ? "-" : num(row.amount, 2)) + "</td></tr>";
      }).join("");
      $("#vol-detail", view).innerHTML = '<div class="table-wrap" style="max-height:420px"><table class="tbl"><thead><tr>' +
        '<th>订单组号</th><th>波次</th><th>经销商</th><th>线路</th><th>库区</th><th class="num">行数</th><th class="num">金额(万)</th>' +
        "</tr></thead><tbody>" + (rows || '<tr><td colspan="7">' + emptyHtml() + "</td></tr>") + "</tbody></table></div>";
    }

    async function load() {
      var box = $("#vol-kpis", view);
      startLoading(box);
      try {
        var data = await api("/api/volume?date=" + encodeURIComponent(state.date) + "&period=" + encodeURIComponent(period));
        var range = data.range || {};
        setText("#vol-range", range.start && range.end ? (range.start + " ~ " + range.end) : "");
        var totals = data.totals || {}, prev = data.prev || {}, yoy = data.yoy || {};
        box.innerHTML =
          volumeKpi("本期行数", totals.lines, prev.lines, yoy.lines, "行") +
          volumeKpi("本期金额", totals.amount, prev.amount, yoy.amount, "万元", 2) +
          volumeKpi("订单组数", totals.groups, prev.groups, yoy.groups, "组") +
          '<div class="panel"><div class="panel-body"><div class="small muted">当前周期</div>' +
          '<div style="font-size:22px;font-weight:700;margin:6px 0">' + esc(periodLabel(period)) + "</div>" +
          '<div class="small muted">对比上一周期 / 去年同期</div></div></div>';
        var bd = data.breakdowns || {};
        ["route", "region", "zone", "doctype"].forEach(function (dim) {
          var target = dim === "doctype" ? "#vol-doctype" : "#vol-" + dim;
          $(target, view).innerHTML = breakdownHtml(bd[dim] || []);
        });
        $("#vol-dealer", view).innerHTML = breakdownHtml(bd.dealer || []);
        detailRows = data.detail || [];
        renderDetail();
      } catch (error) {
        showError(box, error, load);
      }
    }
    $$("[data-period]", view).forEach(function (button) {
      button.addEventListener("click", function () {
        period = button.getAttribute("data-period");
        $$("[data-period]", view).forEach(function (b) {
          b.className = "btn btn-sm" + (b.getAttribute("data-period") === period ? " btn-primary" : "");
        });
        load();
      });
    });
    $("#vol-search", view).addEventListener("click", renderDetail);
    $("#vol-q", view).addEventListener("keydown", function (event) { if (event.key === "Enter") renderDetail(); });
    load();
  }

  // ---------------------------------------------------------------- 订单组登记
  async function pageOrders(view) {
    var token = state.routeToken;
    var canEdit = has("action.orders.override");
    var canArchive = has("action.orders.archive");
    var ui = {
      mode: "live",
      page: 1,
      size: 100,
      wave: (state.query && state.query.wave) || "",
      route: "",
      region: "",
      q: "",
      included: "all",
      sort: "reg"
    };

    view.innerHTML =
      '<div class="page-head"><div><div class="page-title">订单组登记</div>' +
      '<div class="page-sub">业务日期 <b>' + esc(state.date) + "</b> · 字段与现行《单据登记表》一致；按波次登记顺序排列，可改区域/承运商/指派/备注，可移出或恢复</div></div>" +
      '<div class="toolbar">' +
        '<button class="btn" id="btn-arch" ' + (canArchive ? "" : "disabled") + ">存档今日</button>" +
        '<button class="btn" id="btn-export">导出 CSV</button>' +
      "</div></div>" +
      dateBanner() +
      '<div class="panel" style="margin-bottom:12px"><div class="panel-body" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">' +
        '<div class="toolbar" id="mode-switch">' +
          '<button class="btn btn-sm btn-primary" data-mode="live">实时登记</button>' +
          '<button class="btn btn-sm" data-mode="archive">存档快照</button>' +
        "</div>" +
        '<select class="select" id="f-wave" style="height:30px;min-width:170px"></select>' +
        '<input class="input" id="f-route" placeholder="承运商/线路" style="height:30px;width:150px">' +
        '<input class="input" id="f-region" placeholder="区域" style="height:30px;width:110px">' +
        '<input class="input" id="f-q" placeholder="订单组号/经销商/波次" style="height:30px;width:200px">' +
        '<select class="select" id="f-included" style="height:30px">' +
          '<option value="all">全部</option><option value="1">仅计入</option><option value="0">已移出</option>' +
        "</select>" +
        '<select class="select" id="f-sort" style="height:30px">' +
          '<option value="reg">按登记顺序</option><option value="wave">按波次号</option>' +
        "</select>" +
        '<button class="btn btn-sm" id="btn-search">查询</button>' +
        '<span class="small muted" id="arch-hint"></span>' +
      "</div></div>" +
      '<div class="panel"><div class="panel-head"><div class="panel-title" id="ord-title">订单组</div>' +
      '<div class="panel-sub" id="ord-sum"></div></div>' +
      '<div class="panel-body flush" id="ord-box"></div>' +
      '<div class="pager" id="ord-pager"></div></div>';

    // 波次下拉
    try {
      var waveData = await api("/api/waves?date=" + encodeURIComponent(state.date));
      if (token !== state.routeToken) return;
      $("#f-wave", view).innerHTML = '<option value="">全部波次</option>' + waveData.rows.map(function (row) {
        return '<option value="' + esc(row.wave_no) + '"' + (row.wave_no === ui.wave ? " selected" : "") + ">" +
          esc(row.wave_no) + (row.pending ? "（待数据）" : "") + "</option>";
      }).join("");
    } catch (error) { /* 波次读取失败不影响台账 */ }

    function modeButton() {
      $$("[data-mode]", view).forEach(function (btn) {
        var on = btn.getAttribute("data-mode") === ui.mode;
        btn.className = "btn btn-sm" + (on ? " btn-primary" : "");
      });
      $("#btn-arch", view).style.display = ui.mode === "live" ? "" : "none";
    }

    async function load() {
      var token = state.routeToken;
      modeButton();
      var box = $("#ord-box", view);
      startLoading(box);
      var url = "/api/order-groups?date=" + encodeURIComponent(state.date) +
        "&mode=" + ui.mode + "&page=" + ui.page + "&size=" + ui.size +
        "&wave=" + encodeURIComponent(ui.wave) + "&route=" + encodeURIComponent(ui.route) +
        "&region=" + encodeURIComponent(ui.region) + "&q=" + encodeURIComponent(ui.q) +
        "&included=" + ui.included + "&sort=" + ui.sort;
      try {
        var data = await api(url);
        if (token !== state.routeToken) return;
        render(data);
      } catch (error) {
        showError(box, error, load);
      }
    }

    function render(data) {
      var rows = data.rows || [];
      var head = "<tr><th class=\"num\">序号</th><th>订单组号</th><th>经销商</th><th class=\"num\">行数</th>" +
        "<th class=\"num\">金额(元)</th><th>库区</th><th>单据类型</th><th>是否免运费（预留）</th>" +
        "<th>区域</th><th>承运商</th><th>波次号</th><th>清洗</th><th>指派</th><th>备注</th>" +
        (canEdit && ui.mode === "live" ? "<th>操作</th>" : "") + "</tr>";
      var body = rows.map(function (row) {
        var moved = !row.included;
        var tds = [
          '<td class="num">' + row.seq + "</td>",
          "<td><span" + (moved ? ' style="text-decoration:line-through;color:#98a2b3"' : "") + ">" +
            esc(row.group_no_label || row.group_no) + "</span>" +
            (moved ? ' <span class="badge danger">已移出</span>' : "") + "</td>",
          "<td>" + esc(row.dealer) + "</td>",
          '<td class="num">' + num(row.lines) + "</td>",
          '<td class="num">' + (row.amount === null ? "-" : num(row.amount)) + "</td>",
          "<td>" + esc(row.zone || "-") + "</td>",
          "<td>" + esc(row.doc_type || "-") + "</td>",
          "<td>" + esc(row.freight_free || "-") + "</td>",
          "<td>" + esc(row.region || "未映射") + "</td>",
          '<td class="nowrap">' + esc(row.route || "未映射") + "</td>",
          "<td>" + esc(row.wave_no) + "</td>",
          "<td>" + (row.tms_status ? '<span class="badge ' + (row.tms_status === "已释放" ? "ok" : "info") + '">' + esc(row.tms_status) + "</span>" : '<span class="badge warn">未匹配</span>') + "</td>",
          "<td>" + esc(row.assignee || "-") + "</td>",
          '<td class="small muted">' + esc(row.note || "") + "</td>"
        ];
        if (canEdit && ui.mode === "live") {
          tds.push('<td class="nowrap"><button class="btn btn-sm btn-ghost" data-edit="' + esc(row.group_no) + '">编辑</button>' +
            (moved ? '<button class="btn btn-sm btn-ghost" data-restore="' + esc(row.group_no) + '">恢复</button>'
                   : '<button class="btn btn-sm btn-danger" data-move="' + esc(row.group_no) + '">移出</button>') + "</td>");
        }
        return '<tr class="' + (moved ? "moved" : "") + '">' + tds.join("") + "</tr>";
      }).join("");

      $("#ord-box", view).innerHTML = '<div class="table-wrap"><table class="tbl" style="min-width:1180px"><thead>' +
        head + "</thead><tbody>" +
        (body || '<tr><td colspan="15">' + emptyHtml(
          ui.mode === "archive"
            ? "该日期还没有存档（切到「实时登记」后点「存档今日」）"
            : (ui.wave ? "该波次还没有订单组" : "当天还没有订单组（先登记波次）")
        ) + "</td></tr>") +
        "</tbody></table></div>";

      var summary = data.summary || {};
      setText("#ord-title", (ui.mode === "archive" ? "订单组（存档快照）" : "订单组") +
        " · " + state.date);
      setText("#ord-sum", "共 " + num(summary.groups) + " 组 / " + num(summary.lines) + " 行" +
        (summary.amount === null || summary.amount === undefined ? "" : " / 金额 " + num(summary.amount) + " 元"));
      setText("#arch-hint", ui.mode === "archive"
        ? ("存档时间：" + (data.archived_at || "-") + "（只读）")
        : (data.archived_at ? "该日已存档：" + data.archived_at + "（" + data.archive_rows + " 行）" : "尚未存档"));
      setText("#btn-arch", data.archived_at ? "重新存档" : (state.date === todayStr() ? "存档今日" : "存档当日"));

      var totalPages = Math.max(1, Math.ceil(data.total / data.size));
      $("#ord-pager", view).innerHTML = '<span>第 ' + data.page + " / " + totalPages + " 页</span>" +
        '<button class="btn btn-sm" id="o-prev"' + (data.page <= 1 ? " disabled" : "") + ">上一页</button>" +
        '<button class="btn btn-sm" id="o-next"' + (data.page >= totalPages ? " disabled" : "") + ">下一页</button>";
      $("#o-prev", view).addEventListener("click", function () { ui.page = Math.max(1, ui.page - 1); load(); });
      $("#o-next", view).addEventListener("click", function () { ui.page = ui.page + 1; load(); });

      bindRowActions(rows);
    }

    function bindRowActions(rows) {
      function byGroup(no) {
        return rows.filter(function (r) { return r.group_no === no; })[0];
      }
      $$("[data-edit]", view).forEach(function (btn) {
        btn.addEventListener("click", function () { editGroup(byGroup(btn.getAttribute("data-edit"))); });
      });
      $$("[data-move]", view).forEach(function (btn) {
        btn.addEventListener("click", function () {
          var row = byGroup(btn.getAttribute("data-move"));
          confirmDialog("移出本波次", "移出后该订单组不再计入当天单量与进度，可在「已移出」里恢复。确定移出？", "移出")
            .then(function (ok) {
              if (!ok) return;
              saveOverride(row.group_no, { include: 0 }, "已移出");
            });
        });
      });
      $$("[data-restore]", view).forEach(function (btn) {
        btn.addEventListener("click", function () {
          var row = byGroup(btn.getAttribute("data-restore"));
          saveOverride(row.group_no, { include: 1 }, "已恢复");
        });
      });
    }

    function saveOverride(groupNo, payload, okText) {
      api("/api/order-groups/" + encodeURIComponent(groupNo) + "?date=" + encodeURIComponent(state.date), {
        method: "PUT",
        body: JSON.stringify(payload)
      }).then(function () {
        toast(okText || "已保存", "ok");
        load();
      }).catch(function (error) { toast(error.message, "err"); });
    }

    function editGroup(row) {
      if (!row) return;
      var m = modal({
        title: "编辑订单组 " + (row.group_no_label || row.group_no),
        wide: true,
        body:
          '<div class="small muted" style="margin-bottom:10px">留空表示按默认口径（经销商映射 / 调拨规则 / 运输单）。波次号不可修改。</div>' +
          '<div class="grid cols-2">' +
            '<div class="field"><label>承运商 / 线路</label><input class="input" id="og-route" value="' + esc(row.route || "") + '" placeholder="默认：' + esc(row.route || "") + '"></div>' +
            '<div class="field"><label>区域</label><input class="input" id="og-region" value="' + esc(row.region || "") + '" placeholder="默认：' + esc(row.region || "") + '"></div>' +
            '<div class="field"><label>指派（实际承运商）</label><input class="input" id="og-assign" value="' + esc(row.assignee || "") + '"></div>' +
            '<div class="field"><label>备注</label><input class="input" id="og-note" value="' + esc(row.note || "") + '"></div>' +
          "</div>" +
          '<label class="check"><input type="checkbox" id="og-include"' + (row.included ? " checked" : "") + ">计入本波次（取消勾选=移出）</label>",
        footer: '<button class="btn btn-danger" data-reset>恢复默认</button>' +
          '<button class="btn" data-cancel>取消</button><button class="btn btn-primary" data-ok>保存</button>'
      });
      $("[data-cancel]", m.el).addEventListener("click", m.close);
      $("[data-ok]", m.el).addEventListener("click", function () {
        api("/api/order-groups/" + encodeURIComponent(row.group_no) + "?date=" + encodeURIComponent(state.date), {
          method: "PUT",
          body: JSON.stringify({
            route_override: $("#og-route", m.el).value.trim(),
            region_override: $("#og-region", m.el).value.trim(),
            assign_override: $("#og-assign", m.el).value.trim(),
            note: $("#og-note", m.el).value.trim(),
            include: $("#og-include", m.el).checked ? 1 : 0
          })
        }).then(function () { m.close(); toast("已保存", "ok"); load(); })
          .catch(function (error) { toast(error.message, "err"); });
      });
      $("[data-reset]", m.el).addEventListener("click", function () {
        api("/api/order-groups/" + encodeURIComponent(row.group_no) + "?date=" + encodeURIComponent(state.date), { method: "DELETE" })
          .then(function () { m.close(); toast("已恢复默认", "ok"); load(); })
          .catch(function (error) { toast(error.message, "err"); });
      });
    }

    $("#btn-search", view).addEventListener("click", function () {
      ui.wave = $("#f-wave", view).value;
      ui.route = $("#f-route", view).value.trim();
      ui.region = $("#f-region", view).value.trim();
      ui.q = $("#f-q", view).value.trim();
      ui.included = $("#f-included", view).value;
      ui.sort = $("#f-sort", view).value;
      ui.page = 1;
      load();
    });
    $("#f-q", view).addEventListener("keydown", function (event) {
      if (event.key === "Enter") $("#btn-search", view).click();
    });
    $$("[data-mode]", view).forEach(function (btn) {
      btn.addEventListener("click", function () {
        ui.mode = btn.getAttribute("data-mode");
        ui.page = 1;
        load();
      });
    });
    $("#btn-arch", view).addEventListener("click", function () {
      var force = $("#btn-arch", view).textContent.indexOf("重新") >= 0;
      confirmDialog(force ? "重新存档" : "存档今日",
        force ? "会用当前数据覆盖该日期的存档快照（留审计）。确定？" : "把当前订单组台账按 " + state.date + " 存档。确定？",
        force ? "覆盖存档" : "存档").then(function (ok) {
        if (!ok) return;
        api("/api/archive", { method: "POST", body: JSON.stringify({ date: state.date, force: force }) })
          .then(function (result) {
            toast("已存档 " + result.count + " 行", "ok");
            load();
          }).catch(function (error) { toast(error.message, "err"); });
      });
    });
    $("#btn-export", view).addEventListener("click", function () {
      window.location.href = "/api/export/order-groups.csv?date=" + encodeURIComponent(state.date) +
        "&mode=" + ui.mode + "&wave=" + encodeURIComponent(ui.wave) + "&sort=" + ui.sort;
    });

    bindDateBanner(view);
    load();
  }

  // ---------------------------------------------------------------- 趋势
  async function pageTrend(view) {
    view.innerHTML =
      '<div class="page-head"><div><div class="page-title">趋势</div>' +
      '<div class="page-sub">每日快照自动沉淀，无需人工归档</div></div>' +
      '<div class="toolbar"><select class="select" id="days"><option value="7">近 7 天</option>' +
      '<option value="30" selected>近 30 天</option><option value="90">近 90 天</option></select></div></div>' +
      '<div class="grid cols-2">' +
        '<div id="p-lines"></div><div id="p-amount"></div>' +
        '<div id="p-rate"></div><div id="p-groups"></div>' +
      "</div>" +
      '<div class="panel" style="margin-top:14px"><div class="panel-head"><div class="panel-title">每日明细</div></div>' +
      '<div class="panel-body flush" id="p-table"></div></div>';
    var titles = ["p-lines", "p-amount", "p-rate", "p-groups"];
    titles.forEach(function (id) { $("#" + id, view).innerHTML = panel("", ""); });
    function load() {
      var days = $("#days", view).value;
      api("/api/trend?days=" + days).then(function (data) {
        var specs = [
          ["p-lines", "line", { dataset: "trend", metrics: ["rows"] }],
          ["p-amount", "line", { dataset: "trend", metrics: ["amount"] }],
          ["p-rate", "line", { dataset: "trend", metrics: ["out_rate"] }],
          ["p-groups", "bar", { dataset: "trend", metrics: ["groups"] }]
        ];
        specs.forEach(function (item) {
          drawWidget($("#" + item[0] + " [data-panel-body]", view), item[1], item[2]);
        });
        var labels = ["每日行数", "每日金额（万元）", "每日出库完成率", "每日订单组数"];
        ["p-lines", "p-amount", "p-rate", "p-groups"].forEach(function (id, index) {
          var t = $("#" + id + " .panel-title", view);
          if (t) t.textContent = labels[index];
        });
        var rows = data.dates.map(function (d, index) {
          return "<tr><td>" + esc(d) + '</td><td class="num">' + num(data.groups[index]) +
            '</td><td class="num">' + num(data.lines[index]) +
            '</td><td class="num">' + (data.amount[index] === null ? "-" : num(data.amount[index], 2)) +
            '</td><td class="num">' + data.waves[index] +
            '</td><td class="num">' + pct(data.out_rate[index]) +
            '</td><td class="num">' + pct(data.ship_rate[index]) + "</td></tr>";
        }).join("");
        $("#p-table", view).innerHTML = '<div class="table-wrap"><table class="tbl"><thead><tr><th>业务日期</th>' +
          '<th class="num">订单组</th><th class="num">行数</th><th class="num">金额(万)</th><th class="num">波次</th>' +
          '<th class="num">出库完成率</th><th class="num">发运完成率</th></tr></thead><tbody>' +
          (rows || '<tr><td colspan="7">' + emptyHtml("还没有历史数据") + "</td></tr>") + "</tbody></table></div>";
      }).catch(function (error) { toast(error.message, "err"); });
    }
    $("#days", view).addEventListener("change", load);
    load();
  }

  // ---------------------------------------------------------------- 动力电池登记
  async function pageBattery(view) {
    var canManage = has("action.battery.manage");
    var stateB = batteryView || { from: state.date, to: state.date, q: "", status: "", page: 1, mode: "live", rows: [], total: 0 };
    batteryView = stateB;
    view.innerHTML =
      '<div class="page-head"><div><div class="page-title">动力电池登记</div>' +
      '<div class="page-sub">按订单组号自动列出动力电池候选，人工确认登记；数量/金额只取该组该备件编码的动力电池行</div></div>' +
      '<div class="toolbar">' +
        (canManage ? '<label class="btn" style="cursor:pointer">上传动力电池备件表<input type="file" id="bat-parts" accept=".xlsx,.xlsm,.csv" style="display:none"></label>' : "") +
        '<button class="btn btn-sm" data-bat-mode="live">实时登记</button>' +
        '<button class="btn btn-sm" data-bat-mode="archive">存档快照</button>' +
        (canManage ? '<button class="btn" id="bat-archive-save">存档今日</button>' : "") +
        '<button class="btn" id="bat-refresh">刷新</button>' +
        '<button class="btn" id="bat-export">导出 CSV</button>' +
      "</div></div>" +
      '<div class="panel" style="margin-bottom:14px"><div class="panel-head"><div class="panel-title">筛选</div>' +
        '<div class="panel-sub" id="bat-parts-sum"></div></div><div class="panel-body">' +
        '<div class="grid cols-4">' +
          '<div class="field"><label id="bat-date-from-label">订单日期从</label><input class="input" type="date" id="bat-from" value="' + esc(stateB.from) + '"></div>' +
          '<div class="field"><label id="bat-date-to-label">订单日期到</label><input class="input" type="date" id="bat-to" value="' + esc(stateB.to) + '"></div>' +
          '<div class="field"><label>状态</label><select class="select" id="bat-status"><option value="">全部</option><option value="pending">待登记</option><option value="confirmed">已登记</option></select></div>' +
          '<div class="field"><label>关键字</label><input class="input" id="bat-q" placeholder="订单组号 / 经销商 / 备件编码 / 名称"></div>' +
        "</div>" +
        '<div class="toolbar"><button class="btn btn-primary" id="bat-search">查询</button>' +
          (canManage ? '<button class="btn btn-sm" id="bat-confirm-all">登记所选</button>' : "") +
          '<span class="panel-sub" id="bat-sum"></span></div>' +
      "</div></div>" +
      '<div class="panel" style="margin-bottom:14px"><div class="panel-head"><div class="panel-title">当天已登记明细（实际登记日期）</div><div class="panel-sub" id="bat-today-sum"></div></div>' +
      '<div class="panel-body flush" id="bat-today-box"></div></div>' +
      '<div class="panel"><div class="panel-head"><div class="panel-title">动力电池订单组</div></div>' +
      '<div class="panel-body flush" id="bat-box"></div></div>';
    var box = $("#bat-box", view);
    function queryString() {
      var range = stateB.mode === "live"
        ? "order_from=" + encodeURIComponent(stateB.from) + "&order_to=" + encodeURIComponent(stateB.to)
        : "from=" + encodeURIComponent(stateB.from) + "&to=" + encodeURIComponent(stateB.to);
      return range + "&q=" + encodeURIComponent(stateB.q) + "&status=" + encodeURIComponent(stateB.status) +
        "&page=" + stateB.page + "&page_size=50";
    }
    function modeButtons() {
      $$("[data-bat-mode]", view).forEach(function (btn) {
        btn.className = "btn btn-sm" + (btn.getAttribute("data-bat-mode") === stateB.mode ? " btn-primary" : "");
      });
      var label = stateB.mode === "archive" ? "登记日期" : "订单日期";
      setText("#bat-date-from-label", label + "从");
      setText("#bat-date-to-label", label + "到");
    }
    function payload(row) {
      return { order_date: row.order_date, group_no: row.group_no, part_code: row.part_code };
    }
    async function loadToday() {
      var todayBox = $("#bat-today-box", view);
      if (!todayBox) return;
      try {
        var data = await api("/api/battery/rows?reg_from=" + encodeURIComponent(todayStr()) +
          "&reg_to=" + encodeURIComponent(todayStr()) + "&status=confirmed&page=1&page_size=5000");
        var rows = data.rows || [];
        var head = '<tr><th>订单日期</th><th>登记日期</th><th>订单组号</th><th>经销商</th><th>备件编码</th><th>备件名称</th>' +
          '<th class="num">行数</th><th class="num">数量</th><th class="num">金额</th><th class="num">拣货行数</th><th class="num">复核行数</th>' +
          '<th>库区</th><th>单据类型</th><th>是否免运费</th><th>区域</th><th>承运商</th><th>送达城市</th><th>地址</th></tr>';
        var body = rows.map(function (row) {
          var incomplete = row.incomplete ? ' class="danger-row"' : "";
          return "<tr" + incomplete + "><td>" + esc(row.order_date || "-") + "</td><td>" + esc(row.reg_date || "-") + "</td>" +
            "<td>" + esc(row.group_no) + "</td><td>" + esc(row.dealer_short || row.dealer_full || "-") + "</td>" +
            '<td><span class="mono">' + esc(row.part_code || "-") + "</span></td><td>" + esc(row.part_name || "-") + "</td>" +
            '<td class="num">' + num(row.lines) + '</td><td class="num">' + num(row.qty) + '</td><td class="num">' + num(row.amount, 2) + "</td>" +
            '<td class="num">' + num(row.picked) + '</td><td class="num">' + num(row.checked) + "</td>" +
            "<td>" + esc(row.zone || "-") + "</td><td>" + esc(row.doc_type || "-") + "</td><td>" + esc(row.freight_free || "-") + "</td>" +
            "<td>" + esc(row.region || "-") + "</td><td>" + esc(row.carrier || "-") + "</td><td>" + esc(row.dest_city || "-") + "</td>" +
            '<td class="small">' + esc(row.address || "") + "</td></tr>";
        }).join("");
        var summary = data.summary || {};
        var totals = '<tfoot><tr><td><b>合计</b></td><td></td><td></td><td></td><td></td><td></td>' +
          '<td class="num"><b>' + num(summary.lines) + '</b></td><td class="num"><b>' + num(summary.qty) + '</b></td><td class="num"><b>' + num(summary.amount, 2) +
          '</b></td><td class="num"><b>' + num(summary.picked) + '</b></td><td class="num"><b>' + num(summary.checked) + "</b></td></tr></tfoot>";
        todayBox.innerHTML = '<div class="table-wrap" style="max-height:320px"><table class="tbl" style="min-width:1650px"><thead>' +
          head + "</thead><tbody>" + (body || '<tr><td colspan="18">' + emptyHtml("今天还没有已登记的动力电池明细") + "</td></tr>") +
          "</tbody>" + (rows.length ? totals : "") + "</table></div>";
        setText("#bat-today-sum", rows.length ? ("当天 " + rows.length + " 条") : "当天 0 条");
      } catch (error) {
        todayBox.innerHTML = '<div class="widget-error">' + esc(error.message) + "</div>";
      }
    }

    async function load() {
      startLoading(box);
      modeButtons();
      try {
        var path = stateB.mode === "archive" ? "/api/battery/archive?" : "/api/battery/rows?";
        var data = await api(path + queryString());
        stateB.rows = data.rows || [];
        stateB.total = data.total || 0;
        render(data);
        loadToday();
      } catch (error) { showError(box, error, load); }
    }
    function render(data) {
      var rows = data.rows || [];
      var archiveMode = stateB.mode === "archive";
      var cols = archiveMode
        ? ["存档日期", "状态", "订单日期", "登记日期", "订单组号", "经销商", "备件编码", "备件名称", "行数", "数量", "金额", "拣货行数", "复核行数", "库区", "单据类型", "是否免运费", "区域", "承运商", "送达城市", "地址"]
        : ["", "状态", "订单日期", "登记日期", "订单组号", "经销商", "备件编码", "备件名称", "行数", "数量", "金额", "库区", "单据类型", "是否免运费", "区域", "承运商", "送达城市", "地址", "操作"];
      var head = "<tr>" + cols.map(function (label, index) {
        if (!archiveMode && index === 0) return '<th><input type="checkbox" id="bat-all"></th>';
        return "<th" + (label === "行数" || label === "数量" || label === "金额" || label === "拣货行数" || label === "复核行数" ? ' class="num"' : "") + ">" + esc(label) + "</th>";
      }).join("") + "</tr>";
      var body = rows.map(function (row) {
        var confirmed = Number(row.confirmed) === 1;
        var key = esc(JSON.stringify(payload(row)));
        var dealer = row.dealer_short || row.dealer_full || "-";
        var addr = row.address_matched ? esc(row.address || "") : '<span class="badge warn">未匹配地址</span>';
        var cells = [];
        if (archiveMode) cells.push("<td>" + esc(row.biz_date || "-") + "</td>");
        else cells.push('<td><input type="checkbox" class="bat-check" data-key="' + key + '"' + (confirmed ? " disabled" : "") + "></td>");
        cells = cells.concat([
          "<td>" + (confirmed ? '<span class="badge ok">已登记</span>' : '<span class="badge warn">待登记</span>') + "</td>",
          "<td>" + esc(row.order_date || "-") + "</td><td>" + esc(row.reg_date || "-") + "</td><td>" + esc(row.group_no) + "</td>",
          '<td title="' + esc(row.dealer_full || "") + '">' + esc(dealer) + "</td>",
          '<td><span class="mono">' + esc(row.part_code || "-") + "</span></td><td>" + esc(row.part_name || "-") + "</td>",
          '<td class="num">' + num(row.lines) + '</td><td class="num">' + num(row.qty) + "</td>",
          '<td class="num">' + (row.amount === null ? "-" : num(row.amount, 2)) + "</td>"
        ]);
        if (archiveMode) {
          cells.push('<td class="num">' + num(row.picked) + '</td><td class="num">' + num(row.checked) + "</td>");
        }
        cells = cells.concat([
          "<td>" + esc(row.zone || "-") + "</td><td>" + esc(row.doc_type || "-") + "</td><td>" + esc(row.freight_free || "-") + "</td>",
          "<td>" + esc(row.region || "-") + "</td><td>" + esc(row.carrier || "-") + "</td><td>" + esc(row.dest_city || "-") + "</td>",
          "<td class=\"small\">" + addr + "</td>"
        ]);
        if (!archiveMode) {
          var ops = "";
          if (canManage) {
            ops += '<button class="btn btn-sm btn-ghost" data-bat-address="' + key + '">' +
              (row.address_matched ? "修改地址/简称" : "录入地址") + "</button>";
            ops += confirmed
              ? '<button class="btn btn-sm btn-ghost" data-bat-unconfirm="' + key + '">取消登记</button>'
              : '<button class="btn btn-sm btn-primary" data-bat-confirm="' + key + '">登记</button>';
          }
          cells.push('<td class="nowrap">' + (ops || "-") + "</td>");
        }
        return "<tr>" + cells.join("") + "</tr>";
      }).join("");
      var foot = "";
      if (data.summary) {
        var t = data.summary;
        if (archiveMode) {
          foot = '<tfoot><tr><td><b>合计</b></td><td></td><td></td><td></td><td></td><td></td><td></td>' +
            '<td class="num"><b>' + num(t.lines) + '</b></td><td class="num"><b>' + num(t.qty) + '</b></td><td class="num"><b>' +
            (t.amount === null ? "-" : num(t.amount, 2)) + '</b></td><td class="num"><b>' + num(t.picked) +
            '</b></td><td class="num"><b>' + num(t.checked) + "</b></td></tr></tfoot>";
        }
      }
      box.innerHTML = '<div class="table-wrap" style="max-height:560px"><table class="tbl" style="min-width:' +
        (archiveMode ? "1500px" : "1560px") + '"><thead>' + head + "</thead><tbody>" +
        (body || '<tr><td colspan="' + cols.length + '">' + emptyHtml(archiveMode ? "没有电池存档" : "没有动力电池候选") + "</td></tr>") +
        "</tbody>" + foot + "</table></div>" +
        '<div class="pager" style="display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:8px">' +
        '<span class="small muted">共 ' + num(data.total) + " 条 · 第 " + num(data.page) + "/" + num(data.pages) + " 页</span>" +
        '<button class="btn btn-sm" id="bat-prev"' + (data.page <= 1 ? " disabled" : "") + ">上一页</button>" +
        '<button class="btn btn-sm" id="bat-next"' + (data.page >= data.pages ? " disabled" : "") + ">下一页</button></div>";
      setText("#bat-sum", "本页 " + rows.length + " 条 · " + num(data.total) + " 条");
      setText("#bat-parts-sum", archiveMode ? "存档快照（只读）" :
        (data.has_parts ? ("备件编码表：" + data.parts_count + " 个") : "备件编码表未导入，暂按“动力电池总成”匹配"));
      $("#bat-prev", view).addEventListener("click", function () { stateB.page = Math.max(1, stateB.page - 1); load(); });
      $("#bat-next", view).addEventListener("click", function () { stateB.page += 1; load(); });
      if (!archiveMode) {
        var all = $("#bat-all", view);
        if (all) all.addEventListener("change", function () { $$(".bat-check", view).forEach(function (x) { if (!x.disabled) x.checked = all.checked; }); });
      }
      $$("[data-bat-confirm]", view).forEach(function (btn) {
        btn.addEventListener("click", function () { confirmRows([JSON.parse(btn.getAttribute("data-bat-confirm"))]); });
      });
      $$("[data-bat-unconfirm]", view).forEach(function (btn) {
        btn.addEventListener("click", function () { unconfirmRows([JSON.parse(btn.getAttribute("data-bat-unconfirm"))]); });
      });
      $$("[data-bat-address]", view).forEach(function (btn) {
        var item = JSON.parse(btn.getAttribute("data-bat-address"));
        var row = rows.filter(function (r) {
          return r.order_date === item.order_date && r.group_no === item.group_no && r.part_code === item.part_code;
        })[0];
        btn.addEventListener("click", function () { editAddress(row); });
      });
    }

    function editAddress(row) {
      if (!row) return;
      var m = modal({
        title: "录入地址 · " + (row.dealer_short || row.dealer_full || ""),
        wide: true,
        body: '<div class="grid cols-2">' +
          '<div class="field"><label>经销商全称</label><input class="input" id="ba-full" value="' + esc(row.dealer_full || "") + '" readonly></div>' +
          '<div class="field"><label>经销商简称</label><input class="input" id="ba-short" value="' + esc(row.dealer_short || "") + '"></div>' +
          '<div class="field"><label>库区</label><input class="input" id="ba-zone" value="' + esc(row.zone || "") + '"></div>' +
          '<div class="field"><label>单据类型</label><input class="input" id="ba-doc" value="' + esc(row.doc_type || "") + '"></div>' +
          '<div class="field"><label>是否免运费</label><input class="input" id="ba-freight" value="' + esc(row.freight_free || "") + '"></div>' +
          '<div class="field"><label>区域</label><input class="input" id="ba-region" value="' + esc(row.region || "") + '"></div>' +
          '<div class="field"><label>承运商</label><input class="input" id="ba-carrier" value="' + esc(row.carrier || "") + '"></div>' +
          '<div class="field"><label>送达城市</label><input class="input" id="ba-city" value="' + esc(row.dest_city || "") + '"></div>' +
          "</div>" +
          '<div class="field"><label>地址</label><textarea class="input" id="ba-address" rows="3">' + esc(row.address || "") + "</textarea></div>",
        footer: '<button class="btn" data-cancel>取消</button><button class="btn btn-primary" data-ok>保存</button>'
      });
      $("[data-cancel]", m.el).addEventListener("click", m.close);
      $("[data-ok]", m.el).addEventListener("click", function () {
        api("/api/battery/dealers", {
          method: "POST",
          body: JSON.stringify({
            dealer_full: $("#ba-full", m.el).value.trim(),
            dealer_short: $("#ba-short", m.el).value.trim(),
            zone: $("#ba-zone", m.el).value.trim(),
            doc_type: $("#ba-doc", m.el).value.trim(),
            freight_free: $("#ba-freight", m.el).value.trim(),
            region: $("#ba-region", m.el).value.trim(),
            carrier: $("#ba-carrier", m.el).value.trim(),
            dest_city: $("#ba-city", m.el).value.trim(),
            address: $("#ba-address", m.el).value.trim()
          })
        }).then(function () { m.close(); toast("地址已保存，后续自动匹配", "ok"); load(); })
          .catch(function (error) { toast(error.message, "err"); });
      });
    }

    async function confirmRows(items) {
      if (!items.length) { toast("请先勾选待登记行", "warn"); return; }
      try {
        var result = await api("/api/battery/confirm", { method: "POST", body: JSON.stringify({ items: items }) });
        toast("已登记 " + (result.confirmed || 0) + " 条", "ok");
        await load();
      } catch (error) { toast(error.message, "err"); }
    }
    async function unconfirmRows(items) {
      if (!items.length) return;
      try {
        await api("/api/battery/unconfirm", { method: "POST", body: JSON.stringify({ items: items }) });
        toast("已取消登记", "ok");
        await load();
      } catch (error) { toast(error.message, "err"); }
    }
    $("#bat-search", view).addEventListener("click", function () {
      stateB.from = $("#bat-from", view).value; stateB.to = $("#bat-to", view).value;
      stateB.q = $("#bat-q", view).value.trim(); stateB.status = $("#bat-status", view).value;
      stateB.page = 1; load();
    });
    $("#bat-q", view).addEventListener("keydown", function (event) { if (event.key === "Enter") $("#bat-search", view).click(); });
    $("#bat-refresh", view).addEventListener("click", load);
    $("#bat-export", view).addEventListener("click", function () {
      window.location.href = "/api/export/battery.csv?" + queryString();
    });
    $("#bat-confirm-all", view) && $("#bat-confirm-all", view).addEventListener("click", function () {
      var items = $$(".bat-check:checked", view).map(function (x) { return JSON.parse(x.getAttribute("data-key")); });
      confirmRows(items);
    });
    $$("[data-bat-mode]", view).forEach(function (btn) {
      btn.addEventListener("click", function () { stateB.mode = btn.getAttribute("data-bat-mode"); stateB.page = 1; load(); });
    });
    $("#bat-archive-save", view) && $("#bat-archive-save", view).addEventListener("click", async function () {
      var day = stateB.mode === "archive" ? stateB.from : todayStr();
      if (!day) { toast("无法确定实际登记日期", "warn"); return; }
      var ok = await confirmDialog("存档动力电池", "按 " + day + " 存档当天动力电池明细？已有存档会覆盖。", "存档");
      if (!ok) return;
      try {
        await api("/api/battery/archive", { method: "POST", body: JSON.stringify({ date: day, force: true }) });
        toast("已存档 " + day, "ok");
        stateB.mode = "archive"; load();
      } catch (error) { toast(error.message, "err"); }
    });
    $("#bat-parts", view) && $("#bat-parts", view).addEventListener("change", async function () {
      var file = this.files && this.files[0];
      if (!file) return;
      try {
        var res = await fetch("/api/battery/parts/import", {
          method: "POST", credentials: "same-origin",
          headers: { "X-Dashboard-Client": "1" }, body: file
        });
        var data = await res.json();
        if (!res.ok) throw new Error(data.error || "导入失败");
        toast("备件表已导入 " + (data.count || 0) + " 条", "ok");
        this.value = ""; load();
      } catch (error) { toast(error.message, "err"); }
    });
    loadToday();
    load();
  }

  // ---------------------------------------------------------------- 波次登记
  async function pageWaves(view) {
    var canCreate = has("action.waves.create");
    var canUpdate = has("action.waves.update");
    var canDelete = has("action.waves.delete");
    view.innerHTML =
      '<div class="page-head"><div><div class="page-title">波次登记</div>' +
      '<div class="page-sub">业务日期 <b>' + esc(state.date) + "</b> · 当天要发运的波次在这里登记，系统自动带出订单组、行数、金额与进度</div></div>" +
      '<div class="toolbar">' +
        (canCreate ? '<button class="btn btn-primary" id="btn-add">新增波次</button>' : "") +
        '<button class="btn" id="btn-refresh">刷新</button>' +
      "</div></div>" +
      dateBanner() +
      '<div class="panel" style="margin-bottom:14px"><div class="panel-head">' +
        (canCreate ? '<button class="btn btn-sm" id="btn-toggle-cand">显示候选波次</button>' : "") +
        '<div class="panel-sub" id="cand-sum"></div></div>' +
      '<div class="panel-body flush" id="cand-box" style="display:none"></div></div>' +
      '<div class="panel"><div class="panel-head"><div class="panel-title">已登记波次</div>' +
      '<div class="panel-sub" id="wave-sum"></div></div>' +
      '<div class="panel-body flush" id="wave-box"></div></div>';
    bindDateBanner(view);

    async function loadWaves() {
      var token = state.routeToken;
      var box = $("#wave-box", view);
      startLoading(box);
      try {
        var data = await api("/api/waves?date=" + encodeURIComponent(state.date));
        if (token !== state.routeToken) return;
        var rows = data.rows.map(function (row) {
          var badge = row.pending
            ? ' <span class="badge warn" title="WMS 导出里还没有这个波次，文件到了会自动补全">待数据</span>'
            : (row.excluded_all ? ' <span class="badge">已全部移出</span>' : "");
          return '<tr data-id="' + row.id + '"><td>' + esc(row.wave_no) + badge + "</td>" +
            '<td class="num">' + row.groups + '</td><td class="num">' + row.lines + "</td>" +
            '<td class="num">' + (row.amount === null ? "-" : num(row.amount, 2)) + "</td>" +
            "<td>" + barHtml(row.rate) + "</td><td>" + esc(row.tms_carrier || (row.pending ? "-" : "未匹配")) + "</td>" +
            '<td class="small muted">' + esc(row.note || "") + "</td>" +
            '<td class="nowrap">' +
              '<button class="btn btn-sm btn-ghost" data-open="' + row.id + '">订单组</button>' +
              (canUpdate ? '<button class="btn btn-sm btn-ghost" data-edit="' + row.id + '">编辑</button>' : "") +
              (canDelete ? '<button class="btn btn-sm btn-danger" data-del="' + row.id + '">删除</button>' : "") +
            "</td></tr>";
        }).join("");
        box.innerHTML = '<div class="table-wrap"><table class="tbl"><thead><tr><th>波次号</th>' +
          '<th class="num">订单组</th><th class="num">行数</th><th class="num">金额(万)</th><th>出库进度</th>' +
          '<th>运输承运商</th><th>备注</th><th></th></tr></thead><tbody>' +
          (rows || '<tr><td colspan="8">' + emptyHtml("当天还没有登记波次") + "</td></tr>") + "</tbody></table></div>";
        setText("#wave-sum", "共 " + data.rows.length + " 个波次（待数据 " +
          data.rows.filter(function (r) { return r.pending; }).length + " 个）· " +
          num(data.rows.reduce(function (a, r) { return a + r.lines; }, 0)) + " 行");
        $$("[data-open]", box).forEach(function (btn) {
          btn.addEventListener("click", function (event) {
            event.stopPropagation();
            var row = data.rows.filter(function (r) { return String(r.id) === btn.getAttribute("data-open"); })[0];
            location.hash = "#/orders?wave=" + encodeURIComponent(row.wave_no);
          });
        });
        $$("[data-edit]", box).forEach(function (btn) {
          btn.addEventListener("click", function (event) {
            event.stopPropagation();
            var row = data.rows.filter(function (r) { return String(r.id) === btn.getAttribute("data-edit"); })[0];
            editWave(row);
          });
        });
        $$("[data-del]", box).forEach(function (btn) {
          btn.addEventListener("click", function (event) {
            event.stopPropagation();
            var id = btn.getAttribute("data-del");
            confirmDialog("删除波次登记", "删除后该波次不再计入当天单量与进度（可在审计里追溯）。确定删除？", "删除")
              .then(function (ok) {
                if (!ok) return;
                api("/api/waves/" + id, { method: "DELETE" }).then(function () {
                  toast("已删除", "ok");
                  loadWaves();
                }).catch(function (error) { toast(error.message, "err"); });
              });
          });
        });
      } catch (error) {
        showError(box, error, loadWaves);
      }
    }

    function editWave(row) {
      var m = modal({
        title: "编辑波次 " + row.wave_no,
        body:
          '<div class="field"><label>备注</label><input class="input" id="w-note" value="' + esc(row.note || "") + '"></div>' +
          '<div class="field"><label>指派承运商（覆盖线路映射，留空则按经销商映射）</label>' +
          '<input class="input" id="w-carrier" value="' + esc(row.carrier_override || "") + '" placeholder="如：民生物流 / 顺丰速运"></div>',
        footer: '<button class="btn" data-cancel>取消</button><button class="btn btn-primary" data-ok>保存</button>'
      });
      $("[data-cancel]", m.el).addEventListener("click", m.close);
      $("[data-ok]", m.el).addEventListener("click", function () {
        api("/api/waves/" + row.id, {
          method: "PUT",
          body: JSON.stringify({
            note: $("#w-note", m.el).value.trim(),
            carrier_override: $("#w-carrier", m.el).value.trim(),
            expected_updated_at: row.updated_at
          })
        }).then(function () { m.close(); toast("已保存", "ok"); loadWaves(); })
          .catch(function (error) { toast(error.message, "err"); });
      });
    }

    function addWaves() {
      var m = modal({
        title: "新增波次登记 · " + state.date,
        body:
          '<div class="field"><label>波次号（可多条：换行、逗号或空格分隔）</label>' +
          '<textarea class="input" id="w-list" placeholder="WAVE1090522088&#10;WAVE1090522090"></textarea></div>' +
          '<div class="small" style="margin-bottom:6px">将登记到业务日 <b>' + esc(state.date) + "</b>" +
          (state.date === todayStr() ? "（今天）" : "（<span style=\"color:#b25f00\">当前选的是历史日期</span>）") + "。</div>" +
          '<div class="small muted">提示：也可以先点「显示候选波次」勾选后一键登记。</div>',
        footer: '<button class="btn" data-cancel>取消</button><button class="btn btn-primary" data-ok>登记</button>'
      });
      $("[data-cancel]", m.el).addEventListener("click", m.close);
      $("[data-ok]", m.el).addEventListener("click", function () {
        var text = $("#w-list", m.el).value;
        api("/api/waves", {
          method: "POST",
          body: JSON.stringify({ date: state.date, waves: text })
        }).then(function (result) {
          m.close();
          var msg = "已登记 " + result.added.length + " 个波次";
          if (result.pending && result.pending.length) msg += "（其中 " + result.pending.length + " 个待数据）";
          if (result.skipped.length) msg += "，跳过 " + result.skipped.length + " 个";
          toast(msg, "ok");
          if (result.skipped.length) {
            var detail = result.skipped.map(function (s) { return s.wave_no + "：" + s.reason; }).join("\n");
            modal({ title: "部分波次未登记", body: '<pre class="small" style="white-space:pre-wrap">' + esc(detail) + "</pre>" });
          }
          loadWaves();
          if ($("#cand-box", view).style.display !== "none") loadCandidates();
        }).catch(function (error) { toast(error.message, "err"); });
      });
    }

    async function loadCandidates() {
      var box = $("#cand-box", view);
      startLoading(box, "加载候选波次");
      try {
        var data = await api("/api/waves/candidates?date=" + encodeURIComponent(state.date));
        var rows = data.rows.map(function (row) {
          return '<tr><td><input type="checkbox" data-wave="' + esc(row.wave_no) + '"></td>' +
            "<td>" + esc(row.wave_no) + '</td><td class="num">' + row.groups + '</td><td class="num">' + row.lines +
            '</td><td class="num">' + (row.amount === null ? "-" : num(row.amount, 2)) +
            "</td><td>" + esc(row.order_date || "") + "</td><td>" + esc(row.wave_time || "") + "</td></tr>";
        }).join("");
        box.innerHTML = '<div class="panel-body"><div class="toolbar" style="margin-bottom:8px">' +
          '<button class="btn btn-sm" id="cand-all">全选</button>' +
          '<button class="btn btn-sm btn-primary" id="cand-add">登记所选</button>' +
          '<span class="panel-sub" id="cand-hint"></span></div></div>' +
          '<div class="table-wrap" style="max-height:360px"><table class="tbl"><thead><tr><th></th><th>波次号</th>' +
          '<th class="num">订单组</th><th class="num">行数</th><th class="num">金额(万)</th><th>订单日期</th><th>波次生成</th>' +
          "</tr></thead><tbody>" + (rows || '<tr><td colspan="7">' + emptyHtml("没有候选波次（发运表里都登记过了）") + "</td></tr>") +
          "</tbody></table></div>";
        setText("#cand-sum", "发运表里还有 " + data.rows.length + " 个未登记波次");
        $("#cand-all", box).addEventListener("click", function () {
          var boxes = $$('input[data-wave]', box);
          var allChecked = boxes.every(function (b) { return b.checked; });
          boxes.forEach(function (b) { b.checked = !allChecked; });
        });
        $("#cand-add", box).addEventListener("click", function () {
          var waves = $$('input[data-wave]:checked', box).map(function (b) { return b.getAttribute("data-wave"); });
          if (!waves.length) { toast("请先勾选波次", "warn"); return; }
          api("/api/waves", { method: "POST", body: JSON.stringify({ date: state.date, waves: waves }) })
            .then(function (result) {
              var msg = "已登记 " + result.added.length + " 个波次";
              if (result.pending && result.pending.length) msg += "（其中 " + result.pending.length + " 个待数据）";
              toast(msg, "ok");
              loadWaves();
              loadCandidates();
            }).catch(function (error) { toast(error.message, "err"); });
        });
      } catch (error) {
        showError(box, error, loadCandidates);
      }
    }

    if (canCreate) {
      $("#btn-add", view).addEventListener("click", addWaves);
      $("#btn-toggle-cand", view).addEventListener("click", function () {
        var box = $("#cand-box", view);
        var show = box.style.display === "none";
        box.style.display = show ? "" : "none";
        setText("#btn-toggle-cand", show ? "隐藏候选波次" : "显示候选波次");
        if (show) loadCandidates();
      });
    }
    $("#btn-refresh", view).addEventListener("click", function () { loadWaves(); });
    loadWaves();
  }

  // ---------------------------------------------------------------- 数据源
  // ---------------------------------------------------------------- 出库文件归档
  async function pageOutboundArchive(view) {
    view.innerHTML =
      '<div class="page-head"><div><div class="page-title">出库归档</div>' +
      '<div class="page-sub">读取【出库】出库流程节点时间跟踪(配送中心)文件；按业务日保存归档，可按日期、表头筛选和导出</div></div>' +
      '<div class="toolbar">' +
        (has("action.scan") ? '<button class="btn btn-primary" id="oa-scan">立即扫描</button>' : "") +
      "</div></div>" +
      '<div class="panel" id="oa-panel"><div class="panel-head"><div class="panel-title">归档数据</div>' +
      '<div class="panel-sub" id="oa-sum">加载中…</div>' +
      '<div class="toolbar"><select class="select" id="oa-date" style="height:30px;min-width:160px"></select></div></div>' +
      '<div class="panel-body" id="oa-body"><div class="small muted">加载中…</div></div></div>';

    var oa = { meta: null, dates: [], bizDate: "", page: 1, page_size: 50, data: null, dateCol: "", from: "", to: "" };

    function fmtBytes(n) {
      var value = Number(n) || 0;
      if (value < 1024) return value + " B";
      if (value < 1024 * 1024) return (value / 1024).toFixed(1) + " KB";
      if (value < 1024 * 1024 * 1024) return (value / 1024 / 1024).toFixed(1) + " MB";
      return (value / 1024 / 1024 / 1024).toFixed(2) + " GB";
    }

    function condRows() {
      var headers = (oa.meta && oa.meta.headers) || [];
      var preferred = ["状态", "订单类型", "区"];
      var rows = "";
      for (var i = 0; i < 3; i++) {
        var options = headers.map(function (h) {
          return '<option value="' + esc(h) + '"' + (h === preferred[i] ? " selected" : "") + ">" + esc(h) + "</option>";
        }).join("");
        rows += '<div class="oa-cond" style="display:flex;gap:6px;align-items:center;margin-bottom:6px">' +
          '<select class="select oa-col" style="height:30px;max-width:220px">' + options + "</select>" +
          '<select class="select oa-op" style="height:30px;width:100px"><option value="contains">包含</option><option value="eq">等于</option></select>' +
          '<input class="input oa-val" placeholder="筛选值（留空不筛选）" style="height:30px;flex:1;min-width:150px">' +
          "</div>";
      }
      return rows;
    }

    function dateOptions() {
      var cols = (oa.meta && oa.meta.date_columns) || [];
      if (!cols.length) return '<option value="">（无日期列）</option>';
      return cols.map(function (h) {
        return '<option value="' + esc(h) + '"' + (h === oa.dateCol ? " selected" : "") + ">" + esc(h) + "</option>";
      }).join("");
    }

    function readFilters() {
      var filters = [];
      $$(".oa-cond", view).forEach(function (row) {
        var col = $(".oa-col", row).value;
        var val = $(".oa-val", row).value.trim();
        if (!col || !val) return;
        filters.push({ col: col, op: $(".oa-op", row).value, value: val });
      });
      return filters;
    }

    function buildQuery() {
      var params = new URLSearchParams();
      (readFilters() || []).forEach(function (f) {
        params.append("col", f.col);
        params.append("op", f.op);
        params.append("val", f.value);
      });
      if (oa.bizDate) params.set("date", oa.bizDate);
      if (oa.dateCol) params.set("date_col", oa.dateCol);
      if (oa.from) params.set("from", oa.from);
      if (oa.to) params.set("to", oa.to);
      params.set("page", String(oa.page));
      params.set("page_size", String(oa.page_size));
      return params.toString();
    }

    function renderShell() {
      var meta = oa.meta;
      var dateSel = $("#oa-date", view);
      if (dateSel) {
        dateSel.innerHTML = (oa.dates || []).map(function (item) {
          return '<option value="' + esc(item.biz_date) + '"' + (item.biz_date === oa.bizDate ? " selected" : "") + ">" +
            esc(item.biz_date) + "（" + num(item.rows) + " 行）</option>";
        }).join("");
      }
      setText("#oa-sum", meta
        ? esc(meta.biz_date || oa.bizDate || "") + " · " + esc(meta.name || "") + " · 更新 " + esc(meta.updated_at || "-") + " · 共 " + num(meta.rows) +
          " 行 · " + num((meta.headers || []).length) + " 列 · " + fmtBytes(meta.stored_bytes)
        : "尚未归档");
      var body = $("#oa-body", view);
      if (!body) return;
      if (!meta) {
        body.innerHTML = emptyHtml("还没有出库归档：把【出库】出库流程节点时间跟踪(配送中心) 文件放进数据源目录，再点「立即扫描」");
        return;
      }
      body.innerHTML =
        '<div class="grid cols-2" style="margin-bottom:10px;gap:10px">' +
          '<div class="field" style="margin:0"><label>日期列</label><select class="select" id="oa-date-col" style="height:30px">' +
            dateOptions() + "</select></div>" +
          '<div class="field" style="margin:0"><label>日期区间</label><div style="display:flex;gap:6px;align-items:center">' +
            '<input class="input" id="oa-from" type="date" style="height:30px;flex:1" value="' + esc(oa.from) + '">' +
            '<span>—</span>' +
            '<input class="input" id="oa-to" type="date" style="height:30px;flex:1" value="' + esc(oa.to) + '">' +
          "</div></div>" +
        "</div>" +
        '<div class="field"><label>按文件表头内容筛选（最多 3 个条件）</label>' + condRows() + "</div>" +
        '<div class="toolbar" style="margin-bottom:10px">' +
          '<button class="btn btn-primary" id="oa-query">查询</button>' +
          '<button class="btn" id="oa-reset">重置</button>' +
          '<button class="btn" id="oa-export">导出筛选 CSV</button>' +
          '<span class="small muted" id="oa-total"></span>' +
        "</div>" +
        '<div id="oa-table"></div>';

      if ($("#oa-date", view)) $("#oa-date", view).addEventListener("change", function () {
        oa.bizDate = this.value; oa.page = 1; oa.data = null; loadMeta();
      });
      $("#oa-date-col", view).addEventListener("change", function () { oa.dateCol = this.value; });
      $("#oa-from", view).addEventListener("change", function () { oa.from = this.value; });
      $("#oa-to", view).addEventListener("change", function () { oa.to = this.value; });
      $("#oa-query", view).addEventListener("click", function () { oa.page = 1; loadRows(); });
      $("#oa-reset", view).addEventListener("click", function () {
        oa.dateCol = (oa.meta.date_columns || [])[0] || "";
        oa.from = ""; oa.to = ""; oa.page = 1;
        $$(".oa-val", view).forEach(function (x) { x.value = ""; });
        $$(".oa-col", view).forEach(function (x) { x.selectedIndex = 0; });
        renderShell();
      });
      $("#oa-export", view).addEventListener("click", function () {
        var params = new URLSearchParams();
        readFilters().forEach(function (f) {
          params.append("col", f.col);
          params.append("op", f.op);
          params.append("val", f.value);
        });
        if (oa.bizDate) params.set("date", oa.bizDate);
        if (oa.dateCol) params.set("date_col", oa.dateCol);
        if (oa.from) params.set("from", oa.from);
        if (oa.to) params.set("to", oa.to);
        window.location.href = "/api/export/outbound-archive.csv?" + params.toString();
      });
      loadRows();
    }

    function tableView(data) {
      var headers = (data.meta && data.meta.headers) || [];
      var rows = data.rows || [];
      if (!rows.length) return emptyHtml("没有符合条件的数据");
      var head = "<tr><th>#</th>" + headers.map(function (h) { return "<th>" + esc(h) + "</th>"; }).join("") + "</tr>";
      var body = rows.map(function (row, index) {
        var offset = (data.page - 1) * data.page_size + index + 1;
        return "<tr><td>" + offset + "</td>" + headers.map(function (_h, i) {
          var v = row[i];
          if (v === null || v === undefined) return "<td>-</td>";
          if (typeof v === "number") return '<td class="num">' + num(v, 2) + "</td>";
          return "<td>" + esc(v) + "</td>";
        }).join("") + "</tr>";
      }).join("");
      return '<div class="table-wrap" style="max-height:62vh"><table class="tbl oa-data" style="min-width:3600px"><thead>' +
        head + "</thead><tbody>" + body + "</tbody></table></div>";
    }

    function renderPager(data) {
      var total = data.total || 0;
      var page = data.page || 1;
      var pages = data.pages || 1;
      return '<div class="pager" style="display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:10px">' +
        '<span class="small muted">共 ' + num(total) + " 行 · 第 " + page + "/" + pages + " 页</span>" +
        '<button class="btn btn-sm" data-oa-prev ' + (page <= 1 ? "disabled" : "") + ">上一页</button>" +
        '<button class="btn btn-sm" data-oa-next ' + (page >= pages ? "disabled" : "") + ">下一页</button></div>";
    }

    async function loadRows() {
      var table = $("#oa-table", view);
      if (!table) return;
      table.innerHTML = '<div class="small muted">查询中…</div>';
      try {
        var data = await api("/api/outbound-archive/query?" + buildQuery());
        oa.data = data;
        setText("#oa-total", "筛选后 " + num(data.total) + " 行 / 全部 " + num((data.meta || {}).rows || 0) + " 行");
        table.innerHTML = tableView(data) + renderPager(data);
        $$("[data-oa-prev]", view).forEach(function (btn) {
          btn.addEventListener("click", function () { oa.page = Math.max(1, oa.page - 1); loadRows(); });
        });
        $$("[data-oa-next]", view).forEach(function (btn) {
          btn.addEventListener("click", function () { oa.page += 1; loadRows(); });
        });
      } catch (error) {
        table.innerHTML = '<div class="widget-error">' + esc(error.message) + "</div>";
      }
    }

    async function loadMeta() {
      try {
        var res = await api("/api/outbound-archive" + (oa.bizDate ? "?date=" + encodeURIComponent(oa.bizDate) : ""));
        oa.dates = res.dates || [];
        if (!oa.bizDate && oa.dates.length) oa.bizDate = oa.dates[0].biz_date;
        oa.meta = res.archive || null;
        if (oa.meta) {
          var dcols = oa.meta.date_columns || [];
          oa.dateCol = dcols.indexOf("订单日期") >= 0 ? "订单日期" : (dcols[0] || "");
        }
        renderShell();
      } catch (error) {
        $("#oa-body", view).innerHTML = '<div class="widget-error">' + esc(error.message) + "</div>";
      }
    }

    if (has("action.scan")) {
      $("#oa-scan", view).addEventListener("click", function () {
        var btn = this;
        btn.disabled = true;
        btn.textContent = "扫描中…";
        api("/api/scan", { method: "POST" }).then(function () {
          toast("扫描完成", "ok");
          loadMeta();
        }).catch(function (error) {
          toast(error.message, "err");
        }).finally(function () {
          btn.disabled = false;
          btn.textContent = "立即扫描";
        });
      });
    }
    await loadMeta();
  }

  async function pageSources(view) {
    var filePage = 1;
    var fileGroup = false;
    view.innerHTML =
      '<div class="page-head"><div><div class="page-title">数据源</div>' +
      '<div class="page-sub">把 WMS「发运表」与 TMS「运输单状态」的下载文件丢进下面目录即可，系统自动识别</div></div>' +
      '<div class="toolbar">' +
        (has("action.scan") ? '<button class="btn btn-primary" id="btn-scan">立即扫描</button>' : "") +
        (has("action.dealers.manage") ? '<label class="btn" style="cursor:pointer">导入经销商 XLSX<input type="file" id="f-dealer" accept=".xlsx,.xlsm" style="display:none"></label>' : "") +
      "</div></div>" +
      '<div class="grid cols-2" style="margin-bottom:14px"><div id="p-dirs"></div><div id="p-unmatched"></div></div>' +
      '<div class="panel" style="margin-bottom:14px"><div class="panel-head"><div class="panel-title">文件台账</div>' +
        '<label class="check small" style="margin-left:auto"><input type="checkbox" id="f-file-group"> 合并同名版本</label></div>' +
      '<div class="panel-body flush" id="p-files"></div></div>' +
      '<div class="panel" style="margin-bottom:14px" id="p-wms-panel">' +
        '<div class="panel-head"><div class="panel-title">WMS 自动下载</div>' +
        '<div class="panel-sub" id="wms-status">加载中…</div></div>' +
        '<div class="panel-body" id="p-wms"></div></div>' +
      '<div class="panel" style="margin-bottom:14px"><div class="panel-head">' +
        '<div class="panel-title">每日归档（订单组 / 人效）</div>' +
        '<div class="panel-sub" id="arch-sum"></div></div>' +
      '<div class="panel-body" id="p-archives"></div></div>' +
      '<div class="panel"><div class="panel-head"><div class="panel-title">未映射经销商</div>' +
      '<div class="small muted" id="unmapped-sum"></div>' +
      (has("action.dealers.manage")
        ? '<div class="toolbar">' +
            '<button class="btn btn-sm" id="btn-unmapped-export">导出未映射 CSV</button>' +
            '<label class="btn btn-sm" style="cursor:pointer">批量导入更新' +
            '<input type="file" id="f-unmapped" accept=".csv" style="display:none"></label>' +
          "</div>"
        : "") +
      '</div><div class="panel-body flush" id="p-unmapped"></div></div>';

    async function load() {
      var token = state.routeToken;
      try {
        var data = await api("/api/sources?file_page=" + filePage + "&file_page_size=10&file_group=" + (fileGroup ? "1" : "0"));
        if (token !== state.routeToken) return;
        $("#p-dirs", view).innerHTML = panel("数据源目录", "");
        var range = data.data_range || {};
        $("[data-panel-body]", $("#p-dirs", view)).innerHTML =
          '<div style="display:flex;flex-direction:column;gap:8px">' +
          data.dirs.map(function (dir) {
            return '<div><span class="badge ' + (dir.ok ? "ok" : "danger") + '">' + (dir.ok ? "可达" : "不可达") +
              '</span> <span class="small mono">' + esc(dir.path) + "</span></div>";
          }).join("") + "</div>" +
          '<div class="small" style="margin-top:10px">发运数据覆盖：<b>' + esc(range.min || "-") + " ~ " +
          esc(range.max || "-") + "</b>（" + (range.days || 0) + " 天）</div>" +
          '<div class="small muted" style="margin-top:4px">每 ' + data.scan_sec + " 秒自动扫描一次 · 上次扫描：" +
          esc(data.last_scan || "-") + "</div>" +
          (data.last_scan_error
            ? '<div class="small" style="margin-top:6px;color:#c92a2a">上次扫描告警：' + esc(data.last_scan_error) + "</div>"
            : "") +
          ((data.archived_dates || []).length
            ? '<div class="small muted" style="margin-top:6px">已存档日期：' +
              esc(data.archived_dates.map(function (x) { return x.biz_date + "(" + x.rows + ")"; }).join("、")) + "</div>"
            : "");

        $("#p-unmatched", view).innerHTML = panel("运输单未匹配波次", "");
        $("[data-panel-body]", $("#p-unmatched", view)).innerHTML = data.tms_unmatched.length
          ? '<div style="display:flex;flex-wrap:wrap;gap:6px">' + data.tms_unmatched.map(function (w) {
              return '<span class="badge warn">' + esc(w) + "</span>";
            }).join("") + "</div>"
          : emptyHtml("全部波次都能在 TMS 里找到");

        var fileRows = data.files || [];
        var pager = '<div class="pager" style="display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:8px">' +
          '<span class="small muted">共 ' + num(data.file_total) + " 个文件 · 第 " + num(data.file_page) + "/" +
          num(data.file_pages) + ' 页</span>' +
          '<button class="btn btn-sm" data-file-prev ' + (Number(data.file_page) <= 1 ? "disabled" : "") + ">上一页</button>" +
          '<button class="btn btn-sm" data-file-next ' + (Number(data.file_page) >= Number(data.file_pages) ? "disabled" : "") + ">下一页</button></div>";
        $("#p-files", view).innerHTML =
          '<div class="table-wrap" style="max-height:430px"><table class="tbl"><thead><tr><th>文件</th><th>类型</th><th class="num">行数</th>' +
          '<th class="num">版本</th><th>内容日期</th><th>状态</th><th>导入时间</th><th>说明</th></tr></thead><tbody>' +
          (fileRows.length ? fileRows.map(function (file) {
            var cls = file.status === "ok" ? "ok" : file.status === "unknown" ? "warn" : "danger";
            var label = file.status === "ok" ? "正常" : file.status === "unknown" ? "未识别" : file.status === "partial" ? "部分成功" : "失败";
            return "<tr><td>" + esc(file.name) +
              (file.exists === false ? ' <span class="badge warn" title="Z 盘已不存在该文件，保留历史台账">源文件已移除</span>' : "") +
              "</td><td>" + esc(file.kind || "-") +
              '</td><td class="num">' + num(file.rows) + '</td><td class="num">' + num(file.versions || 1) +
              '</td><td class="small">' + esc(file.biz_dates || "-") +
              (file.content_date_mismatch ? ' <span class="badge warn" title="文件名日期不在实际订单日期中">日期不一致</span>' : "") +
              '</td><td><span class="badge ' + cls + '">' + label +
              "</span></td><td>" + esc(file.imported_at || "") + '</td><td class="small muted">' + esc(file.error || "") + "</td></tr>";
          }).join("") : '<tr><td colspan="8">' + emptyHtml("还没有导入任何文件") + "</td></tr>") +
          "</tbody></table></div>" + pager;
        $$("[data-file-prev]", view).forEach(function (btn) {
          btn.addEventListener("click", function () { if (filePage > 1) { filePage -= 1; load(); } });
        });
        $$("[data-file-next]", view).forEach(function (btn) {
          btn.addEventListener("click", function () { if (filePage < Number(data.file_pages)) { filePage += 1; load(); } });
        });
        var groupToggle = $("#f-file-group", view);
        if (groupToggle) {
          groupToggle.checked = fileGroup;
          groupToggle.onchange = function () { fileGroup = this.checked; filePage = 1; load(); };
        }

        setText("#unmapped-sum", "共 " + data.unmapped_count + " 个，建议补全映射后单量分类才完整");
        $("#p-unmapped", view).innerHTML = data.unmapped.length
          ? '<div class="table-wrap"><table class="tbl"><thead><tr><th>经销商全称</th><th class="num">行数</th>' +
            '<th class="num">金额(万)</th><th></th></tr></thead><tbody>' +
            data.unmapped.slice(0, 100).map(function (item) {
              return "<tr><td>" + esc(item.full_name) + '</td><td class="num">' + item.lines +
                '</td><td class="num">' + (item.amount === null ? "-" : num(item.amount, 2)) + "</td>" +
                '<td><button class="btn btn-sm btn-ghost" data-map="' + esc(item.full_name) + '">补映射</button></td></tr>';
            }).join("") + "</tbody></table></div>"
          : emptyHtml("所有经销商都已映射");
        $$("[data-map]", view).forEach(function (btn) {
          btn.addEventListener("click", function () { editDealer({ full_name: btn.getAttribute("data-map"), short_name: "", region: "", route: "" }); });
        });
        state.sources = data;
        await loadDailyArchives();
        await loadWms();
      } catch (error) {
        toast(error.message, "err");
      }
    }

    // ---------------------------------------------------------------- WMS 自动下载
    var wmsState = null;

    async function loadWms() {
      var token = state.routeToken;
      try {
        var data = await api("/api/wms-download?tail=120");
        if (token !== state.routeToken || !$("#p-wms", view)) return;
        wmsState = data;
        renderWms(data);
      } catch (error) {
        var box = $("#p-wms", view);
        if (box) box.innerHTML = '<div class="widget-error">' + esc(error.message) + "</div>";
      }
    }

    function wmsStatusText(data) {
      var task = data.task || {};
      var last = data.lastRun || {};
      var parts = [];
      parts.push(task.installed ? (task.enabled ? "定时：已启用" : "定时：已暂停") : "定时：未安装");
      if (task.nextRun) parts.push("下次 " + task.nextRun);
      if (last.running) parts.push("当前运行中");
      else if (last.exitCode === 0) parts.push("最近：成功");
      else if (last.exitCode !== undefined && last.exitCode !== null) parts.push("最近：失败");
      else parts.push("最近：暂无运行");
      if (task.lastResult !== undefined && task.lastResult !== null) parts.push("任务结果 " + task.lastResult);
      if (task.needs_reinstall) parts.push("启动器缺失，请重新应用定时任务");
      if (data.latest && data.latest.file) parts.push("最近文件 " + data.latest.file.imported_at);
      return parts.join(" · ");
    }

    function renderWms(data) {
      setText("#wms-status", wmsStatusText(data));
      var host = $("#p-wms", view);
      if (!host) return;
      var cfg = data.config || {};
      var schedule = cfg.schedule || {};
      var can = has("action.scan");
      var mode = schedule.mode === "daily" ? "daily" : "interval";
      var enabled = data.task && data.task.enabled;
      var latest = data.latest || {};
      var latestText = latest.file
        ? "最近导入：" + esc(latest.file.name) + " · " + num(latest.file.rows) + " 行 · " + esc(latest.file.imported_at)
        : "还没有导入过出库文件";
      var lastText = (data.lastSummary || "").replace(/^\[[^\]]+\]\s*/, "");
      host.innerHTML =
        '<div class="small muted" style="margin-bottom:10px">' +
          "登录方式：" + esc(cfg.loginMode || "aTrust SSO / 复用已登录会话") +
          " · " + latestText +
          (lastText ? " · 最近日志：" + esc(lastText.slice(0, 120)) : "") +
        "</div>" +
        '<div class="grid cols-2">' +
          '<div class="field"><label>WMS 地址</label><input class="input wms-input" id="wms-url" value="' + esc(cfg.url || "") + '"></div>' +
          '<div class="field"><label>下载目录</label><input class="input wms-input" id="wms-deliver" value="' + esc(cfg.deliverDir || "") + '"></div>' +
        "</div>" +
        '<div class="grid cols-3">' +
          '<div class="field"><label>查询日期</label><select class="select wms-input" id="wms-date-mode">' +
            ["today|今天", "yesterday|昨天", "fixed|固定日期", "relative|相对今天"].map(function (item) {
              var pair = item.split("|");
              return '<option value="' + pair[0] + '"' + (cfg.dateMode === pair[0] ? " selected" : "") + ">" + pair[1] + "</option>";
            }).join("") +
          "</select></div>" +
          '<div class="field" id="wms-fixed-wrap"><label>固定日期</label><input class="input wms-input" id="wms-fixed" type="date" value="' + esc(cfg.fixedDate || "") + '"></div>' +
          '<div class="field" id="wms-relative-wrap"><label>相对今天（天）</label><input class="input wms-input" id="wms-relative" type="number" min="-365" max="365" value="' + esc(cfg.relativeDays || 0) + '"></div>' +
        "</div>" +
        '<div class="grid cols-2">' +
          '<div class="field"><label>执行方式</label><select class="select wms-input" id="wms-schedule-mode">' +
            '<option value="interval"' + (mode === "interval" ? " selected" : "") + ">间隔执行</option>" +
            '<option value="daily"' + (mode === "daily" ? " selected" : "") + ">每天固定时间</option>" +
          "</select></div>" +
          '<div class="field" id="wms-times-wrap"><label>每天时间点（逗号分隔）</label><input class="input wms-input" id="wms-times" value="' + esc((schedule.times || ["08:30"]).join(",")) + '"></div>' +
        "</div>" +
        '<div class="grid cols-3" id="wms-interval-wrap">' +
          '<div class="field"><label>间隔分钟</label><input class="input wms-input" id="wms-interval" type="number" min="1" max="1440" value="' + esc(schedule.intervalMinutes || 10) + '"></div>' +
          '<div class="field"><label>开始时间</label><input class="input wms-input" id="wms-start" type="time" value="' + esc(schedule.startTime || "08:00") + '"></div>' +
          '<div class="field"><label>结束时间</label><input class="input wms-input" id="wms-end" type="time" value="' + esc(schedule.endTime || "21:00") + '"></div>' +
        "</div>" +
        '<div class="toolbar" style="margin-top:2px;gap:8px">' +
          '<button class="btn btn-primary" id="wms-save" ' + (can ? "" : "disabled") + ">保存配置</button>" +
          '<button class="btn" id="wms-run" ' + (can ? "" : "disabled") + ">立即下载</button>" +
          '<button class="btn" id="wms-install" ' + (can ? "" : "disabled") + ">" + (enabled ? "更新定时任务" : "启用定时任务") + "</button>" +
          '<button class="btn" id="wms-pause" ' + (can && data.task && data.task.installed ? "" : "disabled") + ">暂停</button>" +
          '<button class="btn btn-ghost" id="wms-remove" ' + (can && data.task && data.task.installed ? "" : "disabled") + ">移除任务</button>" +
          '<button class="btn btn-ghost" id="wms-logs">查看日志</button>' +
          '<span class="small muted" id="wms-run-hint"></span>' +
        "</div>";
      if (!can) {
        $$(".wms-input", host).forEach(function (el) { el.disabled = true; });
      }
      function syncWmsFields() {
        var dm = $("#wms-date-mode", host).value;
        $("#wms-fixed-wrap", host).style.display = dm === "fixed" ? "" : "none";
        $("#wms-relative-wrap", host).style.display = dm === "relative" ? "" : "none";
        var sm = $("#wms-schedule-mode", host).value;
        $("#wms-interval-wrap", host).style.display = sm === "interval" ? "" : "none";
        $("#wms-times-wrap", host).style.display = sm === "daily" ? "" : "none";
      }
      $("#wms-date-mode", host).addEventListener("change", syncWmsFields);
      $("#wms-schedule-mode", host).addEventListener("change", syncWmsFields);
      syncWmsFields();
      if (!can) return;

      function collectWms() {
        var sm = $("#wms-schedule-mode", host).value;
        var schedulePayload = {
          mode: sm,
          intervalMinutes: Number($("#wms-interval", host).value) || 10,
          startTime: $("#wms-start", host).value || "08:00",
          endTime: $("#wms-end", host).value || "21:00",
          times: ($("#wms-times", host).value || "08:30").split(",").map(function (x) { return x.trim(); }).filter(Boolean)
        };
        return {
          url: $("#wms-url", host).value.trim(),
          dateMode: $("#wms-date-mode", host).value,
          fixedDate: $("#wms-fixed", host).value,
          relativeDays: Number($("#wms-relative", host).value) || 0,
          deliverDir: $("#wms-deliver", host).value.trim(),
          schedule: schedulePayload
        };
      }
      async function saveWms(silent) {
        var data = await api("/api/wms-download/config", { method: "PUT", body: JSON.stringify(collectWms()) });
        wmsState = data;
        renderWms(data);
        if (!silent) toast("WMS 配置已保存", "ok");
        return data;
      }
      $("#wms-save", host).addEventListener("click", function () {
        saveWms(false).catch(function (error) { toast(error.message, "err"); });
      });
      $("#wms-install", host).addEventListener("click", async function () {
        var btn = this; btn.disabled = true; btn.textContent = "应用中…";
        try {
          await saveWms(true);
          var data = await api("/api/wms-download/schedule", { method: "POST", body: JSON.stringify({ action: "install" }) });
          toast("定时任务已启用", "ok");
          if (data && data.state) renderWms(data.state);
        } catch (error) { toast(error.message, "err"); }
        finally { btn.disabled = false; btn.textContent = "更新定时任务"; }
      });
      $("#wms-pause", host).addEventListener("click", async function () {
        try {
          await api("/api/wms-download/schedule", { method: "POST", body: JSON.stringify({ action: "disable" }) });
          toast("定时任务已暂停", "ok");
          await loadWms();
        } catch (error) { toast(error.message, "err"); }
      });
      $("#wms-remove", host).addEventListener("click", async function () {
        if (!await confirmDialog("移除定时任务", "确定删除 WMS 定时任务？配置和已下载文件不受影响。", "移除")) return;
        try {
          await api("/api/wms-download/schedule", { method: "POST", body: JSON.stringify({ action: "remove" }) });
          toast("定时任务已移除", "ok");
          await loadWms();
        } catch (error) { toast(error.message, "err"); }
      });
      $("#wms-run", host).addEventListener("click", async function () {
        var btn = this; btn.disabled = true;
        var hint = $("#wms-run-hint", host);
        try {
          await saveWms(true);
          var started = await api("/api/wms-download/run", { method: "POST", body: JSON.stringify({ date: "" }) });
          hint.textContent = "正在下载，请稍候…";
          var deadline = Date.now() + 180000;
          var status = null;
          while (Date.now() < deadline) {
            await new Promise(function (resolve) { setTimeout(resolve, 2500); });
            var run = await api("/api/wms-download/run");
            status = run.run || {};
            if (!status.running) break;
            hint.textContent = "正在下载（" + Math.round((Date.now() - Date.parse(status.startedAt || new Date().toISOString())) / 1000) + "s）…";
          }
          if (status && status.running) {
            hint.textContent = "仍在运行，请稍后在日志查看";
            toast("下载仍在运行", "warn");
          } else if (status && status.exitCode === 0) {
            hint.textContent = "已完成，正在扫描导入…";
            await api("/api/scan", { method: "POST" }).catch(function () {});
            toast("WMS 下载完成", "ok");
            await load();
          } else {
            hint.textContent = "失败，请查看日志";
            toast("WMS 下载失败，请查看日志", "err");
            await loadWms();
          }
        } catch (error) {
          hint.textContent = "";
          toast(error.message, "err");
        } finally {
          btn.disabled = false;
        }
      });
      $("#wms-logs", host).addEventListener("click", function () { showWmsLogs(); });
    }

    async function showWmsLogs() {
      var m = modal({ title: "WMS 下载日志", wide: true, body: '<div class="small muted">加载中…</div>' });
      async function render() {
        try {
          var data = await api("/api/wms-download/log?tail=200");
          $(".modal-body", m.el).innerHTML =
            '<div class="small muted" style="margin-bottom:6px">最近运行日志（尾部 200 行）</div>' +
            '<pre class="wms-log">' + esc(data.run || "（暂无）") + "</pre>" +
            '<div class="toolbar" style="margin-top:8px"><button class="btn btn-sm" id="wms-log-refresh">刷新</button></div>';
          $("#wms-log-refresh", m.el).addEventListener("click", render);
        } catch (error) {
          $(".modal-body", m.el).innerHTML = '<div class="widget-error">' + esc(error.message) + "</div>";
        }
      }
      render();
    }

    async function loadDailyArchives() {
      var token = state.routeToken;
      var data = await api("/api/archive/list");
      if (token !== state.routeToken || !$("#p-archives", view)) return;
      setText("#arch-sum",
        "自动归档已开启：扫描发现新增/变更时覆盖受影响日期" +
        (data.last_archive_scan ? " · 上次自动归档：" + data.last_archive_scan : ""));
      function block(title, rows, type) {
        return '<div><div class="panel-sub" style="margin-bottom:6px"><b>' + esc(title) + "</b></div>" +
          '<div class="table-wrap" style="max-height:260px"><table class="tbl"><thead><tr>' +
          '<th>日期</th><th class="num">行数/条数</th><th>归档时间</th><th>操作</th></tr></thead><tbody>' +
          ((rows || []).length ? rows.map(function (row) {
            return "<tr><td>" + esc(row.biz_date) + '</td><td class="num">' + num(row.rows) +
              '</td><td class="small muted">' + esc(row.archived_at || "") + "</td>" +
              '<td class="nowrap"><button class="btn btn-sm btn-ghost" data-arch-view="' + type + ":" +
              esc(row.biz_date) + '">查看</button><button class="btn btn-sm btn-ghost" data-arch-export="' +
              type + ":" + esc(row.biz_date) + '">导出</button></td></tr>';
          }).join("") : '<tr><td colspan="4">' + emptyHtml("还没有归档") + "</td></tr>") +
          "</tbody></table></div></div>";
      }
      $("#p-archives", view).innerHTML =
        '<div class="grid cols-2" style="gap:16px">' +
        block("订单组归档", data.orders, "orders") +
        block("人效归档", data.labor, "labor") +
        "</div>" +
        '<div class="toolbar" style="margin-top:12px;gap:8px;align-items:center">' +
        '<span class="small muted">区间导出：</span>' +
        '<select class="select" id="arch-type" style="height:30px"><option value="orders">订单组归档</option>' +
        '<option value="labor">人效归档</option></select>' +
        '<input class="input" id="arch-from" type="date" style="height:30px;width:150px">' +
        '<span>—</span>' +
        '<input class="input" id="arch-to" type="date" style="height:30px;width:150px">' +
        '<button class="btn btn-sm btn-primary" id="arch-export-range">导出 CSV</button></div>';
      $$("[data-arch-view]", view).forEach(function (btn) {
        btn.addEventListener("click", function () {
          var parts = btn.getAttribute("data-arch-view").split(":");
          viewArchive(parts[0], parts[1]);
        });
      });
      $$("[data-arch-export]", view).forEach(function (btn) {
        btn.addEventListener("click", function () {
          var parts = btn.getAttribute("data-arch-export").split(":");
          downloadArchive(parts[0], parts[1], parts[1]);
        });
      });
      $("#arch-export-range", view).addEventListener("click", function () {
        var type = $("#arch-type", view).value;
        var from = $("#arch-from", view).value;
        var to = $("#arch-to", view).value;
        if (!from || !to) { toast("请选择开始和结束日期", "err"); return; }
        downloadArchive(type, from, to);
      });
    }

    function fmtBytes(n) {
      var value = Number(n) || 0;
      if (value < 1024) return value + " B";
      if (value < 1024 * 1024) return (value / 1024).toFixed(1) + " KB";
      if (value < 1024 * 1024 * 1024) return (value / 1024 / 1024).toFixed(1) + " MB";
      return (value / 1024 / 1024 / 1024).toFixed(2) + " GB";
    }

    async function loadFileArchives() {
      var token = state.routeToken;
      var params = [];
      var kind = $("#sa-kind", view).value;
      if (kind && kind !== "all") params.push("kind=" + encodeURIComponent(kind));
      var q = $("#sa-q", view).value.trim();
      if (q) params.push("q=" + encodeURIComponent(q));
      var from = $("#sa-from", view).value;
      if (from) params.push("from=" + encodeURIComponent(from));
      var to = $("#sa-to", view).value;
      if (to) params.push("to=" + encodeURIComponent(to));
      var data = await api("/api/source-archives" + (params.length ? "?" + params.join("&") : ""));
      if (token !== state.routeToken || !$("#p-scan-archives", view)) return;
      setText("#scan-arch-sum", "共 " + num(data.total) + " 个归档 · 占用 " + fmtBytes(data.bytes) +
        " · 保留最近 " + num(data.keep_days) + " 天" +
        (data.last_cleanup ? " · 上次清理：" + data.last_cleanup : ""));
      var rows = data.rows || [];
      if (!rows.length) {
        $("#p-scan-archives", view).innerHTML = emptyHtml("还没有归档：把文件保存到数据源目录后点「立即扫描」");
        return;
      }
      var kindLabel = { ship: "发运表", tms: "运输单状态", dealer: "经销商" };
      $("#p-scan-archives", view).innerHTML =
        '<div class="table-wrap" style="max-height:420px"><table class="tbl"><thead><tr>' +
        "<th>扫描时间</th><th>文件</th><th>类型</th><th class=\"num\">行数</th>" +
        '<th class="num">大小</th><th>涉及日期</th><th>操作</th></tr></thead><tbody>' +
        rows.map(function (row) {
          return "<tr><td class=\"nowrap\">" + esc(row.scan_at || "") + "</td><td>" +
            '<span title="' + esc(row.name) + '">' + esc(row.name) + "</span>" +
            (row.error ? '<div class="small" style="color:#c92a2a">' + esc(row.error) + "</div>" : "") +
            '</td><td>' + esc(kindLabel[row.kind] || row.kind || "-") +
            '</td><td class="num">' + num(row.rows) + '</td><td class="num" title="源文件 ' +
            fmtBytes(row.size) + '">' + fmtBytes(row.stored_bytes || 0) +
            '</td><td class="small muted">' + esc(row.biz_dates || "-") + '</td><td class="nowrap">' +
            '<button class="btn btn-sm btn-ghost" data-sa-view="' + row.id + '">预览</button>' +
            '<button class="btn btn-sm btn-ghost" data-sa-export="' + row.id + '">导出CSV</button>' +
            "</td></tr>";
        }).join("") + "</tbody></table></div>";
      $$("[data-sa-view]", view).forEach(function (btn) {
        btn.addEventListener("click", function () { previewFileArchive(btn.getAttribute("data-sa-view")); });
      });
      $$("[data-sa-export]", view).forEach(function (btn) {
        btn.addEventListener("click", function () {
          window.location.href = "/api/export/source-archive.csv?id=" + encodeURIComponent(btn.getAttribute("data-sa-export"));
        });
      });
    }

    async function previewFileArchive(id) {
      var m = modal({ title: "归档预览", wide: true, body: '<div class="small muted">加载中…</div>' });
      try {
        var data = await api("/api/source-archive/" + id + "/preview?limit=100");
        var html = '<div class="small muted" style="margin-bottom:8px">' + esc(data.name) + " · " +
          esc(data.scan_at || "") + " · 共 " + num(data.rows) + " 行" +
          (data.biz_dates ? " · 涉及日期 " + esc(data.biz_dates) : "") + "</div>";
        (data.sheets || []).forEach(function (sheet) {
          html += '<div class="small" style="margin:10px 0 4px"><b>' + esc(sheet.name) + "</b>（预览前 " +
            (sheet.rows || []).length + " 行，表头 " + (sheet.headers || []).length + " 列）</div>" +
            '<div class="table-wrap" style="max-height:55vh"><table class="tbl"><thead><tr>' +
            (sheet.headers || []).map(function (h) { return "<th>" + esc(h) + "</th>"; }).join("") +
            "</tr></thead><tbody>" +
            (sheet.rows || []).map(function (row) {
              return "<tr>" + row.map(function (v) {
                return "<td>" + esc(v === null || v === undefined ? "" : String(v)) + "</td>";
              }).join("") + "</tr>";
            }).join("") + "</tbody></table></div>";
        });
        $(".modal-body", m.el).innerHTML = html;
      } catch (error) {
        $(".modal-body", m.el).innerHTML = '<div class="widget-error">' + esc(error.message) + "</div>";
      }
    }

    function downloadArchive(type, from, to) {
      window.location.href = "/api/export/archive.csv?type=" + encodeURIComponent(type) +
        "&from=" + encodeURIComponent(from) + "&to=" + encodeURIComponent(to);
    }

    async function viewArchive(type, date) {
      var m = modal({ title: (type === "labor" ? "人效归档" : "订单组归档") + " · " + date,
        wide: true, body: '<div class="small muted">加载中…</div>' });
      try {
        var data = await api("/api/archive/view?type=" + type + "&date=" + encodeURIComponent(date));
        var body = type === "labor" ? laborArchiveTable(data) : ordersArchiveTable(data);
        $(".modal-body", m.el).innerHTML = body;
      } catch (error) {
        $(".modal-body", m.el).innerHTML = '<div class="widget-error">' + esc(error.message) + "</div>";
      }
    }

    function ordersArchiveTable(data) {
      var rows = data.rows || [];
      return '<div class="small muted" style="margin-bottom:6px">共 ' + num(data.total) +
        " 组 · 金额 " + num((data.summary || {}).amount) + " 元 · 归档 " + esc(data.archived_at || "-") + "</div>" +
        '<div class="table-wrap" style="max-height:60vh"><table class="tbl"><thead><tr>' +
        '<th>序号</th><th>订单组号</th><th>经销商</th><th class="num">行数</th><th class="num">金额(元)</th>' +
        "<th>库区</th><th>单据类型</th><th>区域</th><th>承运商</th><th>波次号</th><th>清洗</th><th>指派</th><th>计入</th></tr></thead><tbody>" +
        (rows.length ? rows.map(function (r) {
          return "<tr><td>" + esc(r.seq) + "</td><td>" + esc(r.group_no) + "</td><td>" + esc(r.dealer) +
            '</td><td class="num">' + num(r.lines) + '</td><td class="num">' + num(r.amount, 2) +
            "</td><td>" + esc(r.zone || "-") + "</td><td>" + esc(r.doc_type || "-") + "</td><td>" +
            esc(r.region || "-") + "</td><td>" + esc(r.route || "-") + "</td><td>" + esc(r.wave_no || "-") +
            "</td><td>" + esc(r.tms_status || "-") + "</td><td>" + esc(r.assignee || "-") + "</td><td>" +
            (r.included ? "计入" : "已移出") + "</td></tr>";
        }).join("") : '<tr><td colspan="13">' + emptyHtml("无数据") + "</td></tr>") +
        "</tbody></table></div>";
    }

    function laborArchiveTable(data) {
      var rows = data.rows || [];
      return '<div class="small muted" style="margin-bottom:6px">共 ' + rows.length + " 人 · 拣货 " +
        num((data.totals || {}).pick_rows) + " 行 / 复核 " + num((data.totals || {}).check_rows) +
        " 行 · 归档 " + esc(data.archived_at || "-") + "</div>" +
        '<div class="table-wrap" style="max-height:60vh"><table class="tbl"><thead><tr>' +
        '<th>人员</th><th class="num">拣货行</th><th class="num">拣货小时</th><th class="num">拣货人效</th>' +
        '<th class="num">复核行</th><th class="num">复核小时</th><th class="num">复核人效</th></tr></thead><tbody>' +
        (rows.length ? rows.map(function (r) {
          return "<tr><td>" + esc(r.person) + '</td><td class="num">' + num(r.pick_rows) +
            '</td><td class="num">' + num(r.pick_hours, 2) + '</td><td class="num">' +
            (r.pick_rate === null || r.pick_rate === undefined ? "-" : num(r.pick_rate, 1)) +
            '</td><td class="num">' + num(r.check_rows) + '</td><td class="num">' + num(r.check_hours, 2) +
            '</td><td class="num">' + (r.check_rate === null || r.check_rate === undefined ? "-" : num(r.check_rate, 1)) +
            "</td></tr>";
        }).join("") : '<tr><td colspan="7">' + emptyHtml("无数据") + "</td></tr>") +
        "</tbody></table></div>";
    }

    function editDealer(dealer) {
      var m = modal({
        title: "经销商映射",
        body:
          '<div class="field"><label>全称</label><input class="input" id="d-full" value="' + esc(dealer.full_name || "") + '" readonly></div>' +
          '<div class="field"><label>简称</label><input class="input" id="d-short" value="' + esc(dealer.short_name || "") + '"></div>' +
          '<div class="field"><label>区域</label><input class="input" id="d-region" value="' + esc(dealer.region || "") + '" placeholder="如：广东"></div>' +
          '<div class="field"><label>承运商/线路</label><input class="input" id="d-route" value="' + esc(dealer.route || "") + '" placeholder="如：下午—广东直发线"></div>',
        footer: '<button class="btn" data-cancel>取消</button><button class="btn btn-primary" data-ok>保存</button>'
      });
      $("[data-cancel]", m.el).addEventListener("click", m.close);
      $("[data-ok]", m.el).addEventListener("click", function () {
        api("/api/dealers", {
          method: "PUT",
          body: JSON.stringify({
            full_name: dealer.full_name,
            short_name: $("#d-short", m.el).value.trim(),
            region: $("#d-region", m.el).value.trim(),
            route: $("#d-route", m.el).value.trim()
          })
        }).then(function () { m.close(); toast("已保存", "ok"); load(); })
          .catch(function (error) { toast(error.message, "err"); });
      });
    }

    $("#btn-scan", view).addEventListener("click", function () {
      var btn = $("#btn-scan", view);
      btn.disabled = true;
      btn.textContent = "扫描中…";
      api("/api/scan", { method: "POST" }).then(function (report) {
        var msg = "扫描 " + report.scanned + " 个文件，新导入 " + report.imported + "，更新 " + report.updated;
        var archived = report.archived || {};
        if ((archived.orders || []).length || (archived.labor || []).length) {
          msg += "；自动归档 订单组 " + (archived.orders || []).length + " 天、人效 " +
            (archived.labor || []).length + " 天";
        }
        if ((report.archived_files || []).length) msg += "；文件归档 " + report.archived_files.length + " 个";
        toast(msg, "ok");
        if (report.errors && report.errors.length) toast(report.errors[0], "warn");
        load();
      }).catch(function (error) { toast(error.message, "err"); })
        .finally(function () { btn.disabled = false; btn.textContent = "立即扫描"; });
    });
    var saSearch = $("#sa-search", view);
    if (saSearch) {
      saSearch.addEventListener("click", function () { loadFileArchives().catch(function (e) { toast(e.message, "err"); }); });
      ["sa-q", "sa-from", "sa-to"].forEach(function (id) {
        var el = $("#" + id, view);
        if (el) el.addEventListener("keydown", function (event) { if (event.key === "Enter") saSearch.click(); });
      });
    }
    var saKind = $("#sa-kind", view);
    if (saKind) saKind.addEventListener("change", function () { loadFileArchives().catch(function (e) { toast(e.message, "err"); }); });
    var unmappedExport = $("#btn-unmapped-export", view);
    if (unmappedExport) {
      unmappedExport.addEventListener("click", function () { window.location.href = "/api/export/unmapped-dealers.csv"; });
    }
    var unmappedInput = $("#f-unmapped", view);
    if (unmappedInput) {
      unmappedInput.addEventListener("change", function () {
        var file = unmappedInput.files[0];
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function () {
          api("/api/dealers/import", { method: "POST", body: String(reader.result) })
            .then(function (result) {
              toast("导入完成：新增 " + (result.created || 0) + " / 更新 " + (result.updated || 0) +
                " / 跳过 " + (result.skipped || 0), "ok");
              unmappedInput.value = "";
              load();
            })
            .catch(function (error) { toast(error.message, "err"); });
        };
        reader.readAsText(file, "utf-8");
      });
    }
    var fileInput = $("#f-dealer", view);
    if (fileInput) {
      fileInput.addEventListener("change", function () {
        var file = fileInput.files[0];
        if (!file) return;
        fetch("/api/dealers/import", {
          method: "POST", credentials: "same-origin",
          headers: { "X-Dashboard-Client": "1" }, body: file
        }).then(function (res) {
          return res.json().then(function (data) { if (!res.ok) throw new Error(data.error || "导入失败"); return data; });
        }).then(function (result) {
          toast("已导入 " + result.count + " 条经销商映射（动力电池 " + (result.battery || 0) + " 条）", "ok");
          load();
        }).catch(function (error) { toast(error.message, "err"); });
      });
    }
    load();
  }

  // ---------------------------------------------------------------- 管理
  async function pageAdmin(view, tab) {
    tab = tab || "users";
    view.innerHTML =
      '<div class="page-head"><div><div class="page-title">用户与权限</div>' +
      '<div class="page-sub">逐项授权：用户组 × 页面/组件/动作/字段 × 数据范围</div></div></div>' +
      '<div class="toolbar" style="margin-bottom:14px">' +
        ["users:用户", "groups:用户组", "permissions:权限矩阵", "scopes:数据范围"].map(function (item) {
          var key = item.split(":")[0];
          return '<button class="btn ' + (key === tab ? "btn-primary" : "") + '" data-tab="' + key + '">' +
            item.split(":")[1] + "</button>";
        }).join("") +
      "</div><div id=\"admin-body\"></div>";
    $$("[data-tab]", view).forEach(function (btn) {
      btn.addEventListener("click", function () { location.hash = "#/admin/" + btn.getAttribute("data-tab"); });
    });
    var body = $("#admin-body", view);
    startLoading(body);
    try {
      if (tab === "users") await adminUsers(body);
      else if (tab === "groups") await adminGroups(body);
      else if (tab === "permissions") await adminPermissions(body);
      else await adminScopes(body);
    } catch (error) {
      showError(body, error);
    }
  }

  function permMatrixHtml(allowCodes, denyCodes) {
    var grouped = {};
    PERM_CACHE.forEach(function (perm) {
      grouped[perm.group] = grouped[perm.group] || [];
      grouped[perm.group].push(perm);
    });
    return Object.keys(grouped).map(function (group) {
      return '<div style="margin-bottom:12px"><div class="panel-sub" style="margin-bottom:6px">' + esc(group) + "</div>" +
        '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:4px 14px">' +
        grouped[group].map(function (perm) {
          var allow = allowCodes.indexOf(perm.code) >= 0;
          var deny = denyCodes.indexOf(perm.code) >= 0;
          var value = allow ? "allow" : deny ? "deny" : "";
          return '<label class="check" title="' + esc(perm.description || "") + '">' +
            '<select class="perm-select" data-code="' + perm.code + '" style="height:26px;padding:0 6px;border-radius:6px;border:1px solid #e6e9ef">' +
            '<option value=""' + (value === "" ? " selected" : "") + ">继承</option>" +
            '<option value="allow"' + (value === "allow" ? " selected" : "") + ">允许</option>" +
            '<option value="deny"' + (value === "deny" ? " selected" : "") + ">拒绝</option>" +
            "</select><span>" + esc(perm.title) + "</span></label>";
        }).join("") + "</div></div>";
    }).join("");
  }

  function collectPerm(scope) {
    var allow = [], deny = [];
    $$(".perm-select", scope).forEach(function (select) {
      if (select.value === "allow") allow.push(select.getAttribute("data-code"));
      if (select.value === "deny") deny.push(select.getAttribute("data-code"));
    });
    return { allow: allow, deny: deny };
  }

  var PERM_CACHE = [];

  async function loadPermissions() {
    if (PERM_CACHE.length) return;
    var data = await api("/api/permissions");
    PERM_CACHE = data.permissions;
  }

  async function adminUsers(body) {
    await loadPermissions();
    var data = await api("/api/users");
    var groups = data.groups;
    var rows = data.rows.map(function (user) {
      return '<tr><td><b>' + esc(user.display_name) + '</b><div class="small muted">' + esc(user.username) + "</div></td>" +
        "<td>" + (user.groups || []).map(function (g) { return '<span class="badge">' + esc(g.name) + "</span>"; }).join(" ") +
        '</td><td class="num">' + (user.permissions || []).length + "</td>" +
        "<td>" + (user.status === "active" ? '<span class="badge ok">启用</span>' : '<span class="badge danger">停用</span>') +
        '</td><td class="small muted">' + esc(user.last_login_at || "-") + "</td>" +
        '<td class="nowrap"><button class="btn btn-sm btn-ghost" data-edit="' + user.id + '">编辑</button>' +
        '<button class="btn btn-sm btn-ghost" data-reset="' + user.id + '">重置密码</button></td></tr>';
    }).join("");
    body.innerHTML =
      '<div class="panel"><div class="panel-head"><div class="panel-title">用户（' + data.rows.length + '）</div>' +
      '<button class="btn btn-primary btn-sm" id="btn-add-user">新建用户</button></div>' +
      '<div class="panel-body flush"><div class="table-wrap"><table class="tbl"><thead><tr><th>用户</th><th>用户组</th>' +
      '<th class="num">权限数</th><th>状态</th><th>最后登录</th><th></th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="6">' + emptyHtml() + "</td></tr>") + "</tbody></table></div></div></div>";

    $("#btn-add-user", body).addEventListener("click", function () { userModal(null, groups); });
    $$("[data-edit]", body).forEach(function (btn) {
      btn.addEventListener("click", function () {
        var user = data.rows.filter(function (u) { return String(u.id) === btn.getAttribute("data-edit"); })[0];
        userModal(user, groups);
      });
    });
    $$("[data-reset]", body).forEach(function (btn) {
      btn.addEventListener("click", function () {
        var user = data.rows.filter(function (u) { return String(u.id) === btn.getAttribute("data-reset"); })[0];
        var m = modal({
          title: "重置密码 — " + user.display_name,
          body: '<div class="field"><label>临时密码</label><input class="input" id="rs-pwd" value="' + esc(randomPassword()) + '">' +
                '</div><div class="small muted">用户下次登录会被强制修改密码。</div>',
          footer: '<button class="btn" data-cancel>取消</button><button class="btn btn-primary" data-ok>重置</button>'
        });
        $("[data-cancel]", m.el).addEventListener("click", m.close);
        $("[data-ok]", m.el).addEventListener("click", function () {
          api("/api/users/" + user.id + "/reset", {
            method: "POST", body: JSON.stringify({ password: $("#rs-pwd", m.el).value })
          }).then(function () { m.close(); toast("密码已重置", "ok"); })
            .catch(function (error) { toast(error.message, "err"); });
        });
      });
    });
  }

  function randomPassword() {
    var chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
    var out = "";
    for (var i = 0; i < 10; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out + "8a";
  }

  function userModal(user, groups) {
    var isNew = !user;
    var allow = user ? (user.permissions || []) : [];
    var m = modal({
      title: isNew ? "新建用户" : "编辑用户 — " + user.display_name,
      wide: true,
      body:
        (isNew
          ? '<div class="grid cols-2"><div class="field"><label>账号</label><input class="input" id="u-name"></div>' +
            '<div class="field"><label>显示名称</label><input class="input" id="u-display"></div></div>' +
            '<div class="grid cols-2"><div class="field"><label>初始密码</label><input class="input" id="u-pwd" value="' + esc(randomPassword()) + '"></div>' +
            '<div class="field"><label>初始角色</label><select class="select" id="u-role">' +
            '<option value="viewer">只读</option><option value="editor">登记员</option><option value="admin">管理员</option></select></div></div>'
          : '<div class="grid cols-2"><div class="field"><label>显示名称</label><input class="input" id="u-display" value="' + esc(user.display_name) + '"></div>' +
            '<div class="field"><label>状态</label><select class="select" id="u-status">' +
            '<option value="active"' + (user.status === "active" ? " selected" : "") + ">启用</option>" +
            '<option value="disabled"' + (user.status !== "active" ? " selected" : "") + ">停用</option></select></div></div>") +
        '<div class="field"><label>所属用户组</label><div style="display:flex;flex-wrap:wrap;gap:10px">' +
        (groups.length ? groups.map(function (g) {
          var checked = (user && (user.groups || []).some(function (x) { return x.id === g.id; })) ? " checked" : "";
          return '<label class="check"><input type="checkbox" data-group="' + g.id + '"' + checked + ">" + esc(g.name) + "</label>";
        }).join("") : '<span class="muted small">还没有用户组</span>') + "</div></div>" +
        '<div class="field"><label>权限点（逐项：继承 / 允许 / 拒绝）</label>' +
        '<div style="max-height:320px;overflow:auto;border:1px solid #e6e9ef;border-radius:8px;padding:10px">' +
        permMatrixHtml(allow, []) + "</div></div>",
      footer: '<button class="btn" data-cancel>取消</button><button class="btn btn-primary" data-ok>' +
        (isNew ? "创建" : "保存") + "</button>"
    });
    $("[data-cancel]", m.el).addEventListener("click", m.close);
    $("[data-ok]", m.el).addEventListener("click", function () {
      var perms = collectPerm(m.el);
      var groupIds = $$("[data-group]:checked", m.el).map(function (input) { return Number(input.getAttribute("data-group")); });
      if (isNew) {
        api("/api/users", {
          method: "POST",
          body: JSON.stringify({
            username: $("#u-name", m.el).value.trim(),
            display_name: $("#u-display", m.el).value.trim(),
            password: $("#u-pwd", m.el).value,
            role: $("#u-role", m.el).value,
            groups: groupIds
          })
        }).then(function (result) {
          return api("/api/users/" + result.id, {
            method: "PUT",
            body: JSON.stringify({ allow: perms.allow, deny: perms.deny, groups: groupIds })
          });
        }).then(function () { m.close(); toast("用户已创建", "ok"); pageAdmin($("#view"), "users"); })
          .catch(function (error) { toast(error.message, "err"); });
      } else {
        api("/api/users/" + user.id, {
          method: "PUT",
          body: JSON.stringify({
            display_name: $("#u-display", m.el).value.trim(),
            status: $("#u-status", m.el).value,
            groups: groupIds,
            allow: perms.allow,
            deny: perms.deny
          })
        }).then(function () { m.close(); toast("已保存", "ok"); pageAdmin($("#view"), "users"); })
          .catch(function (error) { toast(error.message, "err"); });
      }
    });
  }

  async function adminGroups(body) {
    await loadPermissions();
    var data = await api("/api/groups");
    var groupRows = data.rows.map(function (group) {
      return '<tr><td><b>' + esc(group.name) + '</b><div class="small muted">' + esc(group.description || "") + "</div></td>" +
        '<td class="num">' + (group.members || []).length + '</td><td class="num">' + (group.allow || []).length +
        '</td><td class="num">' + (group.deny || []).length + "</td>" +
        '<td class="nowrap"><button class="btn btn-sm btn-ghost" data-edit="' + group.id + '">编辑</button>' +
        '<button class="btn btn-sm btn-danger" data-del="' + group.id + '">删除</button></td></tr>';
    }).join("");
    body.innerHTML =
      '<div class="panel"><div class="panel-head"><div class="panel-title">用户组（' + data.rows.length + '）</div>' +
      '<button class="btn btn-primary btn-sm" id="btn-add-group">新建用户组</button></div>' +
      '<div class="panel-body flush"><div class="table-wrap"><table class="tbl"><thead><tr><th>组名</th>' +
      '<th class="num">成员</th><th class="num">允许权限</th><th class="num">拒绝权限</th><th></th></tr></thead><tbody>' +
      (groupRows || '<tr><td colspan="5">' + emptyHtml() + "</td></tr>") + "</tbody></table></div></div></div>";

    $("#btn-add-group", body).addEventListener("click", function () { groupModal(null); });
    $$("[data-edit]", body).forEach(function (btn) {
      btn.addEventListener("click", function () {
        var group = data.rows.filter(function (g) { return String(g.id) === btn.getAttribute("data-edit"); })[0];
        groupModal(group);
      });
    });
    $$("[data-del]", body).forEach(function (btn) {
      btn.addEventListener("click", function () {
        confirmDialog("删除用户组", "删除后该组成员会失去通过本组获得的权限。确定？", "删除").then(function (ok) {
          if (!ok) return;
          api("/api/groups/" + btn.getAttribute("data-del"), { method: "DELETE" })
            .then(function () { toast("已删除", "ok"); pageAdmin($("#view"), "groups"); })
            .catch(function (error) { toast(error.message, "err"); });
        });
      });
    });
  }

  async function groupModal(group) {
    await loadPermissions();
    var users = await api("/api/users");
    var isNew = !group;
    var m = modal({
      title: isNew ? "新建用户组" : "编辑用户组 — " + group.name,
      wide: true,
      body:
        '<div class="grid cols-2"><div class="field"><label>组名</label><input class="input" id="g-name" value="' +
        esc(group ? group.name : "") + '"></div>' +
        '<div class="field"><label>说明</label><input class="input" id="g-desc" value="' + esc(group ? group.description || "" : "") + '"></div></div>' +
        '<div class="field"><label>成员</label><div style="display:flex;flex-wrap:wrap;gap:10px">' +
        users.rows.map(function (user) {
          var checked = group && (group.members || []).indexOf(user.id) >= 0 ? " checked" : "";
          return '<label class="check"><input type="checkbox" data-member="' + user.id + '"' + checked + ">" +
            esc(user.display_name) + "</label>";
        }).join("") + "</div></div>" +
        '<div class="field"><label>权限点</label><div style="max-height:320px;overflow:auto;border:1px solid #e6e9ef;border-radius:8px;padding:10px">' +
        permMatrixHtml(group ? group.allow || [] : [], group ? group.deny || [] : []) + "</div></div>",
      footer: '<button class="btn" data-cancel>取消</button><button class="btn btn-primary" data-ok>' +
        (isNew ? "创建" : "保存") + "</button>"
    });
    $("[data-cancel]", m.el).addEventListener("click", m.close);
    $("[data-ok]", m.el).addEventListener("click", function () {
      var perms2 = collectPerm(m.el);
      var members = $$("[data-member]:checked", m.el).map(function (input) { return Number(input.getAttribute("data-member")); });
      var payload = {
        name: $("#g-name", m.el).value.trim(),
        description: $("#g-desc", m.el).value.trim(),
        members: members,
        allow: perms2.allow,
        deny: perms2.deny
      };
      var request = isNew
        ? api("/api/groups", { method: "POST", body: JSON.stringify(payload) })
        : api("/api/groups/" + group.id, { method: "PUT", body: JSON.stringify(payload) });
      request.then(function (result) {
        if (isNew && result.id) {
          return api("/api/groups/" + result.id, { method: "PUT", body: JSON.stringify(payload) });
        }
      }).then(function () {
        m.close();
        toast("已保存", "ok");
        pageAdmin($("#view"), "groups");
      }).catch(function (error) { toast(error.message, "err"); });
    });
  }

  async function adminPermissions(body) {
    await loadPermissions();
    var data = await api("/api/groups");
    var rows = data.rows.map(function (group) {
      return "<tr><td><b>" + esc(group.name) + '</b></td><td class="num">' + (group.members || []).length +
        '</td><td class="num">' + (group.allow || []).length + '</td><td class="num">' + (group.deny || []).length +
        '</td><td><button class="btn btn-sm btn-ghost" data-open="' + group.id + '">配置权限</button></td></tr>';
    }).join("");
    body.innerHTML =
      '<div class="panel" style="margin-bottom:14px"><div class="panel-head"><div class="panel-title">按用户组授权</div>' +
      '<div class="panel-sub">权限点共 ' + PERM_CACHE.length + ' 项，可逐项设置为允许/拒绝/继承</div></div>' +
      '<div class="panel-body flush"><div class="table-wrap"><table class="tbl"><thead><tr><th>用户组</th>' +
      '<th class="num">成员</th><th class="num">允许</th><th class="num">拒绝</th><th></th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="5">' + emptyHtml("还没有用户组") + "</td></tr>") + "</tbody></table></div></div></div>" +
      '<div class="panel"><div class="panel-head"><div class="panel-title">权限点清单</div></div><div class="panel-body flush">' +
      '<div class="table-wrap"><table class="tbl"><thead><tr><th>分组</th><th>权限点</th><th>代码</th><th>说明</th></tr></thead><tbody>' +
      PERM_CACHE.map(function (perm) {
        return "<tr><td>" + esc(perm.group) + "</td><td>" + esc(perm.title) + '</td><td class="mono small">' +
          esc(perm.code) + '</td><td class="small muted">' + esc(perm.description || "") + "</td></tr>";
      }).join("") + "</tbody></table></div></div></div>";
    $$("[data-open]", body).forEach(function (btn) {
      btn.addEventListener("click", function () {
        var group = data.rows.filter(function (g) { return String(g.id) === btn.getAttribute("data-open"); })[0];
        var m = modal({
          title: "配置权限 — " + group.name,
          wide: true,
          body: '<div style="max-height:60vh;overflow:auto">' + permMatrixHtml(group.allow || [], group.deny || []) + "</div>",
          footer: '<button class="btn" data-cancel>取消</button><button class="btn btn-primary" data-ok>保存</button>'
        });
        $("[data-cancel]", m.el).addEventListener("click", m.close);
        $("[data-ok]", m.el).addEventListener("click", function () {
          var p = collectPerm(m.el);
          api("/api/permissions/group/" + group.id, { method: "PUT", body: JSON.stringify(p) })
            .then(function () { m.close(); toast("权限已保存", "ok"); pageAdmin($("#view"), "permissions"); })
            .catch(function (error) { toast(error.message, "err"); });
        });
      });
    });
  }

  async function adminScopes(body) {
    await loadPermissions();
    var permsData = await api("/api/permissions");
    var options = permsData.users.map(function (u) {
      return { type: "user", id: u.id, label: "用户：" + u.display_name, scopes: u.scopes || {} };
    }).concat((permsData.groups || []).map(function (g) {
      return { type: "group", id: g.id, label: "用户组：" + g.name, scopes: g.scopes || {} };
    }));
    body.innerHTML =
      '<div class="panel"><div class="panel-head"><div class="panel-title">数据范围（行级过滤）</div></div>' +
      '<div class="panel-body">' +
      '<div class="field" style="max-width:420px"><label>选择用户或用户组</label><select class="select" id="scope-owner">' +
      options.map(function (item) {
        return '<option value="' + item.type + ":" + item.id + '">' + esc(item.label) + "</option>";
      }).join("") + "</select></div>" +
      '<div class="grid cols-2" id="scope-form"></div>' +
      '<div class="small muted">多个来源取并集；留空表示不限。填「own」表示只看本人登记的波次。</div>' +
      '<div style="margin-top:12px"><button class="btn btn-primary" id="scope-save">保存数据范围</button></div>' +
      "</div></div>";

    function renderForm(owner) {
      var dims = { region: "区域", route: "承运商/线路", zone: "库区", doc_type: "单据类型", waves: "波次(own=本人)" };
      $("#scope-form", body).innerHTML = Object.keys(dims).map(function (dim) {
        var value = (owner.scopes && owner.scopes[dim]) ? owner.scopes[dim].join(",") : "";
        return '<div class="field"><label>' + esc(dims[dim]) + '</label>' +
          '<input class="input" data-scope="' + dim + '" value="' + esc(value) + '" placeholder="多个用逗号分隔，留空不限"></div>';
      }).join("");
    }

    function currentOwner() {
      var value = $("#scope-owner", body).value.split(":");
      var owner = options.filter(function (item) { return item.type === value[0] && String(item.id) === value[1]; })[0];
      return owner;
    }

    $("#scope-owner", body).addEventListener("change", function () { renderForm(currentOwner()); });
    renderForm(options[0]);
    $("#scope-save", body).addEventListener("click", function () {
      var owner = currentOwner();
      var scopes = {};
      $$("[data-scope]", body).forEach(function (input) {
        var raw = input.value.trim();
        if (!raw) return;
        scopes[input.getAttribute("data-scope")] = raw.split(/[,，\s]+/).filter(Boolean);
      });
      api("/api/scopes/" + owner.type + "/" + owner.id, { method: "PUT", body: JSON.stringify({ scopes: scopes }) })
        .then(function () { toast("数据范围已保存", "ok"); })
        .catch(function (error) { toast(error.message, "err"); });
    });
  }

  async function pageAudit(view) {
    view.innerHTML = '<div class="page-head"><div><div class="page-title">审计日志</div></div></div>' +
      '<div class="panel"><div class="panel-body flush" id="audit-box"></div><div class="pager" id="audit-pager"></div></div>';
    var pageNo = 1;
    async function load() {
      var box = $("#audit-box", view);
      startLoading(box);
      try {
        var data = await api("/api/audit?page=" + pageNo);
        var rows = data.rows.map(function (row) {
          return "<tr><td>" + esc(row.ts) + "</td><td>" + esc(row.username || "-") + '</td><td class="mono small">' +
            esc(row.ip) + "</td><td>" + esc(row.action) + "</td><td>" + esc(row.target) +
            '</td><td class="small muted" style="max-width:520px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
            esc(row.detail || "") + "</td></tr>";
        }).join("");
        box.innerHTML = '<div class="table-wrap"><table class="tbl"><thead><tr><th>时间</th><th>用户</th><th>IP</th>' +
          "<th>动作</th><th>对象</th><th>详情</th></tr></thead><tbody>" +
          (rows || '<tr><td colspan="6">' + emptyHtml() + "</td></tr>") + "</tbody></table></div>";
        var totalPages = Math.max(1, Math.ceil(data.total / data.size));
        $("#audit-pager", view).innerHTML = '<span>共 ' + data.total + " 条 · 第 " + data.page + " / " + totalPages + " 页</span>" +
          '<button class="btn btn-sm" id="aprev"' + (data.page <= 1 ? " disabled" : "") + ">上一页</button>" +
          '<button class="btn btn-sm" id="anext"' + (data.page >= totalPages ? " disabled" : "") + ">下一页</button>";
        $("#aprev", view).addEventListener("click", function () { pageNo = Math.max(1, pageNo - 1); load(); });
        $("#anext", view).addEventListener("click", function () { pageNo = pageNo + 1; load(); });
      } catch (error) {
        showError(box, error);
      }
    }
    load();
  }

  // ---------------------------------------------------------------- 自定义看板
  async function pageDashboards(view, dashId) {
    if (!window.DashGrid) {
      view.innerHTML = emptyHtml("grid.js 未加载，无法使用拖拽看板");
      return;
    }
    view.innerHTML =
      '<div class="page-head"><div><div class="page-title">自定义看板</div>' +
      '<div class="page-sub">拖拽组件、自选维度与指标；保存后成为你自己的布局</div></div>' +
      '<div class="toolbar" id="dash-toolbar"></div></div>' +
      '<div class="palette" id="palette"></div>' +
      '<div id="canvas"></div>';

    var list = await api("/api/dashboards");
    var rows = list.rows || [];
    var current = rows.filter(function (item) { return String(item.id) === String(dashId); })[0] ||
      rows.filter(function (item) { return item.editable; })[0] || rows[0];
    if (!current) { view.innerHTML = emptyHtml("还没有看板"); return; }
    state.dashboards = rows;
    state.currentDashId = current.id;
    var editable = current.editable && has("action.dashboard.edit");

    var PALETTE = [
      { type: "kpi", title: "KPI 卡", spec: { dataset: "orders", metrics: ["groups"] } },
      { type: "bar", title: "柱状图", spec: { dataset: "orders", dimension: "route", metrics: ["rows"], limit: 10 } },
      { type: "line", title: "折线图", spec: { dataset: "lines", dimension: "hour", metrics: ["rows"], limit: 24 } },
      { type: "pie", title: "饼/环图", spec: { dataset: "orders", dimension: "zone", metrics: ["rows"], limit: 8 } },
      { type: "funnel", title: "漏斗图", spec: {} },
      { type: "table", title: "表格", spec: { dataset: "orders", dimension: "dealer", metrics: ["groups", "rows"], limit: 15 } },
      { type: "progress", title: "进度条", spec: { dataset: "orders", dimension: "route", metrics: ["out_rate", "rows"], limit: 10 } },
      { type: "alert", title: "预警清单", spec: { dataset: "alerts" } },
      { type: "text", title: "文本说明", spec: {} }
    ];

    renderToolbar(view, current, editable);
    renderPalette(view, editable);

    var canvas = $("#canvas", view);
    var layout = (current.layout && current.layout.widgets) || [];
    state.grid = DashGrid(canvas, {
      cols: 12,
      rowHeight: 60,
      editable: editable,
      layout: layout,
      renderWidget: function (widget, body) {
        drawWidget(body, widget.type, widget.spec);
      },
      onConfigure: function (widget) { configureWidget(widget); },
      onDuplicate: function (widget) {
        var copy = JSON.parse(JSON.stringify(widget));
        copy.id = "w" + Date.now();
        copy.title = widget.title + " 副本";
        copy.y = widget.y + widget.h;
        state.grid.addWidget(copy);
        persist();
      },
      onRemove: function () { persist(); },
      confirmRemove: function (widget) {
        confirmDialog("删除组件", "确定删除「" + (widget.title || widget.type) + "」？", "删除")
          .then(function (ok) {
            if (ok && state.grid) state.grid.removeWidget(widget.id);
          });
      },
      onChange: function () { schedulePersist(); }
    });

    var persistTimer = null;
    function schedulePersist() {
      clearTimeout(persistTimer);
      persistTimer = setTimeout(persist, 600);
    }
    function persist() {
      if (!editable) return;
      var payload = { layout: { widgets: state.grid.getLayout() } };
      api("/api/dashboards/" + current.id, { method: "PUT", body: JSON.stringify(payload) })
        .then(function () { $("#save-state", view) && ($("#save-state", view).textContent = "已保存 " + clock()); })
        .catch(function (error) { toast(error.message, "err"); });
    }

    function renderToolbar(host, dash, canEdit) {
      $("#dash-toolbar", host).innerHTML =
        '<select class="select" id="dash-select">' + rows.map(function (item) {
          return '<option value="' + item.id + '"' + (item.id === dash.id ? " selected" : "") + ">" +
            esc(item.name) + (item.owner_user_id ? "" : "（公共）") + "</option>";
        }).join("") + "</select>" +
        '<span class="small muted" id="save-state"></span>' +
        (canEdit ? '<button class="btn" id="btn-add-dash">新建看板</button>' +
          '<button class="btn btn-danger" id="btn-reset-layout">恢复模板</button>' : "") +
        (has("action.dashboard.publish") && canEdit ? '<button class="btn" id="btn-publish">发布为公共</button>' : "");
      $("#dash-select", host).addEventListener("change", function (event) {
        location.hash = "#/dashboard/" + event.target.value;
      });
      if (!canEdit) return;
      $("#btn-add-dash", host).addEventListener("click", function () {
        var m = modal({
          title: "新建看板",
          body: '<div class="field"><label>名称</label><input class="input" id="nd-name" placeholder="例如：承运商专题"></div>',
          footer: '<button class="btn" data-cancel>取消</button><button class="btn btn-primary" data-ok>创建</button>'
        });
        $("[data-cancel]", m.el).addEventListener("click", m.close);
        $("[data-ok]", m.el).addEventListener("click", function () {
          api("/api/dashboards", {
            method: "POST",
            body: JSON.stringify({ name: $("#nd-name", m.el).value.trim() || "我的看板", layout: { widgets: [] } })
          }).then(function (result) {
            m.close();
            location.hash = "#/dashboard/" + result.id;
            location.reload();
          }).catch(function (error) { toast(error.message, "err"); });
        });
      });
      $("#btn-reset-layout", host).addEventListener("click", function () {
        confirmDialog("恢复模板", "会把当前布局替换为「今日总览」模板（保存后生效）。", "恢复").then(function (ok) {
          if (!ok) return;
          api("/api/widget-catalog");
          api("/api/dashboards").then(function (data) {
            var source = (data.rows || []).filter(function (item) { return !item.owner_user_id; })[0];
            if (!source) { toast("没有公共模板", "warn"); return; }
            state.grid.setLayout((source.layout && source.layout.widgets) || []);
            persist();
          });
        });
      });
      $("#btn-publish", host) && $("#btn-publish", host).addEventListener("click", function () {
        api("/api/dashboards/" + dash.id + "/publish", { method: "POST" })
          .then(function () { toast("已发布为公共看板", "ok"); })
          .catch(function (error) { toast(error.message, "err"); });
      });
    }

    function renderPalette(host, canEdit) {
      if (!canEdit) { $("#palette", host).style.display = "none"; return; }
      $("#palette", host).innerHTML = '<button class="btn btn-sm btn-primary" id="dash-add-template">+ 从模板添加</button>' +
        '<span class="small muted" style="align-self:center;margin:0 6px">或拖入画布：</span>' +
        PALETTE.filter(function (item) { return has("widget." + item.type); }).map(function (item) {
          return '<div class="palette-item" data-type="' + item.type + '">' + esc(item.title) + "</div>";
        }).join("");
      var dashTemplateBtn = $("#dash-add-template", host);
      if (dashTemplateBtn) dashTemplateBtn.addEventListener("click", function () {
        openAddWidgetModal(function (widget) {
          state.grid.addWidget(widget);
          persist();
        });
      });
      $$(".palette-item", host).forEach(function (item) {
        item.addEventListener("pointerdown", function (event) {
          var preset = PALETTE.filter(function (p) { return p.type === item.getAttribute("data-type"); })[0];
          if (!preset) return;
          var widget = {
            id: "w" + Date.now() + Math.floor(Math.random() * 1000),
            type: preset.type,
            title: preset.title,
            spec: JSON.parse(JSON.stringify(preset.spec)),
            x: 0, y: 0, w: preset.type === "kpi" ? 2 : 6, h: preset.type === "kpi" ? 2 : 4
          };
          state.grid.beginExternalDrag(widget)(event);
        });
      });
    }

    async function configureWidget(widget) {
      openWidgetConfig(widget, function (updated) {
        state.grid.updateWidget(updated.id, { title: updated.title, spec: updated.spec });
        persist();
      });
    }

    function datasetAllowed(type, dataset) {
      if (type === "funnel") return true;
      if (type === "alert") return dataset === "alerts";
      if (dataset === "trend") return type === "line" || type === "bar";
      return true;
    }
  }

  // ---------------------------------------------------------------- 打印
  async function pagePrint(view) {
    view.innerHTML = '<div class="page-head no-print"><div><div class="page-title">单量表（打印版）</div>' +
      '<div class="page-sub">与现行「单量表」同口径：承运商/线路 × 库区（行数 / 金额万元）</div></div>' +
      '<div class="toolbar"><button class="btn btn-primary" id="btn-do-print">打印</button>' +
      '<button class="btn" onclick="history.back()">返回</button></div></div><div id="print-body"></div>';
    $("#btn-do-print", view).addEventListener("click", function () { window.print(); });
    var box = $("#print-body", view);
    startLoading(box);
    try {
      var data = await api("/api/summary?date=" + encodeURIComponent(state.date));
      var zones = data.zones || [];
      var head = "<tr><th>承运商/线路</th>" + zones.map(function (zone) {
        return '<th class="num" colspan="' + (data.with_amount ? 2 : 1) + '">' + esc(zone) + " 区</th>";
      }).join("") + '<th class="num" colspan="2">合计</th>' +
        (data.with_amount ? '<th class="num">金额(万)</th>' : "") + "</tr>" +
        "<tr><th></th>" + zones.map(function () {
          return (data.with_amount ? '<th class="num small">行</th><th class="num small">额</th>' : '<th class="num small">行</th>');
        }).join("") + '<th class="num small">行</th><th class="num small">组</th>' +
        (data.with_amount ? '<th class="num small">额</th>' : "") + "</tr>";
      var body = data.routes.map(function (item) {
        var cells = zones.map(function (zone) {
          var cell = item.cells[zone];
          var lines = cell ? cell.lines : 0;
          if (!data.with_amount) return '<td class="num">' + (lines || "-") + "</td>";
          var amount = cell && cell.amount ? num(cell.amount, 2) : "-";
          return '<td class="num">' + (lines || "-") + '</td><td class="num">' + amount + "</td>";
        }).join("");
        return "<tr><td>" + esc(item.label) + "</td>" + cells +
          '<td class="num"><b>' + num(item.lines) + '</b></td><td class="num">' + num(item.groups) + "</td>" +
          (data.with_amount ? '<td class="num"><b>' + num(item.amount, 2) + "</b></td>" : "") + "</tr>";
      }).join("");
      var foot = "<tr><td>合计</td>" + zones.map(function (zone) {
        var cell = data.zone_totals[zone] || { lines: 0, amount: 0 };
        if (!data.with_amount) return '<td class="num">' + num(cell.lines) + "</td>";
        return '<td class="num">' + num(cell.lines) + '</td><td class="num">' + num(cell.amount, 2) + "</td>";
      }).join("") + '<td class="num">' + num(data.totals.lines) + '</td><td class="num">' +
        num(data.totals.groups) + "</td>" +
        (data.with_amount ? '<td class="num">' + num(data.totals.amount, 2) + "</td>" : "") + "</tr>";
      box.innerHTML = '<div class="panel"><div class="panel-head"><div class="panel-title">单量表 · ' +
        esc(data.biz_date) + '</div><div class="panel-sub">共 ' + num(data.totals.groups) + " 组 / " +
        num(data.totals.lines) + " 行" +
        (data.with_amount ? " / " + num(data.totals.amount, 2) + " 万元" : "") + "</div></div>" +
        '<div class="panel-body flush"><div class="table-wrap"><table class="tbl"><thead>' + head +
        "</thead><tbody>" + body + "</tbody><tfoot>" + foot + "</tfoot></table></div></div></div>" +
        '<div class="small muted" style="margin-top:8px">口径说明：行数=发运明细行；库区取明细行自身的区；' +
        "金额按万元展示；调拨出库统一归「省外调拨 / 顺丰速运」。</div>";
    } catch (error) {
      showError(box, error);
    }
  }

  // ---------------------------------------------------------------- 实时刷新
  function connectSSE() {
    if (!window.EventSource) return;
    var source = new EventSource("/api/events");
    source.addEventListener("ready", function () {
      state.online = true;
      updateOnline();
    });
    source.addEventListener("update", function () {
      state.lastUpdate = clock();
      var el = $("#update-time");
      if (el) el.textContent = state.lastUpdate;
      updateBell();
      scheduleRefresh();
    });
    source.onerror = function () {
      state.online = false;
      updateOnline();
      source.close();
      setTimeout(connectSSE, 5000);
    };
  }

  function updateOnline() {
    var dot = $("#online-dot");
    if (dot) dot.className = "dot" + (state.online ? "" : " off");
  }

  function scheduleRefresh() {
    clearTimeout(state.refreshTimer);
    if (document.querySelector(".modal-mask")) return;
    if (document.body.classList.contains("screen-mode")) return;  // 大屏自己有 60s 刷新
    if (state.editing) return;                                     // 编辑看板时不打断操作
    state.refreshTimer = setTimeout(function () {
      if (document.querySelector(".modal-mask")) return;
      if (document.body.classList.contains("screen-mode")) return;
      if (state.editing) return;
      route();
    }, 1200);
  }

  // ---------------------------------------------------------------- 启动
  async function boot() {
    try {
      state.me = await api("/api/me");
    } catch (error) {
      document.body.innerHTML = '<div class="auth-wrap"><div class="auth-card"><div class="auth-title">连接失败</div>' +
        '<div class="auth-sub">' + esc(error.message) + "</div></div></div>";
      return;
    }
    if (state.me.setup) { renderSetup(); return; }
    if (!state.me.authenticated) { renderLogin(); return; }
    if (state.me.user && state.me.user.must_change_pwd) { forceChangePassword(); return; }
    state.meta = await api("/api/meta");
    state.date = state.meta.default_biz_date;
    state.dateManual = false;
    renderShell();
    route();
    connectSSE();
    startMetaTicker();
  }

  /** 每 5 分钟刷新一次 meta；若跨天且用户没手动选日期，自动切到新的一天。 */
  function startMetaTicker() {
    setInterval(function () {
      if (!state.meta || document.visibilityState === "hidden") return;
      api("/api/meta").then(function (meta) {
        var oldToday = state.meta.today;
        state.meta = meta;
        if (!state.dateManual && meta.today !== oldToday) {
          state.date = meta.default_biz_date;
          refreshDateSelect();
          route();
          toast("已进入新的业务日 " + meta.today, "ok");
          return;
        }
        refreshDateSelect();
      }).catch(function () { /* 忽略，等下一轮 */ });
    }, 5 * 60 * 1000);
  }

  document.addEventListener("DOMContentLoaded", boot);

  // 兜底错误提示：前端异常不要让页面静默空白
  window.addEventListener("error", function (event) {
    try {
      toast("页面脚本错误：" + (event.message || "未知错误"), "err");
    } catch (ignored) { /* noop */ }
  });
  window.addEventListener("unhandledrejection", function (event) {
    var reason = event.reason;
    var message = (reason && reason.message) || String(reason || "未知错误");
    try { toast("操作失败：" + message, "err"); } catch (ignored) { /* noop */ }
  });
})();
