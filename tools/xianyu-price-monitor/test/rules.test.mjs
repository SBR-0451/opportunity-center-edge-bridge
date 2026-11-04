import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTask } from '../src/config.mjs';
import { evaluate, filterItems } from '../src/rules.mjs';

const searchTask = normalizeTask({
  name: 's',
  keyword: 'iPhone 15 Pro',
  minPrice: 3000,
  maxPrice: 6000,
  include: ['256'],
  exclude: ['壳', '求购'],
  alert: { targetPrice: 4500, dropPercent: 5, newListing: true, newLow: true },
}, 0);

const it = (itemId, price, title = 'iPhone 15 Pro 256G', status = 'onsale') => ({ itemId, price, title, status, url: `u${itemId}` });
const t = (min) => new Date(Date.UTC(2026, 10, 4, 0, min));

test('filterItems：价格区间、必含词、排除词', () => {
  const { kept, dropped } = filterItems([
    it('1', 4800),
    it('2', 30, 'iPhone 15 Pro 256G 手机壳'),
    it('3', 4800, 'iPhone 15 Pro 128G'),
    it('4', 2000),
    it('5', 5000, '求购 iPhone 15 Pro 256G'),
    it('6', null),
  ], searchTask);
  assert.deepEqual(kept.map((x) => x.itemId), ['1']);
  assert.equal(dropped.length, 5);
});

test('首轮只建基线；目标价提醒在首轮也会发', () => {
  const r = evaluate(searchTask, [it('1', 4800), it('2', 4400)], {}, t(0));
  assert.deepEqual(r.alerts.map((a) => [a.item.itemId, a.reasons]), [['2', ['≤ 目标价 ¥4,500']]]);
  assert.equal(r.state.lowest, 4400);
  assert.equal(r.state.initialized, true);
});

test('新上架、降价、创新低、目标价去重', () => {
  const s1 = evaluate(searchTask, [it('1', 4800), it('2', 4400)], {}, t(0)).state;

  // 同价不重复提醒；1 号降 6.25%；3 号新上架并创新低
  const r2 = evaluate(searchTask, [it('1', 4500), it('2', 4400), it('3', 4300)], s1, t(15));
  const byId = Object.fromEntries(r2.alerts.map((a) => [a.item.itemId, a.reasons]));
  assert.deepEqual(Object.keys(byId).sort(), ['1', '3']);
  assert.ok(byId['1'].some((r) => r.startsWith('≤ 目标价')));
  assert.ok(byId['1'].some((r) => r.startsWith('降价 ¥4,800 → ¥4,500')));
  assert.deepEqual(byId['3'], ['新上架', '≤ 目标价 ¥4,500', '创历史新低（此前最低 ¥4,400）']);

  // 2 号继续降到更低 → 再次提醒；涨回目标价以上后再跌回来 → 重新提醒
  const r3 = evaluate(searchTask, [it('2', 4350)], r2.state, t(30));
  assert.ok(r3.alerts[0].reasons.some((r) => r.startsWith('≤ 目标价')));
  const s4 = evaluate(searchTask, [it('2', 4700)], r3.state, t(45)).state;
  const r5 = evaluate(searchTask, [it('2', 4500)], s4, t(60));
  assert.ok(r5.alerts[0].reasons.some((r) => r.startsWith('≤ 目标价')));
});

test('连续小幅降价会累计触发 dropPercent', () => {
  const task = normalizeTask({ name: 'i', type: 'item', itemId: '9', alert: { dropPercent: 5 } }, 0);
  let s = evaluate(task, [it('9', 1000)], {}, t(0)).state;
  const r1 = evaluate(task, [it('9', 980)], s, t(1)); // -2%
  assert.equal(r1.alerts.length, 0);
  const r2 = evaluate(task, [it('9', 940)], r1.state, t(2)); // 累计 -6%
  assert.deepEqual(r2.alerts[0].reasons, ['降价 ¥1,000 → ¥940（↓6.0%）']);
  const r3 = evaluate(task, [it('9', 930)], r2.state, t(3)); // 参考价重置为 940
  assert.equal(r3.alerts.length, 0);
});

test('单品状态变化提醒，已售商品不触发价格提醒', () => {
  const task = normalizeTask({ name: 'i', type: 'item', itemId: '9', alert: { targetPrice: 900 } }, 0);
  const s = evaluate(task, [it('9', 1000)], {}, t(0)).state;
  const r = evaluate(task, [it('9', 800, 'x', 'offline')], s, t(1));
  assert.deepEqual(r.alerts[0].reasons, ['状态变化：在售 → 已下架/不可购买']);
});

test('超过 30 天没再出现的搜索结果会被清理', () => {
  const s = evaluate(searchTask, [it('1', 4800)], {}, t(0)).state;
  const later = new Date(t(0).getTime() + 31 * 86400_000);
  const r = evaluate(searchTask, [it('2', 4900)], s, later);
  assert.deepEqual(Object.keys(r.state.items), ['2']);
});
