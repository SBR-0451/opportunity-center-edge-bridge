// 把闲鱼网页版接口（mtop）返回的 JSON 归一化成统一的商品结构。
// 所有字段路径都集中在这个文件：闲鱼改版导致解析失败时，用 `--debug` 导出原始 JSON 对照修改这里即可。

import { get, toInt } from './util.mjs';

export const SITE = 'https://www.goofish.com';

/** 出现任意一个就说明已登录 */
export const LOGIN_COOKIES = ['unb', 'tracknick', '_nk_'];

export function itemUrl(itemId) {
  return `${SITE}/item?id=${itemId}`;
}

export function searchUrl(keyword) {
  return `${SITE}/search?q=${encodeURIComponent(keyword)}`;
}

/** 从商品链接里取出数字 ID；短链（m.tb.cn）取不到时返回 null，此时直接打开短链即可 */
export function extractItemId(url) {
  const m = String(url ?? '').match(/[?&](?:id|itemId)=(\d+)/);
  return m ? m[1] : null;
}

/** 解析 JSON，兼容 JSONP 包裹：mtopjsonp1({...}) */
export function parseJsonLoose(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    const m = t.match(/^[\w$.]+\(([\s\S]*)\)\s*;?$/);
    if (!m) return null;
    try {
      return JSON.parse(m[1]);
    } catch {
      return null;
    }
  }
}

/**
 * mtop 响应的 ret 字段分类：
 *  ok    成功
 *  token 令牌为空/过期，页面自己会换 token 重试，继续等待即可
 *  login 未登录或登录过期
 *  risk  触发风控（滑块验证 / "被挤爆啦"），必须停下来由人处理
 *  error 其他业务错误
 */
export function classifyRet(json) {
  const ret = Array.isArray(json?.ret) ? json.ret.join(' | ') : String(json?.ret ?? '');
  if (/SUCCESS/i.test(ret)) return { kind: 'ok', ret };
  if (/FAIL_SYS_TOKEN_(EMPTY|EXOIRED|EXPIRED|ILLEGAL)/i.test(ret)) return { kind: 'token', ret };
  if (/USER_VALIDATE|RGV587|挤爆|滑块|验证码|PUNISH/i.test(ret)) return { kind: 'risk', ret };
  if (/SESSION_EXPIRED|NOT_LOGIN|LOGIN_REQUIRED|FAIL_SYS_LOGIN|请登录|未登录/i.test(ret)) return { kind: 'login', ret };
  return { kind: 'error', ret };
}

/**
 * 价格解析，兼容：数字、"¥1,299"、"1.2万"、"当前价¥88"、[{text:'¥'},{text:'4299'},{text:'.50'}]
 */
export function parsePrice(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (Array.isArray(raw)) {
    return parsePrice(raw.map((p) => (p && typeof p === 'object' ? p.text ?? p.value ?? '' : p)).join(''));
  }
  if (typeof raw === 'object') return parsePrice(raw.text ?? raw.value ?? raw.price ?? null);
  const s = String(raw).replace(/当前价|到手价|券后价?|[¥￥,，\s]/g, '');
  const m = s.match(/(\d+(?:\.\d+)?)(万)?/);
  if (!m) return null;
  let v = parseFloat(m[1]);
  if (m[2]) v *= 10000;
  return Math.round(v * 100) / 100;
}

function msToIso(v) {
  const n = toInt(v);
  if (!n || n < 1e11) return null; // 只接受毫秒时间戳
  return new Date(n).toISOString();
}

function collectTags(ex, args) {
  const tags = new Set();
  if (args.tag === 'freeship') tags.add('包邮');
  const fishTags = ex.fishTags && typeof ex.fishTags === 'object' ? ex.fishTags : {};
  for (const group of Object.values(fishTags)) {
    for (const tag of get(group, ['tagList'], []) || []) {
      const content = get(tag, ['data', 'content']);
      if (typeof content === 'string' && content.trim() && content.length <= 12) tags.add(content.trim());
    }
  }
  return [...tags].slice(0, 6);
}

/** 搜索接口 mtop.taobao.idlemtopsearch.pc.search → 商品列表 */
export function parseSearch(json) {
  const list = get(json, ['data', 'resultList'], []);
  const items = [];
  for (const row of Array.isArray(list) ? list : []) {
    const main = get(row, ['data', 'item', 'main'], {}) || {};
    const ex = main.exContent || {};
    const args = get(main, ['clickParam', 'args'], {}) || {};
    const itemId = String(ex.itemId ?? args.item_id ?? args.id ?? '').trim();
    if (!/^\d+$/.test(itemId)) continue; // 广告位、推荐卡片等不是商品
    items.push({
      itemId,
      title: String(ex.title ?? get(ex, ['detailParams', 'title']) ?? '').trim(),
      price: parsePrice(ex.price) ?? parsePrice(args.price),
      originalPrice: parsePrice(ex.oriPrice),
      area: String(ex.area ?? ''),
      seller: String(ex.userNickName ?? ''),
      wantCount: toInt(args.wantNum),
      publishTime: msToIso(args.publishTime),
      tags: collectTags(ex, args),
      picUrl: String(ex.picUrl ?? ''),
      url: itemUrl(itemId),
      status: 'onsale',
    });
  }
  return items;
}

export const STATUS_LABEL = { onsale: '在售', sold: '已售出', offline: '已下架/不可购买' };

function detailStatus(it) {
  const text = [it.itemStatusStr, it.itemStatusText, it.statusText, it.itemStatusDesc].filter(Boolean).join(' ');
  if (/已售|卖掉|售出|交易成功/.test(text)) return 'sold';
  if (/下架|删除|失效|不存在|已关闭/.test(text)) return 'offline';
  // itemStatus: 0 = 在售；其他值为售出/下架等不可购买状态
  if (it.itemStatus != null && it.itemStatus !== '' && Number(it.itemStatus) !== 0) return 'offline';
  return 'onsale';
}

/** 详情接口 mtop.taobao.idle.pc.detail → 单个商品 */
export function parseDetail(json, fallbackId = null) {
  const data = json?.data || {};
  const it = data.itemDO || data.item || {};
  const seller = data.sellerDO || data.seller || {};
  const itemId = String(it.itemId ?? it.id ?? fallbackId ?? '').trim();
  if (!itemId) return null;
  return {
    itemId,
    title: String(it.title ?? '').trim(),
    price: parsePrice(it.soldPrice) ?? parsePrice(it.price) ?? parsePrice(it.priceText) ?? parsePrice(it.minPrice),
    originalPrice: parsePrice(it.originalPrice),
    area: String(seller.publishCity ?? seller.city ?? it.area ?? ''),
    seller: String(seller.nick ?? seller.userNick ?? ''),
    wantCount: toInt(it.wantCnt),
    browseCount: toInt(it.browseCnt),
    tags: [],
    url: itemUrl(itemId),
    status: detailStatus(it),
  };
}

/** 详情接口返回这些错误时，说明商品已经没了，按"已下架"处理而不是当作抓取失败 */
export const ITEM_GONE_RE = /NOT_EXIST|ITEM_DELETED|不存在|已删除|已下架|宝贝不见了/i;
