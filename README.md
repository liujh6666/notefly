# NoteFly · 本地多平台内容分发工作台

写一次内容，分发到多个内容平台。**本地单机运行，数据全部存在本机**，没有云端、没有账号体系。

作者在编辑器里写一篇 Markdown，勾选目标平台，程序用 Playwright 驱动真实浏览器，把标题、正文、标签、封面自动填进各平台的创作者后台，然后按你选的模式收尾：

- **草稿箱模式**：只填不发布，停在草稿页，人去平台后台过目后再手动发布
- **立即发布**：填完后自动点平台的发布按钮

> ⚠️ **请先读这段**：本项目通过浏览器自动化（RPA）操作平台后台，属于灰色地带。请控制频率、遵守各平台用户协议，账号风险自担。项目仅供学习交流，作者不对账号限流、封禁等后果负责。

## 功能

- **多平台分发**：内置掘金、知乎专栏、微博、CSDN、头条号、百家号、搜狐号、开源中国、一点号、大鱼号、微信公众号、网易号、企鹅号、简书、博客园、思否、InfoQ、51CTO、B站专栏等适配器，另有通用适配器可快速接入新平台
- **AI 写作台**：写作 / 续写 / 润色 / 精简 / 扩写 / AI 标题，走 **OpenAI 兼容协议**，不绑定厂商（DeepSeek / 通义 / Kimi / 智谱 / 硅基流动 / OpenAI / 本地 Ollama 均可）
- **一键排版 / 去 AI 味**：纯本地规则引擎，不联网、不花钱、不外传正文；「去 AI 味」会逐处标记改动，由你决定是否应用
- **公众号排版**：7 套主题模板，Markdown 直接渲染成微信合规的内联样式 HTML（过 `span leaf` 等微信铁律自检）
- **登录态管理**：真实浏览器登录一次，登录判定含严格证据链与 12 小时快照有效期，避免「明明掉线却显示在线」
- **任务状态机**：结果未知 > 仍在执行 > 全失败 > 全成功 > 部分成功 > 待人工，绝不谎报成功
- **运行日志**：设置 → 关于 → 连点版本号 5 次解锁，所有操作与报错留痕，敏感信息自动脱敏
- **数据目录可迁移**：所有数据在一个目录，换电脑整包搬走

## 环境要求

- Node.js ≥ 18
- Windows / macOS / Linux（桌面版基于 Electron 45）

## 快速开始

```bash
git clone https://github.com/liujh6666/notefly.git
cd notefly

# 1. 安装依赖
npm install

# 2. 装 Playwright 的 Chromium
npx playwright install chromium

# 3. 启动桌面版（推荐）
npm run desktop

# 或者只跑服务端，浏览器打开 http://127.0.0.1:3210
npm start
```

首次启动后：

1. **账号管理** → 选择平台登录（真实浏览器登录一次，登录态存本机）
2. **设置 → AI 模型**（可选）→ 填 baseUrl + API Key + 模型名，Key 只存本地
3. **内容库 → 新建内容** → 写作 → 勾选账号 → 发布到草稿箱

## 启动方式：为什么用快捷方式而不是 .bat

`npm install` 之后，仓库根目录会生成两个 **Windows 快捷方式**：

| 入口 | 形态 | 控制台窗口 |
|---|---|---|
| `启动NoteFly桌面版.lnk` | 桌面版（应用窗口 + 托盘 + 内置浏览器） | **完全没有** |
| `启动NoteFly.lnk` | 浏览器版（后台跑服务，自动打开系统浏览器） | **完全没有** |
| `启动NoteFly桌面版.bat` / `启动NoteFly.bat` | 同上，兼容入口 | 会**闪一下**（见下） |
| `停止NoteFly.bat` | 停掉 3210 端口的服务 | 一闪而过 |

**直接双击 `.lnk` 是零窗口的。** 快捷方式指向 `electron.exe`——它是 GUI 子系统程序（PE Subsystem=2），不分配控制台，所以屏幕上不会出现任何黑框。

`.bat` 做不到这一点：`.bat` 一定由 `cmd.exe` 执行，而 `cmd.exe` 是控制台子系统程序，Windows 11 上还会被「默认终端应用」（Windows Terminal）接管，**控制台窗口一定会出现**，脚本层只能让它尽快消失。所以 `.bat` 被改成了「转交同名 `.lnk` 后立即退出」的最短形态（移除了旧版里的 `pause` 和前台运行的 `node server.js` —— 这两样才是窗口赖着不走的真正原因）。

> 换机器或换了安装目录后，快捷方式里的绝对路径会失效，执行 `npm run make:lnk` 重新生成即可（需要 Python；没有 Python 时会自动改用 Windows 自带的 PowerShell）。

## 数据与隐私

- 所有数据存在 `data/` 目录（内容、配置、登录态、日志），**不经过任何第三方服务器**
- AI API Key 只落本机 `data/config.json`，服务端直接发起请求，前端只拿到掩码
- 平台登录态通过 CDP attach 驱动 Electron 自身的浏览器会话，**绝不复制 cookie**（复制会让平台风控踢下线）
- 在「设置」中可以把整个数据目录迁移到任意位置

## 开发

```bash
npm test                 # 214 条单元/集成测试
npm run test:ui          # 54 项真实浏览器 UI 回归
npm run test:ai          # 45 项 AI 与文本工具端到端
npm run test:gzh         # 29 项公众号排版端到端
npm run test:log         # 19 项运行日志端到端
npm run test:shots       # 90 张多主题多宽度截图 + 溢出检测
```

### 代码结构

```
├─ server.js            Express 服务端：全部接口 + 定时调度 + 保活巡检
├─ lib/                 状态归并 / 文本工具 / AI 客户端 / 公众号排版 / 日志 / 数据目录 / 脱离控制台
├─ engines/rpa.js       Playwright 引擎：CDP 接管、登录判定、平台适配器、发布编排
├─ electron/            桌面外壳（主进程 + preload）
├─ public/              前端单页应用（Vue3 + Element Plus，无构建，改完刷新即生效）
├─ tests/               单元 + 集成测试
├─ scripts/             端到端测试、快捷方式生成器与工具脚本
├─ docs/                修复报告
├─ 启动NoteFly桌面版.lnk / 启动NoteFly.lnk      零窗口启动入口（npm run make:lnk 生成）
└─ 启动NoteFly桌面版.bat / 启动NoteFly.bat      兼容入口（会闪一下控制台）
```

技术栈：Electron 45 · Express 4 · Playwright 1.64 · Vue 3 · Element Plus · 原生 CSS 令牌，无打包工具、无 TypeScript。

### 新增一个平台适配器

在 `engines/rpa.js` 的 `ADAPTERS` 里加一条（或用通用适配器传配置）：声明 `composeUrl`（创作后台地址）、`loginUrl`、各步骤选择器即可。详见 `engines/rpa.js` 头部注释。

## 已知限制

- 平台适配器中目前只有掘金完成了真机验证，其余为通用适配器，未逐台验证
- 发布成功的证据链不完整（缺作品 ID / 管理页状态佐证），自动提交前请到平台后台确认
- 正文里的本地图片不会自动上传到平台（只有封面做路径转换）
- 一个平台只能绑一个账号
- 「去 AI 味」是规则引擎，不是训练过的检测模型

## 协议

[MIT](LICENSE) · 字体[阿里巴巴普惠体 3.0](https://www.alibabafonts.com/)免费商用 · 内嵌依赖 Vue / Element Plus / marked 均为 MIT
