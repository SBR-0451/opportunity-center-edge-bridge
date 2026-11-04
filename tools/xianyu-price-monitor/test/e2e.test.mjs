// 端到端：真实浏览器 + 拦截路由模拟闲鱼网页版。页面自己用 fetch 调 mtop 接口，
// 监控程序只"旁听"响应——和线上的工作方式一致。没有可用浏览器时自动跳过。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { normalizeConfig } from '../src/config.mjs';
import { fetchItem, fetchSearch, launchContext } from '../src/goofish.mjs';
import { runTasks } from '../src/runner.mjs';
import { Store } from '../src/store.mjs';
import { detailResponse, failResponse, searchResponse, searchRow } from './helpers.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'xianyu-test-'));

// 模拟页面：首次请求返回令牌为空 → 页面重试；带翻页按钮
const PAGE_HTML = (api, payload) => `<!doctype html><meta charset="utf-8"><body>
<div class="search-pagination-arrow-right--x1" id="next" style="display:none">›</div>
<script>
  const api = ${JSON.stringify(api)};
  let page = 1;
  async function call() {
    for (let i = 0; i < 2; i++) {
      const url = 'https://h5api.m.goofish.com/h5/' + api + '/1.0/?jsv=2.7.2&appKey=34839810&t=' + Date.now() + '&sign=test&api=' + api;
      const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(JSON.stringify({ ...${JSON.stringify(payload)}, pageNumber: page })), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
      const j = await r.json();
      if (!String(j.ret).includes('TOKEN')) return j;
    }
  }
  call().then(() => { document.getElementById('next').style.display = 'block'; });
  document.getElementById('next').onclick = () => { page += 1; call(); };
</script>`;

/** 安装路由；handler(api, body, callIndex) 返回 mtop JSON */
async function mockGoofish(context, handler) {
  const tokenSeen = new Set();
  let calls = 0;
  await context.route('https://www.goofish.com/**', (route) => {
    const url = new URL(route.request().url());
    const html = url.pathname === '/search'
      ? PAGE_HTML('mtop.taobao.idlemtopsearch.pc.search', { keyword: url.searchParams.get('q') })
      : PAGE_HTML('mtop.taobao.idle.pc.detail', { itemId: url.searchParams.get('id') });
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
  });
  await context.route('https://h5api.m.goofish.com/**', (route) => {
    const req = route.request();
    const api = new URL(req.url()).pathname.split('/')[2];
    const data = JSON.parse(new URLSearchParams(req.postData() || '').get('data') || '{}');
    let json;
    if (!tokenSeen.has(api)) {
      tokenSeen.add(api);
      json = failResponse('FAIL_SYS_TOKEN_EMPTY::令牌为空');
    } else {
      json = handler(api, data, calls++);
    }
    return route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': 'https://www.goofish.com' }, body: JSON.stringify(json) });
  });
}

let context;
let skipReason = null;
test.before(async () => {
  try {
    context = await launchContext({ profileDir: tmp(), headless: true, channel: process.env.TEST_BROWSER_CHANNEL || '' });
  } catch (e) {
    skipReason = `没有可用的浏览器：${e.message.split('\n')[0]}`;
  }
});
test.after(async () => {
  await context?.close();
});

const OPTS = { timeoutMs: 8_000, graceMs: 500 };

test('搜索：等过令牌重试、翻页并去重', async (t) => {
  if (skipReason) return t.skip(skipReason);
  await mockGoofish(context, (api, data) => {
    assert.equal(api, 'mtop.taobao.idlemtopsearch.pc.search');
    return data.pageNumber === 1
      ? searchResponse([searchRow({ id: '1', title: 'A 256G', price: '4800' }), searchRow({ id: '2', title: 'B 256G', price: '4400' })])
      : searchResponse([searchRow({ id: '2', title: 'B 256G', price: '4400' }), searchRow({ id: '3', title: 'C 256G', price: '4300' })]);
  });
  const res = await fetchSearch(context, { name: 's', keyword: 'iPhone 15', pages: 2 }, OPTS);
  assert.equal(res.kind, 'ok');
  assert.deepEqual(res.items.map((i) => [i.itemId, i.price]), [['1', 4800], ['2', 4400], ['3', 4300]]);
  await context.unrouteAll();
});

test('搜索：风控响应被识别为 risk', async (t) => {
  if (skipReason) return t.skip(skipReason);
  await mockGoofish(context, () => failResponse('RGV587_ERROR::SM::哎哟喂,被挤爆啦,请稍后重试'));
  const res = await fetchSearch(context, { name: 's', keyword: 'x', pages: 1 }, OPTS);
  assert.equal(res.kind, 'risk');
  await context.unrouteAll();
});

test('单品：读取详情接口', async (t) => {
  if (skipReason) return t.skip(skipReason);
  await mockGoofish(context, (api, data) => detailResponse({ id: data.itemId, title: 'Switch OLED', soldPrice: '1450' }));
  const res = await fetchItem(context, { name: 'i', itemId: '777', url: 'https://www.goofish.com/item?id=777' }, OPTS);
  assert.equal(res.kind, 'ok');
  assert.deepEqual([res.items[0].itemId, res.items[0].price, res.items[0].status], ['777', 1450, 'onsale']);
  await context.unrouteAll();
});

test('完整流程：基线 → 降价/新品 → Webhook 推送 → 风控暂停', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push(JSON.parse(body));
      res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());

  const dataDir = tmp();
  const config = normalizeConfig({
    dataDir,
    taskDelaySeconds: [0, 0],
    captureTimeoutSeconds: 8,
    notify: [{ type: 'webhook', url: `http://127.0.0.1:${server.address().port}/hook` }],
    tasks: [
      { name: '相机', keyword: '富士 X100VI', maxPrice: 12000, exclude: ['求购'], alert: { targetPrice: 9000, dropPercent: 5, newLow: true } },
      { name: '单品', type: 'item', itemId: '888', alert: { statusChange: true } },
    ],
  }, dataDir, () => {});
  const store = new Store(dataDir);
  const logs = [];
  const run = () => runTasks({ config, tasks: config.tasks, store, getContext: async () => context, log: (m) => logs.push(m) });

  let round = 1;
  await mockGoofish(context, (api) => {
    if (api.endsWith('detail')) return detailResponse({ id: '888', title: '镜头', soldPrice: '2000', itemStatus: round === 1 ? 0 : 1 });
    return round === 1
      ? searchResponse([searchRow({ id: '10', title: '富士 X100VI 银色', price: '10500' }), searchRow({ id: '11', title: '求购 X100VI', price: '9000' })])
      : searchResponse([searchRow({ id: '10', title: '富士 X100VI 银色', price: '9800' }), searchRow({ id: '12', title: '富士 X100VI 黑色 全新', price: '8999' })]);
  });

  const r1 = await run();
  assert.equal(r1.blocked, null);
  assert.equal(received.length, 0, '首轮只建立基线');

  round = 2;
  const r2 = await run();
  assert.equal(r2.blocked, null);
  assert.equal(received.length, 2);
  const camera = received.find((m) => m.task === '相机');
  const reasons = Object.fromEntries(camera.alerts.map((a) => [a.itemId, a.reasons]));
  assert.ok(reasons['10'].some((r) => r.startsWith('降价 ¥10,500 → ¥9,800')));
  assert.deepEqual(reasons['12'], ['新上架', '≤ 目标价 ¥9,000', '创历史新低（此前最低 ¥10,500）']);
  assert.match(camera.text, /https:\/\/www\.goofish\.com\/item\?id=12/);
  const item = received.find((m) => m.task === '单品');
  assert.deepEqual(item.alerts[0].reasons, ['状态变化：在售 → 已下架/不可购买']);

  const csv = fs.readFileSync(path.join(dataDir, 'history.csv'), 'utf8');
  assert.ok(csv.startsWith('﻿time,task,itemId'));
  assert.equal(csv.trim().split('\n').length, 1 + 2 + 3, '表头 + 首轮 2 行（10、888）+ 次轮 3 行变化（10 降价、12 新品、888 下架）');
  await context.unrouteAll();

  // 第三轮：风控 → 发一条系统提醒并中止本轮，同一冷却期内不重复提醒
  await mockGoofish(context, () => failResponse('FAIL_SYS_USER_VALIDATE::被挤爆啦'));
  const r3 = await run();
  assert.equal(r3.blocked, 'risk');
  assert.equal(r3.results.length, 1, '风控后剩余任务被跳过');
  assert.equal(received.at(-1).kind, 'system');
  const before = received.length;
  await run();
  assert.equal(received.length, before, '冷却期内不重复推送风控提醒');
  await context.unrouteAll();
});
