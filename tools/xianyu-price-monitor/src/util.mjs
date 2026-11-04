export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function randInt(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

/** 在基准值上加 ±ratio 的随机抖动，避免每次都在整点、固定间隔访问 */
export function jitter(ms, ratio = 0.2) {
  return Math.round(ms * (1 - ratio + Math.random() * 2 * ratio));
}

/** 安全取深层字段：get(obj, ['a', 'b', 0, 'c']) */
export function get(obj, path, fallback = undefined) {
  let cur = obj;
  for (const key of path) {
    if (cur == null || typeof cur !== 'object') return fallback;
    cur = cur[key];
  }
  return cur === undefined ? fallback : cur;
}

export function toInt(v) {
  if (v == null || v === '') return null;
  const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

export function fmtPrice(v) {
  if (v == null || !Number.isFinite(v)) return '价格未知';
  return `¥${v.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;
}

export function truncate(s, n) {
  const str = String(s ?? '').replace(/\s+/g, ' ').trim();
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

export function timestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 解析 "08:00-23:30"（支持跨午夜，如 "22:00-02:00"），返回 [起始分钟, 结束分钟]；空串返回 null 表示全天。
 */
export function parseActiveHours(spec) {
  if (!spec) return null;
  const m = String(spec).trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) throw new Error(`activeHours 格式应为 "HH:MM-HH:MM"，实际为 "${spec}"`);
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  if (start > 1440 || end > 1440) throw new Error(`activeHours 时间超出范围："${spec}"`);
  return [start, end];
}

export function inActiveHours(range, d = new Date()) {
  if (!range) return true;
  const [start, end] = range;
  const now = d.getHours() * 60 + d.getMinutes();
  return start <= end ? now >= start && now < end : now >= start || now < end;
}
