import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_APIS } from './goofish.mjs';
import { SORT_NAMES } from './mtop.mjs';
import { extractItemId, itemUrl } from './parse.mjs';
import { parseActiveHours } from './util.mjs';

const MIN_INTERVAL_MINUTES = 5;
const MODES = ['auto', 'http', 'browser'];

/** 把配置里的 "${ENV_NAME}" 替换成环境变量，推送密钥可以不写进文件 */
export function substituteEnv(value, env = process.env, missing = new Set()) {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name) => {
      if (env[name] == null) missing.add(name);
      return env[name] ?? '';
    });
  }
  if (Array.isArray(value)) return value.map((v) => substituteEnv(v, env, missing));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substituteEnv(v, env, missing)]));
  }
  return value;
}

const optNum = (v, field) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${field} 应为数字，实际为 ${JSON.stringify(v)}`);
  return n;
};

const strList = (v) => (Array.isArray(v) ? v : v ? [v] : []).map((s) => String(s).trim()).filter(Boolean);

export function normalizeTask(t, index) {
  if (!t || typeof t !== 'object') throw new Error(`tasks[${index}] 应为对象`);
  const type = t.type ?? (t.keyword ? 'search' : 'item');
  const name = String(t.name ?? t.keyword ?? t.itemId ?? `任务${index + 1}`).trim();
  const a = t.alert || {};
  const where = `任务「${name}」`;
  const base = {
    name,
    type,
    enabled: t.enabled !== false,
    intervalMinutes: optNum(t.intervalMinutes, `${where}.intervalMinutes`),
  };
  const priceAlerts = {
    targetPrice: optNum(a.targetPrice, `${where}.alert.targetPrice`),
    dropPercent: optNum(a.dropPercent, `${where}.alert.dropPercent`),
    dropAmount: optNum(a.dropAmount, `${where}.alert.dropAmount`),
  };

  if (type === 'search') {
    if (!t.keyword) throw new Error(`${where} 缺少 keyword`);
    const pages = Math.min(Math.max(parseInt(t.pages ?? 1, 10) || 1, 1), 5);
    const sort = t.sort ?? 'default';
    if (!SORT_NAMES.includes(sort)) throw new Error(`${where}.sort 只能是 ${SORT_NAMES.join(' / ')}`);
    if (t.searchParams != null && (typeof t.searchParams !== 'object' || Array.isArray(t.searchParams))) {
      throw new Error(`${where}.searchParams 应为对象`);
    }
    return {
      ...base,
      keyword: String(t.keyword).trim(),
      pages,
      sort,
      searchParams: t.searchParams || null,
      minPrice: optNum(t.minPrice, `${where}.minPrice`),
      maxPrice: optNum(t.maxPrice, `${where}.maxPrice`),
      include: strList(t.include),
      exclude: strList(t.exclude),
      alert: { ...priceAlerts, newListing: a.newListing ?? true, newLow: a.newLow ?? false },
    };
  }

  if (type === 'item') {
    const itemId = t.itemId != null && t.itemId !== '' ? String(t.itemId).trim() : extractItemId(t.url);
    if (itemId && !/^\d+$/.test(itemId)) throw new Error(`${where} 的 itemId 应为纯数字（商品链接里 id= 后面那串）`);
    const url = itemId ? itemUrl(itemId) : t.url ? String(t.url).trim() : null;
    if (!url) throw new Error(`${where} 需要 itemId 或 url`);
    return { ...base, itemId, url, alert: { ...priceAlerts, statusChange: a.statusChange ?? true } };
  }

  throw new Error(`${where} 的 type 只能是 "search" 或 "item"`);
}

export function normalizeConfig(raw, baseDir = process.cwd(), log = console.warn) {
  if (!raw || typeof raw !== 'object') throw new Error('配置文件内容应为 JSON 对象');
  const missing = new Set();
  const cfg = substituteEnv(raw, process.env, missing);
  if (missing.size) log(`[配置] 以下环境变量未设置，已按空值处理：${[...missing].join(', ')}`);

  let interval = optNum(cfg.intervalMinutes, 'intervalMinutes') ?? 15;
  if (interval < MIN_INTERVAL_MINUTES) {
    log(`[配置] intervalMinutes 过小，已调整为 ${MIN_INTERVAL_MINUTES} 分钟（访问太频繁容易触发风控）`);
    interval = MIN_INTERVAL_MINUTES;
  }

  if (!Array.isArray(cfg.tasks) || !cfg.tasks.length) throw new Error('tasks 不能为空，至少配置一个监控任务');
  const tasks = cfg.tasks.map(normalizeTask);
  const seen = new Set();
  for (const t of tasks) {
    if (seen.has(t.name)) throw new Error(`任务名重复：「${t.name}」（name 用来区分监控记录，需要唯一）`);
    seen.add(t.name);
    if (t.intervalMinutes != null && t.intervalMinutes < MIN_INTERVAL_MINUTES) t.intervalMinutes = MIN_INTERVAL_MINUTES;
  }

  const mode = cfg.mode ?? 'auto';
  if (!MODES.includes(mode)) throw new Error(`mode 只能是 ${MODES.join(' / ')}`);

  const dataDir = path.resolve(baseDir, cfg.dataDir || './data');
  return {
    mode,
    dataDir,
    profileDir: path.join(dataDir, 'browser-profile'),
    sessionFile: path.join(dataDir, 'storage-state.json'),
    userAgent: cfg.userAgent || null,
    mtopOrigin: cfg.mtopOrigin || undefined, // 仅供测试指向本地模拟服务
    debug: false,
    browser: {
      channel: cfg.browser?.channel ?? '',
      headless: cfg.browser?.headless ?? false,
      executablePath: cfg.browser?.executablePath || undefined,
    },
    intervalMinutes: interval,
    activeHours: parseActiveHours(cfg.activeHours),
    riskCooldownMinutes: optNum(cfg.riskCooldownMinutes, 'riskCooldownMinutes') ?? 60,
    captureTimeoutMs: (optNum(cfg.captureTimeoutSeconds, 'captureTimeoutSeconds') ?? 25) * 1000,
    taskDelaySeconds: Array.isArray(cfg.taskDelaySeconds) ? cfg.taskDelaySeconds.map(Number) : [5, 15],
    apis: { ...DEFAULT_APIS, ...(cfg.apis || {}) },
    notify: Array.isArray(cfg.notify) && cfg.notify.length ? cfg.notify : [{ type: 'console' }],
    tasks,
  };
}

export function loadConfig(file, log = console.warn) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) {
    throw new Error(`找不到配置文件 ${abs}\n先复制一份示例：cp config.example.json config.json，然后按需修改。`);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(abs, 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    throw new Error(`配置文件不是合法 JSON：${e.message}`);
  }
  return normalizeConfig(raw, path.dirname(abs), log);
}
