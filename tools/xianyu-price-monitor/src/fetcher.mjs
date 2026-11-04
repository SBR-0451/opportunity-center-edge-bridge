// 选择取数方式：
//   http     只用 HTTP 直连（最省资源，服务器上不需要浏览器）
//   browser  只用浏览器（最接近真人访问，但最占资源）
//   auto     默认先走 HTTP；被风控或登录失效拦下时，用浏览器重试这一个任务，
//            成功后把浏览器里的新 Cookie 同步给 HTTP。如果原因是风控，
//            冷却期内（riskCooldownMinutes）直接用浏览器，不再拿 HTTP 去撞。

import { fetchItem as browserFetchItem, fetchSearch as browserFetchSearch } from './goofish.mjs';
import { CookieJar, MtopClient, httpFetchItem, httpFetchSearch } from './mtop.mjs';

const FALLBACK_KINDS = new Set(['risk', 'login', 'needBrowser']);

/**
 * @param {object} p
 * @param {object} p.config                      normalizeConfig 的结果
 * @param {() => Promise<object>} [p.getContext] 按需启动浏览器（只有用到浏览器时才会调用）
 * @param {(task) => Promise<object>} [p.httpFetch]    测试注入
 * @param {(task) => Promise<object>} [p.browserFetch] 测试注入
 */
export function createFetcher({ config, getContext, log = console.log, debugDir = null, now = () => Date.now(), httpFetch, browserFetch }) {
  const opts = { apis: config.apis, timeoutMs: config.captureTimeoutMs, debugDir };
  let jar = null;
  let client = null;

  const loadClient = () => {
    if (!client) {
      jar = CookieJar.load(config.sessionFile);
      client = new MtopClient({ jar, userAgent: config.userAgent, origin: config.mtopOrigin, timeoutMs: config.captureTimeoutMs });
    }
    return client;
  };

  const viaHttp =
    httpFetch ??
    (async (task) => {
      const c = loadClient();
      if (!jar.hasLogin()) return { kind: 'login', ret: `${config.sessionFile} 里没有登录信息，请先运行 npm run login` };
      try {
        return task.type === 'search' ? await httpFetchSearch(c, task, opts) : await httpFetchItem(c, task, opts);
      } finally {
        jar.save(config.sessionFile); // 保存服务器下发的新令牌
      }
    });

  const viaBrowser =
    browserFetch ??
    (async (task) => {
      const ctx = await getContext();
      return task.type === 'search' ? browserFetchSearch(ctx, task, opts) : browserFetchItem(ctx, task, opts);
    });

  /** 浏览器拿到数据后，把它的 Cookie（含刷新后的登录态、验证通过后的凭证）写回 HTTP 用的会话文件 */
  async function syncCookiesFromBrowser() {
    if (browserFetch || !getContext) return;
    try {
      const state = await (await getContext()).storageState();
      const userAgent = (jar ?? CookieJar.load(config.sessionFile)).userAgent; // 保留登录时记录的真实 UA
      new CookieJar(state.cookies, { userAgent }).save(config.sessionFile);
      jar = null;
      client = null;
    } catch (e) {
      log(`    同步浏览器 Cookie 失败：${e.message}`);
    }
  }

  return {
    async fetch(task, system = {}) {
      const mode = config.mode;
      const httpPaused = mode === 'auto' && system.httpPausedUntil && Date.parse(system.httpPausedUntil) > now();
      if (mode === 'browser' || httpPaused) return { ...(await viaBrowser(task)), via: 'browser' };

      const res = await viaHttp(task);
      if (mode === 'http' || !FALLBACK_KINDS.has(res.kind)) return { ...res, via: 'http' };

      log(`    HTTP 未通过（${res.kind}：${res.ret}），改用浏览器重试`);
      const b = { ...(await viaBrowser(task)), via: 'browser' };
      if (b.kind === 'ok') {
        await syncCookiesFromBrowser();
        if (res.kind === 'risk') {
          system.httpPausedUntil = new Date(now() + config.riskCooldownMinutes * 60_000).toISOString();
          log(`    浏览器取数成功；${config.riskCooldownMinutes} 分钟内先用浏览器，之后再试 HTTP`);
        }
      }
      return b;
    },
  };
}
