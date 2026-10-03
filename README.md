# Stronghold Protocol · 端侧客户端打包

把《卫戍协议：盟约》的浏览器客户端打成 **Windows 客户端**（Electron）和 **Android `.apk`**（Capacitor），默认连接 **`game.starst.site`**：素材与代码从本地读（进对局不用重新下载约 260 MB 素材），房间、回合、联机仍然走远程服务器。

游戏本体（Node 服务器 + 浏览器客户端，GPL-3.0）是**另一个仓库**：上游 <https://github.com/sganggs/Stronghold-Protocol>。
本仓库只放"壳"和打包流程，**从不修改游戏仓库**——客户端要的那 3 处改动以补丁形式打在 payload 上（见下）。

```
npm run client:desktop      # → build/desktop/win-unpacked/（exe + 依赖目录，约 585 MB，双击即开）
npm run client:android      # → mobile/android/app/build/outputs/apk/debug/app-debug.apk（约 192 MB）
npm run client:build        # 只生成 build/client/www（想用自己的静态托管时用）
npm test                    # 打包流程的单元/契约测试（无游戏 checkout 时相关用例自动跳过）
```

详细说明（Android SDK 准备、签名、**服务器公告**、排错、**部署与重启**、**查服务器忙不忙**）见 **[docs/PACKAGING.md](docs/PACKAGING.md)**；服务器上的发版自动化（钩子/定时器脚本 `deploy/`）见 **[docs/DEPLOY-SERVER.md](docs/DEPLOY-SERVER.md)**。

```
npm run server:status                                  # 现在多少人在线 / 多少对局在跑
npm run server:status -- --watch --under 40             # 蹲空窗：humans ≤ 40 时提示可以重启
```

## 前置

| | 需要 |
|---|---|
| 通用 | Node.js 22+；一个**游戏仓库 checkout**（默认同级 `../Stronghold-Protocol`，可用 `--game` / `SP_GAME_ROOT` / `client.config.json` 指定），且已 `npm install` + `npm run assets`（素材不在 GitHub 仓里） |
| exe | 无额外要求（`electron` / `electron-builder` 由 `desktop/` 的 `npm install` 装，首次约 500 MB） |
| apk | JDK 17+（`JAVA_HOME`）+ Android SDK（`ANDROID_HOME`，`platforms;android-36`、`build-tools;36.0.0`） |

## 目录

| 路径 | 内容 |
|---|---|
| `tools/package-client.mjs` | 把游戏仓库的挂载点摊平成 `build/client/www`，生成 `data.js` / `js/runtime-config.js` / `js/shell/*` / `css/shell-display.css` / `build.json`，并应用 payload 补丁 |
| `tools/game-contract.mjs` | 游戏仓库路径解析 + `DATA_SHIM_JS` / `SIM_PRIVATE` 的对照校验 + 版本读取 |
| `tools/payload-patches.mjs`、`tools/unified-diff.mjs` | 把 `patches/game-client.patch` 打在 payload 副本上（自带极简 diff 应用器，不依赖 git） |
| `patches/game-client.patch` | 客户端改动（3 个文件、6 个 hunk，见下），`git diff` 生成 || `shell/picker.js`、`shell/picker-core.js` | 端侧"选择服务器"页（进游戏前覆盖启动画面）：探测服务器、记住上次选择、自定义地址；`picker-core.js` 是纯逻辑（可单测） |
| `shell/display.css` | 端侧显示修正：横屏手机的 HUD/棋盘比例（见下"手机端适配"） |
| `desktop/` | Electron 壳：只监听 `127.0.0.1` 的静态服务（固定端口 47821，让 `localStorage` 跨重启保留，见 §4.4）+ 窗口；`icon.ico`。默认出**目录版**（`win-unpacked/`），`--portable` 才出单文件 exe。日志在 `%APPDATA%\StrongholdProtocol\client.log`（见 §4.3） |
| `mobile/` | Capacitor 工程（`webDir` → `../build/client/www`）+ 生成的 `android/` Gradle 工程 |
| `client.config.json` | `gameRoot`、`defaultServer` |
| `tools/server-status.mjs` | 查服务器忙不忙（`/healthz`）：单次采样、滚动观察、`--under N` 等空窗（见 §11） |
| `test/packaging.test.js`、`test/picker.test.js` | 补丁/契约/摊平/增量的测试；选择页规则的测试 |

## 与游戏仓库的契约（重要）

- **游戏仓库只读**：`git status` 永远干净，`git pull` 不会因为打包而冲突。客户端的改动是补丁：
  `js/net.js`（`defaultWsUrl()` 支持 `globalThis.__SP_SERVER__` / `?server=host`）、`js/screens/room.js`（邀请链接指向远程网页版）、`index.html`（模块图之前载入 `/js/runtime-config.js` 与 `/js/shell/picker.js`，`css/devices.css` 之后载入 `/css/shell-display.css`）。
- 上游改了这 3 个文件 → 补丁对不上 → **构建会失败**（而不是悄悄发出一个连错服务器的客户端）。此时重新生成 `patches/game-client.patch` 即可。
- `tools/game-contract.mjs` 里复制了游戏仓库的 `DATA_SHIM_JS` 与 `SIM_PRIVATE`（避免为打包在游戏仓库里 `npm install`），每次构建都会对照 `server/index.js` 校验。
- 产物里记录构建来源：payload 的 `build.json` 与 `build/client/manifest.json` 都有 `git describe` + commit + `PROTOCOL_VERSION`。

## 用法

```bash
npm run client:desktop -- --server 192.168.1.9:3000   # 换成局域网服务器
npm run client:android -- --server 192.168.1.9:3000
npm run client:desktop -- --portable                   # 单文件便携 exe（分发方便，启动慢，见下）
npm run client:android -- --release                    # 未签名 release APK
node tools/package-client.mjs --game ../Stronghold-Protocol --out D:\client-www
```

桌面客户端运行时也可以临时改服务器：`StrongholdProtocol.exe --server <地址>`（另有 `--choose-server`、`--fullscreen`，快捷键 F2/F11/F5/F12）。

## 桌面版为什么是"文件夹"而不是单文件 exe

```
npm run client:desktop            # 默认：build/desktop/win-unpacked/（exe + 依赖 + resources/）
```

| 形态 | 体积 | 启动到首屏 | 说明 |
|---|---|---|---|
| **目录版（默认）** | 585 MB（解压后） | **约 0.3 s** | 直接双击 `win-unpacked/StrongholdProtocol.exe` |
| 目录版打成 zip | 321 MB | 解压一次后同上 | 用资源管理器右键"压缩到 zip"即可（本机实测 28 s） |
| 单文件 `--portable` | 261 MB | **约 24 s** | 每次启动都把整包解压到 `%TEMP%`，所以慢 |

分发推荐"目录版 + 手动打 zip"：**下载 321 MB，解压一次，之后每次启动都是 0.3 s**；单文件 exe 虽然只大 60 MB 的差距，但每次启动都要解压 585 MB。打包时顺手把 Electron 的 55 个语言包裁到 `zh-CN` / `en-US`（省约 46 MB）。

## 手机端适配（APK）

两个独立的问题，都在本仓库解决，游戏仓库依旧零改动：

**1. 黑边（左/上/下）** —— Android 壳层。默认主题既没让窗口使用刘海区域（横屏时系统会把窗口 letterbox，那条刘海带就是左边的黑边），也没隐藏状态栏/导航栏（上下两条）。现在：

- `res/values/styles.xml`：`windowLayoutInDisplayCutoutMode=shortEdges`（游戏仓库的 `css/devices.css` 本来就把 HUD 放在 `env(safe-area-inset-*)` 里，所以画进刘海区是安全的）
- `MainActivity.java`：`setDecorFitsSystemWindows(false)` + 隐藏 system bars（`BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE`，划一下仍能临时唤出）
- `AndroidManifest.xml`：`screenOrientation="sensorLandscape"`（游戏本来就是横屏设计，自带"请横屏"提示）

**2. 准备阶段场景过小** —— 视口比例问题。游戏用根字号缩放整个 HUD：`clamp(40px, min(100vw/19.2, 100vh/10.8), 240px)`。横屏手机只有 ~366 px 高，`100vh/10.8 ≈ 33.9` 被 **40 px 下限**抬上去，于是 HUD 相对屏幕比桌面高 ~15%，而准备阶段的镜头要"避开 HUD"（`js/ui/fieldHost.js hudBands` → `js/render/projection.js clearHud`），只能把准备场景缩小。自动战斗的镜头没有这个约束，所以你看到"战斗正常、准备阶段小"。

`shell/display.css` 在横屏矮屏（`orientation: landscape and max-height: 480px`）用同一个公式但**去掉 40 px 下限**，HUD 与棋盘回到桌面的比例：同一个页面上（`dev/game-mock.html?phase=PREP`，每个备战格的屏幕像素，桌面基准 122 px）：

| 视口 | rem | 备战格 px（改前 → 改后） |
|---|---|---|
| 756×366（你那台的可用区） | 40 → 33.9 | 35 → **41.5**（+19%） |
| 798×366 + 41 px 刘海 | 40 → 33.9 | 35 → **41.5**（+19%） |
| 800×360 | 40 → 33.3 | 33.8 → **40.8**（+21%） |
| 915×412 | 40 → 38.1 | 44.5 → 46.7（+5%） |
| 1920×1080 桌面 | 100 = 100 | 122.3 → 122.3（**不变**） |

同一套测量还确认：所有视口下备战格/临时格/后排仍然 **100 % 不被 HUD 遮挡**（这正是当初 `clearHud` 缩小的原因），页面无报错。

## 选择服务器（exe / apk 首次启动）

端侧客户端不绑定死一台服务器：payload 里多了一个"选择服务器"页（`shell/picker.js`），在进游戏前盖住启动画面。

- **列出的服务器**：`官方服务器 game.starst.site`（`--server` 打包时指定的地址会显示为"默认"）、`本机 / 局域网 localhost:3000`，以及自己添加的地址（`host`、`host:port`、`http(s)://…`、`ws(s)://…` 都能识别，存在客户端本地）。每次打开都会**探测**：直接开 `/ws`（和游戏用同一条通道，所以不需要服务器支持 CORS），绿灯代表真的能连进去；如果服务器给 `/healthz` 加了 CORS 头，还会显示版本 / 在线人数。
- **记住上次选择**：桌面端勾上"记住并直接进入"后，下次启动直接进游戏（想换服务器按 **F2**，或用 `--choose-server` 启动）。Android 没有 F2，所以每次都显示这个页面（默认不记住），免得换了服务器回不去。
- **网页版不受影响**：浏览器版没有这个页面，服务器永远是自己所在的站点。
- **重启后不丢本地缓存**：身份 token、干员调配、设置都存在 `localStorage` 里，而它是按"源"隔离的——所以桌面壳固定用 `127.0.0.1:47821`（`desktop/serve.mjs` 的 `DEFAULT_PORT`），每次启动都是同一个源，重启后原样读回（以前每次随机端口 = 每次换源，等于重装）。Android 本来就从固定的 `https://localhost` 提供页面，无需处理。详见 [docs/PACKAGING.md](docs/PACKAGING.md) §4.4。
- Android 上连局域网的 `ws://` 需要 APK 打开 `allowMixedContent`（本仓库默认打开，原因见 [docs/PACKAGING.md](docs/PACKAGING.md) §5）。
- 优先级：`--server <地址>`（本次运行强制）> 命令行/`?server=` > 选择页记住的地址 > 打包时的默认地址。选择页只是把选择写进 `localStorage`（`sp.shell.*`）并重载页面，`js/net.js` 一条代码都没多改。

## 许可

本仓库自有代码 GPL-3.0-or-later（与游戏本体相同）。打包产物里含《明日方舟》美术 / 音频素材，版权归鹰角网络 / Yostar，**不适用** GPL，仅限个人非商业自用，请勿再分发（见上游 [声明](https://github.com/sganggs/Stronghold-Protocol#声明) 与 [NOTICE.md](https://github.com/sganggs/Stronghold-Protocol/blob/master/NOTICE.md)）。
