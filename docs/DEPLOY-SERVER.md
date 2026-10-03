# 服务器部署自动化（自有环境，不进游戏仓库）

游戏仓库（`Stronghold-Protocol`）只保留能上游化的功能——**服务器公告**（`server/notice.js` +
`scripts/notice.mjs` + 客户端横幅，见那边 `docs/DEPLOY.md` §6）。发版自动化属于"每台机器都不一样"的
运维，所以放在本仓库（客户端打包仓库）的 `deploy/` 里，运行在**你自己的服务器**上。

starst.site 上已经装好的东西（源码都在这里，服务器上的是副本）：

| 服务器上的位置 | 内容 |
|---|---|
| `/usr/local/bin/stronghold-deploy.sh` | `deploy/deploy.sh` 的副本：手动发版用，也是钩子的兜底 |
| `<游戏检出>/.git/hooks/post-receive` | `deploy/hooks/post-receive`：push 到服务器仓库即部署 |
| `/etc/default/stronghold-deploy` | 两种模式共用的配置（`SP_DEPLOY_*`） |
| `<游戏检出>/.git/stronghold-deploy.log` | 钩子每次运行的日志（`--status` 会显示最后 20 行） |

## 0. 先搞清楚"哪些改动要重启"

线上是 systemd 单元 `stronghold.service`（`ExecStart=/usr/bin/node server/index.js`，**没有 `--watch`**，
`Restart=always`，`KillSignal=SIGINT`，nginx 反代 `127.0.0.1:3000`）：

* **要重启**：`server/**`、`shared/**`、`server/sim/**`（启动时 `import` 进内存）、`data/*.json`
  （`server/data.js` 的 `getData()` 是单例）。
* **不用重启**：`public/**`（每次请求都读盘）——网页端改完刷新即生效。

仓库里没有 `fs.watch`/nodemon、没有 CI，所以"推上去"不会自动生效，除非装上第 2 或第 3 节的东西。

两种自动方式共用同一份 `deploy.sh`，区别只在"谁把工作区更新到新提交"：

| | 2. 钩子（`post-receive`） | 3. 定时器（systemd timer） |
|---|---|---|
| 触发 | 你 `git push` 到服务器仓库，**立刻** | 服务器每 2 分钟拉一次，最多滞后 2 分钟 |
| 需要 | 服务器仓库接受 push（`receive.denyCurrentBranch=ignore`）+ 仓库属主有免密 sudo | 服务器能拉取你指定的远端（本机推不动也能用） |
| 反馈 | 部署日志直接打在**你的 push 输出**里 | `journalctl -u stronghold-deploy -f` |
| 失败处理 | 自动回滚到推送前的提交并重启 | 保持在工作区已更新的状态，人工处理 |

## 1. 手动发版

```bash
cd ~/webUI/Stronghold-Protocol
sudo /usr/local/bin/stronghold-deploy.sh --dry-run              # 先看它会做什么（exit 2 = 什么都没做）
sudo /usr/local/bin/stronghold-deploy.sh --remote <远端> --lead 60
```

顺序：fetch → 比对 HEAD（没变就退出）→ 必要时还原 `data/assets.json`（运行中的服务器会改写它）→
`git merge --ff-only`（拒绝分叉，不会留下半成品）→ 清单变了才 `npm ci --omit=dev` →
**先发游戏内公告并等 `--lead` 秒** → `systemctl restart stronghold` → 轮询 `/healthz` 直到 `uptimeSec`
变小并打印版本/在线人数 → **撤下那条维护公告**（它的 `until` 还有几分钟，不撤的话刚重连进来的玩家会
被告知"马上要重启"，而重启已经完成）。

## 2. 钩子模式：`git push` 即上线（推荐）

```bash
# 在服务器上装一次（--repo 指向游戏检出；脚本可以放在任何地方）
sudo deploy/install.sh --mode hook --repo /home/ubuntu/webUI/Stronghold-Protocol
sudo deploy/install.sh --status        # 装了什么、上次钩子跑的结果
sudo deploy/install.sh --off           # 卸掉钩子（也会顺手关掉定时器）
```

之后一次发版就是两次 push：

```bash
git push origin master        # 你自己的 fork：留档、给别人看
git push workplace master     # 部署：公告 → 重启 → 校验，日志就在这次 push 的输出里
```

`install.sh --mode hook` 会做四件事（第 4 件是 `deploy.sh` 干的）：

1. `git config receive.denyCurrentBranch ignore` —— 非裸仓库默认会**拒绝**被 push 到已检出的分支，
   不改这个配置连推都推不上去；
2. 把 `deploy/hooks/post-receive` 装到 `<检出>/.git/hooks/post-receive`（属主保持仓库属主，
   `sed` 去掉可能混进来的 CR）；
3. 写 `/etc/default/stronghold-deploy`（两种模式共用）；
4. 钩子收到 `refs/heads/master` 的更新后：记下被丢弃的本地改动 → `git reset --hard <新提交>`
   （**这也会清掉服务器自己改写的 `data/assets.json`**）→ 调 `deploy.sh --pushed`（公告 → 重启 →
   校验 → 撤公告）。

细节与坑：

* **必须是 `reset --hard`，不能用 `receive.denyCurrentBranch=updateInstead`**：后者要求工作区干净，
  而运行中的服务器一直在改 `data/assets.json`，会直接拒绝推送。
* **脚本解析顺序**：`SP_DEPLOY_SCRIPT` → 检出里的 `scripts/deploy/deploy.sh` → `/usr/local/bin/stronghold-deploy.sh`。
  游戏仓库现在不带脚本，所以走 `/usr/local/bin` 那份；两个都没有才告警。
* **失败自动回滚**：校验没过就 `reset --hard` 回推送前的提交并重启，push 退出码非 0
  （`SP_DEPLOY_ROLLBACK=0` 可关）。
* **只部署 `master`**：推其他分支只打印一行 `ignoring` 并正常退出 0；删分支也忽略。
  钩子用 `flock` 串行化，两个人同时推不会互相打断。
* **push 期间看不到日志是正常的**：公告要等 `--lead` 秒（默认 60），这段时间 push 会停在那里。
  想快就 `SP_DEPLOY_LEAD=20 git push workplace master`。
* **`GIT_DIR` 陷阱**：`receive-pack` 会以 `GIT_DIR=.` 调用钩子，钩子里每条 git 命令都会报
  `fatal: not a git repository: '.'`。钩子和 `deploy.sh` 都会先清掉它。
* `/usr/local/bin` 那份自己会读 `/etc/default/stronghold-deploy`（否则它按脚本位置把仓库算成 `/usr`）。

## 3. 定时器模式：服务器自己拉

```bash
sudo deploy/install.sh --mode timer --remote https://gh-proxy.com/https://github.com/<你>/Stronghold-Protocol.git
journalctl -u stronghold-deploy -f
```

装 `/usr/local/bin/stronghold-deploy.sh` + `stronghold-deploy.{service,timer}`，每 2 分钟
`deploy.sh --remote ...` 一次：有新提交就自动走第 1 节那套（**含游戏内公告**）。适合"服务器拉得到、
但推不动"的场景。**不要和钩子模式同时开**（会重启两次）。

## 4. 配置：`/etc/default/stronghold-deploy`

改完 `sudo systemctl restart stronghold-deploy.timer`（钩子模式下次 push 生效）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `SP_DEPLOY_REPO` | 安装时脚本所在仓库 | 部署哪个检出 |
| `SP_DEPLOY_REMOTE` / `SP_DEPLOY_BRANCH` | 安装时给的 / `master` | 定时器拉哪个仓库、哪个分支；钩子模式只看分支 |
| `SP_DEPLOY_SERVICE` | `stronghold` | systemd 单元名 |
| `SP_DEPLOY_LEAD` | `60` | 重启前公告多少秒（`0` = 不公告） |
| `SP_DEPLOY_MAX_WAIT` / `SP_DEPLOY_MAX_MATCHES` | `0` / `0` | 等空窗：最多等多少秒、对局数降到多少才重启（`0` = 不等） |
| `SP_DEPLOY_HEALTH_URL` | `http://127.0.0.1:${PORT}/healthz` | 校验地址 |
| `SP_DEPLOY_ROLLBACK` | `1` | 钩子模式：校验失败自动回滚 |
| `SP_DEPLOY_SCRIPT` | 未设 | 强制指定用哪个 deploy 脚本 |
| `SP_DEPLOY_TRIES` | `30` | 重启后最多轮询多少次 `/healthz`（每次 1 秒） |

## 5. 排错

| 现象 | 处理 |
|---|---|
| 自动发版没反应 | 钩子模式：看 push 输出（有 `ignoring refs/heads/...` 说明推错了分支）、`git -C <检出> log` 看服务器仓库的 HEAD、`sudo deploy/install.sh --status`。定时器模式：`journalctl -u stronghold-deploy -n 50`。两种情况都可以手动跑一次 `--dry-run` |
| `git push workplace master` 被拒（`branch is currently checked out`） | `receive.denyCurrentBranch` 没设成 `ignore`：重跑 `install.sh --mode hook` |
| 钩子报 `fatal: not a git repository: '.'` | 钩子/脚本没清掉 `receive-pack` 注入的 `GIT_DIR`：更新到含该修复的版本后重装钩子 |
| 钩子报 `no executable deploy script at …` | 检出里没有 `scripts/deploy/deploy.sh`，且 `/usr/local/bin/stronghold-deploy.sh` 也不在：装一个 |
| `/usr/local/bin/stronghold-deploy.sh` 报 `not a git checkout: /usr` | 它没读到 `/etc/default/stronghold-deploy`（或那里没有 `SP_DEPLOY_REPO`）：补上，或加 `--repo <检出>` |
| 部署失败自动回滚了 | 看 push 输出里的 `ERROR`，一般是新提交起不来（`journalctl -u stronghold -n 50`）；服务器已回到推送前的提交 |
| 重启后玩家看到"马上要重启" | 公告没有被撤下：`node scripts/notice.mjs --clear`（`deploy.sh` 正常情况下会自动撤） |

## 6. 上线前的检查清单

1. 挑空窗（本仓库 `npm run server:status`，`--watch` 滚动、`--under 40` 等空窗）——
   **重启会结束所有正在进行的对局**：客户端会自动重连，但那是**新会话**，正在打的那一局就没了。
2. 第一次部署"公告功能"本身时，那一次重启**没有**游戏内公告（功能还没上线）：挑人少的时候，
   或者先用平台（www.starst.site）发一条房间公告。之后就都有公告了。
3. 确认已装的 exe/apk 是新包（客户端把 `public/**` 打进安装包）。
