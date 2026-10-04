# 打包客户端（exe / apk）

把浏览器客户端和本机素材打进**桌面 / Android 可执行文件**：素材和代码从本地读取，房间、回合、联机仍然连服务器——默认 **`localhost:3000`**（自己在本机 / 局域网跑游戏服务器；官方远程服已下线）。

```
npm run client:desktop      # → build/desktop/win-unpacked/（exe + 依赖目录，约 585 MB）
npm run client:android      # → mobile/android/app/build/outputs/apk/debug/app-debug.apk
npm run client:build        # 只生成 build/client/www（想用自己的静态托管时用）
```

## 1. 原理

浏览器客户端是按服务器的挂载布局写的（游戏仓库的 `server/index.js`）：`/`→`public/`、`/data/`→`data/`、`/shared/`→`shared/`、`/sim/`→`server/sim/**/*.js`，外加服务器现生成的 `/data.js`（`server/data.js` 的浏览器替身）。打包好的客户端没有 Node 服务器，所以：

1. `tools/package-client.mjs` 把**游戏仓库 checkout** 的这些挂载点**摊平**成一个目录 `build/client/www/`——任何静态文件服务器或 Android WebView 都能直接托管，`/js/...`、`/data/...`、`/sim/...` 这些绝对路径照常解析；顺带生成 `data.js`（垫片）、`js/runtime-config.js`（服务器地址）、`js/shell/*`（选择服务器页）与 `build.json`（构建来源）。
2. 客户端要连远程服务器，需要几处源码级改动：`js/net.js` 的 `defaultWsUrl()` 读 `globalThis.__SP_SERVER__`、`js/screens/room.js` 的邀请链接指向远程网页版、`index.html` 在模块图之前载入 `/js/runtime-config.js` 与 `/js/shell/picker.js`。**这些改动不在游戏仓库里**，而是以 `patches/game-client.patch` 的形式打在 payload 副本上（见 §7），游戏仓库保持与上游逐字节一致。
3. 桌面壳（`desktop/`）用 Electron 起一个**只监听 127.0.0.1** 的静态服务器托管 `www/`，再打开窗口；Android 壳（`mobile/`，Capacitor）把 `www/` 作为原生 assets 打进 APK。

所以：进对局不用再下载约 260 MB 素材，但服务器地址、协议版本仍然跟着远程服务器走。

> 客户端和服务端的协议版本必须一致（游戏仓库 `shared/constants.js` 的 `PROTOCOL_VERSION`）。服务器升级后请重新打包，否则客户端会提示「客户端版本与服务器不一致」。

## 2. 先决条件

| 目标 | 需要 |
|---|---|
| 通用 | Node.js 22 / 24；一个**游戏仓库 checkout**（`Stronghold-Protocol`，默认同级 `../Stronghold-Protocol`，可用 `--game` / `SP_GAME_ROOT` / `client.config.json` 指定），且已 `npm install` + `npm run assets` 下载素材——**没有素材的客户端只是个空壳** |
| exe | 无额外要求（`electron` / `electron-builder` 由 `desktop/` 的 `npm install` 装）；出 zip 用资源管理器右键，出 7z/zip 更小可用 7-Zip（可选） |
| apk | JDK 17+（`JAVA_HOME`）、Android SDK（`ANDROID_HOME`）含 `platforms;android-36` 与 `build-tools;36.0.0`、并已接受许可协议（见 §5） |

## 3. 命令与参数

```bash
npm run client:build                                    # 只生成 build/client/www
npm run client:desktop -- --server 192.168.1.9:3000     # 换成局域网服务器
npm run client:android -- --server 192.168.1.9:3000
npm run client:desktop -- --portable                    # 单文件便携 exe（启动慢，见 §4）
npm run client:desktop -- --skip-install                # 不自动 npm install
npm run client:android -- --release                     # 未签名 release APK
node tools/package-client.mjs --game D:\gits\Stronghold-Protocol --out D:\client-www
```

`--dir` 仍被接受，但它现在就是默认值（目录版）。

`--server` 接受 `host`、`host:port`、`http(s)://…`、`ws(s)://…`。私有地址（`localhost`、`127.*`、`10.*`、`192.168.*`、`172.16–31.*`）自动用 `ws://`，其余用 `wss://`。

`--game` 指定游戏仓库 checkout（也可以设环境变量 `SP_GAME_ROOT`，或改 `client.config.json` 的 `gameRoot`）。

网页版也可以临时改服务器：`https://<你的站点>/?server=192.168.1.9:3000`（只对本次会话生效）。

## 4. 桌面版

| 文件 | 说明 |
|---|---|
| `desktop/main.mjs` | Electron 主进程：起本地静态服务、开窗口、外链走系统浏览器、F2（选择服务器）/ F11 / F5 / F12 快捷键、`--choose-server`、`--insecure-tls`（接受自签证书，仅桌面版、默认关） |
| `desktop/serve.mjs` | 只监听 `127.0.0.1` 的静态服务，默认端口 `DEFAULT_PORT`（47821，见 §4.4）；MIME 表与游戏仓库 `server/index.js` 一致，由 `test/packaging.test.js` 锁定 |
| `desktop/package.json` | electron / electron-builder 与打包配置（`extraResources` 把 `build/client/www` 放进 `resources/www`；`electronLanguages` 只保留 `zh-CN`/`en-US`） |
| `desktop/icon.ico` | 应用图标（取自客户端自带的盾牌图标） |

### 4.1 产物形态：默认目录版，不是单文件

```
build/desktop/win-unpacked/     ← 分发这个目录
  StrongholdProtocol.exe        234 MB   ← Electron 本体（改名 + 图标 + 版本信息）
  resources/www/                265 MB   ← 游戏 payload（素材与代码，见 §1）
  locales/                      ~2 MB    ← 只留 zh-CN / en-US（默认 55 个语言包约 48 MB）
  *.dll, *.pak, *.bin           ~80 MB   ← Chromium / V8 运行时（一个都不能少）
```

| 形态 | 体积 | 启动到首屏 | 说明 |
|---|---|---|---|
| **目录版（`npm run client:desktop`）** | 585 MB | **约 0.3 s** | 双击 `win-unpacked/StrongholdProtocol.exe` |
| 目录版打成 zip 分发 | 321 MB | 解压一次后同上 | 资源管理器右键"压缩到 zip"即可（本机实测：585 MB → 321 MB，28 s） |
| 单文件 `--portable` | 261 MB | **约 24 s** | 每次启动都把整包解压到 `%TEMP%`（本机实测解压 389 MB 时已用 14 s） |

分发就用**目录版 + 手动 zip**：下载 321 MB，解压一次，之后每次启动都是 0.3 s。单文件只小 60 MB，却要每次启动等你 24 s，所以它退成了 `--portable` 选项（`desktop/` 里也有 `npm run pack:portable`）。

> 让 zip 更小：装了 [7-Zip](https://www.7-zip.org/) 的话用 `7z a -mx=9 dist.7z build/desktop/win-unpacked`，LZMA2 通常比 zip 再小 10~15%，但要收件人装 7-Zip 才能解。

### 4.2 运行参数

`StrongholdProtocol.exe --server <地址>`、`--choose-server`、`--fullscreen`、`--insecure-tls`；快捷键 F2（选择服务器）/ F11 / F5 / F12。开发时：

```bash
node tools/package-desktop.mjs --skip-install   # 先生成 build/client/www
cd desktop && npm start
```

#### 自签证书的服务器（首次信任 / trust-on-first-use）

玩家自己开的服务器常常挂在 frp 隧道或反向代理后面，证书是自签的（SakuraFrp 的"自动 TLS"就是），Chromium 会直接拒绝（`ERR_CERT_AUTHORITY_INVALID`）。桌面壳因此**按服务器**做一次询问，而不是关掉校验：

1. `certificate-error` 拦下这次失败（`desktop/main.mjs` → `desktop/trust.mjs`）；
2. 弹窗给出 **域名 + 证书主题 + SHA-256 指纹**，并写明跳过的风险；
3. 点"仍然连接"→ 记住这台服务器的**这张证书**（`%APPDATA%\StrongholdProtocol\trusted-certs.json`，形如 `{"frp-boy.com:60751":"sha256/…"}`）→ 连接继续，以后静默直连；
4. 点"取消"→ 本次不连，且这一页不再弹（页面重载或切换服务器后会再问一次）。

要点：

- **其它服务器、其它请求照常严格校验**——和 `ignore-certificate-errors` 那种全局关闭不一样；
- 证书**换了**（指纹不同，例如隧道换节点重新签）会再问一次，而不是默默放行；
- 想撤销：删掉 `trusted-certs.json` 里的那一行（或整个文件）；
- `--insecure-tls` = 不再询问，对所有证书直接放行（日志里会留一行说明）。只给"自己开服、不想被问"的人用；
- 排错时看 `client.log`：`the certificate of <host> is not trusted … asking the player` / `player trusted … ` / `player declined …`。

Android 版是同一套策略，见 §5。

### 4.3 崩溃与日志

壳没有控制台在前台，所以一切异常都写进日志文件：

```
%APPDATA%\StrongholdProtocol\client.log        （1 MB 自动清空；启动时也会打印到 stderr）
C:\Users\<你>\AppData\Roaming\StrongholdProtocol\client.log
```

玩家反馈"客户端突然消失"时，让他把这个文件发过来。

壳对下面这些情况**不再退出**（以前任何一条都会让整个应用消失，看起来就是"闪退"）：

| 情况 | 现在的行为 |
|---|---|
| 渲染进程崩溃（GPU/内存，`render-process-gone`） | 记录原因（`reason=crashed/oom`）并**自动重载页面**；会话由服务器记住，玩家回到原来的界面 |
| 主进程未捕获异常 / 未处理的 Promise 拒绝 | 记录日志并继续运行（不再静默退出） |
| 首屏 `loadURL` 失败 | 记录日志，保留窗口 |
| 页面无响应（`unresponsive`） | 记录日志 |

> 排查 "打开某个界面就闪退"：先看 `client.log` 里有没有 `renderer gone: reason=…`。有 → 是渲染进程崩了（现在会自动恢复，原因也记下来了）；没有 → 是整个进程被别的东西结束了（例如**已有实例在跑**：单实例锁会让新启动的进程直接退出，`client.log` 里会有 `another instance was launched`）。

### 4.4 本地缓存（重启后不丢干员调配 / 登录 / 设置）

游戏把身份续连 token（`sp.tokens`）、干员调配（`sp.pref.loadout`）、设置（`sp.pref.settings`）等存在浏览器 `localStorage` 里，而 **`localStorage` 是按"源"（origin）隔离的**。壳把 payload 挂在 `http://127.0.0.1:<port>` 上，所以端口必须每次启动都一样：

| | 端口 | 源 | 重启后 |
|---|---|---|---|
| 以前 | `0`（系统每次随机分配） | `http://127.0.0.1:53471` → 下次 `http://127.0.0.1:58203` | 换了源 → 读回空值，看起来像"重装了一遍"：要重新登录、干员调配和设置都没了 |
| 现在 | `DEFAULT_PORT` = 47821（固定） | 每次都是 `http://127.0.0.1:47821` | 同一个源 → `localStorage` 原样读回 |

47821 被占用时按 `47821, 47822, …` **固定顺序**往后找（`serve.mjs` 的 `PORT_SEARCH`），顺序固定意味着下一次启动仍落在同一个端口，源依旧不变；只有这一小段端口全被占满才会退回随机端口（`client.log` 会有 `loopback port … is in use` 提示）。

Android 不需要这个处理：Capacitor 固定从 `https://localhost` 提供页面（`mobile/capacitor.config.json` 的 `androidScheme: https`），源本来就是稳定的，`localStorage` 随应用数据一起保留。

## 5. Android 版（apk）

| 文件 | 说明 |
|---|---|
| `mobile/capacitor.config.json` | `appId` / `appName`；`webDir` = `../build/client/www`；`android.allowMixedContent` = `true`（见下） |
| `mobile/android/` | Capacitor 生成的 Gradle 工程（可提交；`assets/public` 与 `local.properties` 已在 `.gitignore` 里忽略） |
| `mobile/android/app/src/main/AndroidManifest.xml` | `usesCleartextTraffic`（局域网 `ws://` 需要；默认仍是 `wss://`）、`screenOrientation="sensorLandscape"` |
| `mobile/android/app/src/main/res/values/styles.xml` | `windowLayoutInDisplayCutoutMode=shortEdges`（不这样系统会在横屏把窗口 letterbox，刘海那条就是左边的黑边） |
| `mobile/android/app/src/main/java/.../MainActivity.java` | 全屏：`setDecorFitsSystemWindows(false)` + 隐藏 system bars（划一下仍能唤出），失焦后重新隐藏 |

### 全屏与手机显示（两个独立问题）

**黑边**：模板给的主题既不让窗口使用刘海区，也没隐藏状态栏 / 导航栏。于是横屏时左边是刘海被 letterbox 出来的黑带，上/下是系统栏（游戏仓库 `test/ui/playtest5-ui.e2e.test.js` 里就记录着这台机器的实测：`2772×1272` 截图、页面 `756×366`、右侧 `141 px` 黑带 = DPR 3.48 下约 41 CSS px）。现在窗口画进刘海区、系统栏隐藏——游戏自己的 `css/devices.css` 已经把 HUD 放在 `env(safe-area-inset-*)` 里，所以这样是安全的。

**准备阶段场景过小**：横屏手机只有 ~366 px 高，而游戏用根字号缩放整个 HUD（`css/theme.css`：`clamp(40px, min(100vw/19.2, 100vh/10.8), 240px)`），`100vh/10.8 ≈ 33.9` 被 **40 px 下限**抬到 40，HUD 就比桌面相对高一截；准备阶段的镜头要避开 HUD（`js/ui/fieldHost.js hudBands` → `js/render/projection.js clearHud`），只能把场景缩小。`shell/display.css`（payload 里是 `/css/shell-display.css`，由补丁挂在 `css/devices.css` 之后）在 `orientation: landscape and max-height: 480px` 下用同一公式、去掉下限，比例回到桌面水平；自动战斗的镜头没有 HUD 约束，所以之前只有准备阶段显得小。

实测（`dev/game-mock.html?phase=PREP`，数字是每个备战格的屏幕像素，桌面基准 122 px；同一次测量还确认备战/临时/后排格在所有视口下 100 % 不被 HUD 遮挡）：

| 视口 | rem | 备战格 px（改前 → 改后） |
|---|---|---|
| 756×366 | 40 → 33.9 | 35 → 41.5（+19 %） |
| 798×366 + 41 px 刘海 | 40 → 33.9 | 35 → 41.5（+19 %） |
| 800×360 | 40 → 33.3 | 33.8 → 40.8（+21 %） |
| 915×412 | 40 → 38.1 | 44.5 → 46.7（+5 %） |
| 1920×1080 桌面 | 100 → 100 | 122.3 → 122.3（不变） |

> 桌面 / 平板不受影响：那些视口 `min(w/19.2, h/10.8) ≥ 40`，覆盖规则等于没写。真机上"系统栏是否消失、刘海是否被填满"需要装到手机上看（本仓库没有模拟器镜像），浏览器侧的比例是按上面这套测量的。

**选择页在手机上也要缩小**：选择页（`shell/picker.js`）是客户端自带的覆盖层，px 排版、不跟游戏的根字号缩放，所以在 366 px 高的横屏手机上原来和桌面一样大。现在 `shell/picker.js` 的 `@media (max-height:520px),(max-width:560px)` 把标题 / 模式按钮 / 卡片 / 按钮 / 表单整体缩小（756×366 实测：整块菜单 217 px 高，一屏放得下；桌面 1920×1080 不变）。

**自签证书的服务器**：Android 用同一套"首次信任"策略，实现是 `MainActivity` 里给 Capacitor 的 `BridgeWebViewClient` 加一个子类、只覆盖 `onReceivedSslError`（不清掉 Capacitor 自己的 client，本地 payload 与 JS 桥照常），证书信息与指纹在 `TrustedCerts.java`（`SslCertificate.getX509Certificate()` 是 API 29+，24–28 走 `SslCertificate.saveState` 的 `x509-certificate` 字节）。弹窗显示域名 + 证书主题 + SHA-256 指纹，"仍然连接"后按 `主机 = 指纹` 存进应用私有 `SharedPreferences`（`stronghold_trusted_certs`），之后静默直连；**其它服务器照常校验**，证书换了指纹变了会再问一次。Android 没有 `--insecure-tls` 那种"全部放行"的开关。

**关于 `allowMixedContent`**：WebView 的页面本身是 `https://localhost`（`androidScheme`），而自建的局域网服务器只有 `ws://`（没有证书），Chromium 会把它当 mixed content 拦掉——`usesCleartextTraffic` 只管系统层的明文策略，管不了这个。所以 APK 里打开了 `allowMixedContent`，让选择服务器页里的 `ws://<局域网地址>:3000` 能用。**代价**：这一层保护没了，页面里的其他连接也可以降级到明文；官方服务器仍然走 `wss://`。不想要局域网联机的话，把 `mobile/capacitor.config.json` 改回 `false` 重新打包即可（`localhost` 属于"可信来源"，不受影响）。

产物：`mobile/android/app/build/outputs/apk/debug/app-debug.apk`（debug 签名，可直接安装）。安装：`adb install -r <apk>`，或把 APK 拷到手机点开（需允许「安装未知应用」）。

发布用的 release APK 需要自己签名：

```bash
keytool -genkeypair -keystore stronghold.jks -alias stronghold -keyalg RSA -keysize 2048 -validity 10000
# 在 mobile/android/app/build.gradle 里加 signingConfigs 并让 release 用它，然后：
node tools/package-android.mjs --release
```

### 首次准备 Android SDK

如果机器上没有 SDK（`ANDROID_HOME` 不存在）：

```powershell
# 1. 下载并解压 cmdline-tools 到 %LOCALAPPDATA%\Android\Sdk\cmdline-tools\latest
#    （zip 里是 cmdline-tools/ 目录，解压后改名为 latest）
$sdk = "$env:LOCALAPPDATA\Android\Sdk"
curl.exe -L -o "$sdk\cmdline-tools.zip" https://dl.google.com/android/repository/commandlinetools-win-16111833_latest.zip
tar -xf "$sdk\cmdline-tools.zip" -C "$sdk"; Move-Item "$sdk\cmdline-tools" "$sdk\cmdline-tools-latest"
New-Item -ItemType Directory -Force "$sdk\cmdline-tools" | Out-Null
Move-Item "$sdk\cmdline-tools-latest" "$sdk\cmdline-tools\latest"

# 2. 装依赖包。注意：在 PowerShell 里 `platforms;android-36` 的分号会被拆开，
#    用 --package_file 最稳（每行一个包名）。
$env:JAVA_HOME = "C:\Program Files\Java\jdk-21"
"platform-tools`nplatforms;android-36`nbuild-tools;36.0.0" | Set-Content -Encoding ASCII packages.txt
& "$sdk\cmdline-tools\latest\bin\sdkmanager.bat" --sdk_root="$sdk" --package_file=packages.txt
& "$sdk\cmdline-tools\latest\bin\sdkmanager.bat" --sdk_root="$sdk" --licenses   # 全部输入 y

# 3. 持久化环境变量
[Environment]::SetEnvironmentVariable('ANDROID_HOME', $sdk, 'User')
[Environment]::SetEnvironmentVariable('JAVA_HOME', $env:JAVA_HOME, 'User')
```

macOS / Linux 同理，把 `commandlinetools-win` 换成 `commandlinetools-mac` / `commandlinetools-linux`，SDK 默认在 `~/Library/Android/sdk` / `~/Android/Sdk`。`tools/package-android.mjs` 会自己找 `ANDROID_HOME` / `ANDROID_SDK_ROOT` / 默认目录，并写 `mobile/android/local.properties`。

## 6. 选择游戏模式 / 服务器（进游戏前）
打包客户端里多了一个 Minecraft 风格的菜单（`shell/picker.js` + `shell/picker-core.js`，被复制成 payload 里的 `/js/shell/*`），它在 `/js/main.js` 之前执行、盖住启动画面，把选择写进 `localStorage`（`sp.shell.*`）后重载页面。`js/net.js` 只认 `globalThis.__SP_SERVER__`，菜单只是给它赋值，所以不需要再改游戏源码。

| 行为 | 说明 |
|---|---|
| 主页 | 上下两个选项：**单人游戏**（预留——大厅 / 房间 / 模拟都在服务端，暂无"纯前端单机"实现，点击只给提示）、**多人游戏** |
| 多人页 | 服务器列表 + **添加服务器**（名称 + 地址）、**直接连接**（只填地址，连上后不保存进列表）、**编辑**（改选中的自建服务器；内置与打包默认服不可改）、**刷新**（重新测一遍所有延迟，放在"返回"左边）、**返回** |
| 地址写法 | `host`、`host:port`、`http(s)://…`、`ws(s)://…`，不用手写协议：不带协议时带端口的按 `ws://` 猜（`:443` 除外），公网域名默认 `wss://`；猜的协议不通会自动换另一种再试，命中后把那个地址存进 `sp.shell.server`（`shell/picker-core.js` 的 `ambiguousScheme` 决定哪些地址需要双协议探测） |
| 列出的服务器 | 内置 `本机 / 局域网 localhost:3000`（官方远程服已下线）；`--server` 打包指定的地址会标"默认"；玩家自己添加的服务器（按 `js/net.js` 的 `toWsUrl()` 归一化，存在客户端本地；旧的"只存地址字符串"列表在读取时会升级成 `{name, address}`） |
| 探测 | 直接开一条 `/ws` 连接（和游戏同一条通道，因此不依赖服务器 CORS），失败重试一次；绿点 = 真的能连进去。若服务器给 `/healthz` 加了 `Access-Control-Allow-Origin`，还会显示 `v<app> · 在线 n · 房间 n`（不加只是少一行信息，控制台会有一条 CORS 报错，页面已忽略） |
| 记住上次 | 桌面端勾"记住并直接进入"后下次直接进游戏；想换服务器按 **F2**，或用 `--choose-server` 启动。Android 没有 F2，所以每次都显示、默认不记住（否则玩家换了服务器就回不去了） |
| 优先级 | `--server <地址>`（本次运行）> `?server=<地址>` > 菜单记住的地址 > 打包默认地址 |
| 网页版 | 没有这个页面（浏览器版的服务器永远是自己所在的站点） |

改动菜单后跑一遍 `test/picker.test.js`（规则单测，含 `customFrom` 的旧格式迁移）。DOM 那半边没有自动化测试，改动后请手动确认：桌面 `cd desktop && npm start`，Android 装 APK 后首启。

## 7. 服务器公告（`app.notice`）

服务端可以把一条公告推给所有在线玩家（"服务器 23:30 维护重启"），客户端在**任何界面**顶部显示一条胶囊，**标题页也显示**——玩家还没进大厅就能看到。

**发公告的地方在游戏仓库**（打包仓库不参与）：`server/notice.js` 轮询一个文件，`scripts/notice.mjs` 是操作命令，完整用法见游戏仓库的 [docs/DEPLOY.md §6](https://github.com/sganggs/Stronghold-Protocol/blob/master/docs/DEPLOY.md)。发公告**不需要重启服务器**。

```bash
# 在游戏仓库的服务器上
node scripts/notice.mjs --kind maintenance --for 30m "30 分钟后维护重启，预计 5 分钟"
node scripts/notice.mjs --clear        # 撤回
```

打包客户端要**重新打包**才能显示公告：

- 客户端代码（`public/js/ui/noticeBanner.js`、`main.js`、`css/components.css`）跟着 `public/**` 打进 payload，所以旧的 exe/apk 里没有这个横幅；
- 旧客户端收到未知的 S2C 类型只是没有监听器（`net.js` 按 `t` 分发，不会报错），会**安静地忽略**它——不会崩，但也看不到；
- 网页端由服务器直接提供文件，服务器一升级就生效，不需要重新打包。

验证（本仓库的流程）：`node tools/package-client.mjs` 后启动本地服务器并 `node scripts/notice.mjs "测试"`，用 `--server 127.0.0.1:3000` 启动 exe/apk 应当看到横幅出现/消失。实测：打包好的 exe 在公告发布后立刻显示「维护」胶囊，`--clear` 后消失。

## 8. 与游戏仓库的关系（契约）与打包内容

游戏仓库（`Stronghold-Protocol`）**只读**：本仓库从它读源码，从不修改它（`git status` 永远是干净的，`git pull` 不会冲突）。

| 文件 | 作用 |
|---|---|
| `client.config.json` | `gameRoot`（默认 `../Stronghold-Protocol`）与 `defaultServer` |
| `tools/game-contract.mjs` | 复制了游戏仓库的 `DATA_SHIM_JS` 与 `SIM_PRIVATE`（这样构建不需要在游戏仓库里 `npm install`）；每次构建都对照 `server/index.js` 校验，不一致直接报错 |
| `patches/game-client.patch` | 打在 payload 上的客户端改动（3 个文件、6 个 hunk，§1.2、§6）。它是 `git diff` 出来的普通补丁，由 `tools/unified-diff.mjs` 应用（不依赖 git）；**上游改了这个文件里的任一文件 → 补丁对不上 → 构建失败**，此时需要重新生成补丁 |
| `build/client/manifest.json`、payload 里的 `build.json` | 记录这次构建基于的游戏版本：`git describe` + commit + `PROTOCOL_VERSION` |

| | 打包进去什么 |
|---|---|
| 打包 | `public/**`（含 `assets`、`fonts`、`vendor`）、`data/**`、`shared/**`、`server/sim/**/*.js`（去掉 Node 专用的 `nodeData.js`）、生成的 `data.js` / `build.json` / `js/runtime-config.js` / `js/shell/picker.js` / `js/shell/picker-core.js`、`local-assets.json`（没做本地提取时给空清单）、打补丁后的 `index.html` / `js/net.js` / `js/screens/room.js` |
| 不打包 | 游戏仓库的 `server/` 其余部分（HTTP / WS / 大厅 / 对局引擎）、`docs/`、`test/`、`.cache/`、`.tools/`、`node_modules/` |

`tools/package-client.mjs` 是**增量**的：文件大小与修改时间没变就跳过，源文件删掉后产物里的对应文件也会被删——重建很快（第二次通常 0 个文件被写入）。

## 9. 排错

| 现象 | 处理 |
|---|---|
| 弹窗「客户端资源缺失」 | 先运行 `npm run client:build` |
| 报「找不到游戏仓库」 | 用 `--game <目录>`、`SP_GAME_ROOT` 或 `client.config.json` 的 `gameRoot` 指定 checkout |
| 报 `hunk … does not match` / 补丁没改到文件 | 上游改了 `public/index.html`、`js/net.js` 或 `js/screens/room.js`：按新源码重新生成 `patches/game-client.patch`，再跑一次 |
| 选择服务器页里全部"无法连接" | 地址写错、服务器没开、或防火墙拦了 `/ws`；本机测试用 `npm start` 起游戏仓库（默认 3000），页面上的 `localhost:3000` 会变绿 |
| 选择页每次启动都出现 / 想换服务器 | 桌面按 **F2**（或 `--choose-server`），取消勾选"记住并直接进入"；Android 每次都会问 |
| 重启后要重新登录 / 干员调配、设置被清空 | 旧版本客户端每次启动都换随机端口（换了源，`localStorage` 读不回来）：重新 `npm run client:desktop` 生成固定 `DEFAULT_PORT`（47821）的客户端，见 §4.4 |
| Android 上局域网地址连不上 | 先确认 APK 是打开 `allowMixedContent` 打的（§5）；地址用 `192.168.x.x:3000` 这种形式，手机与服务器要在同一个 Wi-Fi |
| 报 `DATA_SHIM_JS changed upstream` / `SIM_PRIVATE is now […]` | 游戏仓库那两处变了：同步 `tools/game-contract.mjs` |
| 打包后的客户端里图片 / 音频 404 | 游戏仓库的 `public/assets` 不完整：在那边 `npm run assets` |
| 连不上服务器 | 先确认服务器活着：`curl http://localhost:3000/healthz`；再用 `--server 127.0.0.1:3000` 指向本地 `npm start` 排除客户端问题。远程服务器同理，换成对应地址 |
| 提示「客户端版本与服务器不一致」 | 服务器更新过，重新打包客户端 |
| APK 报找不到 SDK / JDK | 检查 `ANDROID_HOME`、`JAVA_HOME`、`mobile/android/local.properties`；platform / build-tools 版本要匹配 `mobile/android/variables.gradle`（当前 36） |
| `sdkmanager` 报 “Package platforms not found” | 分号被 shell 拆开了，改用 `--package_file`（见 §5） |
| 想换服务器但不重新打包 | 桌面：选择服务器页按 F2（或启动时 `--choose-server`）、或 `StrongholdProtocol.exe --server <地址>`；Android：启动时的选择服务器页；网页：`?server=<地址>` |
| 桌面客户端启动很慢（几十秒） | 用的是单文件 `--portable`：它每次启动都要解压整包到 `%TEMP%`。改用默认的目录版（`win-unpacked/`），启动只要零点几秒 |
| 桌面客户端弹窗报缺少 DLL / 打不开 | 目录版必须整个文件夹一起拷贝，不能只拿 `StrongholdProtocol.exe`（运行时 DLL 与 `resources/` 在旁边） |
| APK 里左侧有黑边 / 上下有黑边 | 装的是旧 APK：现在的主题让窗口画进刘海区（`shortEdges`）并隐藏系统栏（`MainActivity` immersive）。重新 `npm run client:android` |
| 手机横屏时准备阶段场景偏小 | 旧 APK：`shell/display.css` 去掉根字号 40 px 下限后，准备阶段和战斗、和桌面同一个比例（见 §5 的实测表） |
| 用 puppeteer 量桌面壳时窗口总是 800×600 | puppeteer 的默认视口覆盖了真实窗口尺寸：`puppeteer.connect({ browserURL, defaultViewport: null })` |

## 10. 部署与重启（服务器侧）

线上跑的是 systemd 单元 `stronghold.service`（starst.site）：

```
WorkingDirectory=/home/ubuntu/webUI/Stronghold-Protocol
Environment=HOST=127.0.0.1  PORT=3000  SP_COMBAT=client  SP_VERIFY=off   # nginx 反代对外
ExecStart=/usr/bin/node server/index.js        ← 没有 --watch
Restart=always / RestartSec=3 / KillSignal=SIGINT / TimeoutStopSec=20
```

**什么要重启**：`server/**`、`shared/**`、`server/sim/**`（启动时 `import` 进内存）和 `data/*.json`（`server/data.js` 的 `getData()` 是单例）**都要重启**；`public/**` 不用——每次请求都 `fs.stat` + 读盘。仓库里没有任何 `fs.watch` / nodemon，`Restart=always` 只在进程崩了时拉起它。

**push 会不会自动生效**：starst.site 上已经装好 `post-receive` 钩子（`receive.denyCurrentBranch=ignore`）——**`git push workplace master` 就是部署**：公告 → 重启 → 校验 `/healthz` → 撤公告，日志直接打在你这次 push 的输出里，失败会自动回滚。脚本、安装方式、配置项和排错见 **[DEPLOY-SERVER.md](./DEPLOY-SERVER.md)**。**不要**再同时装 systemd 定时器（会重启两次）。仓库与远程的现状：

| 位置 | 指向 | 说明 |
|---|---|---|
| 本地 `origin` | `git@github.com:Starst796/Stronghold-Protocol` | 你的 fork，SSH 推送正常 |
| 本地 `upstream` | `https://github.com/sganggs/Stronghold-Protocol.git` | 上游项目（开发机直连 github.com:443 会超时） |
| 本地 `workplace` | `ubuntu@starst.site:/home/ubuntu/webUI/Stronghold-Protocol` | 服务器工作目录。**非裸仓库**、`master` 正被检出；已设 `receive.denyCurrentBranch=ignore` + 装了 post-receive 钩子 → **push = 部署** |
| 服务器 `origin` | `https://gh-proxy.com/https://github.com/sganggs/Stronghold-Protocol.git` | 服务器只跟**上游**同步（钩子模式下会显得"落后"，正常） |

一次发版 = 两次 push（`origin` 留档、`workplace` 部署）：

```bash
git push origin master        # 给别人看 / 开 PR
git push workplace master     # 部署（公告会等 --lead 秒，默认 60）
```

**重启会掉什么**：全部。会话 / 房间 / 对局都在内存里（`SessionRegistry` + `Lobby`），没有任何持久化。优雅停机会给每个房间发 `room.closed{reason:'shutdown'}`、socket 以 **1001** 关闭；客户端会自动重连（只有 4001「被顶替」不重连），但重启后注册表是空的 → `byToken()` 查不到 → **新建会话**（`resumed:false`，新 `playerId`）。昵称在客户端 `localStorage` 里所以还在，**房间与进行中的对局不恢复**（`reconnectWindowMs: 10 分钟` 只对"服务器活着、只是网络抖一下"有效）。停机时长 ≈ **5 秒**（优雅收尾 <1 s + `RestartSec=3` + 启动约 0.6 s，本机实测 `start → /healthz` 200 = 626 ms）。

**一个坑**：`data/assets.json` 是被跟踪的文件，而服务器上的进程会改写它（`git status` 里常驻 ` M data/assets.json`）。钩子的 `git reset --hard` 会把它一起清掉，所以自动发版不受影响；但如果你在服务器上手动 `git pull`，先 `git checkout -- data/assets.json` 再拉。

## 11. 查服务器忙不忙（挑空窗）

`/healthz` 是公开的，`tools/server-status.mjs` 把它变成能"蹲空窗"的工具：

```bash
npm run server:status                                  # 一次采样
npm run server:status -- --watch                       # 每 60 秒采样，每 10 次汇总（min/max/均值 + 最空时刻）
npm run server:status -- --watch --under 40            # 等到 humans ≤ 40 就打印"可以动手"并退出 0
npm run server:status -- --samples 20 --interval 30    # 采 20 次（10 分钟）后退出
npm run server:status -- --json                        # 原始 JSON，喂给别的脚本
```

字段：`humans` = 真人占座（最该看的）、`matches` = 进行中的对局、`rooms`、`sockets` = 打开的连接、`sessions` = 注册表里的会话（含 10 分钟重连窗口内已断开的，所以通常 ≥ sockets）、`uptimeSec` = 进程运行时长（重启后应归零，用来确认部署生效）。

## 12. 素材与许可
打包产物里包含《明日方舟》的美术 / 音频素材，版权归鹰角网络 / Yostar，**不适用**本仓库的 GPL-3.0，仅限个人非商业自用；请勿再分发这些素材或包含它们的整合包（见游戏仓库的 [声明](https://github.com/sganggs/Stronghold-Protocol#声明) 与 [NOTICE.md](https://github.com/sganggs/Stronghold-Protocol/blob/master/NOTICE.md)）。

## 13. 一键发布（`package.bat` / `package.sh`）

上游（`../Stronghold-Protocol`）更新后，**手动跑一次**这个入口，把"对齐版本号 → 测试 → 打包 → 提交"串起来：

```bat
package.bat                        :: Windows（双击或命令行都行）
```

```bash
./package.sh                       # Linux / macOS / Git Bash
npm run release                    # 等价，前提是 node 在 PATH 上
```

它按顺序做四件事（实现在 `tools/package-release.mjs`）：

1. 从上游 `shared/constants.js` 读 `APP_VERSION`（顺带 `PROTOCOL_VERSION`）；
2. 把本仓库的版本字段对齐到它：`package.json`（根 / `desktop/` / `mobile/`）、`desktop/package-lock.json` 与 `mobile/package-lock.json` 的根 + `packages[""]`（只动这两处，npm 传递依赖保持原样）、`mobile/android/app/build.gradle` 的 `versionName` 与 `versionCode`（语义化版本换算：`0.1.2` → `102`）；
3. 跑 `node --test`，再调 `tools/package-desktop.mjs` 出目录版并压成 `build/dist/StrongholdProtocol-<版本>-win-x64.zip`，接着调 `tools/package-android.mjs` 把 APK 拷成 `build/dist/StrongholdProtocol-<版本>-android-debug.apk`；
4. 在本仓库 `git add -A` + `git commit`（`build/` 已 gitignore，产物不会进库）。

常用开关：

```bash
package.bat --server 192.168.1.9:3000     # 把默认服务器换成局域网地址
package.bat --no-commit                   # 只对齐 + 打包，不提交
package.bat --skip-android                # 不打 APK
package.bat --no-zip                      # 只留 win-unpacked 目录，不压缩
package.bat --no-test --skip-install      # 赶时间
package.bat --portable                    # 桌面改出单文件便携 exe
```

说明：

- **不修改游戏仓库**：上游版本只读；补丁 / payload / 壳都在本仓库完成。
- 上游改了 `public/index.html`、`js/net.js`、`js/screens/room.js` 时补丁会先失败（这是设计好的报警）：按 §9 重新生成 `patches/game-client.patch` 再跑。
- 缺 JDK 17+ / Android SDK 时脚本**跳过 APK 并继续**（只报一句警告）。本机实测可用 `C:\Program Files\Java\jdk-21` 与 `%LOCALAPPDATA%\Android\Sdk`，脚本会自己找。
- Windows 下 zip 用系统自带的 `tar -a`（bsdtar）；想要更小就自己用 7-Zip 的 LZMA2（见 §4.1）。
