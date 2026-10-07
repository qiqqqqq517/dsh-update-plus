# dsh-update-plus

DeepSeek Harness 桌面端的**更新与重启增强**插件。

补上官方桌面端没有给普通用户的两件事：

1. **可选通道的检查更新 + 直接下载最新版**。官方桌面端把更新通道硬编码成 `nightly`
   （`lib/main.js`: `this.updater.channel = "nightly"`），用户在界面上没有任何选择；
   本插件把 **稳定版 / 测试版 / 每日构建** 三个通道摊开，检查完能**直接下载官方安装包**并做
   SHA-512 校验 —— 不走官方的多级确认对话框，也不是「点一下只知道有没有更新」。
2. **重启按钮**。官方把「重启应用与 Host」放在 `development` 分支里
   （`lib/main.js`: `...development ? [{ label: restartAppHostMenu … }] : []`），
   打包版**没有这个入口**。本插件在面板上提供了一个重启按钮，位置就在「检查更新」控件的
   **正下方**。

## 界面

设置 → **更新与重启**：

```
当前安装         应用版本 / Harness 版本 / 安装目录 / 启动程序 / 自带更新配置
更新通道         [稳定版] [测试版] [每日构建]      ← 分段按钮
                 [检查更新]  [直接下载最新版本]   ← 检查更新控件
                 各通道结果 + 下载进度条
                 ─────────────────────────────
                 [重启应用与 Host]                ← 重启按钮，位于检查更新下方
设置             下载目录 / 手动指定安装目录 / 重启前等待秒数
```

## 通道是真实的，不是装饰

三个通道对应官方生产源上的三个清单文件，**没有发布的通道会被明确标成「未发布」，不会假装有更新**：

| 通道 | 清单 | 实测（2026-10-07） |
|---|---|---|
| 稳定版 Stable | `feeds/win-x64/latest.yml` | 404 → 回退到官网「下载桌面版」直链 `desktop/dsh-latest-windows-x64.exe`，版本由构建尺寸比对推断 |
| 测试版 Beta | `feeds/win-x64/beta.yml` | 404 → 显示「未发布」 |
| 每日构建 Nightly | `feeds/win-x64/nightly.yml` | 200 → `0.2.0-rc.2`，289,313,640 字节 |

官方目前**只发布 nightly**（桌面端仍在 public preview），所以今天稳定版能拿到东西是因为它回退到了
官网直链，测试版诚实地报「未发布」。等官方发布 `latest.yml` / `beta.yml`，两个通道自动生效，
不需要改代码。

## 安装

```powershell
# 需要先关掉 DSH Desktop 吗？不需要；装完重启一次即可
node "C:\Users\30458\.dsh\plugins\dsh-update-plus\install.mjs"
```

装完**重启一次 DSH Desktop**（或点插件面板里的重启按钮重新加载），
然后打开 设置 → 更新与重启。

卸载：

```powershell
node install.mjs --revert
```

### 装了什么

- `<profile>\node_modules\dsh-update-plus\` —— 插件本体
- `<profile>\package.json` 的 `dsh.profile.bundles` 增加一条 `"dsh-update-plus"`
  （首次备份为 `package.json.bak_update-plus`）

**为什么是 bundle 而不是 `cordis.patch.yml` 里加一行**：实测手写 `- insert:` 行挂载的插件，
插件管理器把它当成「发现但未启用」，`enabled: false`，面板不会出现；而
`dsh.profile.bundles` 条目开箱即启用 —— 这也是本机其它第三方插件
（`dsh-builtin-browser`、`dsh-free-search`、`dsh-better-sidebar`…）的统一形状。

**为什么不用 `pnpm add`**：插件未发布，且 profile 的 pnpm 有严格的 `minimumReleaseAge` 闸门。
目录拷贝 + 一条 bundle 记录不碰 registry，也容易回滚。
代价是：以后在 profile 里跑 `pnpm install` 可能会把这个「非托管目录」清掉 —— 再跑一次
`install.mjs` 即可，这就是全部恢复步骤。

## 重启是怎么实现的

Harness Host 是桌面壳的**子进程**（实测：它以 `DeepSeek Harness.exe …dsh-desktop-host\lib\index.js`
的形式运行），拿不到 Electron 的 `app.relaunch()`，而且它本身就是随应用一起死掉的那个进程。

所以重启交给一个**脱离的 `cmd` 脚本**：脚本先等若干秒（面板上可配，默认 3 秒），
`taskkill /F` 关掉应用，轮询等进程真的消失，再 `start` 启动程序。它的日志写在
`~/.dsh/dsh-update-plus/restart.log`。

用 `/F` 强制关闭是刻意的：桌面壳的窗口 `close` 处理器会 `preventDefault()` 然后隐藏到托盘
（`lib/main.js`），优雅关闭信号**关不掉应用**，反而会让重启后多出一个托盘实例。
面板因此在按钮上加了明确警告，并且按钮就在「检查更新」下方，先更新、再重启是自然的阅读顺序。

## 目录结构

| 文件 | 职责 |
|---|---|
| `lib/core.js` | 通道表、清单解析、版本比较、安装位探测、流式下载+SHA-512、重启脚本 |
| `lib/index.js` | Host 半：`/dsh-update-plus/api` JSON 接口（state/check/download/progress/cancel/restart/openFile/settings） |
| `lib/client.js` | Client 半：`settings.section` 面板（ModuleLoader bundle，无需构建） |
| `cordis.patch.yml` | bundle 的挂载行 |
| `install.mjs` / `--revert` | 安装 / 卸载 |

Host 与 Client 之间走**自建的 HTTP 路由**，不用生成的 Remote/typert 界面：后者跨 harness
版本会变，而这条路由只要 web server 在就成立，也让整个插件零构建步骤、零运行时依赖。

## 验证

```powershell
cd "C:\Users\30458\.dsh\plugins\dsh-update-plus"
node run-tests.mjs
```

六个套件、全部通过，跑在 **host 自己的运行时**（`ELECTRON_RUN_AS_NODE=1` + Electron 二进制，
这样 asar 层是打开的，和真实 Host 一致）：

| 套件 | 覆盖 |
|---|---|
| `test-core.mjs` | 版本比较（含 `0.2.0-rc.2 < 0.2.0` 这类预发布序）、清单解析（折叠块标量）、安装位探测、**真实 feed 解析** |
| `test-download.mjs` | 本地服务器上跑完整下载管线：流式、进度、摘要一致、**摘要不一致必须拒绝并删除**、取消、HTTP 错误、无摘要 |
| `test-load.mjs` | Host 半：路由注册、`?action=state` 真实应答、跨源写拒绝、未知 action 404 |
| `test-cordis-load.mjs` | **用 host 自己的 cordis** 激活插件，并含阴性对照（`Config` 写成普通对象必须被 cordis 拒绝） |
| `test-client.mjs` | 用桩 React **真的执行** client bundle，断言槽位/字典/键集一致、渲染路径无硬编码中文 |
| `test-install.mjs` | profile 里的解析链、bundle 记录唯一、无残留、清单 UTF-8 完好、**安装副本与源码逐字节一致** |
| `verify-tarball.mjs` | 真的 `npm pack` → 解包 → **从解出来的树里**用真实 cordis 激活并执行 Client bundle（发布门禁） |

另外做过一次**真实全量下载验证**（`verify-live-download.mjs nightly`）：

```
LIVE DOWNLOAD OK in 92.1s
  file    : …\deepseek-harness-0.2.0-rc.2-win-x64.exe
  bytes   : 289313640 (manifest declared 289313640)
  verified: SHA-512 matches nightly.yml
```

## 已知限制

- **重启目前只支持 Windows**（脚本是 `cmd`）。macOS 上按钮会明确拒绝并让你用菜单。
- 强制关应用会中断**正在进行的回复**；会话记录是实时落盘的，但那一轮回复会断。
- 「稳定版」的版本号在官方没有 `latest.yml` 时是**推断**的（拿官网直链的 `Content-Length`
  与已知清单的尺寸比对）。面板会把这种情况标成「官网直链」，不会冒充成清单里的正式版本。
- 界面里的重启按钮**不能**变成原生菜单项：「检查更新…」在 Electron 主进程的弹窗菜单里，
  插件（跑在 Host 子进程）够不到它。要做原生菜单项必须给桌面壳装一个 bridge，
  那是另一条路（`dsh-builtin-browser/desktop-bridge` 是同类先例），本插件刻意不做这种侵入。

## 发布（npm）

包名 `dsh-update-plus` 在 `registry.npmjs.org` 上**是空闲的**（实测 404），无需改名。

```powershell
# 1. 审计：不发网络请求，只列出发布包里到底有哪些文件
node publish.mjs --check

# 2. 登录（交互式，必须你自己做；密码与 2FA 不要交给别人）
npm login --registry https://registry.npmjs.org --auth-type=legacy
npm whoami  --registry https://registry.npmjs.org     # 必须打印出用户名才算成功

# 3. 发布（registry 必须显式给，脚本不去猜）
node publish.mjs --registry https://registry.npmjs.org
```

### 登录「看起来成功了」但 `whoami` 仍报 ENEEDAUTH

实测踩过一次：`~/.npmrc` 里始终只有 `registry=https://registry.npmmirror.com` 一行，
**没有任何 `_authToken`**，globalconfig 文件也不存在，`npm whoami` 在两个 registry 上都失败。
三条原因，按可能性排：

1. **在 npmjs.com 网站上登录** —— 那是浏览器会话，不会生成 CLI token。网站登录 ≠ 命令行可用。
2. **npm 11 默认 `--auth-type=web`**（开浏览器 + 回调 `localhost`）在本地终端里会静默走不完。
   读源码可确认只有 `authType === 'web'` 才走浏览器分支，**其余任何值都回落经典终端提示**
   （`node_modules/npm/lib/utils/auth.js:38,74`）⇒ 加 `--auth-type=legacy` 最可靠。
3. **`npm login` 没带 `--registry`** —— 它会去登 `~/.npmrc` 里那个 registry，而本机是
   `registry.npmmirror.com`（只读镜像），登了也没用。

排查凭据到底有没有落盘，只看两件事，不要凭「我登录了」：

```powershell
# 有没有 _authToken 键（值不要打印出来）
node -e "const t=require('fs').readFileSync(process.env.USERPROFILE+'/.npmrc','utf8');console.log('has token key:', /_authToken/.test(t))"
# 目标 registry 上认不认这个身份
npm whoami --registry https://registry.npmjs.org
```

**为什么不直接 `npm publish`**：本机 `~/.npmrc` 把 registry 指向
`https://registry.npmmirror.com`，那是**只读镜像**，发布不了；而裸调 `npm publish` 在这种情况下
要么报一堆看不懂的错，要么发到你没打算发的 registry。`publish.mjs` 因此要求显式 `--registry`、
拒绝已知只读镜像、先在该 registry 上证明身份（`npm whoami`）、先查这个版本号是否已存在、
再用 `npm pack --dry-run --json` 把**将要发布的文件清单**逐条对账，全绿才发。

发布内容固定为 8 个文件（实测 `npm pack`：8 files / 29,932 packed bytes）：

```
LICENSE  README.md  cordis.patch.yml  install.mjs
lib/client.js  lib/core.js  lib/index.js  package.json
```

测试脚本、`publish.mjs`、`run-tests.mjs`、`verify-*.mjs`、备份文件都不进包 ——
`publish.mjs` 会把「多出来的文件」直接判成 FAIL，不是靠 `files` 白名单口头保证。

发完之后：

```powershell
npm view dsh-update-plus --registry https://registry.npmjs.org
```

## 许可

MIT，见 [LICENSE](LICENSE)。
