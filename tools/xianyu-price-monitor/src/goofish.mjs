// 浏览器层：用一个独立的、已登录的浏览器配置打开闲鱼网页版，
// 监听页面"自己"发出的 mtop 接口响应拿到结构化数据。
// 不自己构造签名请求、不处理验证码；遇到风控就停下来交给人。

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import { LOGIN_COOKIES, SITE, classifyRet, parseDetail, parseJsonLoose, parseSearch, searchUrl } from './parse.mjs';
import { randInt, sleep } from './util.mjs';

const require = createRequire(import.meta.url);

export const DEFAULT_APIS = {
  search: 'mtop.taobao.idlemtopsearch.pc.search',
  detail: 'mtop.taobao.idle.pc.detail',
};

// 搜索结果翻页按钮（尽力而为：找不到就只取第一页）
const NEXT_PAGE_SELECTORS = ['[class*="search-pagination-arrow-right"]', 'button:has-text("下一页")', 'li[title="下一页"]'];

function loadPlaywright() {
  try {
    return require('playwright');
  } catch {
    throw new Error('找不到 playwright，请先在 tools/xianyu-price-monitor 目录运行 npm install');
  }
}

export async function launchContext({ profileDir, headless = false, channel = '', executablePath } = {}) {
  const { chromium } = loadPlaywright();
  fs.mkdirSync(profileDir, { recursive: true });
  try {
    return await chromium.launchPersistentContext(profileDir, {
      headless,
      channel: channel || undefined,
      executablePath: executablePath || undefined,
      viewport: { width: 1366, height: 860 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
    });
  } catch (e) {
    const hint = channel
      ? `无法启动 ${channel}。确认本机已安装该浏览器，或把 config.json 的 browser.channel 改成 ""，再运行 npx playwright install chromium。`
      : '无法启动 Chromium。运行 npx playwright install chromium，或在 config.json 设置 browser.channel 为 "msedge" / "chrome" 使用本机浏览器。';
    if (/ProcessSingleton|SingletonLock|profile.*in use|user data directory is already in use/i.test(e.message)) {
      throw new Error(`浏览器配置目录 ${profileDir} 正被占用：同一时间只能运行一个监控/登录进程。`);
    }
    throw new Error(`${hint}\n原始错误：${e.message.split('\n')[0]}`);
  }
}

export async function isLoggedIn(context) {
  const cookies = await context.cookies([SITE, 'https://h5api.m.goofish.com']);
  return cookies.some((c) => LOGIN_COOKIES.includes(c.name) && c.value);
}

/**
 * 监听 page 上名为 apiName 的 mtop 响应，直到拿到成功结果或明确失败。
 * 令牌类错误（页面首次请求常见）会被忽略，因为页面会自动重试。
 */
export function captureMtop(page, apiName, { timeoutMs = 25_000, graceMs = 3_000 } = {}) {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  let settled = false;
  let lastFail = null;
  let graceTimer = null;

  const finish = (result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearTimeout(graceTimer);
    page.off('response', onResponse);
    resolve(result);
  };

  const onResponse = async (resp) => {
    if (!resp.url().includes(`/${apiName}/`) || resp.request().method() === 'OPTIONS') return;
    let json;
    try {
      json = parseJsonLoose(await resp.text());
    } catch {
      return;
    }
    if (!json) return;
    const c = classifyRet(json);
    if (c.kind === 'ok') return finish({ kind: 'ok', json });
    if (c.kind === 'token') return;
    lastFail = { kind: c.kind, ret: c.ret, json };
    clearTimeout(graceTimer);
    graceTimer = setTimeout(() => finish(lastFail), graceMs);
  };

  const timer = setTimeout(() => finish(lastFail ?? { kind: 'timeout', ret: `${timeoutMs / 1000}s 内没有捕获到 ${apiName} 接口响应` }), timeoutMs);
  page.on('response', onResponse);
  return promise;
}

/** 超时时进一步判断原因：被跳到登录页 / 出现滑块验证 */
async function diagnose(page, result) {
  if (result.kind !== 'timeout') return result;
  const url = page.url();
  if (/login|passport/i.test(url)) return { kind: 'login', ret: `页面跳转到了登录页：${url}` };
  const riskFrame = page.frames().some((f) => /punish|captcha|baxia|_____tmd_____/i.test(f.url()));
  if (riskFrame) return { kind: 'risk', ret: '页面出现了滑块/验证码' };
  return result;
}

async function dumpDebug(page, debugDir, tag, payload) {
  if (!debugDir) return;
  fs.mkdirSync(debugDir, { recursive: true });
  const base = path.join(debugDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${tag.replace(/[^\w一-龥-]+/g, '_')}`);
  fs.writeFileSync(`${base}.json`, JSON.stringify({ url: page.url(), ...payload }, null, 2));
  if (payload.kind && payload.kind !== 'ok') await page.screenshot({ path: `${base}.png` }).catch(() => {});
}

async function findNextPage(page) {
  for (const sel of NEXT_PAGE_SELECTORS) {
    const loc = page.locator(sel).first();
    if (!(await loc.count())) continue;
    if (!(await loc.isVisible().catch(() => false))) continue;
    const cls = (await loc.getAttribute('class').catch(() => '')) || '';
    const disabled = /disabled/i.test(cls) || (await loc.isDisabled().catch(() => false));
    if (!disabled) return loc;
  }
  return null;
}

/** 关键词搜索任务：返回 { kind:'ok', items } 或 { kind:'risk'|'login'|'timeout'|'error', ret } */
export async function fetchSearch(context, task, opts = {}) {
  const apis = { ...DEFAULT_APIS, ...opts.apis };
  const page = await context.newPage();
  try {
    let waiting = captureMtop(page, apis.search, opts);
    await page.goto(searchUrl(task.keyword), { waitUntil: 'domcontentloaded', timeout: opts.navTimeoutMs ?? 30_000 });
    let res = await diagnose(page, await waiting);
    await dumpDebug(page, opts.debugDir, `${task.name}-p1`, res);
    if (res.kind !== 'ok') return res;

    const firstPageJson = res.json;
    const items = parseSearch(res.json);
    for (let p = 2; p <= (task.pages || 1); p++) {
      const next = await findNextPage(page);
      if (!next) break;
      await sleep(randInt(2_000, 5_000));
      waiting = captureMtop(page, apis.search, opts);
      await next.click();
      res = await diagnose(page, await waiting);
      await dumpDebug(page, opts.debugDir, `${task.name}-p${p}`, res);
      if (res.kind !== 'ok') {
        // 翻页失败时保留已拿到的数据；风控/登录问题要向上报告
        if (res.kind === 'risk' || res.kind === 'login') return res;
        break;
      }
      items.push(...parseSearch(res.json));
    }
    const unique = [...new Map(items.map((it) => [it.itemId, it])).values()];
    return { kind: 'ok', items: unique, firstPageJson };
  } finally {
    await page.close().catch(() => {});
  }
}

/** 单品任务：打开商品页，读取详情接口 */
export async function fetchItem(context, task, opts = {}) {
  const apis = { ...DEFAULT_APIS, ...opts.apis };
  const page = await context.newPage();
  try {
    const waiting = captureMtop(page, apis.detail, opts);
    await page.goto(task.url, { waitUntil: 'domcontentloaded', timeout: opts.navTimeoutMs ?? 30_000 });
    const res = await diagnose(page, await waiting);
    await dumpDebug(page, opts.debugDir, task.name, res);
    if (res.kind !== 'ok') return res;
    const item = parseDetail(res.json, task.itemId);
    if (!item) return { kind: 'error', ret: '详情接口里没有找到商品 ID，可能是接口字段变了（用 --debug 查看原始数据）' };
    return { kind: 'ok', items: [item] };
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * 打开可见浏览器：未登录时等待扫码（检测到登录 Cookie 自动结束）；已登录时等用户处理完滑块验证后按回车。
 * 结束时把 Cookie 和真实浏览器 UA 导出到 stateFile，供 HTTP 模式使用。
 */
export async function interactiveLogin({ profileDir, channel, executablePath, stateFile, timeoutMs = 10 * 60_000, log = console.log }) {
  const context = await launchContext({ profileDir, headless: false, channel, executablePath });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(SITE, { waitUntil: 'domcontentloaded' }).catch(() => {});
  const already = await isLoggedIn(context).catch(() => false);
  if (already) {
    log('当前已是登录状态。如果监控提示触发了验证，可以在窗口里搜一下商品、完成滑块验证；处理完后在这里按回车保存。');
  } else {
    log('已打开浏览器：点右上角「登录」，用闲鱼或淘宝 App 扫码。');
    log('检测到登录成功会自动保存并关闭；也可以登录完成后在这里按回车。');
  }

  const rl = readline.createInterface({ input: process.stdin });
  let enter = false;
  rl.once('line', () => {
    enter = true;
  });
  const deadline = Date.now() + timeoutMs;
  let ok = false;
  try {
    while (Date.now() < deadline && !enter) {
      if (!already && (await isLoggedIn(context).catch(() => false))) {
        await sleep(3_000); // 给页面一点时间写完剩余 Cookie
        break;
      }
      await sleep(1_000);
    }
    ok = await isLoggedIn(context).catch(() => false);
    if (ok && stateFile) {
      const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => null);
      const state = await context.storageState();
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify({ ...state, userAgent }, null, 2));
    }
  } finally {
    rl.close();
    await context.close().catch(() => {});
  }
  return ok;
}

/** 把另一台机器 login 导出的 storage-state.json 导入本机浏览器配置（用于无图形界面的服务器） */
export async function importState({ profileDir, channel, executablePath, file }) {
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cookies = Array.isArray(state.cookies) ? state.cookies : [];
  if (!cookies.length) throw new Error(`${file} 里没有 cookies`);
  const context = await launchContext({ profileDir, headless: true, channel, executablePath });
  try {
    await context.addCookies(cookies);
    return { count: cookies.length, loggedIn: await isLoggedIn(context) };
  } finally {
    await context.close().catch(() => {});
  }
}
