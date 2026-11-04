#!/usr/bin/env node
// 用法：
//   node src/cli.mjs login                     打开浏览器扫码登录闲鱼（只需一次，掉线后再跑）
//   node src/cli.mjs once [--task 名称] [--debug] 立即跑一轮（适合配合系统定时任务）
//   node src/cli.mjs watch                     常驻运行，按间隔自动监控
//   node src/cli.mjs test-notify               给所有推送渠道发一条测试消息
//   node src/cli.mjs import-state <文件>        导入另一台机器 login 生成的 storage-state.json
// 通用参数：--config <路径>（默认 ./config.json）  --headless / --headed（覆盖配置）

import path from 'node:path';
import { loadConfig } from './config.mjs';
import { importState, interactiveLogin, launchContext } from './goofish.mjs';
import { buildSystemMessage, notifyAll } from './notify.mjs';
import { runTasks } from './runner.mjs';
import { Store } from './store.mjs';
import { inActiveHours, jitter, sleep, timestamp } from './util.mjs';

const CONTEXT_MAX_AGE_MS = 6 * 3600_000; // 常驻模式下每 6 小时重启一次浏览器，防止内存越涨越高

function parseArgs(argv) {
  const args = { _: [], config: 'config.json', task: [], debug: false, headless: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') args.config = argv[++i];
    else if (a === '--task') args.task.push(argv[++i]);
    else if (a === '--debug') args.debug = true;
    else if (a === '--headless') args.headless = true;
    else if (a === '--headed') args.headless = false;
    else if (a === '-h' || a === '--help') args._.unshift('help');
    else args._.push(a);
  }
  return args;
}

function contextProvider(config) {
  let ctx = null;
  let startedAt = 0;
  const close = async () => {
    const c = ctx;
    ctx = null;
    if (c) await c.close().catch(() => {});
  };
  return {
    async get() {
      if (ctx && Date.now() - startedAt > CONTEXT_MAX_AGE_MS) await close();
      if (!ctx) {
        ctx = await launchContext({ profileDir: config.profileDir, ...config.browser });
        startedAt = Date.now();
        const mine = ctx;
        mine.on('close', () => {
          if (ctx === mine) ctx = null; // 用户手动关掉窗口时，下一轮自动重开
        });
      }
      return ctx;
    },
    close,
  };
}

function selectTasks(config, names) {
  const enabled = config.tasks.filter((t) => t.enabled);
  if (!names.length) return enabled;
  const picked = config.tasks.filter((t) => names.includes(t.name));
  const unknown = names.filter((n) => !config.tasks.some((t) => t.name === n));
  if (unknown.length) throw new Error(`找不到任务：${unknown.join('、')}`);
  return picked;
}

async function cmdOnce(config, args) {
  const tasks = selectTasks(config, args.task);
  if (!tasks.length) return console.log('没有启用的任务。');
  const ctx = contextProvider(config);
  try {
    const { blocked } = await runTasks({ config, tasks, store: new Store(config.dataDir), getContext: ctx.get, debug: args.debug });
    if (blocked) process.exitCode = 2;
  } finally {
    await ctx.close();
  }
}

async function cmdWatch(config, args) {
  const tasks = selectTasks(config, args.task);
  if (!tasks.length) return console.log('没有启用的任务。');
  const store = new Store(config.dataDir);
  const ctx = contextProvider(config);
  const nextDue = new Map(tasks.map((t) => [t.name, 0]));
  let cooldownUntil = 0;
  let stopping = false;
  const stop = async () => {
    if (stopping) process.exit(130);
    stopping = true;
    console.log('\n正在退出…（再按一次 Ctrl+C 强制退出）');
    await ctx.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  console.log(`开始监控 ${tasks.length} 个任务，默认间隔 ${config.intervalMinutes} 分钟。Ctrl+C 退出。`);
  while (!stopping) {
    const now = Date.now();
    if (!inActiveHours(config.activeHours)) {
      await ctx.close(); // 非活跃时段释放浏览器
      await sleep(5 * 60_000);
      continue;
    }
    if (now < cooldownUntil) {
      await sleep(Math.min(cooldownUntil - now, 5 * 60_000));
      continue;
    }
    const due = tasks.filter((t) => nextDue.get(t.name) <= now);
    if (due.length) {
      const { blocked } = await runTasks({ config, tasks: due, store, getContext: ctx.get, debug: args.debug });
      const doneAt = Date.now();
      for (const t of due) nextDue.set(t.name, doneAt + jitter((t.intervalMinutes ?? config.intervalMinutes) * 60_000));
      if (blocked) {
        cooldownUntil = doneAt + config.riskCooldownMinutes * 60_000;
        console.log(`[${timestamp()}] ${blocked === 'risk' ? '触发风控' : '登录失效'}，暂停 ${config.riskCooldownMinutes} 分钟。`);
        if (config.browser.headless) await ctx.close(); // 有界面模式保留窗口，方便手动处理验证/登录
      }
    }
    const wake = Math.min(...nextDue.values());
    await sleep(Math.max(1_000, Math.min(wake - Date.now(), 5 * 60_000)));
  }
}

async function cmdLogin(config) {
  const ok = await interactiveLogin({
    profileDir: config.profileDir,
    channel: config.browser.channel,
    executablePath: config.browser.executablePath,
    stateFile: path.join(config.dataDir, 'storage-state.json'),
  });
  if (ok) {
    console.log('登录成功，登录态已保存在 data/browser-profile。');
    console.log('（另导出了 data/storage-state.json，用于部署到服务器；它等同于你的登录凭据，不要发给别人。）');
  } else {
    console.log('没有检测到登录 Cookie。如果你确实已经登录，可以忽略；否则请重新运行 npm run login。');
  }
}

async function cmdImportState(config, args) {
  const file = args._[1];
  if (!file) throw new Error('用法：node src/cli.mjs import-state <storage-state.json 路径>');
  const r = await importState({ profileDir: config.profileDir, ...config.browser, file: path.resolve(file) });
  console.log(`已导入 ${r.count} 个 Cookie，登录状态：${r.loggedIn ? '已登录' : '未检测到登录 Cookie'}`);
}

async function cmdTestNotify(config) {
  const n = await notifyAll(
    config.notify,
    buildSystemMessage('测试消息', `这是一条测试推送，发送时间 ${timestamp()}。\n收到说明渠道配置正确。`),
  );
  console.log(`测试消息已发送：${n}/${config.notify.length} 个渠道成功。`);
  if (n < config.notify.length) process.exitCode = 1;
}

const HELP = `闲鱼价格监控
  npm run login          扫码登录（首次使用 / 登录失效时）
  npm run once           立即跑一轮
  npm start              常驻监控
  npm run test-notify    测试推送渠道
参数：--config <文件>  --task <任务名>（可重复）  --debug  --headless/--headed`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'help';
  if (cmd === 'help') return console.log(HELP);
  const config = loadConfig(args.config);
  if (args.headless != null) config.browser.headless = args.headless;
  const commands = { once: cmdOnce, watch: cmdWatch, login: cmdLogin, 'import-state': cmdImportState, 'test-notify': cmdTestNotify };
  if (!commands[cmd]) throw new Error(`未知命令 ${cmd}\n${HELP}`);
  await commands[cmd](config, args);
}

main().catch((e) => {
  console.error(`错误：${e.message}`);
  process.exit(1);
});
