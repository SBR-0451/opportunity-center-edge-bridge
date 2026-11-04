// 过滤与提醒规则：纯函数，不碰网络和文件，方便单测。

import { STATUS_LABEL } from './parse.mjs';
import { fmtPrice } from './util.mjs';

const PRUNE_DAYS = 30;

function dropReason(item, task) {
  if (item.price == null) return '没有价格';
  if (task.minPrice != null && item.price < task.minPrice) return `低于 minPrice ${task.minPrice}`;
  if (task.maxPrice != null && item.price > task.maxPrice) return `高于 maxPrice ${task.maxPrice}`;
  const title = (item.title || '').toLowerCase();
  for (const word of task.include) if (!title.includes(word.toLowerCase())) return `标题缺少「${word}」`;
  for (const word of task.exclude) if (title.includes(word.toLowerCase())) return `标题含排除词「${word}」`;
  return null;
}

/** 关键词任务的结果过滤：价格区间 + 必含词 + 排除词。单品任务不过滤。 */
export function filterItems(items, task) {
  if (task.type !== 'search') return { kept: items, dropped: [] };
  const kept = [];
  const dropped = [];
  for (const item of items) {
    const reason = dropReason(item, task);
    if (reason) dropped.push({ ...item, dropReason: reason });
    else kept.push(item);
  }
  return { kept, dropped };
}

/**
 * 根据本轮结果和上一轮状态计算提醒。
 *
 * 提醒类型（task.alert）：
 *  targetPrice  价格 ≤ 目标价。同一商品只在"首次达到"或"比上次提醒更低"时再提醒；涨回目标价以上后重新计数。
 *  dropPercent / dropAmount  同一商品较参考价下跌达到阈值。参考价 = 上次降价提醒后出现过的最高价，
 *               所以连续小幅降价也会累计触发。
 *  newListing   （关键词任务）出现通过过滤的新商品。首轮只建立基线，不提醒。
 *  newLow       （关键词任务）过滤后的最低价低于历史最低。
 *  statusChange （单品任务）在售 → 已售出 / 下架，或重新上架。
 */
export function evaluate(task, items, prev = {}, now = new Date()) {
  const nowIso = now.toISOString();
  const alert = task.alert || {};
  const prevItems = prev.items || {};
  const initialized = Boolean(prev.initialized);
  const next = { ...prev, initialized: true, lowest: prev.lowest ?? null, items: { ...prevItems } };
  const alerts = [];
  const byId = new Map();

  for (const item of items) {
    const old = prevItems[item.itemId];
    const reasons = [];
    const rec = {
      title: item.title || old?.title || '',
      price: item.price,
      status: item.status,
      firstSeen: old?.firstSeen ?? nowIso,
      lastSeen: nowIso,
      minPrice: item.price == null ? old?.minPrice ?? null : Math.min(item.price, old?.minPrice ?? Infinity),
      refPrice: old?.refPrice ?? null,
      lastAlertPrice: old?.lastAlertPrice ?? null,
    };

    if (task.type === 'search' && !old && initialized && alert.newListing) reasons.push('新上架');

    if (task.type === 'item' && alert.statusChange && old?.status && old.status !== item.status) {
      reasons.push(`状态变化：${STATUS_LABEL[old.status] ?? old.status} → ${STATUS_LABEL[item.status] ?? item.status}`);
    }

    if (item.price != null && item.status === 'onsale') {
      if (alert.targetPrice != null) {
        if (item.price <= alert.targetPrice) {
          if (rec.lastAlertPrice == null || item.price < rec.lastAlertPrice) {
            reasons.push(`≤ 目标价 ${fmtPrice(alert.targetPrice)}`);
            rec.lastAlertPrice = item.price;
          }
        } else {
          rec.lastAlertPrice = null;
        }
      }

      if (rec.refPrice == null || item.price > rec.refPrice) {
        rec.refPrice = item.price;
      } else if (item.price < rec.refPrice) {
        const diff = rec.refPrice - item.price;
        const pct = (diff / rec.refPrice) * 100;
        const hitPct = alert.dropPercent != null && pct >= alert.dropPercent;
        const hitAmount = alert.dropAmount != null && diff >= alert.dropAmount;
        if (hitPct || hitAmount) {
          reasons.push(`降价 ${fmtPrice(rec.refPrice)} → ${fmtPrice(item.price)}（↓${pct.toFixed(1)}%）`);
          rec.refPrice = item.price;
        }
      }
    }

    next.items[item.itemId] = rec;
    if (reasons.length) {
      const entry = { item, prevPrice: old?.price ?? null, reasons };
      alerts.push(entry);
      byId.set(item.itemId, entry);
    }
  }

  let lowestItem = null;
  for (const item of items) {
    if (item.price != null && item.status === 'onsale' && (!lowestItem || item.price < lowestItem.price)) lowestItem = item;
  }
  if (task.type === 'search' && lowestItem) {
    if (alert.newLow && initialized && prev.lowest != null && lowestItem.price < prev.lowest) {
      const reason = `创历史新低（此前最低 ${fmtPrice(prev.lowest)}）`;
      const entry = byId.get(lowestItem.itemId);
      if (entry) entry.reasons.push(reason);
      else alerts.push({ item: lowestItem, prevPrice: prevItems[lowestItem.itemId]?.price ?? null, reasons: [reason] });
    }
    next.lowest = prev.lowest == null ? lowestItem.price : Math.min(prev.lowest, lowestItem.price);
  }

  if (task.type === 'search') {
    const cutoff = now.getTime() - PRUNE_DAYS * 86400_000;
    for (const [id, rec] of Object.entries(next.items)) {
      if (Date.parse(rec.lastSeen) < cutoff) delete next.items[id];
    }
  }

  return { alerts, state: next, lowestItem };
}
