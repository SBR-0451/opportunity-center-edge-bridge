# 闲鱼价格监控（xianyu-price-monitor）

在自己电脑上定时检查闲鱼上**指定商品链接**或**搜索关键词**的价格。降价、低于目标价、出现低价新品、商品售出或下架时，推送到微信、钉钉、飞书或手机。

## 方案概述

这个工具用 Playwright 驱动一个独立的浏览器（Edge 或 Chrome），登录态单独保存。它定时打开闲鱼网页版（goofish.com）的搜索页或商品页，但**不解析网页内容**：页面自己会调用闲鱼的 mtop 接口，工具只读取这些接口的 JSON 返回，然后过滤结果、和上一轮比较，命中规则就推送。

```
config.json ─► 调度（默认 15 分钟 ±20% 随机、只在活跃时段、遇到风控自动冷却）
                 │
                 ▼
  浏览器（data/browser-profile，扫码登录一次）
     打开 goofish.com/search?q=… 或 /item?id=…
     读取页面自己发出的接口响应：
       mtop.taobao.idlemtopsearch.pc.search   搜索结果
       mtop.taobao.idle.pc.detail             商品详情
                 │
                 ▼
  parse.mjs  统一成：itemId / 标题 / 价格 / 地区 / 卖家 / 想要数 / 状态
  rules.mjs  过滤（价格区间、必含词、排除词），再和上一轮比较
  store      data/state.json（上次价格、参考价、防重复提醒）
             data/history.csv（价格变化记录，Excel 可直接打开）
  notify     Server酱 / PushPlus / 企业微信 / 钉钉 / 飞书 / Bark / Telegram / 通用 Webhook
```

### 为什么用这种方式

| 做法 | 优点 | 缺点 |
| --- | --- | --- |
| 用脚本直接请求 mtop 接口（自己计算 sign） | 轻量 | 要自己维护签名、token 和 Cookie；遇到滑块验证直接失败；接口一改就不能用 |
| 解析网页 DOM | 直观 | 闲鱼的样式类名是哈希值，改版很频繁 |
| **在浏览器里读接口响应（本方案）** | 签名和令牌由页面自己处理；拿到的是结构化数据；登录态长期保存 | 需要一个浏览器，比纯脚本重一些 |
| 第三方比价或监控服务 | 不用自己部署 | 覆盖范围和及时性没保证，还要交出账号 |

## 快速开始

需要 Node.js 22 或更高版本。

```bash
cd tools/xianyu-price-monitor
npm install
cp config.example.json config.json    # Windows 用 copy；改成你要监控的商品，填好推送渠道
npm run login                          # 弹出浏览器，用闲鱼/淘宝 App 扫码，只需一次
npm run test-notify                    # 确认能收到推送
npm run once                           # 先手动跑一轮，看看输出
npm start                              # 常驻运行，按间隔自动检查
```

- **Windows**：示例配置用本机自带的 Edge（`"channel": "msedge"`），不用另外下载浏览器。
- **macOS / Linux**：把 `browser.channel` 改成 `"chrome"`（本机已装 Chrome），或者改成 `""` 后运行 `npx playwright install chromium`。国内下载慢可以先设置 `PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright`。
- 第一轮只记录当前价格作为基线，不会推送"新上架"（价格已经低于目标价的仍会推送）。

## 配置说明（config.json）

### 全局配置

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `browser.channel` | `""` | `msedge` / `chrome` 表示用本机已安装的浏览器；留空则用 Playwright 自带的 Chromium |
| `browser.headless` | `false` | 是否隐藏浏览器窗口。**建议保持 `false`**：窗口可见时不容易触发风控，出现滑块时也能直接在窗口里手动完成 |
| `intervalMinutes` | `15` | 检查间隔，实际会在 ±20% 内随机浮动；最小 5 分钟 |
| `activeHours` | 全天 | 例如 `"08:00-23:30"`，这个时段以外不检查；也支持跨午夜，如 `"22:00-02:00"` |
| `riskCooldownMinutes` | `60` | 遇到风控或登录失效后暂停多久 |
| `taskDelaySeconds` | `[5, 15]` | 相邻两个任务之间的随机等待时间 |
| `captureTimeoutSeconds` | `25` | 打开页面后等待接口数据的最长时间 |
| `dataDir` | `./data` | 登录态、状态和历史记录的保存位置 |
| `apis` | 见上文 | 闲鱼接口改名时在这里覆盖，例如 `{"search": "新接口名"}` |
| `notify` | 只输出到控制台 | 推送渠道列表，见下文 |

### 关键词任务 `"type": "search"`

| 字段 | 说明 |
| --- | --- |
| `name` | 任务名，必须唯一（用来区分各任务的监控记录） |
| `keyword` | 搜索词，相当于在闲鱼网页版搜索框里输入的内容 |
| `pages` | 抓取几页，1 到 5，默认 1。翻页靠点击页面上的按钮，找不到按钮时只取第一页 |
| `minPrice` / `maxPrice` | 价格区间。**`minPrice` 很重要**：它能过滤掉手机壳、配件和 1 元钓鱼帖，否则"历史最低价"会被这些低价帖拉低 |
| `include` | 标题必须**全部**包含的词，例如容量 `["256"]` |
| `exclude` | 标题包含**任意一个**就排除的词，例如 `["求购","回收","租","壳","配件","有锁"]` |
| `intervalMinutes` | 单独为这个任务设置检查间隔 |
| `enabled` | 设为 `false` 时暂停这个任务 |

### 单品任务 `"type": "item"`

| 字段 | 说明 |
| --- | --- |
| `itemId` 或 `url` | 商品 ID（链接里 `id=` 后面的数字），或者直接粘贴 `https://www.goofish.com/item?id=…` 形式的链接。App 分享出来的 `m.tb.cn` 短链可能会跳到手机版页面，读不到数据，建议先在电脑浏览器里打开短链，再复制地址栏里的链接 |

### 提醒规则 `alert`

| 字段 | 适用任务 | 什么时候提醒 |
| --- | --- | --- |
| `targetPrice` | 两种都适用 | 价格 ≤ 目标价。同一个商品只在首次达到目标价、或者比上次提醒时更便宜时才再提醒；价格涨回目标价以上后重新开始计算 |
| `dropPercent` | 两种都适用 | 和参考价相比跌幅 ≥ 设定的百分比。参考价是上次降价提醒之后出现过的最高价，所以连续几次小幅降价也会累计触发 |
| `dropAmount` | 两种都适用 | 和参考价相比降了 ≥ 设定的金额（元） |
| `newListing` | 关键词任务，默认开启 | 出现通过了过滤条件的新商品 |
| `newLow` | 关键词任务 | 过滤后的最低价低于历史最低价 |
| `statusChange` | 单品任务，默认开启 | 在售变成已售出或下架，或者重新上架 |

同一个商品命中多条规则时只发一条消息，消息里列出所有原因。同一个任务一次最多列 10 个商品。

### 推送渠道 `notify`

```jsonc
[
  { "type": "console" },                                                      // 输出到终端
  { "type": "serverchan", "sendkey": "${SERVERCHAN_SENDKEY}" },               // Server酱 → 微信（也支持 Server酱³ 的 sctp 开头的 key）
  { "type": "pushplus", "token": "..." },                                     // PushPlus → 微信
  { "type": "wecom", "webhook": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..." },
  { "type": "dingtalk", "webhook": "https://oapi.dingtalk.com/robot/send?access_token=...", "secret": "SEC...（选填）" },
  { "type": "feishu", "webhook": "https://open.feishu.cn/open-apis/bot/v2/hook/...", "secret": "（选填）" },
  { "type": "bark", "key": "设备 key", "server": "https://api.day.app" },     // iPhone
  { "type": "telegram", "botToken": "...", "chatId": "..." },
  { "type": "webhook", "url": "http://127.0.0.1:8080/xianyu", "headers": {} } // 把结构化 JSON 推给你自己的服务
]
```

- 配置里的 `${变量名}` 会被替换成同名环境变量的值，这样密钥不用写进文件。
- 钉钉机器人如果用"自定义关键词"作为安全设置，关键词填「闲鱼」即可，因为所有消息标题都包含这两个字。
- `webhook` 渠道推送的 JSON 里有 `alerts` 数组，每一项包含 `itemId`、`price`、`prevPrice`、`reasons`、`url` 等字段，可以接入自己的服务或其他自动化流程。

## 部署方式

- **Windows 或 Mac 常驻**：在终端里运行 `npm start`。如果想开机自启，可以用 pm2：`pm2 start src/cli.mjs --name xianyu -- watch`。
- **系统定时任务**：也可以不常驻，每次只跑一轮，交给 cron 或 Windows 任务计划程序调度。示例：
  `*/15 8-23 * * * cd /path/to/xianyu-price-monitor && node src/cli.mjs once >> data/monitor.log 2>&1`
- **没有图形界面的 Linux 服务器**：在 `config.json` 里设置 `"headless": true`。先在自己电脑上运行 `npm run login`，把生成的 `data/storage-state.json` 复制到服务器，再运行 `node src/cli.mjs import-state storage-state.json`。如果无头模式经常触发验证，可以改用 `xvfb-run npm start` 以有窗口的模式运行。
- 同一个 `data/` 目录同一时间只能有一个进程在用，因为浏览器配置目录会被锁定。

## 风控与使用边界

- **只读，频率低**：默认每 15 分钟检查一次并随机浮动，最小间隔 5 分钟；任务之间随机等 5 到 15 秒；夜间不运行。工具不会下单、聊天或发消息。
- **不绕过风控**：不自己计算签名，也不自动过滑块。检测到风控（滑块验证、"被挤爆啦"）或登录失效时，会推送一条提醒并暂停 `riskCooldownMinutes` 分钟。如果开着浏览器窗口，可以直接在窗口里手动完成验证。
- **登录态就是你的账号凭据**：`data/browser-profile` 和 `data/storage-state.json` 只保存在本机，已经写进 `.gitignore`，不要发给别人。
- 请遵守闲鱼用户协议。数据只供个人比价使用，不要转发或用于商业用途。

## 闲鱼改版后怎么修

1. 运行 `node src/cli.mjs once --task "任务名" --debug`。`data/debug/` 下会保存每次接口的原始 JSON，失败时还会保存页面截图；终端还会打印被过滤掉的商品和原因（最多 20 条）。
2. **接口名变了**：在 `config.json` 里设置 `"apis": {"search": "...", "detail": "..."}`。
3. **字段变了**：修改 `src/parse.mjs` 里的 `parseSearch` 或 `parseDetail`。所有字段路径都集中在这个文件里。
4. **翻页按钮变了**：修改 `src/goofish.mjs` 里的 `NEXT_PAGE_SELECTORS`。

## 已知限制

- **还没在真实闲鱼上跑过**：开发环境访问不了闲鱼，所以测试用的是同样结构的模拟接口。接口名和字段路径来自闲鱼网页版目前的结构。第一次在你自己的网络上运行时，建议加上 `--debug` 跑一轮，核对解析出来的价格是否正确。
- 搜索结果只能按页面的默认排序；翻页靠点击按钮，找不到按钮时只取第一页。
- 详情接口里 `itemStatus` 不为 0 的商品统一显示为"已下架/不可购买"，没有细分已售出和下架（除非接口返回的文字里写明了"已售"）。
- 商品从搜索结果里消失时，不会被当作已售出处理，因为也可能只是排到了后面的页。

## 测试

```bash
npm test                                   # 单元测试 + 端到端测试
TEST_BROWSER_CHANNEL=msedge npm test       # 端到端测试改用本机 Edge
```

端到端测试会启动一个真实浏览器，加载模拟的闲鱼页面，覆盖以下流程：令牌重试、翻页去重、风控识别、单品详情，以及"建立基线 → 降价和新品提醒 → Webhook 推送 → 风控暂停且不重复提醒"。本机没有可用浏览器时，这部分测试会自动跳过。

## 文件结构

```
src/cli.mjs      命令入口：login / once / watch / test-notify / import-state
src/goofish.mjs  浏览器启动、读取接口响应、翻页、登录
src/parse.mjs    接口 JSON 转成统一的商品结构（闲鱼改版时主要改这里）
src/rules.mjs    过滤规则和提醒规则（纯函数）
src/runner.mjs   一轮监控的完整流程
src/notify.mjs   各推送渠道
src/store.mjs    state.json 和 history.csv 的读写
```
