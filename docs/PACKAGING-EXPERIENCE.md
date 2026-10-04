# 端侧打包经验（Windows exe / Android apk）——给后续 agent

给接手"打客户端包"这件事的 agent。**先读 [`docs/PACKAGING.md`](docs/PACKAGING.md)**（那是给用户的说明书，
命令、参数、目录、排错都在里面）；这份文档只写**踩过的坑、验证配方和判断依据**，也就是"照着做会踩什么"。
本文件不涉及服务器发版（那个在 [`docs/DEPLOY-SERVER.md`](docs/DEPLOY-SERVER.md) 与 `deploy/`）。

---

## 0. 速览

| 命令 | 产物 | 体积 | 备注 |
|---|---|---|---|
| `npm run client:build` | `build/client/www` | 265.7 MB / 4157 文件 | 只是摊平的 payload，用来自托管/调试 |
| `npm run client:desktop` | `build/desktop/win-unpacked/`（exe + 依赖目录） | 585.5 MB，exe 本身 234.3 MB | **默认形态**，双击到首屏 ~0.3 s |
| `npm run client:desktop -- --portable` | `StrongholdProtocol-<ver>-portable.exe` | ~253 MB | 单文件，首屏 **~24 s**（每次启动都把整个应用解到 `%TEMP%`） |
| `npm run client:android` | `mobile/android/app/build/outputs/apk/debug/app-debug.apk` | 192.4 MB | debug 包；`--release` 出未签名的 release |
| `npm test` | —— | 36 用例 | `packaging/picker/status`；没有游戏 checkout 时自动 skip |

默认连 `game.starst.site`。三个仓库分工：**游戏仓库**（`../Stronghold-Protocol`，要能跟上游对齐）／
**本打包仓库**（`Stronghold-Protocol-Client`）／**服务器启动器**（`Stronghold-Protocol-Server-Launcher`，另一件事）。

前置：Node 22+；一个已经 `npm install` + `npm run assets` 的**游戏仓库 checkout**（素材约 265 MB，不在 GitHub 里）；
打 apk 另需 JDK 17+ 与 Android SDK（`platforms;android-36` + `build-tools;36.0.0`）。
本机可用：JDK 21 在 `C:\Program Files\Java\jdk-21`，SDK 在 `%LOCALAPPDATA%\Android\Sdk`，
游戏仓库自带 Node 在 `d:\gits\Stronghold-Protocol\.tools\node\node.exe`，
无头浏览器用 Edge `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`。

---

## 1. 第一条铁律：payload 是"快照"，改游戏端就必须重打

`tools/package-client.mjs` 把游戏仓库的挂载点**摊平**成 `build/client/www`（`/`→`public/`，`/data/`→`data/`，
`/shared/`→`shared/`，`/sim/`→`server/sim/*.js` 去掉 Node 专用 loader），并生成 `data.js`（浏览器版
`server/data.js` 替身）、`js/runtime-config.js`（连哪个服务器）、`js/shell/*`、`css/shell-display.css`、`build.json`。
exe 把它塞进 `resources/www`，apk 把它塞进 `assets/public/`。

**后果**：游戏端只要动了 `public/**`（新 UI、新功能，比如"服务器公告"的横幅），**已经装出去的 exe/apk 都不会有**——
网页端刷新就有，端侧必须重打。给玩家的说明和你的发布节奏都要考虑这一点。

`build.json` 是溯源用的：`server` / `game.app`（客户端界面显示的版本）/ `game.commit` / `game.dirty`。
`game.describe` 走 `git describe --tags`，而开发机只有旧 tag、又常常连不上 github.com，所以它常常显示
`v0.1.0-184-gxxxx` 这种"看起来版本不对"的值——**它只进日志和 build.json，界面显示的是 `app`**，别被它带跑偏。

## 2. 改动游戏端要给上游留面子：补丁不进游戏仓库

客户端需要的游戏端改动放在 **`patches/game-client.patch`**（当前 3 文件 6 hunk：`public/index.html`、
`public/js/net.js`、`public/js/screens/room.js`），由 `tools/unified-diff.mjs`（自带极简 diff 应用器，不依赖 git）
打在 payload **副本**上。客户端独有的东西（`shell/picker*.js`、`shell/display.css`）直接由打包器写进 payload。

所以：**永远不要为了让客户端能用而改游戏仓库**。游戏仓库只放"能给上游开 PR"的功能。
分叉是否干净可以用一条命令对账：

```bash
cd d:/gits/Stronghold-Protocol && git diff --stat upstream/master..master
# 期望：只剩你自己的、准备开 PR 的功能；出现打包/部署脚本就是放错地方了
```

`test/packaging.test.js` 通过 `tools/game-contract.mjs` 锁定 `DATA_SHIM_JS` / `SIM_PRIVATE` 必须与游戏仓库
`server/index.js` 一致——**游戏端改了挂载点或 sim 的私有文件，这里会红**，这是设计好的报警，不要改断言绕过。

## 3. 桌面端（exe）：几个必须记住的判断

**目录版 vs 单文件**：单文件版每次启动都把整个应用解压到 `%TEMP%`，实测首屏 **24.4 s**，目录版 **0.28 s**。
所以默认出目录版（`win.target: ['dir']`），`--portable` 才出单文件。分发时自己压成 zip
（LZMA/默认算法 321 MB / 28 s；**别用 deflate**，比 LZMA 差很多）。

**瘦身**：`electronLanguages: ['zh-CN','en-US']` 把 `locales/` 从 55 个文件砍到 2 个，省 ~48 MB（632 → 585 MB）。
再想瘦就得动 265 MB 的素材，那是另一个话题。

**一次调用一个 target**：electron-builder 的 CLI 一次只接受一个 target（`--win dir` 或 `--win portable`），
所以别指望一条命令同时出两种形态；`desktop/package.json` 的 `pack` / `pack:portable` 两个 script 就是干这个的。

**固定端口 47821（最容易白干活的坑）**：壳把 payload 挂在 `http://127.0.0.1:<port>`，而 `localStorage`
按**源**隔离——游戏把续连 token、干员调配、设置都存在里面。以前用端口 `0`（系统随机分配），
结果每次启动都是新源：**看起来像"重装了一遍"**（要重新登录、调配和设置清空）。
现在 `desktop/serve.mjs` 固定 `DEFAULT_PORT = 47821`，被占用时按 `47821, 47822, …` **固定顺序**往后找
（顺序固定 → 下次启动仍落回同一个源）。改这里之前先想清楚源会不会变。Android 不用管：Capacitor 固定
从 `https://localhost` 提供页面，源本来就稳定。

**崩溃/闪退的诊断**：`desktop/main.mjs` 里 `render-process-gone` 是**重载而不是退出**，日志写到
`%APPDATA%\StrongholdProtocol\client.log`（1 MB 轮转）。排查顺序：
1. 看 `client.log` 有没有 `renderer gone: reason=…`；
2. 有没有**残留进程**——单实例锁会让新进程立刻退出，**看起来就像"闪退"**（单文件版尤其容易残留）：
   `Get-Process -Name StrongholdProtocol`；
3. 用 CDP 主动崩一次验证恢复：`Page.crash` → 应用应存活并回到大厅（历史上 6/6 通过）。

## 4. Android（apk）：两个独立问题，别混在一起

**（a）黑边／全屏**：Capacitor 的主题既没声明"允许显示区域延伸到刘海"（系统就把窗口letterbox 成横屏可用区 →
左侧那条黑带），也没隐藏状态栏/导航栏。修法是三处**原生**改动，都在版本管理里：

| 文件 | 改动 |
|---|---|
| `app/src/main/res/values/styles.xml` | `windowLayoutInDisplayCutoutMode=shortEdges`（两个主题；aapt2 会生成 v28 变体 `0x01010586=1`） |
| `.../java/site/starst/stronghold/MainActivity.java` | `setDecorFitsSystemWindows(false)` + `hide(systemBars())` + 重新获得焦点时再隐藏 |
| `app/src/main/AndroidManifest.xml` | `screenOrientation="sensorLandscape"` |

**（b）准备阶段场景过小**：根因在游戏端 CSS——根字号 `clamp(40px, min(100vw/19.2, 100vh/10.8), 240px)` 的
**40 px 下限**在矮屏上把 HUD 撑高 ~15%，于是 `clearHud` 把准备阶段相机拉远（棋盘只占屏高 46%）。
修法是客户端自己的 `shell/display.css`（payload 里挂在 `css/shell-display.css`，补丁在 `css/devices.css` 之后引入）：
对 `(orientation: landscape) and (max-height: 480px)` 去掉那个下限。实测（用游戏自带的
`dev/game-mock.html?phase=PREP`）：756×366 每格 35→41.5 px（+19%），800×360 +21%，915×412 +5%，
**1920×1080 完全不变**（122.3 px），且所有尺寸下格子都不被 HUD 覆盖。改动必须**只在矮屏生效**，
否则会破坏桌面端。

**网络**：`AndroidManifest` 的 `usesCleartextTraffic` 只管系统层，**WebView 的混合内容另说**——
从 `https://localhost` 页面连 `ws://<局域网IP>` 需要 `capacitor.config.json` 的 `allowMixedContent: true`。

**`cap sync` 会覆盖什么**：`mobile/android/app/src/main/assets/public/`（payload 副本）与
`assets/capacitor.config.json` 是生成物、已 gitignore；`android/` 项目本体（manifest、MainActivity、
styles.xml、gradle）是**手写并入库的**，改完记得提交，否则下一个人重打又丢。

**宿主机上打不出"能直连局域网服务器"的包**只能靠上面两条；`androidScheme: https` 别乱动（见 §3 的源问题）。

## 5. 验证配方（给 agent 的"怎么证明它是对的"）

打包这件事**不看日志猜、要拿产物本身验**。以下几条都是实际用过的：

```powershell
# 1) payload 与产物是否一致（哈希比对，确认新文件真的进了包）
(Get-FileHash build\client\www\js\ui\<file>.js).Hash
(Get-FileHash build\desktop\win-unpacked\resources\www\js\ui\<file>.js).Hash   # 应相同

# 2) 桌面端启动冒烟：15 秒后进程还在 + client.log 只有一行正常日志
$exe='build\desktop\win-unpacked\StrongholdProtocol.exe'; $p=Start-Process $exe -PassThru
Start-Sleep 15; [bool](Get-Process -Id $p.Id -ErrorAction SilentlyContinue)
Get-Content "$env:APPDATA\StrongholdProtocol\client.log"     # 之后 Stop-Process -Id $p.Id -Force

# 3) apk 里到底有什么（zip 就是 zip）
Add-Type -AssemblyName System.IO.Compression.FileSystem
$z=[IO.Compression.ZipFile]::OpenRead((Resolve-Path $apk))
$z.Entries | Where-Object { $_.FullName -match 'noticeBanner|shell-display|build.json' } | ForEach-Object { $_.FullName }
#   或 Git bash：tar -xf app-debug.apk assets/public/build.json

# 4) manifest / 资源真编进去了吗（aapt2 在 %LOCALAPPDATA%\Android\Sdk\build-tools\36.0.0）
aapt2 dump xmltree --file AndroidManifest.xml app-debug.apk | findstr screenOrientation   # 6 = sensorLandscape
aapt2 dump resources app-debug.apk | findstr 01010586                                     # 1 = SHORT_EDGES

# 5) 手写 Java 有没有进 dex（编译过才算）
#    解出 classes*.dex 后搜字符串：setDecorFitsSystemWindows / hide / systemBars
```

**无头浏览器 e2e**：涉及真浏览器行为的改动（公告横幅、客户端壳）不要只跑单测——用 `SP_E2E=1` +
`CHROME_PATH=<Edge 路径>` 跑 `node --test test/ui/*.e2e.test.js`。没有这两个环境变量时它们**静默 skip**，
很容易误以为"通过"。

## 6. 陷阱清单（都是实际踩过的）

| 现象 | 原因 / 处理 |
|---|---|
| 桌面端"闪退"、日志正常 | 多半是**残留进程**撞单实例锁；先 `Get-Process -Name StrongholdProtocol` 清干净 |
| 重启后要重新登录 / 调配没了 | 端口变了 → 换了源（§3 固定 47821） |
| 单文件 exe 首屏 24 s | 正常：每次解压到 `%TEMP%`；改用目录版 |
| CDP 连上 Electron 后窗口变成 800×600 | `puppeteer.connect()` 默认强制视口：传 `defaultViewport: null` |
| `browser.close()` 之后应用没了 | 那是**退出 Electron**；用 `disconnect()` |
| `waitForFunction` 永远不返回 | 后台标签页节流 rAF：`polling: 100`，或先 `bringToFront()` |
| CDP 注入的按键触发不了 `before-input-event` | 自动化按键到不了 Electron 那层；要测就得真按键（历史上 F2 用真按键测的） |
| PowerShell 里 `&&`、heredoc 不可用 | 用 `;` + `if ($?)`；多行脚本写文件或用 `node -e`；提交信息写文件再 `git commit -F` |
| 版本号改了产物名却没变 / 反之 | 版本要从**游戏仓库** `shared/constants.js` 读；本仓库 `package.json`+两份 lock 的根与 `packages.""` 也要同步（`1ca6d71`），别碰传递依赖里的 `0.1.0` |
| 脚本在 Windows 上好好的，Linux/systemd 上炸 | CRLF：仓库用 `.gitattributes`（`*.sh`/`*.mjs`/`deploy/**` = `eol=lf`）；`git archive` 会按 `core.autocrlf` 输出 CRLF；装到服务器/`/etc/systemd/system` 的副本要 `sed -i 's/\r$//'` |
| 只有个别尺寸（手机横屏）出问题 | 改 UI 比例前先用 `dev/game-mock.html?phase=<阶段>` 在**多个视口**下量，桌面 1920×1080 必须回归不变 |
| 服务器填 `IP:端口` 连不上、非得写 `http://` | 曾经不带协议的地址一律"非私网 → wss"，公网 IP 就废了。现在 `toWsUrl()`：**带端口的地址按 `ws://` 猜**（`:443` 除外）、不带端口才按"公网 wss / 本机 ws"；选择页还会对"无协议 + 有端口"的地址**两种协议都探一次**（`picker-core.js` 的 `ambiguousScheme`），命中即记录那个地址。实测 `211.71.60.138:3000` → `ws://…` 一次连上 |
| 内网穿透（frp / SakuraFrp）连不上 | 先用 `-k` + `Upgrade` 头验隧道：`curl -k -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" -o NUL -w '%{http_code}' https://host:port/ws`。实测 SakuraFrp 的端口返回 **101** —— 隧道和 ws 都没问题，唯一障碍是**自签证书**（`CN=SakuraFrp Automatic TLS sn.…`，SAN 还是 `lt.<域名>`，与裸域名不匹配），Chromium 一律 `ERR_CERT_AUTHORITY_INVALID`，客户端怎么改都连不上：要么换成受信任证书（SakuraFrp 的"自动HTTPS"需要自有域名验证），要么改用明文端口走 `ws://`。桌面 exe 可临时用 Chromium 自带开关 `StrongholdProtocol.exe --ignore-certificate-errors`（**不用改代码**，实测 `ws.handshake: 101` 并连上），但它对**整个应用**关掉证书校验，且 APK / 网页版用不了 |
| 域名带路径（`host/play/`）连不上 | 选择页把路径原样接到 `/ws` 前（`host/play/` → `wss://host/play/ws`），路径不存在就是 404。注意游戏服务端的 `/ws` **只应答带 `Upgrade` 的请求**：普通 GET 返回 404 是正常的，用 `curl -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=="` 才能看到 101 |
| `Number(null) === 0` | 可选数字别随手 `Number()`：`null` 必须保持"没有"，否则"未设置"会被当成 0（公告的 `until` 就栽过） |

## 7. 交付

* **exe**：给 `build/desktop/win-unpacked/` 整个目录，自己压 zip（LZMA）。别只给 exe——它离不开旁边的 dll/locales/resources。
* **apk**：debug 包用 debug keystore 签过、可直接安装；正式分发才需要自己的签名（见 `docs/PACKAGING.md` §5）。
* 产物目录（`build/`、`mobile/android/app/build/`、`app/src/main/assets/public/`）都已 gitignore，**不要提交**。
* 发版后提醒玩家：`public/**` 的新功能要**换成新包**才看得到。

## 8. 交给后续 agent 的三步验收

1. `npm test`（36 用例，含 payload 补丁格式与游戏契约）——红了的断言先读懂，别改断言；
2. 重新 `npm run client:desktop` + `npm run client:android`，按 §5 的 1)~5) **验产物**（哈希、启动冒烟、apk 拆包、aapt2）；
3. `git diff --stat upstream/master..master` 确认游戏仓库没有混进客户端专用代码。

三个仓库的分工与提交历史（`git log --oneline` 里的 `9d6f84e` 目录版默认、`6069e3f` 手机端适配、
`744a071` 崩溃与日志、`fe6f824` 固定端口、`b061213` 部署脚本搬入）可以作为"为什么这么做"的索引。
