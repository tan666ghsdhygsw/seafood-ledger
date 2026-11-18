/* 海鲜记账 · 核心逻辑（纯函数，浏览器和 Node 通用）
 *
 * 一条记录 record：
 *   id, day:'YYYY-MM-DD', session:'早市', kind:'buy'|'sell'|'clear'|'loss',
 *   person  收货=档口 / 卖货=客户 / 清货=厂家 / 损耗=null
 *   itemId, itemName, modeId, cellId, cellLabel,
 *   jin, price, amount, note,
 *   paidAmount, payments:[{d:'YYYY-MM-DD', a:number}]
 *
 * 一天 day 的附加信息放在 db.days[day]：
 *   { sessions:['早市','晚市'], closed:false, expenses:{workers:[{name,amount}], oil, ice, water} }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Ledger = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MS_DAY = 86400000;

  // ================= 品种与档位 =================

  function c(id, label) { return { id: id, label: label }; }

  var ITEMS = [
    {
      id: 'yingke', name: '虾姑', short: '虾姑', group: null,
      modes: [
        { id: 'none', label: '不分', cells: [c('-', '虾姑')] },
        { id: 'gao', label: '分有膏', cells: [c('w', '无膏'), c('g', '有膏')] },
        { id: 'size', label: '分大小', cells: [c('big', '大'), c('small', '小')] },
        {
          id: 'both', label: '都分', cells: [
            c('big-w', '大·无膏'), c('big-g', '大·有膏'),
            c('small-w', '小·无膏'), c('small-g', '小·有膏')
          ]
        }
      ],
      defaultMode: 'none'
    },
    {
      id: 'dachangjin', name: '大长劲', short: '大长劲', group: null,
      modes: [
        { id: 'none', label: '不分', cells: [c('-', '大长劲')] },
        { id: 'gao', label: '分有膏', cells: [c('w', '无膏'), c('g', '有膏')] },
        { id: 'size', label: '分大小', cells: [c('big', '大'), c('small', '小')] },
        {
          id: 'both', label: '都分', cells: [
            c('big-w', '大·无膏'), c('big-g', '大·有膏'),
            c('small-w', '小·无膏'), c('small-g', '小·有膏')
          ]
        }
      ],
      defaultMode: 'none'
    },
    {
      id: 'sandian', name: '三点蟹', short: '三点蟹', group: null,
      modes: [
        { id: 'none', label: '不分', cells: [c('-', '三点蟹')] },
        { id: 'size', label: '分大小', cells: [c('big', '大'), c('mid', '中'), c('small', '小')] }
      ],
      defaultMode: 'none'
    },
    {
      id: 'huaxie', name: '花蟹', short: '花蟹', group: null,
      modes: [
        { id: 'none', label: '不分', cells: [c('-', '花蟹')] },
        { id: 'sex', label: '分公母', cells: [c('g', '公'), c('m', '母')] },
        { id: 'size', label: '分大小', cells: [c('big', '大'), c('mid', '中'), c('small', '小')] },
        {
          id: 'both', label: '都分', cells: [
            c('big-g', '大公'), c('big-m', '大母'),
            c('mid-g', '中公'), c('mid-m', '中母'),
            c('small-g', '小公'), c('small-m', '小母')
          ]
        }
      ],
      defaultMode: 'none'
    },
    {
      id: 'dongxie', name: '冬蟹', short: '冬蟹', group: null,
      modes: [
        { id: 'type', label: '肥/水', cells: [c('fertil', '肥蟹'), c('water', '水蟹')] }
      ],
      defaultMode: 'type'
    },
    {
      id: 'shitou', name: '石头蟹', short: '石头蟹', group: null,
      modes: [{ id: 'none', label: '不分', cells: [c('-', '石头蟹')] }],
      defaultMode: 'none'
    }
  ];

  function getItem(id) {
    for (var i = 0; i < ITEMS.length; i++) if (ITEMS[i].id === id) return ITEMS[i];
    return null;
  }
  function getMode(itemId, modeId) {
    var it = getItem(itemId);
    if (!it) return null;
    for (var i = 0; i < it.modes.length; i++) if (it.modes[i].id === modeId) return it.modes[i];
    return it.modes[0];
  }
  function getCell(itemId, modeId, cellId) {
    var m = getMode(itemId, modeId);
    if (!m) return null;
    for (var i = 0; i < m.cells.length; i++) if (m.cells[i].id === cellId) return m.cells[i];
    return m.cells[0];
  }

  /** 临时加的货类（存在用户数据里）。分法由她自己选，没选就是"不分" */
  function registerExtra(list) {
    (list || []).forEach(function (it) {
      if (!it || !it.id || !it.name) return;
      if (getItem(it.id)) return;
      var modes = (Array.isArray(it.modes) && it.modes.length) ? it.modes
        : [{ id: 'none', label: '不分', cells: [{ id: '-', label: it.name }] }];
      ITEMS.push({
        id: it.id, name: it.name, short: it.name, group: null,
        modes: modes, defaultMode: modes[0].id, extra: true
      });
    });
  }

  function makeExtraItem(name) {
    return {
      id: 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      name: name
    };
  }

  /** 新货类的分法：跟虾姑一样四种，进去再选 */
  function extraModes(kind, name) {
    function c(id, label) { return { id: id, label: label }; }
    return [
      { id: 'none', label: '不分', cells: [c('-', name)] },
      { id: 'size', label: '分大小', cells: [c('big', '大'), c('small', '小')] },
      { id: 'gao', label: '分有膏', cells: [c('w', '无膏'), c('g', '有膏')] },
      {
        id: 'both', label: '都分', cells: [
          c('big-w', '大·无膏'), c('big-g', '大·有膏'),
          c('small-w', '小·无膏'), c('small-g', '小·有膏')
        ]
      }
    ];
  }

  /** "花蟹 大公" 这种给人看的写法 */
  function cellText(rec) {    var it = getItem(rec.itemId);
    var short = it ? it.short : (rec.itemName || '');
    if (!rec.cellLabel || rec.modeId === 'none') return short;
    return short + ' ' + rec.cellLabel;
  }
  /** "花蟹大公" 紧凑写法，发微信的简短版用 */
  function cellTextTight(rec) {
    var it = getItem(rec.itemId);
    var short = it ? it.short : (rec.itemName || '');
    if (!rec.cellLabel || rec.modeId === 'none') return short;
    return short + rec.cellLabel;
  }

  // ================= 数字 =================

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function dateStr(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function parseDay(s) { var p = String(s).split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function round2(v) { return Math.round((v + Number.EPSILON) * 100) / 100; }

  /** 营业日：6 点前算前一天（晚市拖过 12 点） */
  function businessDay(input, cutoffHour) {
    var cut = (cutoffHour == null) ? 6 : cutoffHour;
    var d = (input instanceof Date) ? input : new Date(input);
    if (d.getHours() < cut) return dateStr(new Date(d.getTime() - MS_DAY));
    return dateStr(d);
  }

  function addDays(day, n) {
    var d = parseDay(day);
    d.setDate(d.getDate() + n);
    return dateStr(d);
  }

  function fmtMoney(v) {
    var n = round2(num(v));
    if (Number.isInteger(n)) return String(n);
    return String(parseFloat(n.toFixed(2)));
  }
  function fmtJin(v) {
    var n = round2(num(v));
    return Number.isInteger(n) ? String(n) : String(parseFloat(n.toFixed(2)));
  }
  function dateLabelCN(day) {
    var d = parseDay(day);
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  // ================= 单条记录 =================

  function calcAmount(rec) { return round2(num(rec.jin) * num(rec.price)); }
  function amountOf(rec) {
    if (rec.kind === 'loss') return 0;
    if (rec.amount != null && rec.amount !== '' && num(rec.amount) > 0) return round2(num(rec.amount));
    return calcAmount(rec);
  }
  /** 有没有抹零 */
  function hasRounding(rec) {
    if (rec.kind === 'loss') return false;
    var a = amountOf(rec), c = calcAmount(rec);
    return Math.abs(a - c) > 0.004;
  }
  function paidOf(rec) { return round2(num(rec.paidAmount)); }
  function owedOf(rec) {
    var rest = round2(amountOf(rec) - paidOf(rec));
    return rest > 0.004 ? rest : 0;
  }
  function isSettled(rec) { return owedOf(rec) < 0.005; }

  // ================= 汇总 =================

  function dayRecords(records, day) {
    return records.filter(function (r) { return r.day === day; });
  }

  function emptyExpenses() {
    return { workers: [], oil: 0, ice: 0, water: 0, stallFee: 0 };
  }

  /** 支出合计：工人 + 油 + 冰 + 水 + 进场费 */
  function expenseTotal(ex) {
    ex = ex || emptyExpenses();
    var t = num(ex.oil) + num(ex.ice) + num(ex.water) + num(ex.stallFee);
    (ex.workers || []).forEach(function (w) { t += num(w.amount); });
    return round2(t);
  }

  /** 收货价卖完之后才定，所以可以「还没定价」 */
  function isPriced(r) {
    return r.kind !== 'buy' || r.priced !== false;
  }

  function summarize(records, day, expenses) {
    var rs = dayRecords(records, day);
    var out = {
      day: day,
      buyAmount: 0, buyJin: 0, buyCount: 0,
      sellAmount: 0, sellJin: 0, sellCount: 0,
      clearAmount: 0, clearJin: 0, clearCount: 0,
      lossJin: 0, lossCount: 0,
      unpaidIn: 0, unpaidOut: 0,
      unpricedCount: 0, unpricedJin: 0
    };
    rs.forEach(function (r) {
      var a = amountOf(r), j = num(r.jin);
      if (r.kind === 'buy') {
        out.buyAmount = round2(out.buyAmount + a); out.buyJin = round2(out.buyJin + j); out.buyCount++;
        if (isPriced(r)) out.unpaidOut = round2(out.unpaidOut + owedOf(r));
        else { out.unpricedCount++; out.unpricedJin = round2(out.unpricedJin + j); }
      } else if (r.kind === 'sell') {
        out.sellAmount = round2(out.sellAmount + a); out.sellJin = round2(out.sellJin + j); out.sellCount++;
        out.unpaidIn = round2(out.unpaidIn + owedOf(r));
      } else if (r.kind === 'clear') {
        out.clearAmount = round2(out.clearAmount + a); out.clearJin = round2(out.clearJin + j); out.clearCount++;
        out.unpaidIn = round2(out.unpaidIn + owedOf(r));
      } else if (r.kind === 'loss') {
        out.lossJin = round2(out.lossJin + j); out.lossCount++;
      }
    });
    out.income = round2(out.sellAmount + out.clearAmount);
    out.expenseGoods = out.buyAmount;
    out.expenseOther = expenseTotal(expenses);
    out.expense = round2(out.expenseGoods + out.expenseOther);
    out.gross = round2(out.income - out.expense);
    return out;
  }

  /** 按品种汇总：收多少斤、卖多少斤、剩（正常应该是 0，因为卖不完就死了） */
  function itemSummary(records, day) {
    var map = new Map();
    dayRecords(records, day).forEach(function (r) {
      var it = getItem(r.itemId);
      var key = it ? (it.group || it.name) : (r.itemName || '未知');
      if (!map.has(key)) map.set(key, { name: key, buyJin: 0, sellJin: 0, clearJin: 0, lossJin: 0, income: 0 });
      var o = map.get(key);
      var j = num(r.jin);
      if (r.kind === 'buy') { o.buyJin = round2(o.buyJin + j); }
      else if (r.kind === 'sell') { o.sellJin = round2(o.sellJin + j); o.income = round2(o.income + amountOf(r)); }
      else if (r.kind === 'clear') { o.clearJin = round2(o.clearJin + j); o.income = round2(o.income + amountOf(r)); }
      else if (r.kind === 'loss') { o.lossJin = round2(o.lossJin + j); }
    });
    return Array.from(map.values()).map(function (o) {
      o.leftJin = round2(o.buyJin - o.sellJin - o.clearJin - o.lossJin);
      return o;
    }).sort(function (a, b) { return (b.buyJin + b.sellJin) - (a.buyJin + a.sellJin); });
  }

  /** 按人汇总：钱从谁那来、钱付给了谁 */
  function personSummary(records, day) {
    var inMap = new Map(), outMap = new Map();
    dayRecords(records, day).forEach(function (r) {
      var a = amountOf(r);
      if (r.kind === 'sell' || r.kind === 'clear') {
        var k = r.person || '（没写人）';
        if (!inMap.has(k)) inMap.set(k, { person: k, amount: 0, unpaid: 0, count: 0 });
        var o = inMap.get(k);
        o.amount = round2(o.amount + a); o.unpaid = round2(o.unpaid + owedOf(r)); o.count++;
      } else if (r.kind === 'buy') {
        var k2 = r.person || '（没写人）';
        if (!outMap.has(k2)) outMap.set(k2, { person: k2, amount: 0, unpaid: 0, count: 0 });
        var o2 = outMap.get(k2);
        o2.amount = round2(o2.amount + a); o2.unpaid = round2(o2.unpaid + owedOf(r)); o2.count++;
      }
    });
    function arr(m) {
      return Array.from(m.values()).sort(function (a, b) { return b.amount - a.amount; });
    }
    return { incomeBy: arr(inMap), expenseBy: arr(outMap) };
  }

  /** 跨天还欠着的：按人聚合 */
  function receivables(records) {
    return groupOwed(records, function (r) { return r.kind === 'sell' || r.kind === 'clear'; });
  }
  function payables(records) {
    return groupOwed(records, function (r) { return r.kind === 'buy' && isPriced(r); });
  }
  function groupOwed(records, filter) {
    var map = new Map();
    records.forEach(function (r) {
      if (!filter(r)) return;
      var owed = owedOf(r);
      if (owed <= 0.004) return;
      var k = r.person || '（没写人）';
      if (!map.has(k)) map.set(k, { person: k, amount: 0, jin: 0, count: 0, days: {} });
      var o = map.get(k);
      o.amount = round2(o.amount + owed);
      o.jin = round2(o.jin + num(r.jin));
      o.count++;
      o.days[r.day] = true;
    });
    return Array.from(map.values()).map(function (o) {
      o.days = Object.keys(o.days).sort();
      o.oldest = o.days[0];
      return o;
    }).sort(function (a, b) { return b.amount - a.amount; });
  }

  /** 某个人某天还没结清的那些笔 */
  function openRecordsOf(records, day, person, kindIn) {
    return records.filter(function (r) {
      if (r.day !== day) return false;
      if ((r.person || '（没写人）') !== person) return false;
      if (!kindIn.some(function (k) { return r.kind === k; })) return false;
      return owedOf(r) > 0.004;
    });
  }

  /** 按人结款：从最老的开始还，返回每条要分配多少 */
  function allocatePayment(records, person, kinds, amount) {
    var list = records.filter(function (r) {
      return (r.person || '（没写人）') === person &&
        kinds.some(function (k) { return r.kind === k; }) &&
        owedOf(r) > 0.004;
    }).sort(function (a, b) { return a.day < b.day ? -1 : a.day > b.day ? 1 : 0; });

    var left = round2(num(amount));
    var out = [];
    for (var i = 0; i < list.length && left > 0.004; i++) {
      var rest = owedOf(list[i]);
      var use = Math.min(rest, left);
      out.push({ id: list[i].id, amount: round2(use) });
      left = round2(left - use);
    }
    return { allocations: out, remainder: left };
  }

  // ================= 发微信的文字 =================

  function statement(records, day, person, style) {
    var rs = records.filter(function (r) {
      return r.day === day && (r.kind === 'sell' || r.kind === 'clear') &&
        (r.person || '（没写人）') === person;
    });
    var total = round2(rs.reduce(function (s, r) { return s + amountOf(r); }, 0));

    if (style === 'brief') {
      return rs.map(function (r) {
        return cellTextTight(r) + fmtJin(r.jin) + '*' + fmtMoney(r.price) + '=' + fmtMoney(amountOf(r));
      }).join(' ');
    }

    var lines = [dateLabelCN(day) + ' ' + person];
    rs.forEach(function (r) {
      var amt = fmtMoney(amountOf(r));
      if (hasRounding(r)) amt = fmtMoney(calcAmount(r)) + '→' + amt;
      lines.push('· ' + cellText(r) + ' ' + fmtJin(r.jin) + '斤*' + fmtMoney(r.price) + '=' + amt);
    });
    lines.push('合计 ' + fmtMoney(total) + '元');
    return lines.join('\n');
  }

  return {
    ITEMS: ITEMS, getItem: getItem, getMode: getMode, getCell: getCell,
    registerExtra: registerExtra, makeExtraItem: makeExtraItem, extraModes: extraModes,
    cellText: cellText, cellTextTight: cellTextTight,
    dateStr: dateStr, parseDay: parseDay, addDays: addDays,
    businessDay: businessDay, dateLabelCN: dateLabelCN,
    num: num, round2: round2, fmtMoney: fmtMoney, fmtJin: fmtJin,
    calcAmount: calcAmount, amountOf: amountOf, hasRounding: hasRounding,
    paidOf: paidOf, owedOf: owedOf, isSettled: isSettled, isPriced: isPriced,
    dayRecords: dayRecords, emptyExpenses: emptyExpenses, expenseTotal: expenseTotal,
    summarize: summarize, itemSummary: itemSummary, personSummary: personSummary,
    receivables: receivables, payables: payables, openRecordsOf: openRecordsOf,
    allocatePayment: allocatePayment, statement: statement
  };
});
