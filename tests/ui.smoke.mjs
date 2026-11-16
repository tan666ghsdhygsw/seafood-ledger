/* 界面冒烟测试：用极简 DOM 假件跑 app.js，把整套流程点一遍。
 * 沙箱里起不了浏览器，所以用这个替代"点一遍"，验证逻辑和 DOM 拼装不报错。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const logicSrc = fs.readFileSync(path.join(root, 'logic.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

function makeEl(id) {
  return {
    id, innerHTML: '', textContent: '', value: '', checked: false, style: {},
    tagName: 'DIV',
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    focus() {}, select() {}, appendChild() {}, removeChild() {}, click() {}
  };
}

function boot(query = '') {
  const els = {};
  const listeners = {};
  const store = new Map();

  const document = {
    getElementById: (id) => (els[id] ? els[id] : (els[id] = makeEl(id))),
    addEventListener: (t, fn, capture) => {
      (listeners[t] = listeners[t] || []).push({ fn, capture: !!capture });
    },
    createElement: () => makeEl('tmp'),
    querySelector: () => null,
    body: { appendChild() {}, removeChild() {} },
    documentElement: { style: { setProperty() {} } },
    activeElement: null,
    execCommand: () => true
  };

  const sandbox = {
    console,
    setTimeout: () => 0,
    clearTimeout: () => {},
    document,
    location: { search: query },
    URLSearchParams,
    navigator: {},
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, v),
      removeItem: (k) => store.delete(k)
    },
    confirm: () => true,
    alert: () => {},
    scrollTo: () => {},
    visualViewport: null,
    Blob: function () {},
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }
  };
  sandbox.window = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(logicSrc, sandbox, { filename: 'logic.js' });
  vm.runInContext(appSrc, sandbox, { filename: 'app.js' });

  // 捕获阶段的先跑，跟真浏览器一致
  const fire = (target, type) => {
    const arr = listeners[type] || [];
    arr.filter((x) => x.capture).concat(arr.filter((x) => !x.capture))
      .forEach((x) => x.fn({ target, key: 'Escape' }));
  };

  function click(act, attrs = {}) {
    const target = {
      tagName: 'BUTTON',
      getAttribute: (k) => (k === 'data-act' ? act : (k in attrs ? attrs[k] : null)),
      closest: (sel) => {
        if (sel === '[data-act]') return target;
        const m = /^\[data-act="(.+)"\]$/.exec(sel);
        if (m) return m[1] === act ? target : null;
        return null;
      },
      dataset: attrs
    };
    fire(target, 'click');
  }

  const el = (id) => document.getElementById(id);

  function input(attrs, value) {
    const t = {
      tagName: 'INPUT',
      value,
      getAttribute: (k) => (k in attrs ? attrs[k] : null)
    };
    (listeners.input || []).forEach((x) => x.fn({ target: t }));
  }

  function change(attrs, value) {
    const t = {
      tagName: 'INPUT',
      value,
      getAttribute: (k) => (k in attrs ? attrs[k] : null)
    };
    (listeners.change || []).forEach((x) => x.fn({ target: t }));
  }

  return { els, sandbox, click, el, input, change, db: () => sandbox.window.__ledger.db };
}

// 收货人、客户是两套名单，测试里两边都放
function seedPeople(app, names) {
  app.db().config.stalls.push(...names);
  app.db().config.customers.push(...names);
}

function doBuy(app, o = {}) {
  app.click('go', { 'data-to': 'buyPick' });
  app.click('pick-person', { 'data-name': o.person || '阿明' });
  app.click('buy-item', { 'data-item': o.item || 'yingke' });
  app.click('buy-cell', { 'data-cell': o.cell || '-' });
  app.el('in-jin').value = o.jin == null ? '' : String(o.jin);
  app.el('in-price').value = o.price == null ? '' : String(o.price);
  if (o.save !== false) app.click('buy-save');
}

/** 卖一笔：进到某一档 → 加一个价 → 在某人那行填斤数 */
function doSell(app, o = {}) {
  const item = o.item || 'sandian';
  const kind = o.kind || 'sell';
  const cell = o.cell || '-';
  app.click('go', { 'data-to': 'sellPick', 'data-kind': kind });
  app.click('go-sell', { 'data-item': item, 'data-kind': kind });
  if (o.mode) app.click('sell-mode', { 'data-item': item, 'data-kind': kind, 'data-mode': o.mode });
  app.click('sell-cell', {
    'data-item': item, 'data-kind': kind,
    'data-mode': o.mode || 'none', 'data-cell': cell, 'data-label': o.label || '货'
  });
  app.click('new-price', { 'data-key': item + '|' + cell + '|' + kind });
  app.el('num-in').value = String(o.price);
  app.click('num-ok');
  app.change({ 'data-row-person': o.person }, String(o.jin));
}

test('空数据：四个页面都能画出来，不冒 NaN/undefined', () => {
  const app = boot();
  ['home', 'book', 'recon', 'summary'].forEach((t) => {
    app.click('tab', { 'data-tab': t });
    const html = app.els.app.innerHTML;
    assert.ok(html.length > 150, t + ' 页几乎是空的');
    assert.ok(!html.includes('NaN'), t + ' 页有 NaN');
    assert.ok(!html.includes('undefined'), t + ' 页有 undefined');
  });
});

test('首页没有场次了，直接是收货/卖货/清货/损耗', () => {
  const app = boot();
  const html = app.els.app.innerHTML;
  assert.equal(html.includes('早市'), false);
  assert.ok(html.includes('收 货'));
  assert.ok(html.includes('卖 货'));
  assert.ok(html.includes('清 货'));
  assert.ok(html.includes('损 耗'));
});

test('收货：档口 → 货 → 档 → 斤数单价 → 记下', () => {
  const app = boot();
  seedPeople(app, ['阿明']);
  doBuy(app, { jin: 20, price: 11 });

  const r = app.db().records;
  assert.equal(r.length, 1);
  assert.equal(r[0].kind, 'buy');
  assert.equal(r[0].person, '阿明');
  assert.equal(r[0].amount, 220);
  assert.equal(r[0].paidAmount, 0);
});

test('收货填完斤数，点别处自动记下（不用点按钮）', () => {
  const app = boot();
  seedPeople(app, ['阿明']);
  doBuy(app, { jin: 30, price: 40, save: false });
  app.click('tab', { 'data-tab': 'book' });

  assert.equal(app.db().records.length, 1);
  assert.equal(app.db().records[0].amount, 1200);
  assert.equal(app.db().records[0].priced, true);
});

test('收货只填斤数没填价，也自动记下，记成待定价', () => {
  const app = boot();
  seedPeople(app, ['阿明']);
  doBuy(app, { jin: 50, price: null, save: false });
  app.click('tab', { 'data-tab': 'home' });

  assert.equal(app.db().records.length, 1);
  assert.equal(app.db().records[0].priced, false);
  assert.equal(app.db().records[0].amount, 0);
});

test('斤数空着不会乱记', () => {
  const app = boot();
  seedPeople(app, ['阿明']);
  doBuy(app, { jin: null, price: 40, save: false });
  app.click('tab', { 'data-tab': 'home' });
  assert.equal(app.db().records.length, 0);
});

test('卖货：出来的是人名单，一行一个，填斤数就记下', () => {
  const app = boot();
  seedPeople(app, ['张老板', '李姐']);
  app.click('go', { 'data-to': 'sellPick', 'data-kind': 'sell' });
  app.click('go-sell', { 'data-item': 'sandian', 'data-kind': 'sell' });
  app.click('sell-cell', { 'data-item': 'sandian', 'data-kind': 'sell', 'data-mode': 'none', 'data-cell': '-', 'data-label': '三点蟹' });

  const html = app.els.app.innerHTML;
  assert.ok(html.includes('张老板'));
  assert.ok(html.includes('李姐'));
  assert.ok(html.includes('谁买了'));
  assert.ok(html.includes('加一个价'));

  app.click('new-price', { 'data-key': 'sandian|-|sell' });
  app.el('num-in').value = '13';
  app.click('num-ok');
  app.change({ 'data-row-person': '张老板' }, '20');

  const r = app.db().records;
  assert.equal(r.length, 1);
  assert.equal(r[0].person, '张老板');
  assert.equal(r[0].jin, 20);
  assert.equal(r[0].price, 13);
  assert.equal(r[0].amount, 260);
});

test('卖货：降价了再加一个价，两批人按各自的价算', () => {
  const app = boot();
  seedPeople(app, ['张老板', '李姐']);
  app.click('go', { 'data-to': 'sellPick', 'data-kind': 'sell' });
  app.click('go-sell', { 'data-item': 'sandian', 'data-kind': 'sell' });
  app.click('sell-cell', { 'data-item': 'sandian', 'data-kind': 'sell', 'data-mode': 'none', 'data-cell': '-', 'data-label': '三点蟹' });

  // 先按 50 记一批
  app.click('new-price', { 'data-key': 'sandian|-|sell' });
  app.el('num-in').value = '50';
  app.click('num-ok');
  app.change({ 'data-row-person': '张老板' }, '10');

  // 降到 45，再加一个价
  app.click('new-price', { 'data-key': 'sandian|-|sell' });
  app.el('num-in').value = '45';
  app.click('num-ok');
  app.change({ 'data-row-person': '李姐' }, '10');

  const r = app.db().records;
  assert.equal(r.length, 2);
  assert.equal(r[0].price, 50);
  assert.equal(r[0].amount, 500);
  assert.equal(r[1].price, 45);
  assert.equal(r[1].amount, 450);
});

test('卖货：同一个人改斤数是改，不是加一笔', () => {
  const app = boot();
  seedPeople(app, ['张老板']);
  doSell(app, { price: 13, person: '张老板', jin: 20 });
  doSell(app, { price: 13, person: '张老板', jin: 30 });

  assert.equal(app.db().records.length, 1);
  assert.equal(app.db().records[0].jin, 30);
  assert.equal(app.db().records[0].amount, 390);
});

test('卖货：斤数清空就把这一笔删掉', () => {
  const app = boot();
  seedPeople(app, ['张老板']);
  doSell(app, { price: 13, person: '张老板', jin: 20 });
  app.change({ 'data-row-person': '张老板' }, '');
  assert.equal(app.db().records.length, 0);
});

test('卖货：两个人各记一笔', () => {
  const app = boot();
  seedPeople(app, ['张老板', '李姐']);
  doSell(app, { price: 13, person: '张老板', jin: 18 });
  doSell(app, { price: 13, person: '李姐', jin: 10 });

  const r = app.db().records;
  assert.equal(r.length, 2);
  assert.equal(r[0].amount, 234);
  assert.equal(r[1].amount, 130);
});

test('卖货：清空斤数就把这一笔删掉', () => {
  const app = boot();
  seedPeople(app, ['某厂']);
  doSell(app, { item: 'shitou', kind: 'clear', price: 4, person: '某厂', jin: 40 });
  assert.equal(app.db().records[0].kind, 'clear');
  assert.equal(app.db().records[0].amount, 160);
});

test('损耗：不问客户，只填斤数', () => {
  const app = boot();
  app.click('go', { 'data-to': 'lossPick' });
  app.click('loss-item', { 'data-item': 'shitou' });
  app.el('num-in').value = '3';
  app.click('num-ok');

  const r = app.db().records[0];
  assert.equal(r.kind, 'loss');
  assert.equal(r.jin, 3);
});

test('支出：工人、油费、进场费都能记，合计对得上', () => {
  const app = boot();
  app.db().config.workers.push('阿强');
  app.click('go', { 'data-to': 'expenses' });
  app.click('add-worker');
  app.click('choose-person', { 'data-name': '阿强' });

  const L = app.sandbox.window.Ledger;
  const d = L.businessDay(new Date(), 6);
  const ex = app.db().days[d].expenses;
  ex.workers[0].amount = '300';

  app.input({ 'data-act-field': 'oil' }, '100');
  app.input({ 'data-act-field': 'stallfee' }, '60');

  assert.equal(ex.oil, '100');
  assert.equal(ex.stallFee, '60');
  assert.equal(L.expenseTotal(ex), 460);
});

test('对账：生成发数文字 → 结一部分 → 还欠多少', () => {
  const app = boot();
  seedPeople(app, ['张老板']);
  doSell(app, { price: 13, person: '张老板', jin: 20 });

  app.click('tab', { 'data-tab': 'recon' });
  assert.ok(app.els.app.innerHTML.includes('三点蟹 20斤*13=260'));

  app.click('pay', { 'data-person': '张老板', 'data-side': 'in' });
  app.el('num-in').value = '100';
  app.click('num-ok');

  const L = app.sandbox.window.Ledger;
  assert.equal(L.owedOf(app.db().records[0]), 160);
});

test('对账打勾：直接结清，不用输金额', () => {
  const app = boot();
  seedPeople(app, ['张老板']);
  doSell(app, { price: 13, person: '张老板', jin: 20 });

  const L = app.sandbox.window.Ledger;
  const d = L.businessDay(new Date(), 6);
  app.click('tab', { 'data-tab': 'recon' });
  assert.ok(app.els.app.innerHTML.includes('全结清'));

  app.click('settle', { 'data-person': '张老板', 'data-day': d, 'data-side': 'in' });
  assert.equal(L.owedOf(app.db().records[0]), 0);
});

test('单笔打勾也能结清', () => {
  const app = boot();
  seedPeople(app, ['张老板']);
  doSell(app, { price: 13, person: '张老板', jin: 20 });

  app.click('recon-person', { 'data-person': '张老板', 'data-side': 'in' });
  app.click('settle-rec', { 'data-id': app.db().records[0].id });
  assert.equal(app.sandbox.window.Ledger.owedOf(app.db().records[0]), 0);
});

test('撤回：记错了能退回来', () => {
  const app = boot();
  seedPeople(app, ['张老板']);
  doSell(app, { price: 13, person: '张老板', jin: 20 });
  assert.equal(app.db().records.length, 1);

  app.click('undo');
  assert.equal(app.db().records.length, 0);

  app.click('undo');
  assert.equal(app.db().records.length, 0); // 再撤也不会炸
});

test('收货可以先不定价，批量一页填完', () => {
  const app = boot();
  const L = app.sandbox.window.Ledger;
  const d = L.businessDay(new Date(), 6);
  const base = { day: d, session: '', kind: 'buy', person: '阿明', modeId: 'none', cellId: '-', price: 0, amount: 0, priced: false, paidAmount: 0, payments: [] };

  app.db().records.push({ ...base, id: 'a', itemId: 'yingke', cellLabel: '虾姑', jin: 60 });
  app.db().records.push({ ...base, id: 'b', itemId: 'dachangjin', cellLabel: '大长劲', jin: 40 });
  app.db().records.push({ ...base, id: 'c', itemId: 'sandian', cellLabel: '三点蟹', jin: 20 });

  app.click('tab', { 'data-tab': 'recon' });
  assert.ok(app.els.app.innerHTML.includes('没定价'));

  app.click('go', { 'data-to': 'pricing' });
  app.input({ 'data-price-id': 'a' }, '40');
  app.input({ 'data-price-id': 'b' }, '55');
  app.click('save-prices');

  const rec = (id) => app.db().records.find((r) => r.id === id);
  assert.equal(rec('a').amount, 2400);
  assert.equal(rec('b').amount, 2200);
  assert.equal(rec('c').priced, false);
});

test('汇总：到手 = 收进来 - 花出去', () => {
  const app = boot();
  seedPeople(app, ['阿明', '张老板']);
  doBuy(app, { jin: 20, price: 11 });
  doSell(app, { price: 13, person: '张老板', jin: 20 });

  app.click('tab', { 'data-tab': 'summary' });
  const L = app.sandbox.window.Ledger;
  const d = L.businessDay(new Date(), 6);
  const s = L.summarize(app.db().records, d, app.db().days[d].expenses);
  assert.equal(s.income, 260);
  assert.equal(s.expense, 220);
  assert.equal(s.gross, 40);
});

test('名单：收货人和客户分开，收货页不出现客户', () => {
  const app = boot();
  app.click('settings');
  app.el('stalls-ta').value = '志浩\n阿明\n';
  app.click('save-stalls');
  app.el('customers-ta').value = '卢妹(虾古、蚧)\n唐明\n';
  app.click('save-customers');

  assert.deepEqual(Array.from(app.db().config.stalls), ['志浩', '阿明']);
  assert.deepEqual(Array.from(app.db().config.customers), ['卢妹(虾古、蚧)', '唐明']);

  app.click('go', { 'data-to': 'buyPick' });
  const html = app.els.app.innerHTML;
  assert.ok(html.includes('志浩'));
  assert.equal(html.includes('卢妹'), false);
});

test('加货类：加完还是有四个分法可选', () => {
  const app = boot();
  seedPeople(app, ['阿明']);
  app.click('go', { 'data-to': 'buyPick' });
  app.click('pick-person', { 'data-name': '阿明' });
  app.click('add-item', { 'data-kind': 'buy' });
  app.el('num-in').value = '梭子蟹';
  app.click('num-ok');

  const it = app.db().config.extraItems[0];
  assert.equal(it.name, '梭子蟹');
  assert.deepEqual(Array.from(it.modes).map((m) => m.label), ['不分', '分大小', '分有膏', '都分']);

  // 界面上应该出现分法开关
  assert.ok(app.els.app.innerHTML.includes('分大小'));
  assert.ok(app.els.app.innerHTML.includes('都分'));
});

test('卖货列表第一个是虾姑，没有"硬壳"这个叫法', () => {
  const app = boot();
  app.click('go', { 'data-to': 'sellPick', 'data-kind': 'sell' });
  const html = app.els.app.innerHTML;
  assert.ok(html.indexOf('虾姑') < html.indexOf('三点蟹'));
  assert.equal(html.includes('硬壳'), false);
});

test('关掉再开，账还在（写进本地存储）', () => {
  const app = boot();
  seedPeople(app, ['张老板']);
  doSell(app, { price: 13, person: '张老板', jin: 20 });

  const saved = app.sandbox.localStorage.getItem('seafood-ledger-v3');
  assert.ok(saved && saved.length > 50);
  assert.equal(JSON.parse(saved).records.length, 1);
});
