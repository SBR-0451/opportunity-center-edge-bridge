// HTTP 直连：不开浏览器，用登录时保存的 Cookie 直接请求闲鱼网页版同一套 mtop 接口。
// 内存几十 MB、每页几百毫秒。签名用的是网页版公开的 H5 规则（需要你自己的登录 Cookie）；
// 不处理验证码——被风控拦下时交给浏览器兜底或由人处理。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { LOGIN_COOKIES, SITE, classifyRet, itemUrl, parseDetail, parseJsonLoose, parseSearch, searchUrl } from './parse.mjs';
import { randInt, sleep } from './util.mjs';

export const APP_KEY = '34839810';
export const H5_ORIGIN = 'https://h5api.m.goofish.com';
// 登录时会记录真实浏览器的 UA；只有拿不到时才用这个
export const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0';

export function mtopSign(token, t, appKey, data) {
  return crypto.createHash('md5').update(`${token}&${t}&${appKey}&${data}`).digest('hex');
}

const domainMatch = (host, domain) => {
  const d = String(domain || '').replace(/^\./, '').toLowerCase();
  return Boolean(d) && (host === d || host.endsWith(`.${d}`));
};

/** 解析一条 Set-Cookie，返回 Playwright storageState 同格式的 cookie；Domain 不属于当前主机时返回 null */
export function parseSetCookie(header, host, nowMs = Date.now()) {
  const [nameValue, ...attrs] = String(header).split(';');
  const eq = nameValue.indexOf('=');
  if (eq <= 0) return null;
  const c = {
    name: nameValue.slice(0, eq).trim(),
    value: nameValue.slice(eq + 1).trim(),
    domain: host,
    path: '/',
    expires: -1,
    httpOnly: false,
    secure: false,
    sameSite: 'Lax',
  };
  let maxAge = null;
  for (const attr of attrs) {
    const i = attr.indexOf('=');
    const key = (i < 0 ? attr : attr.slice(0, i)).trim().toLowerCase();
    const val = i < 0 ? '' : attr.slice(i + 1).trim();
    if (key === 'domain' && val) c.domain = val.startsWith('.') ? val : `.${val}`;
    else if (key === 'path' && val) c.path = val;
    else if (key === 'expires') {
      const ms = Date.parse(val);
      if (!Number.isNaN(ms)) c.expires = Math.floor(ms / 1000);
    } else if (key === 'max-age') maxAge = parseInt(val, 10);
    else if (key === 'secure') c.secure = true;
    else if (key === 'httponly') c.httpOnly = true;
    else if (key === 'samesite' && val) {
      const v = val.toLowerCase();
      c.sameSite = v === 'none' ? 'None' : v === 'strict' ? 'Strict' : 'Lax';
    }
  }
  if (maxAge != null && Number.isFinite(maxAge)) c.expires = Math.floor(nowMs / 1000) + maxAge;
  if (!domainMatch(host, c.domain)) return null;
  return c;
}

/** 最小 Cookie 罐，文件格式与 Playwright storageState 相同（额外存一个 userAgent 字段） */
export class CookieJar {
  constructor(cookies = [], { userAgent } = {}) {
    this.map = new Map();
    this.userAgent = userAgent || null;
    for (const c of cookies) if (c?.name) this.map.set(CookieJar.key(c), { path: '/', expires: -1, ...c });
  }

  static key(c) {
    return `${c.name}\u0000${String(c.domain).replace(/^\./, '')}\u0000${c.path || '/'}`;
  }

  static load(file) {
    if (!fs.existsSync(file)) return new CookieJar();
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return new CookieJar(Array.isArray(s.cookies) ? s.cookies : [], { userAgent: s.userAgent });
  }

  save(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ cookies: this.list(), origins: [], userAgent: this.userAgent }, null, 2));
    fs.renameSync(tmp, file);
  }

  list(nowSec = Date.now() / 1000) {
    return [...this.map.values()].filter((c) => c.expires == null || c.expires < 0 || c.expires > nowSec);
  }

  matching(url) {
    const host = new URL(url).hostname.toLowerCase();
    return this.list().filter((c) => domainMatch(host, c.domain));
  }

  header(url) {
    return this.matching(url)
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  }

  get(name, url = H5_ORIGIN) {
    return this.matching(url).find((c) => c.name === name)?.value ?? null;
  }

  hasLogin() {
    return this.list().some((c) => LOGIN_COOKIES.includes(c.name) && c.value);
  }

  setFromResponse(url, setCookieHeaders, nowMs = Date.now()) {
    const host = new URL(url).hostname.toLowerCase();
    for (const h of setCookieHeaders || []) {
      const c = parseSetCookie(h, host, nowMs);
      if (!c) continue;
      const k = CookieJar.key(c);
      if (c.expires >= 0 && c.expires <= nowMs / 1000) this.map.delete(k);
      else this.map.set(k, c);
    }
  }
}

export class MtopClient {
  constructor({ jar, origin = H5_ORIGIN, userAgent, timeoutMs = 20_000, fetchImpl = globalThis.fetch }) {
    this.jar = jar;
    this.origin = origin.replace(/\/+$/, '');
    this.userAgent = userAgent || jar.userAgent || DEFAULT_UA;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = (...a) => fetchImpl(...a);
  }

  /** 调一次 mtop 接口；令牌为空/过期时用服务器下发的新令牌自动重试 */
  async call(api, data, { v = '1.0', referer = `${SITE}/` } = {}) {
    const dataStr = JSON.stringify(data);
    let last = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const token = (this.jar.get('_m_h5_tk', this.origin) || '').split('_')[0];
      const t = String(Date.now());
      const qs = new URLSearchParams({
        jsv: '2.7.2',
        appKey: APP_KEY,
        t,
        sign: mtopSign(token, t, APP_KEY, dataStr),
        v,
        type: 'originaljson',
        accountSite: 'xianyu',
        dataType: 'json',
        timeout: '20000',
        api,
        sessionOption: 'AutoLoginOnly',
      });
      const url = `${this.origin}/h5/${api}/${v}/?${qs}`;
      const headers = {
        accept: 'application/json',
        'accept-language': 'zh-CN,zh;q=0.9',
        'content-type': 'application/x-www-form-urlencoded',
        origin: SITE,
        referer,
        'user-agent': this.userAgent,
      };
      const cookie = this.jar.header(url);
      if (cookie) headers.cookie = cookie;

      let res;
      try {
        res = await this.fetchImpl(url, { method: 'POST', headers, body: `data=${encodeURIComponent(dataStr)}`, signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (e) {
        return { kind: 'error', ret: `网络错误：${e.cause?.code || e.name || e.message}` };
      }
      this.jar.setFromResponse(url, res.headers.getSetCookie?.() ?? []);
      const json = parseJsonLoose(await res.text());
      if (!json) {
        // 风控有时直接回 403/429 或一个验证页 HTML
        return { kind: [403, 429].includes(res.status) ? 'risk' : 'error', ret: `HTTP ${res.status}，返回的不是 JSON` };
      }
      const c = classifyRet(json);
      if (c.kind === 'token') {
        last = c;
        continue;
      }
      const punish = c.kind === 'risk' && json?.data?.url ? `（验证页：${json.data.url}）` : '';
      return { kind: c.kind, ret: `${c.ret}${punish}`, json };
    }
    return { kind: 'error', ret: `令牌刷新失败：${last?.ret ?? ''}` };
  }
}

const SORTS = {
  default: { sortField: '', sortValue: '' },
  newest: { sortField: 'create', sortValue: 'desc' },
  priceAsc: { sortField: 'price', sortValue: 'asc' },
};
export const SORT_NAMES = Object.keys(SORTS);

/** 与网页版搜索页发出的请求参数一致；task.searchParams 可以覆盖任意字段 */
export function searchPayload(task, pageNumber) {
  const sort = SORTS[task.sort] ?? SORTS.default;
  return {
    pageNumber,
    keyword: task.keyword,
    fromFilter: false,
    rowsPerPage: 30,
    sortValue: sort.sortValue,
    sortField: sort.sortField,
    customDistance: '',
    gps: '',
    propValueStr: {},
    customGps: '',
    searchReqFromPage: 'pcSearch',
    extraFilterValue: '{}',
    userPositionJson: '{}',
    ...(task.searchParams || {}),
  };
}

function dumpJson(debugDir, tag, payload) {
  if (!debugDir) return;
  fs.mkdirSync(debugDir, { recursive: true });
  const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-http-${tag.replace(/[^\w一-龥-]+/g, '_')}.json`;
  fs.writeFileSync(path.join(debugDir, name), JSON.stringify(payload, null, 2));
}

export async function httpFetchSearch(client, task, opts = {}) {
  const api = opts.apis?.search;
  const items = [];
  for (let p = 1; p <= (task.pages || 1); p++) {
    if (p > 1) await sleep(opts.pageDelayMs ?? randInt(1_500, 4_000));
    const res = await client.call(api, searchPayload(task, p), { referer: searchUrl(task.keyword) });
    dumpJson(opts.debugDir, `${task.name}-p${p}`, res);
    if (res.kind !== 'ok') {
      if (p === 1 || res.kind === 'risk' || res.kind === 'login') return res;
      break; // 后面的页失败时保留已拿到的数据
    }
    const pageItems = parseSearch(res.json);
    items.push(...pageItems);
    if (!pageItems.length) break;
  }
  return { kind: 'ok', items: [...new Map(items.map((it) => [it.itemId, it])).values()] };
}

export async function httpFetchItem(client, task, opts = {}) {
  if (!task.itemId) return { kind: 'needBrowser', ret: '短链没有商品 ID，HTTP 模式无法直接请求' };
  const res = await client.call(opts.apis?.detail, { itemId: task.itemId }, { referer: itemUrl(task.itemId) });
  dumpJson(opts.debugDir, task.name, res);
  if (res.kind !== 'ok') return res;
  const item = parseDetail(res.json, task.itemId);
  if (!item) return { kind: 'error', ret: '详情接口里没有找到商品，可能是接口字段变了（用 --debug 查看原始数据）' };
  return { kind: 'ok', items: [item] };
}
