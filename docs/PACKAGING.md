# 打包客户端（exe / apk）

把浏览器客户端和本机素材打进**桌面 / Android 可执行文件**：素材和代码从本地读取，房间、回合、联机仍然连远程服务器——默认 **`game.starst.site`**。

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

网页版也可以临时改服务器：`https://game.starst.site/?server=192.168.1.9:3000`（只对本次会话生效）。

## 4. 桌面版

| 文件 | 说明 |
|---|---|
| `desktop/main.mjs` | Electron 主进程：起本地静态服务、开窗口、外链走系统浏览器、F2（选择服务器）/ F11 / F5 / F12 快捷键、`--choose-server` |
| `desktop/serve.mjs` | 只监听 `127.0.0.1` 的静态服务（MIME 表与游戏仓库 `server/index.js` 一致，由 `test/packaging.test.js` 锁定） |
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

`StrongholdProtocol.exe --server <地址>`、`--choose-server`、`--fullscreen`；快捷键 F2（选择服务器）/ F11 / F5 / F12。开发时：

```bash
node tools/package-desktop.mjs --skip-install   # 先生成 build/client/www
cd desktop && npm start
```

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

## 6. 选择服务器（进游戏前）

打包客户端里多了一个**选择服务器页**（`shell/picker.js` + `shell/picker-core.js`，被复制成 payload 里的 `/js/shell/*`），它在 `/js/main.js` 之前执行、盖住启动画面，把选择写进 `localStorage`（`sp.shell.*`）后重载页面。`js/net.js` 只认 `globalThis.__SP_SERVER__`，选择页只是给它赋值，所以不需要再改游戏源码。

| 行为 | 说明 |
|---|---|
| 列出的服务器 | `官方服务器 game.starst.site`（`--server` 打包指定的地址会标"默认"）、`本机 / 局域网 localhost:3000`，以及玩家自己添加的地址（`host`、`host:port`、`http(s)://…`、`ws(s)://…`，按 `js/net.js` 的 `toWsUrl()` 归一化，存在客户端本地） |
| 探测 | 直接开一条 `/ws` 连接（和游戏同一条通道，因此不依赖服务器 CORS），失败重试一次；绿点 = 真的能连进去。若服务器给 `/healthz` 加了 `Access-Control-Allow-Origin`，还会显示 `v<app> · 在线 n · 房间 n`（不加只是少一行信息，控制台会有一条 CORS 报错，页面已忽略） |
| 记住上次 | 桌面端勾"记住并直接进入"后下次直接进游戏；想换服务器按 **F2**，或用 `--choose-server` 启动。Android 没有 F2，所以每次都显示、默认不记住（否则玩家换了服务器就回不去了） |
| 优先级 | `--server <地址>`（本次运行）> `?server=<地址>` > 选择页记住的地址 > 打包默认地址 |
| 网页版 | 没有这个页面（浏览器版的服务器永远是自己所在的站点） |

改动选择页后跑一遍 `test/picker.test.js`（规则单测）。DOM 那半边没有自动化测试，改动后请手动确认：桌面 `cd desktop && npm start`，Android 装 APK 后首启。

## 7. 与游戏仓库的关系（契约）与打包内容

游戏仓库（`Stronghold-Protocol`）**只读**：本仓库从它读源码，从不修改它（`git status` 永远是干净的，`git pull` 不会冲突）。

| 文件 | 作用 |
|---|---|
| `client.config.json` | `gameRoot`（默认 `../Stronghold-Protocol`）与 `defaultServer` |
| `tools/game-contract.mjs` | 复制了游戏仓库的 `DATA_SHIM_JS` 与 `SIM_PRIVATE`（这样构建不需要在游戏仓库里 `npm install`）；每次构建都对照 `server/index.js` 校验，不一致直接报错 |
| `patches/game-client.patch` | 打在 payload 上的客户端改动（3 个文件、4 处，§1.2、§6）。它是 `git diff` 出来的普通补丁，由 `tools/unified-diff.mjs` 应用（不依赖 git）；**上游改了这个文件里的任一文件 → 补丁对不上 → 构建失败**，此时需要重新生成补丁 |
| `build/client/manifest.json`、payload 里的 `build.json` | 记录这次构建基于的游戏版本：`git describe` + commit + `PROTOCOL_VERSION` |

| | 打包进去什么 |
|---|---|
| 打包 | `public/**`（含 `assets`、`fonts`、`vendor`）、`data/**`、`shared/**`、`server/sim/**/*.js`（去掉 Node 专用的 `nodeData.js`）、生成的 `data.js` / `build.json` / `js/runtime-config.js` / `js/shell/picker.js` / `js/shell/picker-core.js`、`local-assets.json`（没做本地提取时给空清单）、打补丁后的 `index.html` / `js/net.js` / `js/screens/room.js` |
| 不打包 | 游戏仓库的 `server/` 其余部分（HTTP / WS / 大厅 / 对局引擎）、`docs/`、`test/`、`.cache/`、`.tools/`、`node_modules/` |

`tools/package-client.mjs` 是**增量**的：文件大小与修改时间没变就跳过，源文件删掉后产物里的对应文件也会被删——重建很快（第二次通常 0 个文件被写入）。

## 8. 排错

| 现象 | 处理 |
|---|---|
| 弹窗「客户端资源缺失」 | 先运行 `npm run client:build` |
| 报「找不到游戏仓库」 | 用 `--game <目录>`、`SP_GAME_ROOT` 或 `client.config.json` 的 `gameRoot` 指定 checkout |
| 报 `hunk … does not match` / 补丁没改到文件 | 上游改了 `public/index.html`、`js/net.js` 或 `js/screens/room.js`：按新源码重新生成 `patches/game-client.patch`，再跑一次 |
| 选择服务器页里全部"无法连接" | 地址写错、服务器没开、或防火墙拦了 `/ws`；本机测试用 `npm start` 起游戏仓库（默认 3000），页面上的 `localhost:3000` 会变绿 |
| 选择页每次启动都出现 / 想换服务器 | 桌面按 **F2**（或 `--choose-server`），取消勾选"记住并直接进入"；Android 每次都会问 |
| Android 上局域网地址连不上 | 先确认 APK 是打开 `allowMixedContent` 打的（§5）；地址用 `192.168.x.x:3000` 这种形式，手机与服务器要在同一个 Wi-Fi |
| 报 `DATA_SHIM_JS changed upstream` / `SIM_PRIVATE is now […]` | 游戏仓库那两处变了：同步 `tools/game-contract.mjs` |
| 打包后的客户端里图片 / 音频 404 | 游戏仓库的 `public/assets` 不完整：在那边 `npm run assets` |
| 连不上服务器 | 先确认服务器活着：`curl https://game.starst.site/healthz`；再用 `--server 127.0.0.1:3000` 指向本地 `npm start` 排除客户端问题 |
| 提示「客户端版本与服务器不一致」 | 服务器更新过，重新打包客户端 |
| APK 报找不到 SDK / JDK | 检查 `ANDROID_HOME`、`JAVA_HOME`、`mobile/android/local.properties`；platform / build-tools 版本要匹配 `mobile/android/variables.gradle`（当前 36） |
| `sdkmanager` 报 “Package platforms not found” | 分号被 shell 拆开了，改用 `--package_file`（见 §5） |
| 想换服务器但不重新打包 | 桌面：选择服务器页按 F2（或启动时 `--choose-server`）、或 `StrongholdProtocol.exe --server <地址>`；Android：启动时的选择服务器页；网页：`?server=<地址>` |
| 桌面客户端启动很慢（几十秒） | 用的是单文件 `--portable`：它每次启动都要解压整包到 `%TEMP%`。改用默认的目录版（`win-unpacked/`），启动只要零点几秒 |
| 桌面客户端弹窗报缺少 DLL / 打不开 | 目录版必须整个文件夹一起拷贝，不能只拿 `StrongholdProtocol.exe`（运行时 DLL 与 `resources/` 在旁边） |
| APK 里左侧有黑边 / 上下有黑边 | 装的是旧 APK：现在的主题让窗口画进刘海区（`shortEdges`）并隐藏系统栏（`MainActivity` immersive）。重新 `npm run client:android` |
| 手机横屏时准备阶段场景偏小 | 旧 APK：`shell/display.css` 去掉根字号 40 px 下限后，准备阶段和战斗、和桌面同一个比例（见 §5 的实测表） |
| 用 puppeteer 量桌面壳时窗口总是 800×600 | puppeteer 的默认视口覆盖了真实窗口尺寸：`puppeteer.connect({ browserURL, defaultViewport: null })` |

## 9. 素材与许可

打包产物里包含《明日方舟》的美术 / 音频素材，版权归鹰角网络 / Yostar，**不适用**本仓库的 GPL-3.0，仅限个人非商业自用；请勿再分发这些素材或包含它们的整合包（见游戏仓库的 [声明](https://github.com/sganggs/Stronghold-Protocol#声明) 与 [NOTICE.md](https://github.com/sganggs/Stronghold-Protocol/blob/master/NOTICE.md)）。
