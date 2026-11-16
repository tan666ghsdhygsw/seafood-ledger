import test from 'node:test';
import assert from 'node:assert/strict';
import L from '../logic.js';

function rec(o) {
  return Object.assign({
    id: String(Math.random()), day: '2026-11-15', session: '早市',
    kind: 'sell', person: '张老板',
    itemId: 'huaxie', itemName: '花蟹', modeId: 'both', cellId: 'big-g', cellLabel: '大公',
    jin: 0, price: 0, amount: 0, paidAmount: 0, payments: []
  }, o);
}

test('营业日：6 点前算前一天', () => {
  assert.equal(L.businessDay(new Date(2026, 10, 15, 2, 0), 6), '2026-11-14');
  assert.equal(L.businessDay(new Date(2026, 10, 15, 5, 59), 6), '2026-11-14');
  assert.equal(L.businessDay(new Date(2026, 10, 15, 6, 0), 6), '2026-11-15');
  assert.equal(L.businessDay(new Date(2026, 10, 15, 9, 0), 6), '2026-11-15'); // 早市 9 点
});

test('金额：斤×价，抹零优先', () => {
  assert.equal(L.amountOf(rec({ jin: 20, price: 15 })), 300);
  assert.equal(L.amountOf(rec({ jin: 5.5, price: 11, amount: 60 })), 60);
  assert.equal(L.calcAmount(rec({ jin: 5.5, price: 11 })), 60.5);
  assert.equal(L.hasRounding(rec({ jin: 5.5, price: 11, amount: 60 })), true);
  assert.equal(L.hasRounding(rec({ jin: 20, price: 15 })), false);
});

test('付款：部分结清、还欠多少', () => {
  const r = rec({ jin: 20, price: 15, paidAmount: 100 });
  assert.equal(L.owedOf(r), 200);
  assert.equal(L.isSettled(r), false);
  const r2 = rec({ jin: 20, price: 15, paidAmount: 300 });
  assert.equal(L.owedOf(r2), 0);
  assert.equal(L.isSettled(r2), true);
});

test('结款：先还最早那一笔', () => {
  const records = [
    rec({ day: '2026-11-13', jin: 10, price: 10 }),   // 欠 100
    rec({ day: '2026-11-15', jin: 20, price: 10 }),   // 欠 200
    rec({ day: '2026-11-14', person: '李姐', jin: 5, price: 10 })
  ];
  const res = L.allocatePayment(records, '张老板', ['sell'], 150);
  assert.equal(res.allocations.length, 2);
  assert.equal(res.allocations[0].id, records[0].id);
  assert.equal(res.allocations[0].amount, 100);
  assert.equal(res.allocations[1].amount, 50);
  assert.equal(res.remainder, 0);
});

test('结款：给多了会剩下来', () => {
  const records = [rec({ jin: 10, price: 10 })];
  const res = L.allocatePayment(records, '张老板', ['sell'], 150);
  assert.equal(res.allocations[0].amount, 100);
  assert.equal(res.remainder, 50);
});

test('单日汇总：收入支出毛利', () => {
  const records = [
    rec({ kind: 'buy', person: '志浩', itemId: 'sandian', itemName: '三点蟹', modeId: 'none', cellId: '-', cellLabel: '三点蟹', jin: 20, price: 11 }), // 220
    rec({ kind: 'sell', jin: 10, price: 15 }),          // 150
    rec({ kind: 'clear', person: '某厂', jin: 5, price: 6 }), // 30
    rec({ kind: 'loss', person: null, jin: 2, price: 0 })
  ];
  const ex = { workers: [{ name: '阿强', amount: 300 }], oil: 100, ice: 20, water: 0 };
  const s = L.summarize(records, '2026-11-15', ex);
  assert.equal(s.buyAmount, 220);
  assert.equal(s.sellAmount, 150);
  assert.equal(s.clearAmount, 30);
  assert.equal(s.income, 180);
  assert.equal(s.expenseOther, 420);
  assert.equal(s.expense, 640);
  assert.equal(s.gross, -460);
  assert.equal(s.unpaidIn, 180);
  assert.equal(s.unpaidOut, 220);
});

test('按品种：虾姑和大长劲分开两行', () => {
  const records = [
    rec({ kind: 'buy', itemId: 'dachangjin', modeId: 'none', cellId: '-', jin: 10, price: 30 }),
    rec({ kind: 'buy', itemId: 'yingke', modeId: 'none', cellId: '-', jin: 5, price: 20 }),
    rec({ kind: 'sell', person: '李姐', itemId: 'yingke', modeId: 'none', cellId: '-', jin: 8, price: 45 })
  ];
  const rows = L.itemSummary(records, '2026-11-15');
  assert.equal(rows.length, 2);
  const xg = rows.find(r => r.name === '虾姑');
  const dc = rows.find(r => r.name === '大长劲');
  assert.equal(xg.buyJin, 5);
  assert.equal(xg.sellJin, 8);
  assert.equal(dc.buyJin, 10);
});

test('进销存差额 = 收 − 卖 − 清 − 死', () => {
  const records = [
    rec({ kind: 'buy', itemId: 'sandian', itemName: '三点蟹', modeId: 'none', cellId: '-', jin: 100, price: 10 }),
    rec({ kind: 'sell', itemId: 'sandian', itemName: '三点蟹', modeId: 'none', cellId: '-', jin: 80, price: 15 }),
    rec({ kind: 'clear', itemId: 'sandian', itemName: '三点蟹', modeId: 'none', cellId: '-', jin: 15, price: 5 }),
    rec({ kind: 'loss', person: null, itemId: 'sandian', itemName: '三点蟹', modeId: 'none', cellId: '-', jin: 5, price: 0 })
  ];
  const rows = L.itemSummary(records, '2026-11-15');
  assert.equal(rows[0].leftJin, 0);
});

test('按人：钱从谁那来 / 付给了谁', () => {
  const records = [
    rec({ kind: 'sell', person: '张老板', jin: 10, price: 15 }),
    rec({ kind: 'sell', person: '张老板', jin: 10, price: 15, paidAmount: 150 }),
    rec({ kind: 'sell', person: '李姐', jin: 5, price: 15 })
  ];
  const ps = L.personSummary(records, '2026-11-15');
  assert.equal(ps.incomeBy[0].person, '张老板');
  assert.equal(ps.incomeBy[0].amount, 300);
  assert.equal(ps.incomeBy[0].unpaid, 150);
});

test('欠账：跨天累计，能查到最早哪天', () => {
  const records = [
    rec({ day: '2026-11-12', jin: 10, price: 50 }),
    rec({ day: '2026-11-15', jin: 20, price: 58 }),
    rec({ day: '2026-11-15', person: '李姐', jin: 5, price: 30, paidAmount: 150 })
  ];
  const un = L.receivables(records);
  assert.equal(un.length, 1);
  assert.equal(un[0].person, '张老板');
  assert.equal(un[0].amount, 500 + 1160);
  assert.equal(un[0].oldest, '2026-11-12');
  assert.equal(un[0].days.length, 2);
});

test('应付档口：只算没付的收货', () => {
  const records = [
    rec({ kind: 'buy', person: '志浩', jour: 1, day: '2026-11-14', jin: 10, price: 10 }),
    rec({ kind: 'buy', person: '志浩', jin: 10, price: 10 }),
    rec({ kind: 'buy', person: '林浩', jin: 10, price: 10, paidAmount: 100 })
  ];
  const p = L.payables(records);
  assert.equal(p.length, 1);
  assert.equal(p[0].person, '志浩');
  assert.equal(p[0].amount, 200);
});

test('发数：多行版带合计，带抹零痕迹', () => {
  const records = [
    rec({ itemId: 'huaxie', modeId: 'both', cellId: 'big-g', cellLabel: '大公', jin: 10, price: 15 }),
    rec({ itemId: 'huaxie', modeId: 'both', cellId: 'big-m', cellLabel: '大母', jin: 8, price: 18 }),
    rec({ itemId: 'dachangjin', modeId: 'none', cellId: '-', cellLabel: '大长劲', jin: 20, price: 6.5 }),
    rec({ itemId: 'yingke', modeId: 'none', cellId: '-', cellLabel: '虾姑', jin: 5.5, price: 11, amount: 60 })
  ];
  const txt = L.statement(records, '2026-11-15', '张老板', 'multi');
  const lines = txt.split('\n');
  assert.equal(lines[0], '11月15日 张老板');
  assert.ok(lines[1].includes('花蟹 大公 10斤*15=150'));
  assert.ok(lines[2].includes('花蟹 大母 8斤*18=144'));
  assert.ok(lines[3].includes('大长劲 20斤*6.5=130'));
  assert.ok(lines[4].includes('60.5→60'), '抹零要留痕');
  assert.ok(txt.includes('合计'));

  const brief = L.statement(records, '2026-11-15', '张老板', 'brief');
  assert.equal(brief.split('\n').length, 1);
  assert.ok(brief.includes('花蟹大公10*15=150'));
  assert.ok(brief.includes('虾姑5.5*11=60'));
});

test('发数：只发这一天这个人', () => {
  const records = [
    rec({ jin: 10, price: 10 }),
    rec({ day: '2026-11-14', jin: 10, price: 10 }),
    rec({ person: '李姐', jin: 10, price: 10 })
  ];
  const txt = L.statement(records, '2026-11-15', '张老板', 'brief');
  assert.equal(txt, '花蟹大公10*10=100');
});

test('档位表齐全', () => {
  const hx = L.getItem('huaxie');
  assert.deepEqual(hx.modes.map(m => m.id), ['none', 'sex', 'size', 'both']);
  assert.equal(L.getMode('huaxie', 'both').cells.length, 6);
  assert.equal(L.getMode('huaxie', 'sex').cells.length, 2);
  assert.equal(L.getMode('dachangjin', 'both').cells.length, 4);
  assert.equal(L.getItem('shitou').modes.length, 1);
});

test('品种顺序：虾姑排第一，硬壳就是虾姑', () => {
  assert.equal(L.ITEMS[0].id, 'yingke');
  assert.equal(L.ITEMS[0].name, '虾姑');
  const names = L.ITEMS.map(i => i.name);
  assert.deepEqual(names, ['虾姑', '大长劲', '三点蟹', '花蟹', '冬蟹', '石头蟹']);
});

test('收货价没定：不算钱、不算欠款，但要能被数出来', () => {
  const records = [
    rec({ kind: 'buy', person: '阿明', itemId: 'yingke', modeId: 'none', cellId: '-', jin: 20, price: 0, amount: 0, priced: false }),
    rec({ kind: 'buy', person: '志浩', itemId: 'sandian', modeId: 'none', cellId: '-', jin: 10, price: 11 })
  ];
  assert.equal(L.isPriced(records[0]), false);
  assert.equal(L.isPriced(records[1]), true);
  assert.equal(L.amountOf(records[0]), 0);

  const s = L.summarize(records, '2026-11-15', null, []);
  assert.equal(s.unpricedCount, 1);
  assert.equal(s.unpricedJin, 20);
  assert.equal(s.buyAmount, 110);
  assert.equal(s.expense, 110);

  // 没定价的不进"欠档口"
  const pay = L.payables(records);
  assert.equal(pay.length, 1);
  assert.equal(pay[0].person, '志浩');
});

test('进场费：一个数，算进当天支出', () => {
  const ex = { workers: [{ name: '阿强', amount: 300 }], oil: 100, ice: 0, water: 0, stallFee: 70 };
  assert.equal(L.expenseTotal(ex), 470);

  const noFee = { workers: [{ name: '阿强', amount: 300 }], oil: 100, ice: 0, water: 0 };
  assert.equal(L.expenseTotal(noFee), 400);

  const s = L.summarize([], '2026-11-15', ex);
  assert.equal(s.expenseOther, 470);
  assert.equal(s.expense, 470);
});
