// 一轮监控：逐个任务抓取 → 过滤 → 对比上一轮 → 推送 → 落盘。

import path from 'node:path';
import { fetchItem, fetchSearch } from './goofish.mjs';
import { buildAlertMessage, buildSystemMessage, notifyAll } from './notify.mjs';
import { ITEM_GONE_RE } from './parse.mjs';
import { evaluate, filterItems } from './rules.mjs';
import { fmtPrice, randInt, sleep, timestamp } from './util.mjs';

const FAILURE_NOTIFY_THRESHOLD = 3;

const BLOCK_TEXT = {
  risk: '闲鱼触发了风控验证（滑块 / "被挤爆啦"）。已暂停监控，冷却后自动重试。\n如果一直出现：把 browser.headless 设为 false，在弹出的窗口里手动完成验证，并适当调大 intervalMinutes。',
  login: '闲鱼登录已失效。请在监控目录运行 npm run login 重新扫码登录。',
};

/**
 * @param {object} p
 * @param {object} p.config      normalizeConfig 的结果
 * @param {object[]} p.tasks     本轮要跑的任务
 * @param {import('./store.mjs').Store} p.store
 * @param {() => Promise<import('playwright').BrowserContext>} p.getContext
 * @returns {Promise<{blocked: null|'risk'|'login', results: object[]}>}
 */
export async function runTasks({ config, tasks, store, getContext, log = console.log, debug = false, now = () => new Date() }) {
  const state = store.load();
  const results = [];
  let blocked = null;
  const fetchOpts = {
    apis: config.apis,
    timeoutMs: config.captureTimeoutMs,
    debugDir: debug ? path.join(config.dataDir, 'debug') : null,
  };
  const [minDelay, maxDelay] = config.taskDelaySeconds;

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    if (i > 0) await sleep(randInt(minDelay * 1000, maxDelay * 1000));

    let res;
    try {
      const context = await getContext();
      res = task.type === 'search' ? await fetchSearch(context, task, fetchOpts) : await fetchItem(context, task, fetchOpts);
    } catch (e) {
      res = { kind: 'error', ret: e.message.split('\n')[0] };
    }

    const ts = (state.tasks[task.name] ??= {});
    const runAt = now();
    ts.lastRun = runAt.toISOString();

    if (res.kind !== 'ok' && task.type === 'item' && ITEM_GONE_RE.test(res.ret || '')) {
      const prevTitle = ts.items?.[task.itemId]?.title ?? '';
      res = { kind: 'ok', items: [{ itemId: task.itemId, title: prevTitle, price: null, status: 'offline', url: task.url, tags: [] }] };
    }

    if (res.kind === 'ok') {
      ts.failures = 0;
      delete state.system.riskNotifiedAt; // 恢复正常后，下次再出问题要立刻通知
      delete state.system.loginNotifiedAt;
      const { kept, dropped } = filterItems(res.items, task);
      const prevItems = ts.items || {};
      const { alerts, state: nextState, lowestItem } = evaluate(task, kept, ts, runAt);
      Object.assign(ts, nextState, { lastOk: runAt.toISOString() });

      store.appendHistory(
        kept
          .filter((it) => !prevItems[it.itemId] || prevItems[it.itemId].price !== it.price || prevItems[it.itemId].status !== it.status)
          .map((it) => ({ time: timestamp(runAt), task: task.name, ...it })),
      );
      store.save(state);

      const summary =
        task.type === 'search'
          ? `${res.items.length} 条结果，过滤后 ${kept.length} 条，最低 ${lowestItem ? fmtPrice(lowestItem.price) : '-'}`
          : `${kept[0]?.title ? `${kept[0].title.slice(0, 30)} ` : ''}${fmtPrice(kept[0]?.price)}（${kept[0]?.status ?? '-'}）`;
      log(`[${timestamp(runAt)}] ${task.name}：${summary}，提醒 ${alerts.length} 条`);
      if (debug && dropped.length) {
        for (const d of dropped.slice(0, 20)) log(`    过滤 ${fmtPrice(d.price)} ${d.title.slice(0, 30)} ← ${d.dropReason}`);
      }
      if (alerts.length) await notifyAll(config.notify, buildAlertMessage(task, alerts), log);
      results.push({ task: task.name, kind: 'ok', count: kept.length, alerts });
      continue;
    }

    log(`[${timestamp(runAt)}] ${task.name}：失败（${res.kind}）${res.ret ?? ''}`);
    results.push({ task: task.name, kind: res.kind, ret: res.ret });

    if (res.kind === 'risk' || res.kind === 'login') {
      blocked = res.kind;
      const last = state.system[`${res.kind}NotifiedAt`];
      const quietMs = config.riskCooldownMinutes * 60_000 * 3;
      if (!last || runAt.getTime() - Date.parse(last) > quietMs) {
        state.system[`${res.kind}NotifiedAt`] = runAt.toISOString();
        await notifyAll(config.notify, buildSystemMessage(res.kind === 'risk' ? '触发风控，已暂停' : '需要重新登录', `${BLOCK_TEXT[res.kind]}\n\n详情：${res.ret ?? ''}`), log);
      }
      store.save(state);
      break; // 风控/掉登录时继续请求只会更糟，本轮剩余任务全部跳过
    }

    ts.failures = (ts.failures || 0) + 1;
    if (ts.failures === FAILURE_NOTIFY_THRESHOLD) {
      await notifyAll(
        config.notify,
        buildSystemMessage(
          `任务连续失败`,
          `任务「${task.name}」已连续 ${ts.failures} 次没有拿到数据：${res.ret ?? res.kind}\n可以用 node src/cli.mjs once --task "${task.name}" --debug 排查（会在 data/debug 保存截图和原始响应）。`,
        ),
        log,
      );
    }
    store.save(state);
  }

  return { blocked, results };
}
