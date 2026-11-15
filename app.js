/* 海鲜记账 · 界面与交互 */
(function () {
  'use strict';

  var L = window.Ledger;
  var DB_KEY = 'seafood-ledger-v3';
  var VERSION = 'v3.2';
  var SESSION_NAMES = ['早市', '午市', '晚市'];

  var db = null;
  var day = null;
  var session = null;
  var route = { name: 'home' };
  var stack = [];
  var sheet = null;      // {type, ...}
  var draftCols = {};    // 还没落地的价格列：'item|mode|cell|kind' -> [price]
  var pending = { num: null, text: null, person: null, cell: null };
  var priceDraft = {};   // 批量定价页里填了一半的价
  var lastPick = null;   // 最近一次人名选择器的上下文
  var lastCellPick = null;

  // ================= 存储 =================

  function defaultDB() {
    return {
      v: 3,
      config: {
        people: [],
        workers: [],
        modes: {},          // 'itemId:kind' -> modeId
        cutoffHour: 6
      },
      records: [],
      days: {}
    };
  }

  function load() {
    try {
      var raw = localStorage.getItem(DB_KEY);
      if (!raw) return defaultDB();
      var d = JSON.parse(raw);
      if (!d || !d.config || !Array.isArray(d.records)) return defaultDB();
      if (!Array.isArray(d.config.people)) d.config.people = [];
      if (!Array.isArray(d.config.workers)) d.config.workers = [];
      if (!d.config.modes) d.config.modes = {};
      if (!d.days) d.days = {};
      return d;
    } catch (e) {
      return defaultDB();
    }
  }

  function persist() {
    try {
      localStorage.setItem(DB_KEY, JSON.stringify(db));
      return true;
    } catch (e) {
      if (!warnedNoStore) {
        warnedNoStore = true;
        toast('这台设备不让存，记的东西关掉就没了 —— 请用「启动.cmd」那个网址打开');
      }
      return false;
    }
  }

  var warnedNoStore = false;
  var storageOK = true;
  try {
    localStorage.setItem('__probe__', '1');
    localStorage.removeItem('__probe__');
  } catch (e) {
    storageOK = false;
  }

  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  // ================= 小工具 =================

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var toastTimer = null;
  function toast(msg) {
    var el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 1900);
  }

  function today() { return L.businessDay(new Date(), db.config.cutoffHour); }

  function weekdayCN(d) { return '周' + '日一二三四五六'[L.parseDay(d).getDay()]; }

  function dayMeta(d) {
    if (!db.days[d]) db.days[d] = { sessions: [], closed: false, expenses: null };
    var m = db.days[d];
    if (!m.expenses) m.expenses = L.emptyExpenses();
    if (!Array.isArray(m.sessions)) m.sessions = [];
    // 老数据可能是 ["早市","晚市"] 这种字符串，统一成 {name, stallFee}
    m.sessions = m.sessions.map(L.normSession).filter(Boolean);
    return m;
  }

  function sessionNames() { return dayMeta(day).sessions.map(function (s) { return s.name; }); }

  function sessionObj(name) {
    return dayMeta(day).sessions.filter(function (s) { return s.name === name; })[0] || null;
  }

  function ensureSession() {
    var names = sessionNames();
    if (!names.length) return false;
    if (!session || names.indexOf(session) === -1) session = names[0];
    return true;
  }

  function modeOf(itemId, kind) {
    var it = L.getItem(itemId);
    if (!it) return 'none';
    if (it.modes.length === 1) return it.modes[0].id;
    var saved = db.config.modes[itemId + ':' + kind];
    if (saved) {
      for (var i = 0; i < it.modes.length; i++) if (it.modes[i].id === saved) return saved;
    }
    return it.defaultMode;
  }

  function setMode(itemId, kind, modeId) {
    db.config.modes[itemId + ':' + kind] = modeId;
    persist();
  }

  function sessionRecords(kind) {
    return db.records.filter(function (r) {
      return r.day === day && r.session === session && (!kind || r.kind === kind);
    });
  }

  function cellRecords(itemId, modeId, cellId, kind) {
    return db.records.filter(function (r) {
      return r.day === day && r.session === session &&
        r.itemId === itemId && r.cellId === cellId && r.kind === kind;
    });
  }

  function soldTotal(itemId, kind) {
    var amt = 0, jin = 0;
    db.records.forEach(function (r) {
      if (r.day !== day || r.session !== session || r.itemId !== itemId || r.kind !== kind) return;
      amt += L.amountOf(r); jin += L.num(r.jin);
    });
    return { amount: L.round2(amt), jin: L.round2(jin) };
  }

  // ================= 路由 =================

  function go(name, params) {
    stack.push({ name: route.name, params: route });
    route = { name: name };
    if (params) for (var k in params) route[k] = params[k];
    render();
    window.scrollTo(0, 0);
  }

  function back() {
    var prev = stack.pop();
    route = prev ? Object.assign({ name: prev.name }, prev.params) : { name: 'home' };
    render();
    window.scrollTo(0, 0);
  }

  // ================= 渲染 =================

  function render() {
    var el = document.getElementById('app');
    var warn = storageOK ? '' :
      '<div style="background:#c0392b;color:#fff;padding:10px 14px;font-size:14px;line-height:1.5">' +
      '⚠ 现在的打开方式存不住数据（关掉就没了）。请用「启动.cmd」启动后的网址打开。' +
      '</div>';
    el.innerHTML = warn + headerHTML() + '<main class="main">' + bodyHTML() + '</main>' + navHTML();
    renderSheet();
  }

  var TAB_TITLE = { home: '记账', book: '日账', recon: '对账', summary: '汇总' };

  function headerHTML() {
    var t = route.name === 'home' ? '记账'
      : route.name === 'book' ? '日账本'
      : route.name === 'recon' || route.name === 'reconPerson' ? '对账'
      : route.name === 'summary' ? '汇总'
      : route.name === 'settings' ? '设置'
      : route.name === 'expenses' ? '今天的支出'
      : route.name === 'buyPick' ? '收货 · 谁家' 
      : route.name === 'buyEntry' ? '收货 · ' + route.person
      : route.name === 'sellPick' ? (route.kind === 'clear' ? '清货 · 哪种' : '卖货 · 哪种')
      : route.name === 'sellCells' ? (route.kind === 'clear' ? '清货' : '卖货') + ' · ' + (L.getItem(route.item) || {}).name
      : route.name === 'sellCell' ? (L.getItem(route.item) || {}).name + ' · ' + route.cellLabel
      : route.name === 'lossPick' ? '损耗 · 哪种'
      : route.name === 'pricing' ? '收货定价'
      : '记账';

    var sub = L.dateLabelCN(day) + ' ' + weekdayCN(day) + (session ? ' · ' + session : '');
    var canBack = route.name !== 'home' && route.name !== 'book' && route.name !== 'recon' && route.name !== 'summary' && route.name !== 'settings';
    return '<header class="hd">' +
      (canBack ? '<button class="icon-btn" data-act="back">‹</button>' : '') +
      '<div class="hd-title">' + esc(t) + '<small>' + esc(sub) + '</small></div>' +
      '<button class="icon-btn" data-act="settings">⚙</button>' +
      '</header>';
  }

  function navHTML() {
    var cur = route.name === 'recon' || route.name === 'reconPerson' ? 'recon'
      : route.name === 'summary' ? 'summary'
      : route.name === 'book' ? 'book' : 'home';
    var items = [['home', '✎', '记账'], ['book', '☰', '日账'], ['recon', '⇄', '对账'], ['summary', '▤', '汇总']];
    var h = '<nav class="nav">';
    items.forEach(function (it) {
      h += '<button data-act="tab" data-tab="' + it[0] + '" class="' + (cur === it[0] ? 'on' : '') + '">' +
        '<span class="ic">' + it[1] + '</span>' + it[2] + '</button>';
    });
    return h + '</nav>';
  }

  function bodyHTML() {
    switch (route.name) {
      case 'home': return homeHTML();
      case 'buyPick': return buyPickHTML();
      case 'buyEntry': return buyEntryHTML();
      case 'sellPick': return sellPickHTML();
      case 'sellCells': return sellCellsHTML();
      case 'sellCell': return sellCellHTML();
      case 'lossPick': return lossPickHTML();
      case 'pricing': return pricingHTML();
      case 'expenses': return expensesHTML();
      case 'recon': return reconHTML();
      case 'reconPerson': return reconPersonHTML();
      case 'summary': return summaryHTML();
      case 'book': return bookHTML();
      case 'settings': return settingsHTML();
      default: return homeHTML();
    }
  }

  // ================= 首页 =================

  function homeHTML() {
    var m = dayMeta(day);
    var h = '';

    if (!m.sessions.length) {
      h += '<div class="card"><div class="card-title">今天拉几趟货进市场？</div>' +
        '<div class="muted" style="margin-bottom:10px">拉一趟就算一场，每场要交一次进场费。只去一次就点 1。</div>' +
        '<div class="row2">' + [1, 2, 3].map(function (n) {
          return '<button class="btn primary" data-act="set-sessions" data-n="' + n + '">' + n + ' 场</button>';
        }).join('') + '</div></div>';
      return h;
    }

    ensureSession();

    h += '<div class="sessions">' + m.sessions.map(function (s) {
      return '<button data-act="session" data-s="' + esc(s.name) + '" class="' + (s.name === session ? 'on' : '') + '">' + esc(s.name) + '</button>';
    }).join('') + '</div>';

    var so = sessionObj(session) || { stallFee: 0 };
    h += '<div class="card" style="display:flex;align-items:center;gap:10px;padding:11px 13px">' +
      '<div style="flex:1"><div style="font-size:13px;font-weight:700;color:#5f7078">' + esc(session) + ' 进场费</div>' +
      '<div class="muted">拉货进市场交的钱</div></div>' +
      '<div class="iw" style="width:112px"><input class="num" inputmode="decimal" data-act-field="stallfee" value="' + esc(so.stallFee || '') + '" placeholder="0"><span class="unit">元</span></div>' +
      '</div>';

    h += '<button class="big buy" style="width:100%;min-height:62px;margin-bottom:9px" data-act="go" data-to="buyPick">' +
      '<span>收 货</span><small>今天这一批（不分早晚，一天只收一次）</small></button>';

    h += '<div class="actions">' +
      '<button class="big sell" data-act="go" data-to="sellPick" data-kind="sell"><span>卖 货</span><small>' + esc(session) + ' 这场卖的</small></button>' +
      '<button class="big clear" data-act="go" data-to="sellPick" data-kind="clear"><span>清 货</span><small>低价甩给厂家</small></button>' +
      '<button class="big loss wide" data-act="go" data-to="lossPick"><span>损 耗</span><small>' + esc(session) + ' 这场死了的</small></button>' +
      '</div>';

    var rs = sessionRecords();
    var sold = 0, cnt = 0;
    rs.forEach(function (r) {
      if (r.kind === 'sell' || r.kind === 'clear') { sold += L.amountOf(r); cnt++; }
    });
    var buys = L.dayRecords(db.records, day).filter(function (r) { return r.kind === 'buy'; });
    var buyAmt = buys.reduce(function (s, r) { return s + L.amountOf(r); }, 0);

    h += '<div class="card"><div class="card-title">' + esc(session) + ' 这场' +
      '<span class="right">' + (cnt + buys.length) + ' 笔</span></div><div class="kpis">' +
      kpi('今天收货', '¥' + L.fmtMoney(buyAmt), 'out') +
      kpi('这场卖出', '¥' + L.fmtMoney(L.round2(sold)), 'in') +
      kpi('这场笔数', String(cnt)) +
      '</div></div>';

    var ex = m.expenses;
    h += '<div class="card"><div class="card-title">今天的支出' +
      '<span class="right m-out">¥' + L.fmtMoney(L.expenseTotal(ex, m.sessions)) + '</span></div>' +
      '<button class="btn ghost block" data-act="go" data-to="expenses">工人工资 / 油费 / 冰 / 水</button></div>';

    h += '<button class="btn primary block" style="margin-top:6px" data-act="close-day">' +
      (m.closed ? '已经收工了，再看一遍今天的账' : '收工，出今天的账') + '</button>';

    if (m.closed) {
      h += '<div class="muted" style="text-align:center;margin-top:8px">今天已收工。还能继续补记，补完再点一次即可。</div>';
    }
    return h;
  }

  function kpi(k, v, dir) {
    var cls = dir === 'out' ? ' m-out' : dir === 'in' ? ' m-in' : '';
    return '<div class="kpi"><div class="k">' + esc(k) + '</div><div class="v' + cls + '">' + esc(v) + '</div></div>';
  }

  // ================= 收货 =================

  function buyPickHTML() {
    var h = '<div class="card"><div class="card-title">从哪个档口收的？</div>';
    if (!db.config.people.length) {
      h += '<div class="empty">还没有名单<br>先去设置里把人名粘进去</div>';
    } else {
      h += '<div class="chips">' + db.config.people.map(function (p) {
        return '<button class="chip" data-act="pick-person" data-name="' + esc(p) + '" data-ctx="buy">' + esc(p) + '</button>';
      }).join('') + '</div>';
    }
    h += '<div style="margin-top:12px"><button class="btn ghost block" data-act="add-person" data-ctx="buy">＋ 新的人</button></div>';
    return h + '</div>';
  }

  function buyEntryHTML() {
    var person = route.person;
    var st = route.ff || {};
    var kind = 'buy';
    var itemId = st.item || '';
    var modeId = itemId ? (st.mode || modeOf(itemId, kind)) : '';
    var m = dayMeta(day);
    var ex = m.expenses;

    if (!st.stage) {
      // 第一步：选品种
      var h = '<div class="card"><div class="card-title">' + esc(person) + ' 这家，收了什么？</div>' +
        '<div class="chips">' + L.ITEMS.map(function (it) {
          return '<button class="chip" data-act="buy-item" data-item="' + it.id + '">' + esc(it.name) + '</button>';
        }).join('') + '</div></div>';

      h += recordedCard(person, kind);
      return h;
    }

    var it = L.getItem(itemId);
    var mode = L.getMode(itemId, modeId);
    var h2 = '<div class="card">' +
      '<div class="card-title">' + esc(it.name) +
      '<button class="btn ghost sm" data-act="buy-reset">换货</button></div>';

    if (it.modes.length > 1) {
      h2 += '<div class="seg">' + it.modes.map(function (mm) {
        return '<button data-act="buy-mode" data-mode="' + mm.id + '" class="' + (mm.id === modeId ? 'on' : '') + '">' + esc(mm.label) + '</button>';
      }).join('') + '</div>';
    }

    h2 += '<div class="cells">' + mode.cells.map(function (c) {
      var on = st.cell === c.id;
      return '<button class="cell' + (on ? ' has' : '') + '" data-act="buy-cell" data-cell="' + c.id + '">' +
        '<span class="n">' + esc(c.label) + '</span>' +
        '<span class="m">' + (on ? '已选中' : '点一下') + '</span></button>';
    }).join('') + '</div></div>';

    if (st.cell) {
      var cellLabel = (L.getCell(itemId, modeId, st.cell) || {}).label || '';
      var last = lastPrice(itemId, modeId, st.cell);
      h2 += '<div class="card"><div class="card-title">' + esc(it.name) + ' · ' + esc(cellLabel) +
        (last ? '<span class="right">上次 ' + L.fmtMoney(last.price) + ' 元</span>' : '') + '</div>' +
        '<div class="nums">' +
        '<div class="iw"><input class="num" inputmode="decimal" id="in-jin" placeholder="斤数" value=""><span class="unit">斤</span></div>' +
        '<div class="iw"><input class="num" inputmode="decimal" id="in-price" placeholder="单价" value=""><span class="unit">元/斤</span></div>' +
        '</div>' +
        '<div class="muted" style="margin:-4px 0 9px">单价可以先空着，卖完跟档口定好价再来填。</div>' +
        '<div class="amount"><span class="k">金额</span><span class="v" id="in-amt">待定价</span></div>' +
        '<button class="btn primary block" data-act="buy-save">记下这笔</button>' +
        '</div>';
    }

    h2 += recordedCard(person, kind);
    return h2;
  }

  function lastPrice(itemId, modeId, cellId) {
    for (var i = db.records.length - 1; i >= 0; i--) {
      var r = db.records[i];
      if (r.kind !== 'buy') continue;
      if (r.itemId === itemId && r.cellId === cellId) return { price: L.num(r.price), day: r.day };
    }
    return null;
  }

  function recordedCard(person, kind) {
    var rs = db.records.filter(function (r) {
      if (r.day !== day || r.person !== person || r.kind !== kind) return false;
      // 收货是整天一次，不分场次；卖货/清货按场
      if (kind !== 'buy' && r.session !== session) return false;
      return true;
    });
    var total = rs.reduce(function (s, r) { return s + L.amountOf(r); }, 0);
    var h = '<div class="card"><div class="card-title">' + (kind === 'buy' ? '今天这家已记' : '这场这家已记') +
      '<span class="right">' + rs.length + ' 笔 · ¥' + L.fmtMoney(total) + '</span></div>';
    if (!rs.length) {
      h += '<div class="empty">还没有</div>';
    } else {
      rs.forEach(function (r) {
        var paid = L.isSettled(r);
        var priced = L.isPriced(r);
        var amt = priced
          ? '<div class="row-amt ' + (kind === 'buy' ? 'm-out' : 'm-in') + '">¥' + L.fmtMoney(L.amountOf(r)) + '</div>'
          : '<span class="tag warn">待定价</span>';
        h += '<div class="row">' +
          '<div class="row-main"><div class="row-title">' + esc(L.cellText(r)) + '</div>' +
          '<div class="row-sub">' + L.fmtJin(r.jin) + '斤' + (priced ? ' × ' + L.fmtMoney(r.price) + ' 元' : ' · 卖完再定价') + '</div></div>' +
          amt +
          (priced ? '<button class="btn ' + (paid ? 'ghost' : 'warn') + ' sm" data-act="toggle-paid" data-id="' + r.id + '">' +
            (paid ? '已付' : '未付') + '</button>' : '<button class="btn ghost sm" data-act="set-price" data-id="' + r.id + '">定价</button>') +
          '<button class="row-del" data-act="del-rec" data-id="' + r.id + '">✕</button>' +
          '</div>';
      });
      if (kind === 'buy') {
        h += '<button class="btn ghost block" style="margin-top:10px" data-act="pay-all" data-person="' + esc(person) + '" data-kind="buy">这家全部标成已付</button>';
      }
    }
    return h + '</div>';
  }

  // ================= 卖货 / 清货 =================

  function sellPickHTML() {
    var kind = route.kind === 'clear' ? 'clear' : 'sell';
    var h = '<div class="card"><div class="card-title">' +
      (kind === 'clear' ? '哪种货甩给厂家？' : '今天卖了哪种？') + '</div>';
    h += '<div class="chips">' + L.ITEMS.map(function (it) {
      var t = soldTotal(it.id, kind);
      return '<button class="chip' + (t.jin > 0 ? ' on' : '') + '" data-act="go-sell" data-item="' + it.id + '" data-kind="' + kind + '">' +
        esc(it.name) + (t.jin > 0 ? ' ' + L.fmtJin(t.jin) + '斤' : '') + '</button>';
    }).join('') + '</div></div>';

    h += '<div class="muted" style="text-align:center">点一个货进去填；没卖的不用管</div>';
    return h;
  }

  function sellCellsHTML() {
    var itemId = route.item, kind = route.kind;
    var it = L.getItem(itemId);
    var modeId = modeOf(itemId, kind);
    var mode = L.getMode(itemId, modeId);
    var t = soldTotal(itemId, kind);

    var h = '<div class="card"><div class="card-title">' + esc(it.name) +
      '<span class="right">' + (t.jin > 0 ? '已卖 ' + L.fmtJin(t.jin) + '斤 · ¥' + L.fmtMoney(t.amount) : '还没记') + '</span></div>';

    if (it.modes.length > 1) {
      h += '<div class="seg">' + it.modes.map(function (mm) {
        return '<button data-act="sell-mode" data-item="' + itemId + '" data-kind="' + kind + '" data-mode="' + mm.id + '" class="' + (mm.id === modeId ? 'on' : '') + '">' + esc(mm.label) + '</button>';
      }).join('') + '</div>';
    }

    // 如果已经记过别的分法，提示一下
    var usedModes = {};
    db.records.forEach(function (r) {
      if (r.day === day && r.session === session && r.itemId === itemId && r.kind === kind) usedModes[r.modeId] = true;
    });

    h += '<div class="cells">' + mode.cells.map(function (c) {
      var rs = cellRecords(itemId, modeId, c.id, kind);
      var jin = rs.reduce(function (s, r) { return s + L.num(r.jin); }, 0);
      var amt = rs.reduce(function (s, r) { return s + L.amountOf(r); }, 0);
      return '<button class="cell' + (jin > 0 ? ' has' : '') + '" data-act="sell-cell" data-item="' + itemId + '" data-kind="' + kind + '" data-mode="' + modeId + '" data-cell="' + c.id + '" data-label="' + esc(c.label) + '">' +
        '<span class="n">' + esc(c.label) + '</span>' +
        '<span class="m">' + (jin > 0 ? L.fmtJin(jin) + '斤 · ¥' + L.fmtMoney(amt) : '点一下') + '</span></button>';
    }).join('') + '</div></div>';

    h += '<div class="muted" style="text-align:center">填了哪个格子，就是那天分了哪几档。空着就是没这个货。</div>';
    return h;
  }

  function sellCellHTML() {
    var itemId = route.item, kind = route.kind, modeId = route.mode, cellId = route.cell;
    var key = itemId + '|' + modeId + '|' + cellId + '|' + kind;
    var rs = cellRecords(itemId, modeId, cellId, kind);

    // 按价格分组
    var prices = [];
    var byPrice = {};
    rs.forEach(function (r) {
      var p = L.num(r.price);
      if (!byPrice[p]) { byPrice[p] = []; prices.push(p); }
      byPrice[p].push(r);
    });
    (draftCols[key] || []).forEach(function (p) {
      if (!byPrice[p]) { byPrice[p] = []; prices.push(p); }
    });
    prices.sort(function (a, b) { return b - a; });

    var h = '<div class="cols">';
    prices.forEach(function (p) {
      var list = byPrice[p] || [];
      var amt = list.reduce(function (s, r) { return s + L.amountOf(r); }, 0);
      h += '<div class="col"><div class="col-hd"><b>' + L.fmtMoney(p) + ' 元</b>' +
        '<span class="sum">' + L.fmtJin(list.reduce(function (s, r) { return s + L.num(r.jin); }, 0)) + '斤</span></div>';
      list.forEach(function (r) {
        h += '<div class="col-item"><span class="nm">' + esc(r.person) + '</span>' +
          '<span class="jj">' + L.fmtJin(r.jin) + '</span>' +
          '<button class="x" data-act="del-rec" data-id="' + r.id + '">✕</button></div>';
      });
      h += '<button class="col-add" data-act="add-to-col" data-item="' + itemId + '" data-kind="' + kind + '" data-mode="' + modeId + '" data-cell="' + cellId + '" data-price="' + p + '">＋ 加一人</button>';
      h += '</div>';
    });

    h += '<button class="col add" data-act="add-price" data-item="' + itemId + '" data-kind="' + kind + '" data-mode="' + modeId + '" data-cell="' + cellId + '">' +
      '<div style="font-size:30px;line-height:1">＋</div><div style="font-size:14px;margin-top:6px">加一个价</div></button>';
    h += '</div>';

    var total = rs.reduce(function (s, r) { return s + L.amountOf(r); }, 0);
    h += '<div class="card" style="margin-top:12px"><div class="card-title">这一档合计' +
      '<span class="right">' + L.fmtJin(rs.reduce(function (s, r) { return s + L.num(r.jin); }, 0)) + '斤 · ¥' + L.fmtMoney(total) + '</span></div>' +
      '<div class="muted">有客户买了别的价，点右边「＋ 加一个价」多开一列。</div></div>';
    return h;
  }

  // ================= 损耗 =================

  function lossPickHTML() {
    var h = '<div class="card"><div class="card-title">死了、扔了的是哪种？</div>' +
      '<div class="chips">' + L.ITEMS.map(function (it) {
        return '<button class="chip" data-act="loss-item" data-item="' + it.id + '">' + esc(it.name) + '</button>';
      }).join('') + '</div></div>';

    var rs = db.records.filter(function (r) {
      return r.day === day && r.session === session && r.kind === 'loss';
    });
    if (rs.length) {
      h += '<div class="card"><div class="card-title">这场死了 ' +
        L.fmtJin(rs.reduce(function (s, r) { return s + L.num(r.jin); }, 0)) + ' 斤</div>';
      rs.forEach(function (r) {
        h += '<div class="row"><div class="row-main"><div class="row-title">' + esc(L.cellText(r)) + '</div></div>' +
          '<div class="row-amt">' + L.fmtJin(r.jin) + ' 斤</div>' +
          '<button class="row-del" data-act="del-rec" data-id="' + r.id + '">✕</button></div>';
      });
      h += '</div>';
    }
    return h;
  }

  // ================= 支出 =================

  function expensesHTML() {
    var m = dayMeta(day);
    var ex = m.expenses;
    var h = '<div class="card"><div class="card-title">工人（日结，每人一个数）' +
      '<span class="right" id="wk-total">¥' + L.fmtMoney((ex.workers || []).reduce(function (s, w) { return s + L.num(w.amount); }, 0)) + '</span></div>';

    if (!ex.workers || !ex.workers.length) {
      h += '<div class="empty">今天没请人，就不用填</div>';
    } else {
      ex.workers.forEach(function (w, i) {
        h += '<div class="row"><div class="row-main"><div class="row-title">' + esc(w.name) + '</div></div>' +
          '<input class="num" style="width:120px;height:44px;font-size:18px" inputmode="decimal" data-act-field="worker" data-i="' + i + '" value="' + esc(w.amount || '') + '" placeholder="0">' +
          '<button class="row-del" data-act="del-worker" data-i="' + i + '">✕</button></div>';
      });
    }
    h += '<button class="btn ghost block" style="margin-top:10px" data-act="add-worker">＋ 今天还叫了谁</button></div>';

    h += '<div class="card"><div class="card-title">其他</div>' +
      '<div class="field"><label>油费</label><div class="iw"><input class="num" inputmode="decimal" data-act-field="oil" value="' + esc(ex.oil || '') + '" placeholder="0"><span class="unit">元</span></div></div>' +
      '<div class="field"><label>冰</label><div class="iw"><input class="num" inputmode="decimal" data-act-field="ice" value="' + esc(ex.ice || '') + '" placeholder="0"><span class="unit">元</span></div></div>' +
      '<div class="field" style="margin-bottom:0"><label>水</label><div class="iw"><input class="num" inputmode="decimal" data-act-field="water" value="' + esc(ex.water || '') + '" placeholder="0"><span class="unit">元</span></div></div>' +
      '</div>';

    var m0 = dayMeta(day);
    if (m0.sessions.length) {
      h += '<div class="card"><div class="card-title">进场费（每场一次）' +
        '<span class="right m-out">¥' + L.fmtMoney(L.stallFeeTotal(m0.sessions)) + '</span></div>' +
        m0.sessions.map(function (s) {
          return '<div class="row"><div class="row-main"><div class="row-title">' + esc(s.name) + '</div></div>' +
            '<div class="row-amt m-out">' + (L.num(s.stallFee) > 0 ? '¥' + L.fmtMoney(s.stallFee) : '没填') + '</div></div>';
        }).join('') +
        '<div class="muted" style="margin-top:8px">在首页场次下面填就行。</div></div>';
    }

    h += '<div class="card"><div class="card-title">今天支出合计' +
      '<span class="right m-out" id="ex-total" style="font-size:19px">¥' + L.fmtMoney(L.expenseTotal(ex, m0.sessions)) + '</span></div>' +
      '<div class="muted">空着就代表今天没花这笔钱，不用填 0。</div></div>';
    return h;
  }

  // ================= 对账 =================

  function reconHTML() {
    var h = '';

    // 还没定收货价
    var unpriced = L.dayRecords(db.records, day).filter(function (r) {
      return r.kind === 'buy' && !L.isPriced(r);
    });
    if (unpriced.length) {
      var uj = unpriced.reduce(function (s, r) { return s + L.num(r.jin); }, 0);
      h += '<div class="sec-title" style="color:#b07b12">还有 ' + unpriced.length + ' 笔收货没定价 · 共 ' + L.fmtJin(uj) + ' 斤</div>' +
        '<div class="card">' +
        '<button class="btn warn block" data-act="go" data-to="pricing">一页填完（' + unpriced.length + ' 笔）</button>' +
        '<div style="height:9px"></div>';
      unpriced.forEach(function (r) {
        h += '<div class="row"><div class="row-main">' +
          '<div class="row-title">' + esc(L.cellText(r)) + '</div>' +
          '<div class="row-sub">' + esc(r.person || '') + ' · ' + L.fmtJin(r.jin) + ' 斤</div></div>' +
          '<button class="btn ghost sm" data-act="set-price" data-id="' + r.id + '">单条定</button></div>';
      });
      h += '</div>';
    }

    var rs = L.dayRecords(db.records, day).filter(function (r) {
      return r.kind === 'sell' || r.kind === 'clear';
    });
    var byPerson = {};
    rs.forEach(function (r) {
      var p = r.person || '（没写人）';
      if (!byPerson[p]) byPerson[p] = { person: p, amount: 0, owed: 0, count: 0 };
      byPerson[p].amount = L.round2(byPerson[p].amount + L.amountOf(r));
      byPerson[p].owed = L.round2(byPerson[p].owed + L.owedOf(r));
      byPerson[p].count++;
    });
    var list = Object.keys(byPerson).map(function (k) { return byPerson[k]; })
      .filter(function (o) { return o.owed > 0.004; })
      .sort(function (a, b) { return b.owed - a.owed; });

    h += '<div class="sec-title">今天还没给钱的（要发数）</div>';
    if (!list.length) {
      h += '<div class="card"><div class="empty">今天都结清了</div></div>';
    } else {
      list.forEach(function (o) {
        var text = L.statement(db.records, day, o.person, 'multi');
        h += '<div class="recon-item">' +
          '<div class="recon-top"><div class="recon-name">' + esc(o.person) + '</div>' +
          '<div class="recon-amt m-in">¥' + L.fmtMoney(o.owed) + '</div></div>' +
          '<div class="recon-meta">' + o.count + ' 笔 · 共 ¥' + L.fmtMoney(o.amount) + '</div>' +
          '<pre style="white-space:pre-wrap;font-size:13px;color:#5f7078;margin:8px 0 0;font-family:inherit">' + esc(text) + '</pre>' +
          '<div class="recon-acts">' +
          '<button class="btn primary" data-act="copy" data-person="' + esc(o.person) + '" data-style="multi">复制 · 多行</button>' +
          '<button class="btn ghost" data-act="copy" data-person="' + esc(o.person) + '" data-style="brief">复制 · 简短</button>' +
          '</div>' +
          '<div class="recon-acts">' +
          '<button class="btn ghost" data-act="pay" data-person="' + esc(o.person) + '" data-side="in">结了多少</button>' +
          '<button class="btn ghost" data-act="recon-person" data-person="' + esc(o.person) + '" data-side="in">看明细</button>' +
          '</div></div>';
      });
    }

    var un = L.receivables(db.records);
    h += '<div class="sec-title">还欠着的（所有日子）</div>';
    if (!un.length) {
      h += '<div class="card"><div class="empty">没有欠账</div></div>';
    } else {
      un.forEach(function (o) {
        h += '<div class="recon-item"><div class="recon-top">' +
          '<div class="recon-name">' + esc(o.person) + '</div>' +
          '<div class="recon-amt">¥' + L.fmtMoney(o.amount) + '</div></div>' +
          '<div class="recon-meta">' + o.count + ' 笔 · 最早 ' + L.dateLabelCN(o.oldest) + '（' + o.days.length + '天）</div>' +
          '<div class="recon-acts">' +
          '<button class="btn ghost" data-act="pay" data-person="' + esc(o.person) + '" data-side="in">结了多少</button>' +
          '<button class="btn ghost" data-act="recon-person" data-person="' + esc(o.person) + '" data-side="in">看明细</button>' +
          '</div></div>';
      });
    }

    var unPay = L.payables(db.records);
    h += '<div class="sec-title">我还没付档口的</div>';
    if (!unPay.length) {
      h += '<div class="card"><div class="empty">都付清了</div></div>';
    } else {
      unPay.forEach(function (o) {
        h += '<div class="recon-item"><div class="recon-top">' +
          '<div class="recon-name">' + esc(o.person) + '</div>' +
          '<div class="recon-amt">¥' + L.fmtMoney(o.amount) + '</div></div>' +
          '<div class="recon-meta">' + o.count + ' 笔 · 最早 ' + L.dateLabelCN(o.oldest) + '</div>' +
          '<div class="recon-acts">' +
          '<button class="btn ghost" data-act="pay" data-person="' + esc(o.person) + '" data-side="out">结了多少</button>' +
          '<button class="btn ghost" data-act="recon-person" data-person="' + esc(o.person) + '" data-side="out">看明细</button>' +
          '</div></div>';
      });
    }
    return h;
  }

  function reconPersonHTML() {
    var person = route.person, side = route.side;
    var kinds = side === 'in' ? ['sell', 'clear'] : ['buy'];
    var rs = db.records.filter(function (r) {
      return (r.person || '（没写人）') === person &&
        kinds.indexOf(r.kind) !== -1 && L.owedOf(r) > 0.004;
    }).sort(function (a, b) { return a.day < b.day ? -1 : 1; });

    var h = '<div class="card"><div class="card-title">' + esc(person) + ' 还没结的' +
      '<span class="right">¥' + L.fmtMoney(rs.reduce(function (s, r) { return s + L.owedOf(r); }, 0)) + '</span></div>';
    if (!rs.length) h += '<div class="empty">没有</div>';
    rs.forEach(function (r) {
      h += '<div class="row"><div class="row-main">' +
        '<div class="row-title">' + esc(L.cellText(r)) + (r.kind === 'clear' ? ' · 清货' : '') + '</div>' +
        '<div class="row-sub">' + L.dateLabelCN(r.day) + ' · ' + L.fmtJin(r.jin) + '斤 × ' + L.fmtMoney(r.price) +
        (L.paidOf(r) > 0 ? ' · 已给 ' + L.fmtMoney(L.paidOf(r)) : '') + '</div></div>' +
        '<div class="row-amt">欠 ¥' + L.fmtMoney(L.owedOf(r)) + '</div></div>';
    });
    h += '</div>';
    h += '<button class="btn primary block" data-act="pay" data-person="' + esc(person) + '" data-side="' + side + '">结款</button>';
    return h;
  }

  // ================= 批量定价 =================

  function pricingHTML() {
    var unpriced = L.dayRecords(db.records, day).filter(function (r) {
      return r.kind === 'buy' && !L.isPriced(r);
    });
    if (!unpriced.length) {
      return '<div class="card"><div class="empty">收货价都定完了</div></div>';
    }

    var byPerson = {};
    unpriced.forEach(function (r) {
      var p = r.person || '（没写人名）';
      if (!byPerson[p]) byPerson[p] = [];
      byPerson[p].push(r);
    });

    var h = '<div class="card"><div class="card-title">还没定价的收货' +
      '<span class="right">' + unpriced.length + ' 笔 · ' +
      L.fmtJin(unpriced.reduce(function (a, r) { return a + L.num(r.jin); }, 0)) + ' 斤</span></div>' +
      '<div class="muted">一页填完，填了价的才会存。空着的下次再来。</div></div>';

    Object.keys(byPerson).forEach(function (p) {
      var rs = byPerson[p];
      var jj = rs.reduce(function (a, r) { return a + L.num(r.jin); }, 0);
      h += '<div class="card"><div class="card-title">' + esc(p) +
        '<span class="right">' + L.fmtJin(jj) + ' 斤</span></div>';
      rs.forEach(function (r) {
        h += '<div class="row">' +
          '<div class="row-main"><div class="row-title">' + esc(L.cellText(r)) + '</div>' +
          '<div class="row-sub">' + L.fmtJin(r.jin) + ' 斤</div></div>' +
          '<div class="iw" style="width:120px"><input class="num" style="height:46px;font-size:18px" inputmode="decimal" ' +
          'data-price-id="' + r.id + '" value="' + esc(priceDraft[r.id] || '') + '" placeholder="元/斤"><span class="unit">元</span></div>' +
          '</div>';
      });
      h += '</div>';
    });

    h += '<button class="btn primary block" data-act="save-prices">保存全部</button>';
    h += '<div class="muted" style="text-align:center;margin-top:8px">按品种各定各的价，互不影响。</div>';
    return h;
  }


  // ================= 日账本 =================

  function bookHTML() {
    var t0 = today();
    var isNow = day === t0;
    var rel = isNow ? '今天'
      : day === L.addDays(t0, -1) ? '昨天'
      : day === L.addDays(t0, -2) ? '前天'
      : '';
    var h = '<div class="card"><div class="card-title" style="justify-content:center;gap:10px">' +
      '<button class="btn ghost sm" data-act="book-prev">‹ 前一天</button>' +
      '<b style="font-size:16px;text-align:center">' + L.dateLabelCN(day) +
      (rel ? '<span style="display:block;font-size:12px;color:#5f7078;font-weight:400">' + rel + ' · ' + weekdayCN(day) + '</span>' : '') +
      '</b>' +
      (isNow ? '<span style="width:86px"></span>' : '<button class="btn ghost sm" data-act="book-next">后一天 ›</button>') +
      '</div>';
    if (!isNow) {
      h += '<button class="btn ghost block" data-act="book-today">回到今天（' + L.dateLabelCN(t0) + '）</button>';
    }
    h += '</div>';

    var m = dayMeta(day);
    var rs = L.dayRecords(db.records, day);
    var s = L.summarize(db.records, day, m.expenses, m.sessions);

    h += '<div class="card"><div class="title" style="font-size:13px;color:#5f7078;font-weight:700;margin-bottom:8px">这一天</div><div class="kpis">' +
      kpi('收货', '¥' + L.fmtMoney(s.buyAmount), 'out') +
      kpi('卖出', '¥' + L.fmtMoney(s.income), 'in') +
      kpi('到手', (s.gross < 0 ? '-¥' : '¥') + L.fmtMoney(Math.abs(s.gross)), s.gross < 0 ? 'out' : 'in') +
      '</div></div>';

    if (!rs.length) {
      h += '<div class="card"><div class="empty">这天没有记录</div></div>';
      return h;
    }

    // 收货：一天一次，不挂场次
    var buys = rs.filter(function (r) { return r.kind === 'buy'; });
    if (buys.length) {
      var bj = buys.reduce(function (a, r) { return a + L.num(r.jin); }, 0);
      var ba = buys.reduce(function (a, r) { return a + L.amountOf(r); }, 0);
      var un = buys.filter(function (r) { return !L.isPriced(r); }).length;
      h += '<div class="sec-title">收货（今天这一批）· ' + buys.length + ' 笔' + (un ? ' · ' + un + ' 笔还没定价' : '') + '</div>' +
        '<div class="card"><div class="card-title">收货' +
        '<span class="right">' + L.fmtJin(bj) + '斤 · ¥' + L.fmtMoney(ba) + '</span></div>';
      buys.forEach(function (r) { h += recRowBook(r); });
      h += '</div>';
    }

    m.sessions.forEach(function (sess) {
      var srs = rs.filter(function (r) { return r.session === sess.name && r.kind !== 'buy'; });
      if (!srs.length) return;
      h += '<div class="sec-title">' + esc(sess.name) + ' · ' + srs.length + ' 笔' +
        (L.num(sess.stallFee) > 0 ? ' · 进场费 ¥' + L.fmtMoney(sess.stallFee) : '') + '</div>';
      var groups = [['sell', '卖货'], ['clear', '清货'], ['loss', '损耗']];
      groups.forEach(function (g) {
        var grs = srs.filter(function (r) { return r.kind === g[0]; });
        if (!grs.length) return;
        h += '<div class="card"><div class="card-title">' + g[1] +
          '<span class="right">' + L.fmtJin(grs.reduce(function (a, r) { return a + L.num(r.jin); }, 0)) + '斤 · ¥' +
          L.fmtMoney(grs.reduce(function (a, r) { return a + L.amountOf(r); }, 0)) + '</span></div>';
        grs.forEach(function (r) { h += recRowBook(r); });
        h += '</div>';
      });
    });
    return h;
  }

  function recRowBook(r) {
    var priced = L.isPriced(r);
    var amt;
    if (r.kind === 'loss') amt = '<div class="row-amt" style="color:#93a3ab">—</div>';
    else if (!priced) amt = '<span class="tag warn">待定价</span>';
    else amt = '<div class="row-amt ' + (r.kind === 'buy' ? 'm-out' : 'm-in') + '">¥' + L.fmtMoney(L.amountOf(r)) + '</div>';

    return '<div class="row"><span class="dot ' + r.kind + '"></span>' +
      '<div class="row-main"><div class="row-title">' + esc(L.cellText(r)) + '</div>' +
      '<div class="row-sub">' + esc(r.person || '') + ' · ' + L.fmtJin(r.jin) + '斤' +
      (r.kind !== 'loss' && priced ? ' × ' + L.fmtMoney(r.price) : '') +
      (r.kind === 'buy' && !priced ? ' · 卖完再定价' : '') +
      (L.owedOf(r) > 0.004 && priced ? ' · 欠' : '') + '</div></div>' +
      amt + '</div>';
  }

  // ================= 汇总 =================

  function summaryHTML() {
    var m = dayMeta(day);
    var s = L.summarize(db.records, day, m.expenses, m.sessions);
    var items = L.itemSummary(db.records, day);
    var ps = L.personSummary(db.records, day);

    var h = '<div class="card"><div class="card-title">' + L.dateLabelCN(day) + ' 的账</div>' +
      '<div class="kpis">' +
      kpi('收进来', '¥' + L.fmtMoney(s.income), 'in') +
      kpi('花出去', '¥' + L.fmtMoney(s.expense), 'out') +
      kpi('今天到手', (s.gross < 0 ? '-¥' : '¥') + L.fmtMoney(Math.abs(s.gross)), s.gross < 0 ? 'out' : 'in') +
      '</div>' +
      '<div style="margin-top:10px;font-size:14px;color:#5f7078;line-height:1.8">' +
      '卖货 ¥' + L.fmtMoney(s.sellAmount) + (s.clearAmount ? '（其中清货 ¥' + L.fmtMoney(s.clearAmount) + '）' : '') + '<br>' +
      '收货 ¥' + L.fmtMoney(s.buyAmount) +
      (s.unpricedCount ? '（还有 ' + s.unpricedCount + ' 笔 ' + L.fmtJin(s.unpricedJin) + ' 斤没定价）' : '') +
      ' ＋ 工人/油/冰/水/进场 ¥' + L.fmtMoney(s.expenseOther) +
      '</div></div>';

    if (s.unpricedCount) {
      h += '<div class="card" style="border-left:4px solid #b07b12"><div class="card-title">⚠ 有 ' + s.unpricedCount +
        ' 笔收货还没定价</div><div class="muted">这些还没算进今天的花销。价定好了，去「对账」里填。</div>' +
        '<button class="btn ghost block" style="margin-top:9px" data-act="go" data-to="pricing">去填收货价</button></div>';
    }

    if (s.unpaidIn > 0.004 || s.unpaidOut > 0.004) {
      h += '<div class="card"><div class="card-title">还挂在账上的</div>' +
        '<div class="row"><div class="row-main"><div class="row-title">客户还欠我（他该给我）</div></div><div class="row-amt m-in">¥' + L.fmtMoney(s.unpaidIn) + '</div></div>' +
        '<div class="row"><div class="row-main"><div class="row-title">我还欠档口（我该给他）</div></div><div class="row-amt m-out">¥' + L.fmtMoney(s.unpaidOut) + '</div></div>' +
        '</div>';
    }

    h += '<div class="card"><div class="card-title">收了什么 / 卖了多少斤</div>';
    if (!items.length) h += '<div class="empty">这一天没有记录</div>';
    else {
      h += '<table class="tbl"><thead><tr><th>货</th><th>收</th><th>卖</th><th>清</th><th>死</th><th>差额</th></tr></thead><tbody>';
      items.forEach(function (r) {
        h += '<tr><td>' + esc(r.name) + '</td><td>' + L.fmtJin(r.buyJin) + '</td><td>' + L.fmtJin(r.sellJin) + '</td>' +
          '<td>' + (r.clearJin ? L.fmtJin(r.clearJin) : '-') + '</td>' +
          '<td>' + (r.lossJin ? L.fmtJin(r.lossJin) : '-') + '</td>' +
          '<td class="' + (Math.abs(r.leftJin) > 0.01 ? 'neg' : 'zero') + '">' + L.fmtJin(r.leftJin) + '</td></tr>';
      });
      h += '</tbody></table>';
      h += '<div class="muted" style="margin-top:8px">差额 = 收 − 卖 − 清 − 死。正常应该接近 0。</div>';
    }
    h += '</div>';

    h += '<div class="card"><div class="card-title">钱从谁那来</div>';
    if (!ps.incomeBy.length) h += '<div class="empty">没有</div>';
    else ps.incomeBy.forEach(function (o) {
      h += '<div class="row"><div class="row-main"><div class="row-title">' + esc(o.person) + '</div>' +
        '<div class="row-sub">' + o.count + ' 笔' + (o.unpaid > 0.004 ? ' · 还欠 ¥' + L.fmtMoney(o.unpaid) : ' · 已结清') + '</div></div>' +
        '<div class="row-amt m-in">¥' + L.fmtMoney(o.amount) + '</div></div>';
    });
    h += '</div>';

    h += '<div class="card"><div class="card-title">钱付给了谁</div>';
    if (!ps.expenseBy.length) h += '<div class="empty">没有</div>';
    else ps.expenseBy.forEach(function (o) {
      h += '<div class="row"><div class="row-main"><div class="row-title">' + esc(o.person) + '</div>' +
        '<div class="row-sub">' + o.count + ' 笔' + (o.unpaid > 0.004 ? ' · 还欠 ¥' + L.fmtMoney(o.unpaid) : ' · 已付清') + '</div></div>' +
        '<div class="row-amt m-out">¥' + L.fmtMoney(o.amount) + '</div></div>';
    });
    var ex = m.expenses;
    if (L.expenseTotal(ex, m.sessions) > 0) {
      (ex.workers || []).forEach(function (w) {
        if (L.num(w.amount) > 0) {
          h += '<div class="row"><div class="row-main"><div class="row-title">' + esc(w.name) + '</div><div class="row-sub">工人工资</div></div>' +
            '<div class="row-amt m-out">¥' + L.fmtMoney(w.amount) + '</div></div>';
        }
      });
      m.sessions.forEach(function (ss) {
        if (L.num(ss.stallFee) > 0) {
          h += '<div class="row"><div class="row-main"><div class="row-title">' + esc(ss.name) + ' 进场费</div></div>' +
            '<div class="row-amt m-out">¥' + L.fmtMoney(ss.stallFee) + '</div></div>';
        }
      });
      if (L.num(ex.oil) > 0) h += '<div class="row"><div class="row-main"><div class="row-title">油费</div></div><div class="row-amt m-out">¥' + L.fmtMoney(ex.oil) + '</div></div>';
      if (L.num(ex.ice) > 0) h += '<div class="row"><div class="row-main"><div class="row-title">冰</div></div><div class="row-amt m-out">¥' + L.fmtMoney(ex.ice) + '</div></div>';
      if (L.num(ex.water) > 0) h += '<div class="row"><div class="row-main"><div class="row-title">水</div></div><div class="row-amt m-out">¥' + L.fmtMoney(ex.water) + '</div></div>';
    }
    h += '</div>';

    h += '<button class="btn ghost block" data-act="backup">存一份备份</button>';
    h += '<div class="muted" style="text-align:center;margin-top:8px">收工时已经自动存过一份，这个是手动再存。</div>';
    return h;
  }

  // ================= 设置 =================

  function settingsHTML() {
    var h = '<div class="card"><div class="card-title">人名单（档口和客户放一起）' +
      '<span class="right">' + db.config.people.length + ' 个</span></div>' +
      '<div class="muted" style="margin-bottom:9px">一行一个名字。可以写成「卢妹(虾古、蚧)」这样带备注。</div>' +
      '<textarea class="txt" id="people-ta" style="min-height:150px;padding:10px">' + esc(db.config.people.join('\n')) + '</textarea>' +
      '<button class="btn primary block" style="margin-top:9px" data-act="save-people">保存名单</button></div>';

    h += '<div class="card"><div class="card-title">固定工人</div>' +
      '<div class="muted" style="margin-bottom:9px">一行一个。每天点支出时会出现在列表里，不来的不填数就行。</div>' +
      '<textarea class="txt" id="worker-ta" style="min-height:100px;padding:10px">' + esc(db.config.workers.join('\n')) + '</textarea>' +
      '<button class="btn primary block" style="margin-top:9px" data-act="save-workers">保存工人</button></div>';

    h += '<div class="card"><div class="card-title">营业日</div>' +
      '<div class="toggle"><span>凌晨 ' + db.config.cutoffHour + ' 点前的交易算前一天</span></div>' +
      '<div class="muted" style="margin-top:7px">晚市拖过 12 点的那部分会自动记到前一天，不用管。</div>' +
      '<div class="muted" style="margin-top:9px;padding-top:9px;border-top:1px solid #dfe6ea;color:#0e4d64">' +
      '这台手机现在是 ' + new Date().getHours() + ' 点 ' + (new Date().getMinutes() < 10 ? '0' : '') + new Date().getMinutes() + ' 分，' +
      '程序认为「今天」是 <b>' + L.dateLabelCN(today()) + ' ' + weekdayCN(today()) + '</b>' +
      '</div></div>';

    h += '<div class="card"><div class="card-title">数据</div>' +
      '<div class="row2" style="margin-bottom:9px">' +
      '<button class="btn ghost" data-act="backup">导出备份</button>' +
      '<button class="btn danger" data-act="wipe">清空所有记录</button></div>' +
      '<div class="muted">数据只在这台手机上。换手机、清浏览器数据前，一定先导出备份。</div></div>';

    h += '<div class="card"><div class="card-title">一共记了多少</div>' +
      '<div class="muted">' + db.records.length + ' 笔 · 共 ' + Object.keys(db.days).length + ' 天 · 版本 ' + VERSION + '</div></div>';
    return h;
  }

  // ================= 弹层 =================

  function renderSheet() {
    var el = document.getElementById('sheet');
    if (!sheet) { el.classList.add('hidden'); el.innerHTML = ''; return; }
    el.classList.remove('hidden');
    el.innerHTML = '<div class="sheet-inner">' + sheetHTML() + '</div>';
  }

  function closeSheet() { sheet = null; renderSheet(); }

  function sheetHTML() {
    if (sheet.type === 'people') {
      var h = '<div class="sheet-hd"><b>' + esc(sheet.title) + '</b><button class="x" data-act="close-sheet">✕</button></div>' +
        '<div class="sheet-body"><input class="txt" id="p-search" placeholder="搜名字" style="margin-bottom:9px">' +
        '<div class="plist" id="p-list">' + personItems(sheet.people) + '</div></div>' +
        '<div class="sheet-ft"><button class="btn ghost" data-act="new-person" data-target="' + sheet.target + '">＋ 新的人</button></div>';
      return h;
    }
    if (sheet.type === 'cells') {
      return '<div class="sheet-hd"><b>' + esc(sheet.title) + '</b><button class="x" data-act="close-sheet">✕</button></div>' +
        '<div class="sheet-body"><div class="plist">' +
        sheet.cells.map(function (c) {
          return '<button class="pitem" data-act="choose-cell" data-id="' + esc(c.id) + '" data-label="' + esc(c.label) + '">' +
            esc(c.label) + '<span class="badge">›</span></button>';
        }).join('') + '</div></div>';
    }
    if (sheet.type === 'num') {
      return '<div class="sheet-hd"><b>' + esc(sheet.title) + '</b><button class="x" data-act="close-sheet">✕</button></div>' +
        '<div class="sheet-body">' +
        (sheet.sub ? '<div class="muted" style="margin-bottom:8px">' + esc(sheet.sub) + '</div>' : '') +
        '<div class="iw"><input class="num" id="num-in" inputmode="decimal" value="' + esc(sheet.value || '') + '" placeholder="' + esc(sheet.ph || '') + '" style="font-size:30px;height:66px"><span class="unit">' + esc(sheet.unit || '') + '</span></div>' +
        '</div><div class="sheet-ft"><button class="btn ghost" data-act="close-sheet">取消</button>' +
        '<button class="btn primary" data-act="num-ok">确定</button></div>';
    }
    if (sheet.type === 'text') {
      return '<div class="sheet-hd"><b>' + esc(sheet.title) + '</b><button class="x" data-act="close-sheet">✕</button></div>' +
        '<div class="sheet-body"><input class="txt" id="num-in" value="' + esc(sheet.value || '') + '" placeholder="' + esc(sheet.ph || '') + '"></div>' +
        '<div class="sheet-ft"><button class="btn ghost" data-act="close-sheet">取消</button>' +
        '<button class="btn primary" data-act="num-ok">确定</button></div>';
    }
    if (sheet.type === 'copy') {
      return '<div class="sheet-hd"><b>发给 ' + esc(sheet.person) + '</b><button class="x" data-act="close-sheet">✕</button></div>' +
        '<div class="sheet-body">' +
        '<div class="sec-title">多行版（看得清）</div>' +
        '<pre style="white-space:pre-wrap;font-size:14px;background:#fff;padding:11px;border-radius:12px;font-family:inherit;margin:0 0 12px">' + esc(sheet.multi) + '</pre>' +
        '<button class="btn primary block" data-act="copy-text" data-style="multi">复制多行版</button>' +
        '<div class="sec-title" style="margin-top:16px">简短版（一行）</div>' +
        '<pre style="white-space:pre-wrap;font-size:14px;background:#fff;padding:11px;border-radius:12px;font-family:inherit;margin:0 0 12px">' + esc(sheet.brief) + '</pre>' +
        '<button class="btn ghost block" data-act="copy-text" data-style="brief">复制简短版</button>' +
        '</div>';
    }
    if (sheet.type === 'ask') {
      return '<div class="sheet-hd"><b>' + esc(sheet.title) + '</b><button class="x" data-act="close-sheet">✕</button></div>' +
        '<div class="sheet-body"><div class="muted">' + esc(sheet.msg || '') + '</div></div>' +
        '<div class="sheet-ft"><button class="btn ghost" data-act="close-sheet">取消</button>' +
        '<button class="btn primary" data-act="ask-ok">确定</button></div>';
    }
    return '';
  }

  function personItems(list) {
    if (!list.length) return '<div class="empty">没有</div>';
    return list.map(function (p) {
      return '<button class="pitem" data-act="choose-person" data-name="' + esc(p) + '">' + esc(p) + '<span class="badge">›</span></button>';
    }).join('');
  }

  function promptNum(title, opts, cb) {
    var o = opts || {};
    pending.num = cb;
    sheet = { type: 'num', title: title, value: o.value, sub: o.sub, ph: o.ph, unit: o.unit };
    renderSheet();
    setTimeout(function () {
      var i = document.getElementById('num-in');
      if (i) { i.focus(); i.select(); }
    }, 70);
  }

  function promptText(title, opts, cb) {
    var o = opts || {};
    pending.text = cb;
    sheet = { type: 'text', title: title, value: o.value, ph: o.ph };
    renderSheet();
    setTimeout(function () {
      var i = document.getElementById('num-in');
      if (i) i.focus();
    }, 70);
  }

  function pickPerson(title, target, cb, list) {
    pending.person = cb;
    lastPick = { title: title, target: target };
    sheet = { type: 'people', title: title, target: target, people: (list || db.config.people).slice() };
    renderSheet();
  }

  // ================= 动作 =================

  function addRecord(obj) {
    obj.id = uid();
    obj.day = day;
    // 收货一天只收一次，不挂到场次上
    obj.session = obj.kind === 'buy' ? '' : session;
    obj.paidAmount = obj.paidAmount || 0;
    obj.payments = obj.payments || [];
    db.records.push(obj);
    persist();
    return obj;
  }

  function allocateAndPay(person, kinds, amount) {
    var res = L.allocatePayment(db.records, person, kinds, amount);
    var todayStr = L.dateStr(new Date());
    res.allocations.forEach(function (a) {
      var r = db.records.filter(function (x) { return x.id === a.id; })[0];
      if (!r) return;
      r.paidAmount = L.round2(L.paidOf(r) + a.amount);
      r.payments.push({ d: todayStr, a: a.amount });
    });
    persist();
    return res;
  }

  function backup() {
    var data = JSON.stringify(db);
    // 装在手机 App 里：走原生，存到「下载」
    var bridge = window.AndroidBridge;
    if (bridge && bridge.saveBackup) {
      try { bridge.saveBackup('海鲜账-' + day + '.json', data); return; } catch (e) { }
    }
    try {
      var blob = new Blob([data], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = '海鲜账-' + day + '.json';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 300);
      toast('备份已存到「下载」文件夹');
    } catch (e) {
      toast('备份失败，试试用「导出」复制文字');
    }
  }

  function copyText(text) {
    var bridge = window.AndroidBridge;
    if (bridge && bridge.copyText) {
      try { bridge.copyText(text); return; } catch (e) { }
    }
    var ok = false;
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (e) { ok = false; }
    if (ok) { toast('已复制，去微信粘贴'); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('已复制，去微信粘贴'); },
        function () { toast('复制失败，长按文字手动复制'); });
    } else {
      toast('复制不了，长按文字手动复制');
    }
  }

  // ================= 事件 =================

  document.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!t) return;
    var act = t.getAttribute('data-act');
    var D = function (k) { return t.getAttribute(k); };

    switch (act) {
      case 'close-sheet': closeSheet(); break;

      case 'tab':
        stack = [];
        var tb = D('data-tab');
        route = { name: tb === 'home' ? 'home' : tb };
        if (tb === 'book') {
          if (!day) day = today();
          if (day > today()) day = today();   // 不让人翻到以后
        }
        render(); window.scrollTo(0, 0);
        break;

      case 'back': back(); break;

      case 'set-sessions': {
        var n = parseInt(D('data-n'), 10);
        var m = dayMeta(day);
        var names = n === 1 ? ['早市'] : n === 2 ? ['早市', '晚市'] : SESSION_NAMES.slice(0, 3);
        m.sessions = names.map(function (x) { return { name: x, stallFee: 0 }; });
        session = m.sessions[0].name;
        persist(); render();
        break;
      }

      case 'session':
        session = D('data-s');
        render();
        break;

      case 'go':
        go(D('data-to'), { kind: D('data-kind') || undefined });
        break;

      case 'sell-mode':
        setMode(D('data-item'), D('data-kind'), D('data-mode'));
        render();
        break;

      case 'sell-cell':
        go('sellCell', {
          item: D('data-item'), kind: D('data-kind'), mode: D('data-mode'),
          cell: D('data-cell'), cellLabel: D('data-label')
        });
        break;

      case 'add-price': {
        var pk = D('data-item') + '|' + D('data-mode') + '|' + D('data-cell') + '|' + D('data-kind');
        var it1 = D('data-item'), md1 = D('data-mode'), cl1 = D('data-cell'), kd1 = D('data-kind');
        promptNum('这个价多少？', { ph: '元/斤', unit: '元/斤' }, function (v) {
          var p = L.num(v);
          if (!(p > 0)) { toast('要填个数'); return; }
          if (!draftCols[pk]) draftCols[pk] = [];
          if (draftCols[pk].indexOf(p) === -1) draftCols[pk].push(p);
          closeSheet();
          addToCol(it1, md1, cl1, kd1, p);
        });
        break;
      }

      case 'add-to-col':
        addToCol(D('data-item'), D('data-mode'), D('data-cell'), D('data-kind'), L.num(D('data-price')));
        break;

      case 'choose-person': {
        var name = D('data-name');
        var pcb = pending.person;
        pending.person = null;
        closeSheet();
        if (pcb) pcb(name);
        break;
      }

      case 'choose-cell': {
        var ccid = D('data-id'), cclabel = D('data-label');
        var ccb = pending.cell;
        pending.cell = null;
        closeSheet();
        if (ccb) ccb(ccid, cclabel);
        break;
      }

      case 'num-ok': {
        var inp = document.getElementById('num-in');
        var val = inp ? inp.value.trim() : '';
        var isNum = sheet && sheet.type === 'num';
        var fn = isNum ? pending.num : pending.text;
        if (isNum) pending.num = null; else pending.text = null;
        closeSheet();
        if (!fn) break;
        if (isNum) {
          if (val === '' || isNaN(Number(val))) { toast('要填个数'); return; }
          fn(L.num(val));
        } else {
          fn(val);
        }
        break;
      }

      case 'ask-ok': {
        closeSheet();
        break;
      }

      case 'new-person': {
        promptText('新的人名', { ph: '比如 王哥(虾)' }, function (v) {
          if (!v) return;
          var isWorker = lastPick && lastPick.target === 'worker';
          var arr = isWorker ? db.config.workers : db.config.people;
          if (arr.indexOf(v) === -1) arr.push(v);
          persist();
          var ctx = lastPick;
          if (ctx) pickPerson(ctx.title, ctx.target, pending.person, isWorker ? db.config.workers : db.config.people);
          else render();
        });
        break;
      }

      case 'add-person':
        promptText('新的人名', { ph: '比如 王哥(虾)' }, function (v) {
          if (!v) return;
          if (db.config.people.indexOf(v) === -1) db.config.people.push(v);
          persist();
          go('buyEntry', { person: v, ff: {} });
        });
        break;

      case 'pick-person':
        go('buyEntry', { person: D('data-name'), ff: {} });
        break;

      case 'buy-item':
        route.ff = { stage: 'cell', item: D('data-item'), mode: modeOf(D('data-item'), 'buy'), cell: null };
        render();
        break;

      case 'buy-reset':
        route.ff = {};
        render();
        break;

      case 'buy-mode':
        route.ff.mode = D('data-mode');
        route.ff.cell = null;
        render();
        break;

      case 'buy-cell':
        route.ff.cell = D('data-cell');
        render();
        setTimeout(function () {
          var i = document.getElementById('in-jin');
          if (i) i.focus();
        }, 80);
        break;

      case 'buy-save': {
        var f = route.ff || {};
        var jin = L.num((document.getElementById('in-jin') || {}).value);
        var priceRaw = (document.getElementById('in-price') || {}).value || '';
        var price = L.num(priceRaw);
        if (!(jin > 0)) { toast('斤数没填'); return; }
        addRecord({
          kind: 'buy', person: route.person, itemId: f.item, itemName: L.getItem(f.item).name,
          modeId: f.mode, cellId: f.cell, cellLabel: (L.getCell(f.item, f.mode, f.cell) || {}).label || '',
          jin: jin, price: price > 0 ? price : 0, amount: price > 0 ? L.round2(jin * price) : 0,
          priced: price > 0
        });
        route.ff = { stage: 'cell', item: f.item, mode: f.mode, cell: null };
        render();
        toast(price > 0 ? '记下了' : '记下了，价以后再填');
        break;
      }

      case 'save-prices': {
        var hit = 0;
        Object.keys(priceDraft).forEach(function (pid2) {
          var pv = L.num(priceDraft[pid2]);
          if (!(pv > 0)) return;
          var pr = db.records.filter(function (x) { return x.id === pid2; })[0];
          if (!pr || L.isPriced(pr)) return;
          pr.price = pv;
          pr.amount = L.round2(L.num(pr.jin) * pv);
          pr.priced = true;
          hit++;
        });
        priceDraft = {};
        persist();
        route = { name: 'recon' };
        render();
        toast(hit ? '定了 ' + hit + ' 笔的价' : '还没填价');
        break;
      }

      case 'set-price': {
        var rid = D('data-id');
        var rr = db.records.filter(function (r) { return r.id === rid; })[0];
        if (!rr) break;
        promptNum('一斤多少钱？', {
          sub: L.cellText(rr) + ' · ' + rr.person + ' · ' + L.fmtJin(rr.jin) + ' 斤',
          ph: '元/斤', unit: '元/斤'
        }, function (v) {
          if (!(v > 0)) { toast('要填个数'); return; }
          rr.price = v;
          rr.amount = L.round2(L.num(rr.jin) * v);
          rr.priced = true;
          persist(); render();
          toast('定好了');
        });
        break;
      }

      case 'toggle-paid': {
        var id = D('data-id');
        var rec = db.records.filter(function (r) { return r.id === id; })[0];
        if (!rec) return;
        if (L.isSettled(rec)) { rec.paidAmount = 0; rec.payments = []; }
        else { rec.paidAmount = L.amountOf(rec); rec.payments = [{ d: L.dateStr(new Date()), a: L.amountOf(rec) }]; }
        persist(); render();
        break;
      }

      case 'pay-all': {
        var pp = D('data-person'), kk = D('data-kind');
        var cnt = 0;
        db.records.forEach(function (r) {
          if (r.day !== day || r.person !== pp || r.kind !== kk) return;
          if (kk !== 'buy' && r.session !== session) return;   // 收货不分场次
          if (L.owedOf(r) <= 0.004) return;
          r.paidAmount = L.amountOf(r);
          r.payments.push({ d: L.dateStr(new Date()), a: L.owedOf(r) });
          cnt++;
        });
        persist(); render();
        toast(cnt ? '标了 ' + cnt + ' 笔' : '没有要标的');
        break;
      }

      case 'del-rec': {
        if (!window.confirm('删掉这一笔？')) break;
        db.records = db.records.filter(function (r) { return r.id !== D('data-id'); });
        persist(); render();
        toast('删了');
        break;
      }

      case 'go-sell':
        go('sellCells', { item: D('data-item'), kind: D('data-kind') });
        break;

      case 'loss-item': {
        var lid = D('data-item');
        var lmode = modeOf(lid, 'loss');
        var mm2 = L.getMode(lid, lmode);
        if (mm2.cells.length === 1) {
          askLossJin(lid, lmode, mm2.cells[0].id, mm2.cells[0].label);
        } else {
          pending.cell = function (cid, label) { askLossJin(lid, lmode, cid, label); };
          sheet = { type: 'cells', title: L.getItem(lid).name + ' 哪个规格？', cells: mm2.cells };
          renderSheet();
        }
        break;
      }

      case 'add-worker': {
        pickPerson('今天叫了谁？', 'worker', function (name) {
          var ex = dayMeta(day).expenses;
          ex.workers = ex.workers || [];
          if (!ex.workers.some(function (w) { return w.name === name; })) {
            ex.workers.push({ name: name, amount: 0 });
          }
          persist(); render();
        }, db.config.workers);
        break;
      }

      case 'del-worker': {
        var ex2 = dayMeta(day).expenses;
        ex2.workers.splice(parseInt(D('data-i'), 10), 1);
        persist(); render();
        break;
      }

      case 'copy': {
        var person = D('data-person'), style = D('data-style');
        var txt = L.statement(db.records, day, person, style);
        copyText(txt);
        break;
      }

      case 'open-copy': {
        var p2 = D('data-person');
        sheet = {
          type: 'copy', person: p2,
          multi: L.statement(db.records, day, p2, 'multi'),
          brief: L.statement(db.records, day, p2, 'brief')
        };
        renderSheet();
        break;
      }

      case 'copy-text': {
        var st = D('data-style');
        if (!sheet) break;
        copyText(st === 'brief' ? sheet.brief : sheet.multi);
        break;
      }

      case 'pay': {
        var payPerson = D('data-person'), side = D('data-side');
        var kinds = side === 'in' ? ['sell', 'clear'] : ['buy'];
        var owed = db.records.filter(function (r) {
          return (r.person || '（没写人）') === payPerson && kinds.indexOf(r.kind) !== -1;
        }).reduce(function (s, r) { return s + L.owedOf(r); }, 0);
        promptNum('结了多少？', { sub: payPerson + ' 一共欠 ¥' + L.fmtMoney(owed), ph: '金额', unit: '元' }, function (v) {
          if (!(v > 0)) { toast('要填金额'); return; }
          var res = allocateAndPay(payPerson, kinds, v);
          render();
          toast('记下了，还差 ¥' + L.fmtMoney(res.remainder));
        });
        break;
      }

      case 'recon-person':
        go('reconPerson', { person: D('data-person'), side: D('data-side') });
        break;

      case 'book-prev': day = L.addDays(day, -1); render(); break;
      case 'book-next':
        if (day >= today()) { toast('已经是今天了，没有以后的账'); break; }
        day = L.addDays(day, 1); render();
        break;
      case 'book-today': day = today(); render(); break;

      case 'close-day': {
        var m2 = dayMeta(day);
        m2.closed = true;
        persist();
        backup();
        stack = [];
        route = { name: 'summary' };
        render();
        window.scrollTo(0, 0);
        break;
      }

      case 'backup': backup(); break;

      case 'settings':
        stack = [];
        go('settings');
        break;

      case 'save-people': {
        var ta = document.getElementById('people-ta');
        if (!ta) break;
        db.config.people = ta.value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
        persist(); render();
        toast('名单存好了，共 ' + db.config.people.length + ' 个');
        break;
      }

      case 'save-workers': {
        var ta2 = document.getElementById('worker-ta');
        if (!ta2) break;
        db.config.workers = ta2.value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
        persist(); render();
        toast('工人存好了');
        break;
      }

      case 'wipe': {
        if (!window.confirm('清空所有记录？不能撤销。')) break;
        db.records = [];
        db.days = {};
        persist(); render();
        toast('清空了');
        break;
      }
    }
  });

  function addToCol(itemId, modeId, cellId, kind, price) {
    pickPerson('谁买的？', 'sell', function (name) {
      promptNum('多少斤？', { sub: name + ' · ' + L.fmtMoney(price) + ' 元/斤', ph: '斤', unit: '斤' }, function (jin) {
        if (!(jin > 0)) { toast('要填斤数'); return; }
        var it = L.getItem(itemId);
        var cell = L.getCell(itemId, modeId, cellId);
        addRecord({
          kind: kind, person: name, itemId: itemId, itemName: it.name,
          modeId: modeId, cellId: cellId, cellLabel: (cell || {}).label || '',
          jin: jin, price: price, amount: L.round2(jin * price)
        });
        // 价格列已经落地，去掉草稿
        var k = itemId + '|' + modeId + '|' + cellId + '|' + kind;
        if (draftCols[k]) draftCols[k] = draftCols[k].filter(function (p) { return p !== price; });
        render();
        toast('记下了');
      });
    });
  }

  function askLossJin(itemId, modeId, cellId, cellLabel) {
    promptNum('死了多少斤？', { ph: '斤', unit: '斤' }, function (v) {
      if (!(v > 0)) { toast('要填斤数'); return; }
      addRecord({
        kind: 'loss', person: null, itemId: itemId, itemName: L.getItem(itemId).name,
        modeId: modeId, cellId: cellId, cellLabel: cellLabel, jin: v, price: 0, amount: 0
      });
      render();
      toast('记下了');
    });
  }

  // 输入联动：斤数 × 单价 = 金额
  document.addEventListener('input', function (e) {
    var el = e.target;
    var pid = el && el.getAttribute ? el.getAttribute('data-price-id') : null;
    if (pid) {
      var pv = el.value.replace(/[^\d.]/g, '');
      priceDraft[pid] = pv;
      if (pv !== el.value) el.value = pv;
      return;
    }

    var fld = el && el.getAttribute ? el.getAttribute('data-act-field') : null;

    if (fld === 'worker' || fld === 'oil' || fld === 'ice' || fld === 'water' || fld === 'stallfee') {
      var ex = dayMeta(day).expenses;
      var v = el.value.replace(/[^\d.]/g, '');
      if (v !== el.value) el.value = v;
      if (fld === 'worker') ex.workers[parseInt(el.getAttribute('data-i'), 10)].amount = v;
      else if (fld === 'stallfee') { var so = sessionObj(session); if (so) so.stallFee = v; }
      else ex[fld] = v;
      persist();
      var wt = document.getElementById('wk-total');
      if (wt) wt.textContent = '¥' + L.fmtMoney((ex.workers || []).reduce(function (s, w) { return s + L.num(w.amount); }, 0));
      var et = document.getElementById('ex-total');
      if (et) et.textContent = '¥' + L.fmtMoney(L.expenseTotal(ex, dayMeta(day).sessions));
      return;
    }

    if (el && el.id === 'p-search' && sheet) {
      var q = el.value.trim();
      var list = db.config.people.filter(function (p) { return !q || p.indexOf(q) !== -1; });
      var box = document.getElementById('p-list');
      if (box) box.innerHTML = personItems(list);
      return;
    }

    if (el && (el.id === 'in-jin' || el.id === 'in-price')) {
      var j = L.num((document.getElementById('in-jin') || {}).value);
      var p = L.num((document.getElementById('in-price') || {}).value);
      var a = document.getElementById('in-amt');
      if (a) a.textContent = p > 0 ? ('¥' + L.fmtMoney(L.round2(j * p))) : '待定价';
    }
  });

  // 回车确认
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && sheet && (sheet.type === 'num' || sheet.type === 'text')) {
      var btn = document.querySelector('[data-act="num-ok"]');
      if (btn) btn.click();
    }
  });

  // ================= 启动 =================

  db = load();
  day = today();

  var q = new URLSearchParams(location.search);
  if (q.get('tab')) route = { name: q.get('tab') };
  if (q.get('day')) day = q.get('day');

  render();

  window.__ledger = {
    get db() { return db; },
    get route() { return route; },
    get day() { return day; },
    get session() { return session; },
    go: go, back: back, render: render
  };

  // 安卓实体返回键：先关弹层，再退一屏，退无可退才退出 App
  window.__appBack = function () {
    try {
      if (sheet) { closeSheet(); return true; }
      if (route.name !== 'home') { back(); return true; }
      return false;
    } catch (e) {
      return false;
    }
  };
})();
