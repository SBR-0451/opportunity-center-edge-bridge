import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeConfig } from '../src/config.mjs';
import { createFetcher } from '../src/fetcher.mjs';
import { CookieJar } from '../src/mtop.mjs';
import { isRelevant, loadKeywords, quantile, runSurvey, summarize, surveyToCsv } from '../src/survey.mjs';
import { failResponse, searchResponse, searchRow } from './helpers.mjs';
import { loginCookie, startMockH5 } from './mockH5.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'xianyu-survey-'));
const NOW = Date.UTC(2026, 10, 5, 12);
const daysAgo = (d) => String(NOW - d * 86400_000);

test('quantile / summarize：价格分位、想要数、上新占比', () => {
  assert.equal(quantile([10, 20, 30, 40], 0.5), 25);
  assert.equal(quantile([], 0.5), null);
  const items = [
    { price: 100, wantCount: 0, publishTime: new Date(NOW - 0.5 * 86400_000).toISOString() },
    { price: 600, wantCount: 5, publishTime: new Date(NOW - 3 * 86400_000).toISOString() },
    { price: 6000, wantCount: 12, publishTime: new Date(NOW - 20 * 86400_000).toISOString() },
    { price: null, wantCount: 1, publishTime: null },
  ];
  const s = summarize(items, NOW);
  assert.deepEqual(s.price, { min: 100, p25: 350, median: 600, p75: 3300, max: 6000, over500: 2, over5000: 1 });
  assert.deepEqual(s.want, { total: 18, median: 3, shareWanted: 0.75 });
  assert.deepEqual(s.recency, { known: 3, within1d: 0.333, within7d: 0.667, within30d: 1 });
});

test('isRelevant 与 loadKeywords 默认值合并', () => {
  const dir = tmp();
  const f = path.join(dir, 'k.json');
  fs.writeFileSync(f, JSON.stringify({ defaults: { mustIncludeAny: ['卡'], exclude: ['求购'] }, keywords: [{ keyword: '高达卡牌' }, { keyword: 'wixoss', mustIncludeAny: ['wixoss'], exclude: ['代肝'] }] }));
  const [a, b] = loadKeywords(f);
  assert.deepEqual([a.mustIncludeAny, a.exclude, b.mustIncludeAny, b.exclude], [['卡'], ['求购'], ['wixoss'], ['求购', '代肝']]);
  assert.equal(isRelevant('高达卡牌 GD05 强袭自由 LR++', a), true);
  assert.equal(isRelevant('高达模型 MG 强袭自由', a), false);
  assert.equal(isRelevant('求购 高达卡牌', a), false);
  assert.equal(isRelevant('WIXOSS 签名 UR', b), true);
});

test('runSurvey（HTTP 模拟）：统计、过滤无关商品、风控中断后 --resume 续跑', async (t) => {
  let blockKeyword = '洛卡纳';
  const mock = await startMockH5((call) => {
    const kw = call.data.keyword;
    if (kw === blockKeyword) return failResponse('FAIL_SYS_USER_VALIDATE::被挤爆啦');
    if (call.data.pageNumber > 1) return searchResponse([]);
    const rows = [
      searchRow({ id: `${kw.length}1`, title: `${kw} 卡 SEC 闪`, price: '880', want: '9', ts: daysAgo(2) }),
      searchRow({ id: `${kw.length}2`, title: `${kw} 卡 普卡一组`, price: '30', want: '0', ts: daysAgo(40) }),
      searchRow({ id: `${kw.length}3`, title: 'MG 强袭自由 模型 手办', price: '200', want: '1', ts: daysAgo(1) }),
    ];
    const res = searchResponse(rows);
    res.data.resultInfo = { hasNextPage: true, totalCount: 1234 };
    return res;
  });
  t.after(mock.close);
  const dataDir = tmp();
  const config = normalizeConfig({ mode: 'http', dataDir, mtopOrigin: mock.origin, tasks: [{ name: 'x', keyword: 'x' }] }, dataDir, () => {});
  new CookieJar([loginCookie()]).save(config.sessionFile);
  const entries = [
    { group: 'A', game: '高达', keyword: '高达卡牌', mustIncludeAny: ['卡'], exclude: [] },
    { group: 'B', game: '洛卡纳', keyword: '洛卡纳', mustIncludeAny: ['卡'], exclude: [] },
    { group: 'C', game: 'WIXOSS', keyword: 'wixoss', mustIncludeAny: ['卡'], exclude: [] },
  ];
  const outFile = path.join(dataDir, 'survey', 's.json');
  const opts = { entries, outFile, pages: 2, delaySeconds: [0, 0], log: () => {}, now: () => NOW };

  const r1 = await runSurvey({ ...opts, fetcher: createFetcher({ config, log: () => {} }) });
  assert.equal(r1.blocked, 'risk');
  assert.deepEqual(r1.result.entries.map((e) => [e.keyword, e.status]), [['高达卡牌', 'ok'], ['洛卡纳', 'risk']]);
  const g = r1.result.entries[0];
  assert.equal(g.raw.listings, 3);
  assert.equal(g.relevant.listings, 2, '模型手办被过滤');
  assert.equal(g.relevant.price.median, 455);
  assert.equal(g.relevant.want.total, 9);
  assert.equal(g.relevant.recency.within7d, 0.5);
  assert.equal(g.meta.resultInfo.totalCount, 1234, '保留首页元数据（可能含总数）');
  assert.equal(g.topByPrice[0].title, '高达卡牌 卡 SEC 闪');
  assert.equal('seller' in g.topByPrice[0], false, '不保存卖家昵称');
  assert.equal(r1.result.finishedAt, null);

  blockKeyword = null;
  const saved = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  const before = mock.calls.filter((c) => c.data.keyword === '高达卡牌').length;
  const r2 = await runSurvey({ ...opts, resume: saved, fetcher: createFetcher({ config, log: () => {} }) });
  assert.equal(r2.blocked, null);
  assert.deepEqual(r2.result.entries.map((e) => [e.keyword, e.status]), [['高达卡牌', 'ok'], ['洛卡纳', 'ok'], ['wixoss', 'ok']]);
  assert.equal(mock.calls.filter((c) => c.data.keyword === '高达卡牌').length, before, '已完成的关键词不重复请求');
  assert.ok(r2.result.finishedAt);

  const csv = surveyToCsv(r2.result);
  assert.ok(csv.startsWith('﻿分组,游戏,关键词'));
  assert.equal(csv.trim().split('\n').length, 4);
});
