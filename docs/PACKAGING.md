# 打包客户端（exe / apk）

把浏览器客户端和本机素材打进**桌面 / Android 可执行文件**：素材和代码从本地读取，房间、回合、联机仍然连远程服务器——默认 **`game.starst.site`**。

```
npm run client:desktop      # → build/desktop/StrongholdProtocol-0.1.0-portable.exe（约 260 MB）
npm run client:android      # → mobile/android/app/build/outputs/apk/debug/app-debug.apk
npm run client:build        # 只生成 build/client/www（想用自己的静态托管时用）
```

## 1. 原理

浏览器客户端是按服务器的挂载布局写的（游戏仓库的 `server/index.js`）：`/`→`public/`、`/data/`→`data/`、`/shared/`→`shared/`、`/sim/`→`server/sim/**/*.js`，外加服务器现生成的 `/data.js`（`server/data.js` 的浏览器替身）。打包好的客户端没有 Node 服务器，所以：

1. `tools/package-client.mjs` 把**游戏仓库 checkout** 的这些挂载点**摊平**成一个目录 `build/client/www/`——任何静态文件服务器或 Android WebView 都能直接托管，`/js/...`、`/data/...`、`/sim/...` 这些绝对路径照常解析；顺带生成 `data.js`（垫片）、`js/runtime-config.js`（服务器地址）与 `build.json`（构建来源）。
2. 客户端要连远程服务器，需要 3 处源码级改动：`js/net.js` 的 `defaultWsUrl()` 读 `globalThis.__SP_SERVER__`、`js/screens/room.js` 的邀请链接指向远程网页版、`index.html` 在模块图之前载入 `/js/runtime-config.js`。**这些改动不在游戏仓库里**，而是以 `patches/game-client.patch` 的形式打在 payload 副本上（见 §6），游戏仓库保持与上游逐字节一致。
3. 桌面壳（`desktop/`）用 Electron 起一个**只监听 127.0.0.1** 的静态服务器托管 `www/`，再打开窗口；Android 壳（`mobile/`，Capacitor）把 `www/` 作为原生 assets 打进 APK。

所以：进对局不用再下载约 260 MB 素材，但服务器地址、协议版本仍然跟着远程服务器走。

> 客户端和服务端的协议版本必须一致（游戏仓库 `shared/constants.js` 的 `PROTOCOL_VERSION`）。服务器升级后请重新打包，否则客户端会提示「客户端版本与服务器不一致」。

## 2. 先决条件

| 目标 | 需要 |
|---|---|
| 通用 | Node.js 22 / 24；一个**游戏仓库 checkout**（`Stronghold-Protocol`，默认同级 `../Stronghold-Protocol`，可用 `--game` / `SP_GAME_ROOT` / `client.config.json` 指定），且已 `npm install` + `npm run assets` 下载素材——**没有素材的客户端只是个空壳** |
| exe | 无额外要求（`electron` / `electron-builder` 由 `desktop/` 的 `npm install` 装） |
| apk | JDK 17+（`JAVA_HOME`）、Android SDK（`ANDROID_HOME`）含 `platforms;android-36` 与 `build-tools;36.0.0`、并已接受许可协议（见 §5） |

## 3. 命令与参数

```bash
npm run client:build                                    # 只生成 build/client/www
npm run client:desktop -- --server 192.168.1.9:3000     # 换成局域网服务器
npm run client:android -- --server 192.168.1.9:3000
npm run client:desktop -- --dir                         # 只出 win-unpacked/ 目录（快，便于试跑）
npm run client:desktop -- --skip-install                # 不自动 npm install
npm run client:android -- --release                     # 未签名 release APK
node tools/package-client.mjs --game D:\gits\Stronghold-Protocol --out D:\client-www
```

`--server` 接受 `host`、`host:port`、`http(s)://…`、`ws(s)://…`。私有地址（`localhost`、`127.*`、`10.*`、`192.168.*`、`172.16–31.*`）自动用 `ws://`，其余用 `wss://`。

`--game` 指定游戏仓库 checkout（也可以设环境变量 `SP_GAME_ROOT`，或改 `client.config.json` 的 `gameRoot`）。

网页版也可以临时改服务器：`https://game.starst.site/?server=192.168.1.9:3000`（只对本次会话生效）。

## 4. 桌面版（exe）

| 文件 | 说明 |
|---|---|
| `desktop/main.mjs` | Electron 主进程：起本地静态服务、开窗口、外链走系统浏览器、F11 / F5 / F12 快捷键 |
| `desktop/serve.mjs` | 只监听 `127.0.0.1` 的静态服务（MIME 表与游戏仓库 `server/index.js` 一致，由 `test/packaging.test.js` 锁定） |
| `desktop/package.json` | electron / electron-builder 与打包配置（`extraResources` 把 `build/client/www` 放进 `resources/www`） |
| `desktop/icon.ico` | 应用图标（取自客户端自带的盾牌图标） |

产物：

- `build/desktop/StrongholdProtocol-0.1.0-portable.exe` —— 单文件免安装（首次启动会解压到临时目录，稍慢）。
- `build/desktop/win-unpacked/StrongholdProtocol.exe` —— 目录版，直接双击即可（调试用）。

运行参数：`StrongholdProtocol.exe --server <地址>`、`--fullscreen`。开发时：

```bash
node tools/package-desktop.mjs --skip-install   # 先生成 build/client/www
cd desktop && npm start
```

## 5. Android 版（apk）

| 文件 | 说明 |
|---|---|
| `mobile/capacitor.config.json` | `appId` / `appName`；`webDir` = `../build/client/www` |
| `mobile/android/` | Capacitor 生成的 Gradle 工程（可提交；`assets/public` 与 `local.properties` 已在 `.gitignore` 里忽略） |
| `mobile/android/app/src/main/AndroidManifest.xml` | 已打开 `usesCleartextTraffic`（局域网 `ws://` 需要；默认仍是 `wss://`） |

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

## 6. 与游戏仓库的关系（契约）与打包内容

游戏仓库（`Stronghold-Protocol`）**只读**：本仓库从它读源码，从不修改它（`git status` 永远是干净的，`git pull` 不会冲突）。

| 文件 | 作用 |
|---|---|
| `client.config.json` | `gameRoot`（默认 `../Stronghold-Protocol`）与 `defaultServer` |
| `tools/game-contract.mjs` | 复制了游戏仓库的 `DATA_SHIM_JS` 与 `SIM_PRIVATE`（这样构建不需要在游戏仓库里 `npm install`）；每次构建都对照 `server/index.js` 校验，不一致直接报错 |
| `patches/game-client.patch` | 打在 payload 上的 3 处客户端改动（§1.2）。它是 `git diff` 出来的普通补丁，由 `tools/unified-diff.mjs` 应用（不依赖 git）；**上游改了这 3 个文件 → 补丁对不上 → 构建失败**，此时需要重新生成补丁 |
| `build/client/manifest.json`、payload 里的 `build.json` | 记录这次构建基于的游戏版本：`git describe` + commit + `PROTOCOL_VERSION` |

| | 打包进去什么 |
|---|---|
| 打包 | `public/**`（含 `assets`、`fonts`、`vendor`）、`data/**`、`shared/**`、`server/sim/**/*.js`（去掉 Node 专用的 `nodeData.js`）、生成的 `data.js` / `build.json` / `js/runtime-config.js`、`local-assets.json`（没做本地提取时给空清单）、打补丁后的 `index.html` / `js/net.js` / `js/screens/room.js` |
| 不打包 | 游戏仓库的 `server/` 其余部分（HTTP / WS / 大厅 / 对局引擎）、`docs/`、`test/`、`.cache/`、`.tools/`、`node_modules/` |

`tools/package-client.mjs` 是**增量**的：文件大小与修改时间没变就跳过，源文件删掉后产物里的对应文件也会被删——重建很快（第二次通常 0 个文件被写入）。

## 7. 排错

| 现象 | 处理 |
|---|---|
| 弹窗「客户端资源缺失」 | 先运行 `npm run client:build` |
| 报「找不到游戏仓库」 | 用 `--game <目录>`、`SP_GAME_ROOT` 或 `client.config.json` 的 `gameRoot` 指定 checkout |
| 报 `hunk … does not match` / 补丁没改到文件 | 上游改了 `public/index.html`、`js/net.js` 或 `js/screens/room.js`：按新源码重新生成 `patches/game-client.patch`，再跑一次 |
| 报 `DATA_SHIM_JS changed upstream` / `SIM_PRIVATE is now […]` | 游戏仓库那两处变了：同步 `tools/game-contract.mjs` |
| 打包后的客户端里图片 / 音频 404 | 游戏仓库的 `public/assets` 不完整：在那边 `npm run assets` |
| 连不上服务器 | 先确认服务器活着：`curl https://game.starst.site/healthz`；再用 `--server 127.0.0.1:3000` 指向本地 `npm start` 排除客户端问题 |
| 提示「客户端版本与服务器不一致」 | 服务器更新过，重新打包客户端 |
| APK 报找不到 SDK / JDK | 检查 `ANDROID_HOME`、`JAVA_HOME`、`mobile/android/local.properties`；platform / build-tools 版本要匹配 `mobile/android/variables.gradle`（当前 36） |
| `sdkmanager` 报 “Package platforms not found” | 分号被 shell 拆开了，改用 `--package_file`（见 §5） |
| 想换服务器但不重新打包 | 桌面：`StrongholdProtocol.exe --server <地址>`；网页：`?server=<地址>`。Android 目前需要重新打包 |

## 8. 素材与许可

打包产物里包含《明日方舟》的美术 / 音频素材，版权归鹰角网络 / Yostar，**不适用**本仓库的 GPL-3.0，仅限个人非商业自用；请勿再分发这些素材或包含它们的整合包（见游戏仓库的 [声明](https://github.com/sganggs/Stronghold-Protocol#声明) 与 [NOTICE.md](https://github.com/sganggs/Stronghold-Protocol/blob/master/NOTICE.md)）。
