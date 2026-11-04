# 闲鱼价格监控（xianyu-price-monitor）

在自己电脑或服务器上定时检查闲鱼上**指定商品链接**或**搜索关键词**的价格。降价、低于目标价、出现低价新品、商品售出或下架时，推送到微信、钉钉、飞书或手机。

## 方案概述

平时**不开浏览器**：用你登录时保存的 Cookie，直接请求闲鱼网页版用的那套接口（mtop），过滤结果、和上一轮比较，命中规则就推送。只有三种情况会临时用一下浏览器，用完就关：

1. 扫码登录；
2. 被风控拦下时，你手动过一次验证；
3. （默认的 auto 模式）HTTP 请求被拦时，用浏览器重试一次。

```
config.json ─► 调度（默认 15 分钟 ±20% 随机、只在活跃时段、遇到风控自动冷却）
                 │
                 ▼
  fetcher.mjs  选择取数方式（mode）
     ├─ HTTP 直连（默认）  mtop.mjs：带登录 Cookie 请求 h5api.m.goofish.com
     │      mtop.taobao.idlemtopsearch.pc.search   搜索结果
     │      mtop.taobao.idle.pc.detail             商品详情
     │      被风控 / 登录失效 ──┐
     └─ 浏览器兜底  goofish.mjs  ◄┘  打开网页，读取页面自己请求接口的返回结果；
                                      成功后把新 Cookie 同步回 HTTP
                 │
                 ▼
  parse.mjs  统一成：itemId / 标题 / 价格 / 地区 / 卖家 / 想要数 / 状态
  rules.mjs  过滤（价格区间、必含词、排除词），再和上一轮比较
  store      data/state.json（上次价格、参考价、防重复提醒）
             data/history.csv（价格变化记录，Excel 可直接打开）
  notify     Server酱 / PushPlus / 企业微信 / 钉钉 / 飞书 / Bark / Telegram / 通用 Webhook
```

### 三种模式（`mode`）

| 模式 | 平时占用 | 说明 |
| --- | --- | --- |
| `auto`（默认，推荐） | 只有 Node 进程 | 先用 HTTP。如果因为风控或登录失效被拦，就用浏览器重试这一个任务，成功后把浏览器里的新 Cookie 同步给 HTTP。如果原因是风控，冷却期内直接用浏览器，不再拿 HTTP 去撞 |
| `http` | 只有 Node 进程 | 只用 HTTP。服务器上不用装浏览器，复制登录文件过去就能跑。被拦时推送提醒并暂停 |
| `browser` | Node 进程 + 一个常驻浏览器 | 每次都打开真实网页。最接近真人访问，但最占资源 |

实测（本地模拟接口，不含网络延迟）：HTTP 每个任务约 10 毫秒，Node 进程约 80 MB；浏览器即使只加载空白的模拟页，每个任务也要约 160 毫秒，内存约 500 MB（浏览器约 360 MB，Node 约 140 MB）。真实闲鱼页面更重，实际差距只会更大。

**成功率要分开说**：浏览器在登录、出现验证时最稳，但每次都要加载完整网页；HTTP 快且省资源，但请求里没有浏览器环境，被风控盯上的可能性更大。auto 模式的思路是：平时走 HTTP，被拦时才切到浏览器，冷却期过后再试 HTTP。所以 HTTP 被拦得越频繁，auto 模式就越接近 browser 模式。在真实闲鱼上 HTTP 能跑多久不被拦，目前还没测过，见文末"已知限制"。

## 快速开始

需要 Node.js 22 或更高版本。

```bash
cd tools/xianyu-price-monitor
npm install
cp config.example.json config.json    # Windows 用 copy；改成你要监控的商品，填好推送渠道
npm run login                          # 弹出浏览器，用闲鱼/淘宝 App 扫码，只需一次
npm run test-notify                    # 确认能收到推送
npm run once -- --debug                # 先手动跑一轮，核对解析出来的价格
npm start                              # 常驻运行，按间隔自动检查
```

- `npm run login` 会把 Cookie 和这个浏览器的 UA 保存到 `data/storage-state.json`，HTTP 模式就用它。登录失效时重新运行一次即可。
- **Windows**：示例配置用本机自带的 Edge（`"channel": "msedge"`），不用另外下载浏览器。
- **macOS / Linux**：把 `browser.channel` 改成 `"chrome"`（本机已装 Chrome），或者改成 `""` 后运行 `npx playwright install chromium`。国内下载慢可以先设置 `PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright`。
- 第一轮只记录当前价格作为基线，不会推送"新上架"（价格已经低于目标价的仍会推送）。

## 配置说明（config.json）

### 全局配置

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `mode` | `"auto"` | `auto` / `http` / `browser`，见上文 |
| `browser.channel` | `""` | 登录和浏览器兜底时用哪个浏览器：`msedge` / `chrome` 表示本机已安装的；留空则用 Playwright 自带的 Chromium |
| `browser.headless` | `false` | 浏览器兜底时是否隐藏窗口。保持 `false` 时，出现滑块可以直接在窗口里手动完成 |
| `intervalMinutes` | `15` | 检查间隔，实际会在 ±20% 内随机浮动；最小 5 分钟 |
| `activeHours` | 全天 | 例如 `"08:00-23:30"`，这个时段以外不检查；也支持跨午夜，如 `"22:00-02:00"` |
| `riskCooldownMinutes` | `60` | 遇到风控或登录失效后暂停多久；auto 模式下也是暂停使用 HTTP 的时长 |
| `taskDelaySeconds` | `[5, 15]` | 相邻两个任务之间的随机等待时间 |
| `captureTimeoutSeconds` | `25` | 单次请求或等待页面数据的超时时间 |
| `userAgent` | 登录时记录的 UA | HTTP 请求用的 UA。一般不用填，默认和你登录时用的浏览器一致 |
| `dataDir` | `./data` | 登录态、状态和历史记录的保存位置 |
| `apis` | 见上文 | 闲鱼接口改名时在这里覆盖，例如 `{"search": "新接口名"}` |
| `notify` | 只输出到控制台 | 推送渠道列表，见下文 |

### 关键词任务 `"type": "search"`

| 字段 | 说明 |
| --- | --- |
| `name` | 任务名，必须唯一（用来区分各任务的监控记录） |
| `keyword` | 搜索词，相当于在闲鱼网页版搜索框里输入的内容 |
| `pages` | 抓取几页，1 到 5，默认 1。HTTP 模式按页码请求；浏览器模式靠点击翻页按钮，找不到按钮时只取第一页 |
| `sort` | 仅 HTTP 模式有效：`default`（综合排序）/ `newest`（最新发布）/ `priceAsc`（价格从低到高）。这几个排序参数是按网页版的请求推测的，用之前先加 `--debug` 核对一下返回结果 |
| `searchParams` | 仅 HTTP 模式有效：直接覆盖搜索请求里的字段，用来补上网页版的其他筛选条件 |
| `minPrice` / `maxPrice` | 价格区间。**`minPrice` 很重要**：它能过滤掉手机壳、配件和 1 元钓鱼帖，否则"历史最低价"会被这些低价帖拉低 |
| `include` | 标题必须**全部**包含的词，例如容量 `["256"]` |
| `exclude` | 标题包含**任意一个**就排除的词，例如 `["求购","回收","租","壳","配件","有锁"]` |
| `intervalMinutes` | 单独为这个任务设置检查间隔 |
| `enabled` | 设为 `false` 时暂停这个任务 |

### 单品任务 `"type": "item"`

| 字段 | 说明 |
| --- | --- |
| `itemId` 或 `url` | 商品 ID（链接里 `id=` 后面的数字），或者直接粘贴 `https://www.goofish.com/item?id=…` 形式的链接。App 分享出来的 `m.tb.cn` 短链里没有商品 ID，HTTP 模式没法请求（auto 模式会交给浏览器，但可能跳到读不到数据的手机版页面），建议先在电脑浏览器里打开短链，再复制地址栏里的链接 |

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

- **Windows 或 Mac 常驻**：在终端里运行 `npm start`。auto 模式下空闲时只有一个 Node 进程。想开机自启可以用 pm2：`pm2 start src/cli.mjs --name xianyu -- watch`。
- **系统定时任务**：也可以不常驻，每次只跑一轮，交给 cron 或 Windows 任务计划程序调度。示例：
  `*/15 8-23 * * * cd /path/to/xianyu-price-monitor && node src/cli.mjs once >> data/monitor.log 2>&1`
- **没有图形界面的 Linux 服务器**：在 `config.json` 里设置 `"mode": "http"`，服务器上就不需要浏览器。先在自己电脑上运行 `npm run login`，把 `data/storage-state.json` 复制到服务器，再运行 `node src/cli.mjs import-state storage-state.json`（或者直接放到服务器的 `data/` 目录下）。登录失效时，在电脑上重新登录，再复制一次。
- 同一个 `data/` 目录同一时间只能有一个进程在用浏览器，因为浏览器配置目录会被锁定。

## 风控与使用边界

- **只读，频率低**：默认每 15 分钟检查一次并随机浮动，最小间隔 5 分钟；任务之间随机等 5 到 15 秒，翻页之间也有随机等待；夜间不运行。工具不会下单、聊天或发消息。
- **不绕过风控**：HTTP 签名用的是网页版公开的 H5 签名规则，请求必须带你自己的登录 Cookie，工具不自动过滑块或验证码。检测到风控（滑块验证、"被挤爆啦"）或登录失效时，会推送一条提醒并暂停 `riskCooldownMinutes` 分钟。需要手动处理时，运行 `npm run login`，在窗口里搜一下商品、完成验证后按回车，新 Cookie 会同步给 HTTP。
- **登录态就是你的账号凭据**：`data/storage-state.json` 和 `data/browser-profile` 只保存在本机，已经写进 `.gitignore`，不要发给别人。
- 请遵守闲鱼用户协议。数据只供个人比价使用，不要转发或用于商业用途。

## 闲鱼改版后怎么修

1. 运行 `node src/cli.mjs once --task "任务名" --debug`。`data/debug/` 下会保存每次接口的原始 JSON（浏览器模式失败时还会保存截图）；终端还会打印被过滤掉的商品和原因（最多 20 条）。可以加 `--mode http` 或 `--mode browser` 单独测试某一种取数方式。
2. **接口名变了**：在 `config.json` 里设置 `"apis": {"search": "...", "detail": "..."}`。
3. **搜索请求参数变了**：修改 `src/mtop.mjs` 里的 `searchPayload`，或者在任务里用 `searchParams` 覆盖。
4. **返回字段变了**：修改 `src/parse.mjs` 里的 `parseSearch` 或 `parseDetail`。HTTP 和浏览器两种方式共用这一份解析代码。
5. **翻页按钮变了**（只影响浏览器模式）：修改 `src/goofish.mjs` 里的 `NEXT_PAGE_SELECTORS`。

## 已知限制

- **还没在真实闲鱼上跑过**：开发环境访问不了闲鱼，所以测试用的是本地模拟接口。模拟服务器会严格校验签名、令牌刷新和 Cookie 的流程。接口名、请求参数和字段路径来自闲鱼网页版目前的结构。第一次在你自己的网络上运行时，建议加上 `--debug` 跑一轮，核对解析出来的价格是否正确。
- **HTTP 模式的风控表现未知**：如果闲鱼对 HTTP 请求要求额外的浏览器环境参数，HTTP 会经常被拦。auto 模式会自动退回浏览器，但这样就省不了资源。遇到这种情况，直接设置 `"mode": "browser"` 会更省事。
- `sort` 的取值是按网页版请求推测的；浏览器模式只能用页面默认排序。
- 详情接口里 `itemStatus` 不为 0 的商品统一显示为"已下架/不可购买"，没有细分已售出和下架（除非接口返回的文字里写明了"已售"）。
- 商品从搜索结果里消失时，不会被当作已售出处理，因为也可能只是排到了后面的页。

## 测试

```bash
npm test                                   # 单元测试 + HTTP 模拟服务器测试 + 浏览器端到端测试
TEST_BROWSER_CHANNEL=msedge npm test       # 浏览器部分改用本机 Edge
```

- **HTTP 部分**：启动一个本地模拟的 h5api 服务器，严格校验签名，覆盖令牌下发与重试、Cookie 罐、风控识别、翻页和排序参数，以及完整的"建立基线 → 降价提醒 → 令牌写回会话文件"流程。
- **auto 模式**：覆盖"HTTP 被风控 → 用浏览器重试 → 冷却期内只用浏览器 → 冷却后回到 HTTP"。
- **浏览器部分**：用真实浏览器加载模拟的闲鱼页面，覆盖令牌重试、翻页去重、风控识别、单品详情，以及包含 Webhook 推送的完整流程。本机没有可用浏览器时，这部分会自动跳过。

## 文件结构

```
src/cli.mjs      命令入口：login / once / watch / test-notify / import-state
src/fetcher.mjs  按 mode 选择 HTTP 或浏览器，以及 auto 模式的兜底和冷却
src/mtop.mjs     HTTP 直连：签名、令牌、Cookie 罐、搜索和详情请求
src/goofish.mjs  浏览器：启动、读取页面接口响应、翻页、扫码登录
src/parse.mjs    接口 JSON 转成统一的商品结构（闲鱼改版时主要改这里）
src/rules.mjs    过滤规则和提醒规则（纯函数）
src/runner.mjs   一轮监控的完整流程
src/notify.mjs   各推送渠道
src/store.mjs    state.json 和 history.csv 的读写
```
