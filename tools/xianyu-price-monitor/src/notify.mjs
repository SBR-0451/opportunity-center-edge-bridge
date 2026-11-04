// 推送渠道。每个渠道只是一次 HTTP POST，不依赖第三方 SDK。

import crypto from 'node:crypto';
import { fmtPrice, truncate } from './util.mjs';

const MAX_ITEMS_PER_MESSAGE = 10;

export function buildAlertMessage(task, alerts) {
  const shown = alerts.slice(0, MAX_ITEMS_PER_MESSAGE);
  const blocks = shown.map(({ item, reasons }, i) => {
    const meta = [
      item.area,
      item.seller && `卖家 ${item.seller}`,
      item.wantCount != null && `${item.wantCount}人想要`,
      ...(item.tags || []),
    ].filter(Boolean);
    return [
      `${i + 1}. ${fmtPrice(item.price)}  ${truncate(item.title || item.itemId, 60)}`,
      `   ${reasons.join('；')}`,
      meta.length ? `   ${meta.join(' · ')}` : null,
      `   ${item.url}`,
    ]
      .filter(Boolean)
      .join('\n');
  });
  if (alerts.length > shown.length) blocks.push(`…另有 ${alerts.length - shown.length} 条，见 data/history.csv`);
  return {
    kind: 'alert',
    title: `闲鱼监控｜${task.name}｜${alerts.length} 条提醒`,
    text: blocks.join('\n\n'),
    url: shown[0]?.item.url,
    task: task.name,
    alerts: alerts.map(({ item, prevPrice, reasons }) => ({ ...item, prevPrice, reasons })),
  };
}

export function buildSystemMessage(title, text) {
  return { kind: 'system', title: `闲鱼监控｜${title}`, text, alerts: [] };
}

async function post(url, body, { form = false, headers = {} } = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json', ...headers },
    body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应 */
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${truncate(text, 200)}`);
  return json ?? text;
}

function need(ch, ...keys) {
  for (const k of keys) if (!ch[k]) throw new Error(`缺少字段 ${k}`);
}

function expect(cond, body) {
  if (!cond) throw new Error(`接口返回失败：${truncate(JSON.stringify(body), 200)}`);
}

const hmacBase64 = (key, msg) => crypto.createHmac('sha256', key).update(msg).digest('base64');

const fullText = (msg) => `${msg.title}\n\n${msg.text}`;

export const SENDERS = {
  console: async (_ch, msg, log) => {
    log(`\n==== ${msg.title} ====\n${msg.text}\n`);
  },

  // Bark（iOS）：{ "type": "bark", "key": "设备key", "server": "https://api.day.app" }
  bark: async (ch, msg) => {
    need(ch, 'key');
    const server = (ch.server || 'https://api.day.app').replace(/\/+$/, '');
    const body = await post(`${server}/${ch.key}`, { title: msg.title, body: msg.text, group: ch.group || '闲鱼监控', url: msg.url });
    expect(body?.code === 200, body);
  },

  // Server酱（微信）：{ "type": "serverchan", "sendkey": "SCT..." }，同时支持 Server酱³ 的 sctp 开头 key
  serverchan: async (ch, msg) => {
    need(ch, 'sendkey');
    const sc3 = String(ch.sendkey).match(/^sctp(\d+)t/i);
    const url = sc3 ? `https://${sc3[1]}.push.ft07.com/send/${ch.sendkey}.send` : `https://sctapi.ftqq.com/${ch.sendkey}.send`;
    const body = await post(url, { title: truncate(msg.title, 32), desp: msg.text.replace(/\n/g, '\n\n') }, { form: true });
    expect(body?.code === 0, body);
  },

  // PushPlus（微信）：{ "type": "pushplus", "token": "..." }
  pushplus: async (ch, msg) => {
    need(ch, 'token');
    const body = await post('https://www.pushplus.plus/send', { token: ch.token, title: msg.title, content: msg.text, template: 'txt' });
    expect(body?.code === 200, body);
  },

  // 企业微信群机器人：{ "type": "wecom", "webhook": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..." }
  wecom: async (ch, msg) => {
    need(ch, 'webhook');
    const body = await post(ch.webhook, { msgtype: 'text', text: { content: fullText(msg) } });
    expect(body?.errcode === 0, body);
  },

  // 钉钉群机器人：{ "type": "dingtalk", "webhook": "...", "secret": "SEC...（加签时填）" }
  // 如果用"自定义关键词"安全设置，关键词填「闲鱼」即可（所有消息标题都含这两个字）。
  dingtalk: async (ch, msg) => {
    need(ch, 'webhook');
    let url = ch.webhook;
    if (ch.secret) {
      const ts = Date.now();
      const sign = encodeURIComponent(hmacBase64(ch.secret, `${ts}\n${ch.secret}`));
      url += `${url.includes('?') ? '&' : '?'}timestamp=${ts}&sign=${sign}`;
    }
    const body = await post(url, { msgtype: 'text', text: { content: fullText(msg) } });
    expect(body?.errcode === 0, body);
  },

  // 飞书群机器人：{ "type": "feishu", "webhook": "https://open.feishu.cn/open-apis/bot/v2/hook/...", "secret": "（签名校验时填）" }
  feishu: async (ch, msg) => {
    need(ch, 'webhook');
    const payload = { msg_type: 'text', content: { text: fullText(msg) } };
    if (ch.secret) {
      const ts = Math.floor(Date.now() / 1000);
      Object.assign(payload, { timestamp: String(ts), sign: hmacBase64(`${ts}\n${ch.secret}`, '') });
    }
    const body = await post(ch.webhook, payload);
    expect(body?.code === 0 || body?.StatusCode === 0, body);
  },

  // Telegram：{ "type": "telegram", "botToken": "...", "chatId": "..." }
  telegram: async (ch, msg) => {
    need(ch, 'botToken', 'chatId');
    const body = await post(`https://api.telegram.org/bot${ch.botToken}/sendMessage`, {
      chat_id: ch.chatId,
      text: fullText(msg),
      disable_web_page_preview: true,
    });
    expect(body?.ok === true, body);
  },

  // 通用 Webhook：把结构化 JSON POST 到任意地址（自建服务、Home Assistant、n8n 等）
  webhook: async (ch, msg) => {
    need(ch, 'url');
    await post(ch.url, { source: 'xianyu-price-monitor', time: new Date().toISOString(), ...msg }, { headers: ch.headers || {} });
  },
};

export async function notifyAll(channels, msg, log = console.log) {
  let ok = 0;
  for (const ch of channels) {
    const sender = SENDERS[ch.type];
    if (!sender) {
      log(`[通知] 未知渠道类型 "${ch.type}"，可用：${Object.keys(SENDERS).join(', ')}`);
      continue;
    }
    try {
      await sender(ch, msg, log);
      ok += 1;
    } catch (e) {
      log(`[通知] ${ch.name || ch.type} 发送失败：${e.message}`);
    }
  }
  return ok;
}
