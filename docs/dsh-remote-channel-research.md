# dsh-remote 宣传/曝光渠道调研

调研时间：2026-10-11（Asia/Shanghai）
方法：web_search + web_fetch + GitHub REST API + 各社区 JSON API 实拉。所有数字为实测快照。
说明：`github.com`、`linux.do`、`dshbase.com`、`v2ex.co` 对 web_fetch 解析为非公网 IP 被拒，改用 `curl` + 官方 API 取数，来源 URL 仍为可公开访问页面。

---

## 0. 本地事实核对

| 项 | 值 | 来源 |
|---|---|---|
| dsh 桌面 app Bundle ID | `com.deepseek.dsh` | 本机 `Info.plist`（`/Applications/DeepSeek Harness.app`） |
| 版本 | `0.2.0-rc.2` | 同上 |
| 当前工作区包名 | 实为 `dsh-pocket`（非 `dsh-remote`） | `/Users/g/Documents/Jem/dshwebapp/package.json` |
| npm 上已有同名/近似包 | `@mrrisega/dsh-remote`、`@dsh-remote/plugin` | [npm @mrrisega/dsh-remote](https://www.npmjs.com/package/@mrrisega/dsh-remote)、[npm @dsh-remote/plugin](https://www.npmjs.com/package/@dsh-remote/plugin) |

> 命名冲突提醒：生态里已存在 `dsh-remote` 命名的包与仓库，发车前先定唯一包名（如 `@yourscope/dsh-remote`），否则所有渠道的安装命令都会被搜到别人仓库。

---

## 1. 官方渠道

**仓库确认：就是 `deepseek-ai/deepseek-harness`**，`deepseek-ai` org 下 44 个公开仓库之一。

| 指标 | 值 |
|---|---|
| full_name | `deepseek-ai/deepseek-harness` |
| description | DeepSeek Harness: Everything is a Plugin. |
| stars | **247,361** |
| forks | 29,698 |
| watchers / subscribers | 1,057 |
| open issues | **0** |
| has_discussions | **true** |
| topics | `ai-agents`, `cordis`, `dsh`, `dsh-plugin` |
| license | MIT |
| created / pushed | 2026-08-13 / 2026-10-09 |
| homepage | https://deepseek.com/harness |

来源：[repo API](https://api.github.com/repos/deepseek-ai/deepseek-harness) · [仓库页](https://github.com/deepseek-ai/deepseek-harness) · [产品页](https://deepseek.com/harness)（实测 http 200，title「DeepSeek Harness｜共探智能上限」）

**是否接受第三方插件 PR/链接：不接受外部 PR，但官方明确设计了插件分发路径。**

`CONTRIBUTING.md` 原文：*"We are sorry that we cannot accept external pull requests at the moment."* 同时给出替代路径 —— 官方希望你把插件做成 `dsh-plugin` topic 的独立仓库，并称 *"We do not believe that packages in the official repository are inherently more important than packages created by the community."*

来源：[CONTRIBUTING.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/CONTRIBUTING.md)

**官方给的四个动作（README「Community and support」段，直接抄）**：
1. GitHub Discussions 提反馈/报 bug → https://github.com/deepseek-ai/deepseek-harness/discussions
2. **给插件仓库打 `dsh-plugin` topic** → https://github.com/topics/dsh-plugin （官方点名的唯一发现机制）
3. 加入 **官方 Discord**：https://discord.gg/4MrtZUhpxg
4. 写博客/how-to、在社区里答疑

来源：[README.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/README.md)

**官方文档站**：https://deepseek-harness.github.io/deepseek-harness/ （实测 http 200，title「DeepSeek Harness」）。仓库内 `docs/` 有中英双语文档（`*.md` + `*.zh.md` + `*.i18n.yaml`），含 `docs/cordis-tutorial/`、`docs/cookbook/`。

**Discussions 可用性**：`has_discussions=true`，API 可读；章节结构里第一个分类是 `General`。已知实例：[Discussion #1797 "Welcome to DeepSeek Harness Community — Please Read Before Posting"](https://github.com/deepseek-ai/deepseek-harness/discussions/1797)、[Discussion #1012 dshbase 插件目录征集](https://github.com/deepseek-ai/deepseek-harness/discussions/1012)、[Discussion #2665 全量插件验证报告](https://github.com/deepseek-ai/deepseek-harness/discussions/2665)。

**官方是否维护「第三方插件清单」：没有。**
- 官方 org 下的相关仓库只有 [deepseek-ai/awesome-deepseek-agent](https://github.com/deepseek-ai/awesome-deepseek-agent)（6,194 star，**无 topics、无 homepage、无 Discussions、pushed 2026-09-17，339 个 open issue**）——是 agent 主题的 awesome 汇总，不是 dsh 插件目录。
- 官方 org 里另有 `dsh-libreoffice-kit`(173★)、`dsh-node-addon-require-builtin`(14★)，描述均为 *"An internal component used by DeepSeek Harness"* —— 内部组件，不是社区插件入口。
- 结论：**「插件目录」这一层完全由社区占住**（见第 5 节）。

---

## 2. 官方社区

| 渠道 | 状态 | 来源 |
|---|---|---|
| **GitHub Discussions** | ✅ 官方指定反馈/讨论区，活跃 | [discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) |
| **Discord** | ✅ README 给出邀请链接 `https://discord.gg/4MrtZUhpxg`，是 dsh 专门社区 | [README](https://github.com/deepseek-ai/deepseek-harness/blob/master/README.md) |
| DeepSeek 开放平台开发者论坛 | ❌ 未找到 dsh 专属讨论区；dsh 的官方支持面就是上面两个 | — |
| 官方微信群 / 飞书群 / QQ 群 | ❌ 官方仓库与 README 中均未出现任何 IM 群链接 | 同上 |
| 官方 X/Twitter 账号用于 dsh | ❌ 未在官方仓库/SNS 链接中确认 |

**找不到的部分按实说**：没有检索到 DeepSeek 为 dsh 单独运营的论坛、微信群或飞书群。Discord 是目前唯一官方社区聊天入口。

> 顺带一条生态信号：社区里已经有人做「把社区装进 dsh」的插件（`seolhw/dsh-guild`，类 Discord 的 DSH 内嵌社区面板），说明 IM/社区入口本身是被需求验证过的方向 —— 对 dsh-remote 是天然话术素材。来源：[seolhw/dsh-guild](https://github.com/seolhw/dsh-guild)

---

## 3. 中文开发者社区（含发帖入口与真实曝光量）

### 3.1 LINUX DO —— 本项目最高性价比渠道（生态事实上的主阵地）

| 项 | 值 | 来源 |
|---|---|---|
| 主版块 | 开发调优 https://linux.do/c/develop/4 | 实测可得 category_id=4 |
| AI 版块 | 人工智能（category_id=34） | 实测 topic 标签 |
| 综合版块 | 搞七捻三（category_id=11） | 实测 topic |
| **官方推广机制** | 设了 `开源推广` 标签，规则见公告帖 | [新推广方式：开源推广](https://linux.do/t/topic/1776670) |

**开源推广 5 条硬前置（公告原文摘录）**：
1. 帖子打上 `开源推广` 标签
2. 项目**完整开源、无未开源部分**
3. **项目里要链接认可 LINUX DO 社区**（公告明确：加个友链就算）
4. 帖内 AI 生成/润色部分**必须截图发出**
5. 承诺永久有效、接受社区监督
   > 发帖编辑器 toolbar 最右 `+` → 插入模版 → 选「开源推广发帖模板」，一键套格式。
   > 不满足第 3 条也有退路：走「公益推广」规则（免费、无收费、无 QQ/TG 引流、站点接入 LINUX DO Connect）。

**真实曝光基准（实测取数，用于设预期）**：

| 帖子 | 版块 | 数据 |
|---|---|---|
| 【更新】DeepSeek Harness 已经发布 | cat 34 人工智能 | views 3,365 / likes 77 / replies 29 |
| 关于 DeepSeek Harness | cat 11 | views 787 / likes 11 / replies 20 |
| 一个 dsh 插件竟然解决了继续工程师的问题？（dsh-auto-continue，**标准开源推广格式范例**） | **cat 4 开发调优**，tags: 人工智能 / 软件开发 / 开源推广 | **views 623 / likes 23 / replies 11** |

来源：[2746605](https://linux.do/t/topic/2746605) · [2753125](https://linux.do/t/topic/2753125) · [2834822](https://linux.do/t/topic/2834822)

> 读数解读：**单帖量级是「数百到三千浏览」，不是「一夜爆火」**。它的价值在于精准人群（agent/dsh 用户密度最高）、可被搜索、以及后续每个版本更新都能回流发帖。第三条帖子的格式就是可以直接照抄的发布稿模板 —— 完整格式与仓库侧配套文件另见一份真实发布稿：[ningbainb/deepseek-harness-desktop/docs/launch/linuxdo-post.md](https://github.com/ningbainb/deepseek-harness-desktop/blob/main/docs/launch/linuxdo-post.md)（含标题、版块、标签、5 条申明、图片位）。

**内容适配**：长文（功能 + 原理 + 安装命令 + 截图）与短分享都行；dsh 用户偏好「能直接跑的命令 + 截图」。**演示视频不是必须，GIF/截图 > 视频。**

### 3.2 V2EX

| 项 | 值 |
|---|---|
| 高活跃节点 | `share` 分享发现 https://www.v2ex.com/go/share （47,435 topics / 6,363 stars） |
| 发帖入口 | https://www.v2ex.com/new |
| 可用 API | `https://www.v2ex.com/api/topics/show.json?id=<id>`（实测 200，可取 replies/created；但**不含 views**，views 需解析页面而页面对 curl 返回 403） |

**同类帖真实热度（实测）**：
- [t/1234499「整理了一份 DeepSeek Harness (dsh) 插件精选列表，目前收录 270 个插件」](https://www.v2ex.com/t/1234499) —— node=share，created 2026-08-14，**replies = 1**
- [t/1234767「DSH 插件已经 3000+ 了，分享一个可搜索的插件导航」](https://www.v2ex.com/t/1234767) —— node=share，created 2026-08-16，**replies = 0**

> **残酷但重要**：V2EX 的「分享发现」节点给带 AI 味的工具帖的即时反馈非常低（0–1 回复）。V2EX 更适合**写有观点的技术长文**（放程序员节点）而不是「我做了个插件」的推广帖。**不建议作为首发渠道。**

### 3.3 dshbase.com —— 独立第三方插件目录（v0.2，先占坑）

| 项 | 值 | 来源 |
|---|---|---|
| 定位 | "independent guide"，安装/教程/对比 + 插件目录 | https://www.dshbase.com/ |
| Verified 含义 | 真跑安装测试：L1 install → L2 load → L3 headless → L4 web CDP（web-only 才测 L4） | 首页 |
| 规模 | 首页自称 **7,819 of 7,819 listings are Verified**（该数字是计数器，非人工逐条） | 首页 |
| 人工征集渠道 | 在**官方仓库 Discussions 开帖收插件**，作者实时回帖实测 | [#1012](https://github.com/deepseek-ai/deepseek-harness/discussions/1012)、[#2665](https://github.com/deepseek-ai/deepseek-harness/discussions/2665) |

**生态早期质量现状（极有用的卖点弹药）**：Discussion #1012 里有作者实测统计 —— **122 个插件里只有 17 个能装、10 个完全通过**。也就是说：*「我认真做了 bundle 声明 + 干净 profile 实测通过」本身就是差异化宣传点。* 来源：[#1012](https://github.com/deepseek-ai/deepseek-harness/discussions/1012)

> dshbase 的 `/submit`、`/plugins/submit`、`/contribute` 均 404（实测）。提交只走 Discussions 帖。

### 3.4 掘金 / 知乎

- 掘金发文入口：https://juejin.cn/editor/drafts/new ｜ MCP 化一键发布有第三方方案：[JueJin-MCP](https://juejin.cn/post/7626315359482249258)
- **找不到「dsh 插件」专属高活跃分区**；dsh 内容在掘金/知乎均被并入泛 AI 编程话题。
- 反证（值得注意）：一份第三方技术情报报告在检索「智能体工程 / AI编程 / 上下文工程」时明确写下 *"未发现任何来自少数派、掘金、知乎专栏的原创分析"* —— 说明这条赛道的中文深度内容目前是**空白**，是可占位的机会，但也意味着这些平台当前**没有 dsh 流量池**。来源：[tech_intelligence_report_2026-08-03_to_2026-08-17.md](https://raw.githubusercontent.com/oneRede/harness-engineering/refs/heads/main/report/tech_intelligence_report_2026-08-03_to_2026-08-17.md)

### 3.5 即刻 / 少数派 / X(Twitter)

| 渠道 | 入口 | 适配内容 | 判断 |
|---|---|---|---|
| 即刻 | https://web.okjike.com/ （AI 开发者浓度高） | 短图文 + 演示动图 | ✅ 有实证：即刻上有「这两天在做的一个插件，让 Code…」类插件作者自述帖 https://m.okjike.com/originalPosts/6ac71952bb8c5d116f72fbdc |
| 少数派 | 投稿：https://sspai.com/ ；征稿公告 [少数派喊你来投稿](https://www.sohu.com/a/1025496073_115785) | 长文 / 完整工具评测（有编辑审稿） | ⚠️ 门槛高、周期长，适合二次分发 |
| X / Twitter | https://x.com/ | 15–30 秒演示视频 | ✅ 英文圈主战场，见第 4 节实证 |
| 小红书 / 抖音 / 公众号 / B站 | — | — | ⚠️ 无 dsh 开发者流量池的直接证据 |

> 强旁证：生态里已出现专门做多平台宣发的插件，其平台清单是 `xiaohongshu / zhihu / wechat / wechat_moments / weibo / bilibili / douyin / kuaishou / x / threads / linkedin / reddit / tiktok / youtube / medium / facebook / instagram`（17 个）。另外还有一个「一键发布微信公众号文章」的 dsh 插件（`aiworkskills/dsh-wechat-article`），以及一个跨 11+ 平台（含掘金/CSDN/知乎/Reddit/Twitter/Product Hunt）的推广 SOP 仓库。这些是**生态共识的证据**，不等于它们对 dsh 插件有效。
> 来源：[dsh-promotion-toolkit](https://www.dshbase.com/plugins/dsh-promotion-toolkit/) · [dsh-wechat-article](https://github.com/aiworkskills/dsh-wechat-article) · [ava-agent/promotion-agent](https://github.com/ava-agent/promotion-agent)

---

## 4. 对照参考：同类工具作者真的发在哪

| 案例 | star（实测快照） | 作者公开的发布路径 | 效果证据 |
|---|---|---|---|
| **ccusage** (`ccusage/ccusage`，Claude Code 用量统计 CLI) | **18,965** ★ / 871 forks，created 2025-05-29 | 作者亲自复盘三周增长，写在 Zenn | 作者发文《【祝 1K Star 達成】ccusageの３週間を振り返る》，即**3 周内到 1K star**，主渠道是 Zenn 长文 + X + HN 类聚合扩散。来源：[zenn.dev/ryoppippi](https://zenn.dev/ryoppippi/articles/aad087994f26a7) |
| **claude-code-router** (`musistudio/claude-code-router`) | **37,626** ★ / 3,161 forks，created 2025-02-25 | linux.do **开发调优**版持续更新帖 | linux.do 上有「Claude-Code-Router 更新 2.0 - 开发调优」长期更新帖，属于典型「原帖 + 每版本回帖」模式。来源：[linux.do/t/topic/1403974](https://linux.do/t/topic/1403974) |
| **OpenCode** (`anomalyco/opencode`) | **212,673** ★ / 28,426 forks | — | 体量对照系，用于理解「agent harness 赛道头部能到 20 万 star」；不作为发布渠道证据 |
| **dsh 生态自身**：某 early-stage 插件被 dshbase 认证后即被收录并出现在目录页 | 9 ★ / 0 forks | 装进 dshbase 目录 | 说明**小插件靠目录收录也能拿到初始可见性**。来源：[dshbase 插件页](https://www.dshbase.com/plugins/dsh-promotion-toolkit/) |

**归纳**：同类工具作者的实际路径是 **「一个长文/帖子讲清价值 → 官方/社区目录收录 → 每版本回帖更新」**，不是一次性铺全平台。1K star 的达成周期量级是**周**级而非天级（ccusage 3 周）。

---

## 5. GitHub 侧优化（可直接执行）

### 5.1 topics 具体填什么

优先填（官方点名 + 生态已被使用的）：

```
dsh-plugin          ← 官方 README 点名的唯一发现机制，必填
deepseek-harness    ← 实测该 topic 下 14,591 个仓库，是生态第二大入口
dsh
cordis
ai-agents
agent-harness
ai-coding-agent
remote-access
mobile
self-hosted
```

事实依据：官方仓库自身 topics 为 `ai-agents, cordis, dsh, dsh-plugin`；`topic:dsh-plugin` 实测 **18,723** 个仓库，`topic:deepseek-harness` 实测 **14,591** 个仓库。来源：[topics/dsh-plugin](https://github.com/topics/dsh-plugin)

### 5.2 要不要发 awesome-list —— 要，这是第一优先级

[awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)：**18,378 star / 3,993 forks**，23 个分类（含专门的 **Remote & Mobile** 分类），README 实测 **4,503** 条链接，中英双语 README，且是标准 awesome 徽章项目。

**投稿规则（实测自 contributing.md，逐条可执行）**：
- 只提交**一个文件**：`data/plugins/<owner>__<repo>.yml`（**不要手改 README**，README 由脚本生成）
- 文件内容：
  ```yaml
  url: https://github.com/owner/repo        # 必须与仓库完全一致
  name: owner/repo
  category: remote                          # 远程/手机类用 remote
  description:
    en: One-line description ending with a period.
    zh: 一句话描述，以句号结尾。             # 可选，维护者会补
  ```
- **硬门槛**：
  1. `package.json` 里必须声明 **`dsh.bundle`** manifest（**只声明 `dsh.client` 会被拒** —— 这是最常见的拒绝原因）
  2. 仓库根要有 `cordis.patch.yml`
  3. 有真实可用代码（占位/纯 README 仓库不收）
  4. **仓库创建满 1 天**（CI 自动校验）
  5. 打了 `dsh-plugin` topic
  6. **描述必须属实**（维护者会对着代码数字数；夸大是主要打回原因）
  7. 描述**不带营销词**
- 分类取值：`agi ui usage theme model identity session memory tools wsl browser vision voice docs skill workflow git notify dev security **remote** market fun`
- monorepo 子包：url 指向子目录，name 用 `owner/repo#subname`
- 来源：[contributing.md](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)

> **对 dsh-remote 的直接结论**：本仓库 `package.json` 已声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` 且根目录存在 `cordis.patch.yml` —— **门槛已满足**，可直接投稿。分类选 `remote`。

### 5.3 GitHub Trending 触发条件（诚实版）

**GitHub 官方从未公布算法。** 社区可查的线索与已知失败模式：

- 官方社区有多个专门讨论帖：["Curious about trending repos calculations" · Discussion #163970](https://github.com/orgs/community/discussions/163970)、["Repository not appearing on Trending despite strong star growth (new account)" · Discussion #208864](https://github.com/orgs/community/discussions/208864)
- 从 #208864 这类案例可确认的**失败模式**：**新账号 + 短期 star 激增，反而可能不上 Trending**（被判定为异常增长）。所以「找人刷 star」是负收益。
- 无法给出可信阈值的部分，我不编。可操作的是把「增长曲线做得自然、持续」而不是「一次性冲量」。

### 5.4 官方渠道的可操作项汇总

- ✅ 打 `dsh-plugin` topic（官方点名）
- ✅ 在 README 里链回官方仓库与官方 Discord
- ✅ 在官方 Discussions 开一个 Show-and-tell 帖（生态里已有先例：#1071 被 #1012 的作者引用）
- ✅ 冲 dshbase 的实测收录（会在官方 Discussions 发验证报告帖）
- ❌ 不要尝试给 `deepseek-ai/deepseek-harness` 提 PR（官方明确暂不接受）

---

## 6. 按性价比排序的发布清单（可执行）

> 前提动作（今天做完，30 分钟内）：
> 1. 定唯一包名，加 `dsh-plugin` + `deepseek-harness` topic
> 2. README 加三样：一行安装命令、一张手机端截图/GIF、官方仓库与 Discord 友链
> 3. 复现一次干净 profile 安装：`dsh plugin --profile web add <your-package>` 并在空 profile 下 headless 跑通 —— 把这条**截图存档**（后面全是素材）

### T0 — 今天必发（加起来 < 1 小时，回报最高）

**① awesome-dsh-plugin 投稿 PR**　成本：20 分钟　预期：长尾持续曝光 + 4,503 条链接的目录内可被检索
- 提交 `data/plugins/<owner>__<repo>.yml`，`category: remote`
- 描述只写功能，例如 `en: Remote and mobile access for the dsh web GUI with a self-configured relay entry point.`
- 注意：**不要改 README**；`url` 必须与仓库名完全一致；描述里的 `: ` 要加引号

**② linux.do 开发调优 开源推广帖**　成本：30 分钟　预期：数百至数千精准浏览 + 长尾搜索
- 版块 https://linux.do/c/develop/4 → 发新帖 → toolbar `+` → 插入「开源推广发帖模板」
- 标题公式（照抄生态里跑通的写法）：`〖开源推广〗dsh-remote：手机的 dsh，自建中继入口 + 5 条实测安装命令`
- 五条申明逐条打勾；**必须先给项目加 LINUX DO 友链**；**AI 生成/润色的段落截图发出**
- 正文结构：一句话价值 → 装什么（`dsh plugin --profile web add ...`）→ 一张手机端截图 → 一张面板截图 → 3 个典型场景 → 仓库链接
- 切忌：写「颠覆/最强/秒杀」类词，社区对营销词敏感

**③ 官方 Discord 自我介绍 + Show-and-tell**　成本：5 分钟
- 进 https://discord.gg/4MrtZUhpxg，在分享频道发：一句价值 + 安装命令 + 一张图
- 这是官方 README 指定的发现路径，且**用户就是 dsh 的核心用户**

### T1 — 本周发（低成本增量）

**④ 官方仓库 Discussions 开一个 Show-and-tell 帖**　成本：10 分钟
- 在 https://github.com/deepseek-ai/deepseek-harness/discussions 开帖
- 顺带 @ dshbase 的维护者（Discussion #1012 的作者 ylwl1997 在实时响应收录请求）—— 请求实测收录，会连带一条官方仓库内的曝光

**⑤ dshbase 收录（通过 ④ 请求）**　成本：0（被 ④ 覆盖）
- 主张写点：**「干净 profile 安装通过 + headless 启动通过」** —— 用生态数据背书「122 个插件只有 17 个能装」，通过本身是卖点
- 提交路径只有 Discussions（站内 `/submit` 404 实测）

**⑥ 即刻 短图文**　成本：10 分钟
- https://web.okjike.com/ 发「手机上的 dsh」15 秒录屏 + 3 行说明
- 即刻 AI 开发者浓度高，插件作者自述帖有先例

### T2 — 有空再发（性价比递减，别先做这两个）

**⑦ V2EX 分享发现**　成本：20 分钟　**预期极低（同类帖实测 0–1 回复）**
- 如果要发，改写成**有观点的长文**（比如「dsh 插件为什么装不上：我踩过的 5 个 bundle 声明坑」）而不是推广帖
- 入口 https://www.v2ex.com/new

**⑧ 掘金 / 知乎 长文**　成本：1–2 小时
- 把 linux.do 那篇扩写成「dsh 插件开发的 bundle 契约 + 一个远程访问插件的完整实现」
- 机会点：这条赛道目前中文深度内容**空白**（见 3.4 反证）；但当前**没有现成流量池**，属于投资不是收割
- 入口 https://juejin.cn/editor/drafts/new

**⑨ X/Twitter 英文版**　成本：30 分钟
- 15–30 秒手机端演示视频 + 英文一句话；参考 ccusage 的路径（英文长文 + X + HN 扩散），1K star 的量级是**周**级
- X 上要单独一份英文短文，不要直接翻译中文稿

**⑩ 少数派投稿 / 小红书 / 公众号 / 抖音**　⚠️ 暂缓
- 少数派走 https://sspai.com/ 投稿（有编辑审稿，周期长）；其余渠道**没有 dsh 开发者流量池的直接证据**，投入产出比不明

### 发布纪律（比渠道更重要）

1. **一次只主推一个渠道，主帖发了就守着回帖** —— 生态里跑通的模式是「原帖 + 每版本更新回帖」，不是全平台刷一遍
2. **每发一版就回帖更新**（linux.do 帖子跟帖更新 + Discussions 更新 + awesome-list 描述随功能改）
3. **截图 > 视频 > 文字**：dsh 用户要的是「能直接跑的命令 + 看得见的效果」
4. **不要刷 star**：已确认的失败模式是「新账号 + 短期激增 → 反而不上 Trending」
5. **描述必须与代码一致**：awesome-list 维护者会对着代码数功能数量，夸大是唯一会让好插件被打回的原因

---

## 附：找不到 / 存疑（按实说明）

- **未找到** DeepSeek 为 dsh 运营的独立开发者论坛、官方微信群、飞书群、官方 dsh X 账号。
- **未找到** 官方维护的任何「第三方插件清单」；这一层 100% 是社区（awesome-dsh-plugin、dshbase、dsh-market 类内部市场）。
- **未能取到** V2EX 帖子的 views 数字（页面 403、API 不含该字段），只有 replies。
- **未能验证** 少数派 / 小红书 / 抖音 / 公众号 对 dsh 插件的实际曝光效果 —— 生态里有人做多平台宣发工具，但没有可验证的效果数据。
- **GitHub Trending 的确切算法与阈值无官方公开来源**，仅确认「新账号 + star 激增可能不上榜」这一失败模式。
