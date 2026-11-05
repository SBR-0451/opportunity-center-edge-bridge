// 市场普查：对一批关键词各搜前几页，统计在售量、价格分布、想要人数、上新速度。
// 用来回答"闲鱼上哪些卡牌有人气、有市场"，结果写到 data/survey/ 下，可直接发给别人分析。
// 只保存统计值和商品的公开字段（标题、价格、想要数、发布时间、地区），不保存卖家昵称。

import fs from 'node:fs';
import path from 'node:path';
import { randInt, sleep, timestamp } from './util.mjs';

const DAY = 86400_000;

export function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return Math.round((sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)) * 100) / 100;
}

const share = (n, d) => (d ? Math.round((n / d) * 1000) / 1000 : null);

/** 标题必须包含 mustIncludeAny 中任意一个词（不区分大小写），且不含 exclude 中任何一个词 */
export function isRelevant(title, entry) {
  const t = String(title || '').toLowerCase();
  const any = entry.mustIncludeAny || [];
  if (any.length && !any.some((w) => t.includes(String(w).toLowerCase()))) return false;
  return !(entry.exclude || []).some((w) => t.includes(String(w).toLowerCase()));
}

/** 对一组商品计算统计值 */
export function summarize(items, now = Date.now()) {
  const prices = items.map((i) => i.price).filter((p) => p != null && p > 0).sort((a, b) => a - b);
  const wants = items.map((i) => i.wantCount ?? 0);
  const published = items.map((i) => (i.publishTime ? Date.parse(i.publishTime) : null)).filter((t) => t != null);
  const wantsSorted = [...wants].sort((a, b) => a - b);
  return {
    listings: items.length,
    price: {
      min: prices[0] ?? null,
      p25: quantile(prices, 0.25),
      median: quantile(prices, 0.5),
      p75: quantile(prices, 0.75),
      max: prices.at(-1) ?? null,
      over500: prices.filter((p) => p >= 500).length,
      over5000: prices.filter((p) => p >= 5000).length,
    },
    want: {
      total: wants.reduce((a, b) => a + b, 0),
      median: quantile(wantsSorted, 0.5),
      shareWanted: share(wants.filter((w) => w > 0).length, items.length),
    },
    recency: {
      known: published.length,
      within1d: share(published.filter((t) => now - t <= DAY).length, published.length),
      within7d: share(published.filter((t) => now - t <= 7 * DAY).length, published.length),
      within30d: share(published.filter((t) => now - t <= 30 * DAY).length, published.length),
    },
  };
}

const slim = (i) => ({ itemId: i.itemId, price: i.price, want: i.wantCount, publishTime: i.publishTime, area: i.area, title: i.title });

/** 首页响应里除商品列表以外的字段（可能含总数、分页信息），截断保存，便于事后核对 */
function metaSnapshot(json) {
  const data = json?.data;
  if (!data || typeof data !== 'object') return null;
  const { resultList, ...rest } = data;
  const text = JSON.stringify(rest);
  return text.length > 3000 ? `${text.slice(0, 3000)}…` : rest;
}

export function loadKeywords(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  const list = Array.isArray(raw) ? raw : raw.keywords;
  if (!Array.isArray(list) || !list.length) throw new Error(`${file} 里没有关键词列表`);
  const d = (!Array.isArray(raw) && raw.defaults) || {};
  return list.map((e, i) => {
    if (!e?.keyword) throw new Error(`${file} 第 ${i + 1} 项缺少 keyword`);
    return {
      group: e.group || '',
      game: e.game || e.keyword,
      keyword: String(e.keyword),
      mustIncludeAny: e.mustIncludeAny || d.mustIncludeAny || [],
      exclude: [...new Set([...(d.exclude || []), ...(e.exclude || [])])],
    };
  });
}

/**
 * @param {object} p
 * @param {object[]} p.entries   loadKeywords 的结果
 * @param {{fetch: Function}} p.fetcher
 * @param {string} p.outFile     结果 JSON 路径（每完成一个关键词就写一次，中断后可 --resume 续跑）
 */
export async function runSurvey({ entries, fetcher, outFile, pages = 2, delaySeconds = [6, 15], log = console.log, now = () => Date.now(), resume = null }) {
  const result = resume ?? { startedAt: new Date(now()).toISOString(), pages, entries: [] };
  const done = new Set(result.entries.filter((e) => e.status === 'ok').map((e) => e.keyword));
  const system = {};
  const save = () => {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
  };
  let blocked = null;
  const todo = entries.filter((e) => !done.has(e.keyword));
  log(`普查 ${todo.length} 个关键词（已完成 ${done.size} 个），每个最多 ${pages} 页。`);

  for (let i = 0; i < todo.length; i++) {
    const entry = todo[i];
    if (i > 0) await sleep(randInt(delaySeconds[0] * 1000, delaySeconds[1] * 1000));
    const task = { name: `普查-${entry.keyword}`, type: 'search', keyword: entry.keyword, pages, sort: 'default' };
    let res;
    try {
      res = await fetcher.fetch(task, system);
    } catch (e) {
      res = { kind: 'error', ret: e.message.split('\n')[0] };
    }
    const at = now();
    const record = { ...entry, at: new Date(at).toISOString(), status: res.kind, via: res.via ?? null };
    if (res.kind === 'ok') {
      const relevant = res.items.filter((it) => isRelevant(it.title, entry));
      Object.assign(record, {
        raw: summarize(res.items, at),
        relevant: summarize(relevant, at),
        relevantShare: share(relevant.length, res.items.length),
        uniqueSellers: new Set(relevant.map((it) => it.seller).filter(Boolean)).size,
        topByPrice: [...relevant].sort((a, b) => (b.price ?? 0) - (a.price ?? 0)).slice(0, 5).map(slim),
        topByWant: [...relevant].sort((a, b) => (b.wantCount ?? 0) - (a.wantCount ?? 0)).slice(0, 5).map(slim),
        meta: metaSnapshot(res.firstPageJson),
      });
      const s = record.relevant;
      log(`[${timestamp(new Date(at))}] ${entry.keyword}：${res.items.length} 条，相关 ${relevant.length} 条，中位价 ${s.price.median ?? '-'}，想要合计 ${s.want.total}，7 天内上新 ${s.recency.within7d ?? '-'}`);
    } else {
      record.error = res.ret ?? null;
      log(`[${timestamp(new Date(at))}] ${entry.keyword}：失败（${res.kind}）${res.ret ?? ''}`);
    }
    result.entries = result.entries.filter((e) => e.keyword !== entry.keyword).concat(record);
    result.updatedAt = new Date(at).toISOString();
    save();
    if (res.kind === 'risk' || res.kind === 'login') {
      blocked = res.kind;
      log(res.kind === 'risk'
        ? '触发风控，已停止。已完成的结果保存好了：过一两个小时（或运行 npm run login 手动过一次验证）后，加 --resume 继续。'
        : '登录失效，已停止。运行 npm run login 重新登录后，加 --resume 继续。');
      break;
    }
  }
  result.finishedAt = blocked ? null : new Date(now()).toISOString();
  save();
  return { blocked, result };
}

/** 把普查结果整理成一行一个关键词的 CSV（带 BOM，Excel 直接打开） */
export function surveyToCsv(result) {
  const head = ['分组', '游戏', '关键词', '状态', '抓到条数', '相关条数', '相关占比', '卖家数', '最低价', 'P25', '中位价', 'P75', '最高价', '≥500元条数', '≥5000元条数', '想要合计', '想要中位数', '有人想要占比', '1天内上新占比', '7天内上新占比', '30天内上新占比'];
  const cell = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = result.entries.map((e) => {
    const r = e.relevant;
    return [
      e.group, e.game, e.keyword, e.status, e.raw?.listings, r?.listings, e.relevantShare, e.uniqueSellers,
      r?.price.min, r?.price.p25, r?.price.median, r?.price.p75, r?.price.max, r?.price.over500, r?.price.over5000,
      r?.want.total, r?.want.median, r?.want.shareWanted, r?.recency.within1d, r?.recency.within7d, r?.recency.within30d,
    ].map(cell).join(',');
  });
  return `﻿${head.join(',')}\n${rows.join('\n')}\n`;
}
