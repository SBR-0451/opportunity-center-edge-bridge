import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeConfig } from '../src/config.mjs';
import { createFetcher } from '../src/fetcher.mjs';
import { CookieJar, MtopClient, httpFetchItem, httpFetchSearch, mtopSign, parseSetCookie, searchPayload } from '../src/mtop.mjs';
import { runTasks } from '../src/runner.mjs';
import { Store } from '../src/store.mjs';
import { detailResponse, failResponse, searchResponse, searchRow } from './helpers.mjs';
import { loginCookie, startMockH5 } from './mockH5.mjs';

const APIS = { search: 'mtop.taobao.idlemtopsearch.pc.search', detail: 'mtop.taobao.idle.pc.detail' };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'xianyu-mtop-'));

test('mtopSign 与 md5(token&t&appKey&data) 一致', () => {
  assert.equal(mtopSign('abc123', '1700000000000', '34839810', '{"itemId":"1"}'), '6efd042ef89b13454990b0339862fc96');
});

test('parseSetCookie：Domain / Max-Age / 拒绝跨域', () => {
  const now = Date.UTC(2026, 0, 1);
  const c = parseSetCookie('_m_h5_tk=a_1; Domain=goofish.com; Path=/; Max-Age=60; Secure; SameSite=None', 'h5api.m.goofish.com', now);
  assert.deepEqual([c.domain, c.expires, c.secure, c.sameSite], ['.goofish.com', now / 1000 + 60, true, 'None']);
  assert.equal(parseSetCookie('x=1; Domain=evil.com', 'h5api.m.goofish.com'), null);
});

test('CookieJar：按域名匹配、过期删除、保存读取', () => {
  const dir = tmp();
  const jar = new CookieJar([
    { name: 'unb', value: '42', domain: '.goofish.com', path: '/', expires: -1 },
    { name: 'old', value: 'x', domain: '.goofish.com', path: '/', expires: 1 },
    { name: 'tb', value: 'y', domain: '.taobao.com', path: '/', expires: -1 },
  ], { userAgent: 'UA/1' });
  assert.equal(jar.header('https://h5api.m.goofish.com/h5/x'), 'unb=42');
  assert.ok(jar.hasLogin());
  jar.setFromResponse('https://h5api.m.goofish.com/', ['unb=; Domain=.goofish.com; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT']);
  assert.equal(jar.hasLogin(), false);
  jar.save(path.join(dir, 's.json'));
  const again = CookieJar.load(path.join(dir, 's.json'));
  assert.equal(again.userAgent, 'UA/1');
  assert.deepEqual(again.list().map((c) => c.name), ['tb']);
});

test('MtopClient：自动拿令牌、签名正确、带上登录 Cookie 与 UA', async (t) => {
  const mock = await startMockH5((call) => detailResponse({ id: call.data.itemId, title: 'Switch', soldPrice: '1450' }));
  t.after(mock.close);
  const jar = new CookieJar([loginCookie()], { userAgent: 'RealBrowser/1.0' });
  const client = new MtopClient({ jar, origin: mock.origin });
  const r = await client.call(APIS.detail, { itemId: '777' });
  assert.equal(r.kind, 'ok');
  assert.equal(mock.calls.length, 2, '第一次拿令牌，第二次带签名');
  const last = mock.calls[1];
  assert.equal(last.cookies.unb, '42');
  assert.equal(last.cookies._m_h5_tk, 'tok123_1999999999999');
  assert.equal(last.headers['user-agent'], 'RealBrowser/1.0');
  assert.equal(last.query.appKey, '34839810');
  // 令牌已在罐里：下一次调用一次就成功
  await client.call(APIS.detail, { itemId: '778' });
  assert.equal(mock.calls.length, 3);
});

test('MtopClient：风控与非 JSON 的 403 都识别为 risk', async (t) => {
  let n = 0;
  const mock = await startMockH5(() => (++n === 1
    ? { ret: ['FAIL_SYS_USER_VALIDATE', 'RGV587_ERROR::SM::哎哟喂,被挤爆啦'], data: { url: 'https://punish.example/x5' } }
    : { __raw: true, status: 403, body: '<html>verify</html>' }));
  t.after(mock.close);
  const client = new MtopClient({ jar: new CookieJar([loginCookie()]), origin: mock.origin });
  const a = await client.call(APIS.search, {});
  assert.equal(a.kind, 'risk');
  assert.match(a.ret, /punish\.example/);
  const b = await client.call(APIS.search, {});
  assert.equal(b.kind, 'risk');
});

test('httpFetchSearch：翻页、排序参数、去重；httpFetchItem 短链交给浏览器', async (t) => {
  const mock = await startMockH5((call) => call.data.pageNumber === 1
    ? searchResponse([searchRow({ id: '1', title: 'A', price: '100' }), searchRow({ id: '2', title: 'B', price: '200' })])
    : call.data.pageNumber === 2 ? searchResponse([searchRow({ id: '2', title: 'B', price: '200' }), searchRow({ id: '3', title: 'C', price: '300' })])
      : searchResponse([]));
  t.after(mock.close);
  const client = new MtopClient({ jar: new CookieJar([loginCookie()]), origin: mock.origin });
  const task = { name: 's', keyword: '相机', pages: 5, sort: 'newest', searchParams: { rowsPerPage: 20 } };
  const r = await httpFetchSearch(client, task, { apis: APIS, pageDelayMs: 0 });
  assert.deepEqual(r.items.map((i) => i.itemId), ['1', '2', '3']);
  const searchCalls = mock.calls.filter((c) => c.cookies._m_h5_tk);
  assert.equal(searchCalls.length, 3, '第 3 页为空后停止');
  assert.deepEqual([searchCalls[0].data.sortField, searchCalls[0].data.sortValue, searchCalls[0].data.rowsPerPage, searchCalls[0].data.keyword], ['create', 'desc', 20, '相机']);
  assert.equal((await httpFetchItem(client, { name: 'i', url: 'https://m.tb.cn/x' }, { apis: APIS })).kind, 'needBrowser');
  assert.equal(searchPayload({ keyword: 'k' }, 1).sortField, '');
});

const baseConfig = (extra = {}) => normalizeConfig({ dataDir: tmp(), tasks: [{ name: 's', keyword: 'k' }], ...extra }, process.cwd(), () => {});

test('auto 模式：HTTP 被风控 → 浏览器重试 → 冷却期内直接走浏览器 → 冷却后回到 HTTP', async () => {
  const config = baseConfig({ mode: 'auto', riskCooldownMinutes: 60 });
  let clock = Date.UTC(2026, 10, 4, 10);
  const used = [];
  let httpResult = { kind: 'risk', ret: 'RGV587' };
  const fetcher = createFetcher({
    config,
    log: () => {},
    now: () => clock,
    httpFetch: async () => (used.push('http'), httpResult),
    browserFetch: async () => (used.push('browser'), { kind: 'ok', items: [] }),
  });
  const system = {};
  const task = config.tasks[0];
  assert.equal((await fetcher.fetch(task, system)).via, 'browser');
  assert.deepEqual(used, ['http', 'browser']);
  assert.ok(system.httpPausedUntil);

  clock += 30 * 60_000;
  await fetcher.fetch(task, system);
  assert.deepEqual(used, ['http', 'browser', 'browser'], '冷却期内不再用 HTTP 撞风控');

  clock += 31 * 60_000;
  httpResult = { kind: 'ok', items: [] };
  assert.equal((await fetcher.fetch(task, system)).via, 'http');
});

test('http 模式不兜底；browser 模式不碰 HTTP；普通错误不触发兜底', async () => {
  const mk = (mode, httpResult) => {
    const used = [];
    const f = createFetcher({ config: baseConfig({ mode }), log: () => {}, httpFetch: async () => (used.push('http'), httpResult), browserFetch: async () => (used.push('browser'), { kind: 'ok', items: [] }) });
    return { f, used };
  };
  let x = mk('http', { kind: 'risk' });
  assert.equal((await x.f.fetch({ type: 'search' }, {})).kind, 'risk');
  assert.deepEqual(x.used, ['http']);
  x = mk('browser', { kind: 'ok' });
  await x.f.fetch({ type: 'search' }, {});
  assert.deepEqual(x.used, ['browser']);
  x = mk('auto', { kind: 'error', ret: '网络错误' });
  assert.equal((await x.f.fetch({ type: 'search' }, {})).kind, 'error');
  assert.deepEqual(x.used, ['http']);
});

test('完整流程（HTTP 模式，不启动浏览器）：基线 → 降价提醒 → 令牌写回会话文件', async (t) => {
  let round = 1;
  const mock = await startMockH5((call) => {
    if (call.api === APIS.detail) return detailResponse({ id: call.data.itemId, title: '镜头', soldPrice: round === 1 ? '2000' : '1800' });
    return searchResponse([searchRow({ id: '10', title: '富士 X100VI', price: round === 1 ? '10500' : '9900' })]);
  });
  t.after(mock.close);
  const dataDir = tmp();
  const config = normalizeConfig({
    mode: 'http',
    dataDir,
    mtopOrigin: mock.origin,
    taskDelaySeconds: [0, 0],
    notify: [{ type: 'console' }],
    tasks: [
      { name: '相机', keyword: 'X100VI', alert: { dropPercent: 5 } },
      { name: '镜头', type: 'item', itemId: '888', alert: { dropAmount: 100 } },
    ],
  }, dataDir, () => {});
  new CookieJar([loginCookie()], { userAgent: 'RealBrowser/1.0' }).save(config.sessionFile);
  const logs = [];
  const run = () => runTasks({ config, tasks: config.tasks, store: new Store(dataDir), fetcher: createFetcher({ config, log: () => {} }), log: (m) => logs.push(m) });

  const r1 = await run();
  assert.deepEqual(r1.results.map((r) => [r.kind, r.alerts.length]), [['ok', 0], ['ok', 0]]);
  round = 2;
  const r2 = await run();
  assert.deepEqual(r2.results.map((r) => r.alerts[0].reasons[0]), ['降价 ¥10,500 → ¥9,900（↓5.7%）', '降价 ¥2,000 → ¥1,800（↓10.0%）']);
  assert.ok(logs.some((l) => l.includes('提醒 1 条（http）')));
  assert.ok(logs.some((l) => l.includes('==== 闲鱼监控｜相机｜1 条提醒 ====')));
  const saved = CookieJar.load(config.sessionFile);
  assert.equal(saved.get('_m_h5_tk', mock.origin), 'tok123_1999999999999', '服务器下发的令牌被保存，下次启动不用重新拿');
  assert.equal(saved.userAgent, 'RealBrowser/1.0');
});

test('HTTP 模式没有登录信息时报 login，并提示先登录', async () => {
  const config = baseConfig({ mode: 'http' });
  const r = await createFetcher({ config, log: () => {} }).fetch(config.tasks[0], {});
  assert.equal(r.kind, 'login');
  assert.match(r.ret, /npm run login/);
});

test('auto 模式：浏览器兜底启动失败时，按 HTTP 的 login/risk 结果上报', async () => {
  const config = baseConfig({ mode: 'auto' });
  const f = createFetcher({
    config,
    log: () => {},
    httpFetch: async () => ({ kind: 'login', ret: '没有登录信息' }),
    browserFetch: async () => {
      throw new Error('找不到 playwright，请先运行 npm install');
    },
  });
  const r = await f.fetch(config.tasks[0], {});
  assert.equal(r.kind, 'login');
  assert.match(r.ret, /浏览器兜底也失败：找不到 playwright/);
});
