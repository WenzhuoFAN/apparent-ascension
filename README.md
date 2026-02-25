# 闪耀舞台｜非官方粉丝站 Site Spec（MVP → V1）

## 1. 项目背景
- 企划：枝江娱乐「闪耀舞台」
- 虚拟偶像：Fiona（心宜）、Gladys（思诺）
- 企划开启：2023-04-22
- B站主页：
  - 思诺：https://space.bilibili.com/3537115310721781
  - 心宜：https://space.bilibili.com/3537115310721181

## 2. 网站定位（一句话）
“一个面向新粉的入坑导航 + 面向粉丝的每周信息枢纽：排班、直播记录、数据成长、精选二创/切片/回放推荐。”

## 3. 目标用户
- 新粉（核心）：想快速了解两位是谁、从哪里开始看
- 老粉：想每周看排班、快速找回放/切片、看成长数据
- 路人：被海报吸引，想知道“这是啥企划、值得关注吗”

## 4. 核心目标（North Star）
让用户在 30 秒内完成：
- 明白两位是谁 + 找到本周直播排班 + 看到“推荐从这里开始看”的内容入口

## 5. 功能范围
### 5.1 MVP（必须有）
1) 入坑导航（Start Here）
- “新粉 3 步路线”：先看（代表内容）→ 再看（代表直播）→ 补课（精选切片/二创）
- 两位成员简介（简洁但有质感）：关键词、直播风格、常用称呼/梗（可后补）、推荐观看清单
- 一键跳转 B站主页/直播间/舰团/相关合集

2) 每周直播排班（Schedule）
- 本周/下周排班表（卡片 or 列表）
- 每场条目包含：时间、主题、成员、链接（有则填）

3) 直播记录（Streams Log）
- 每场直播一个“记录条目”：日期、标题、时长、亮点摘要、回放链接、关联切片/二创

4) 精选内容库（Library）
- 内容分类：二创 / 切片 / 回放推荐 / Cover&作品（可先做前3个）
- 必备能力：标签筛选 + 搜索（先做筛选，搜索可 V1）

5) 数据记录（Stats）
- 粉丝数记录（按日/周快照）
- 直播数据（至少：场次、总时长；可逐步加同接/弹幕等）

### 5.2 非目标（MVP 不做）
- 自动抓取/爬虫（先手动维护，V2 再考虑）
- 复杂登录系统、评论系统
- 多语言（除非后续确实需要）

---

## 6. 信息架构（Sitemap）
- `/` 首页（氛围 + 快入口 + 本周排班预览 + 最新推荐）
- `/start` 入坑导航（新粉路线 + 成员入口 + 必看推荐）
- `/members/fiona` 心宜
- `/members/gladys` 思诺
- `/schedule` 直播排班（本周/下周）
- `/streams` 直播记录列表
- `/streams/[slug]` 单场直播详情（亮点、回放、关联切片/二创）
- `/library` 精选库总览（分类 + 标签筛选）
  - `/library/clips`
  - `/library/fanworks`
  - `/library/replays`（可选：回放推荐单独页）
- `/stats` 数据（粉丝数折线 + 里程碑 + 直播统计）
- `/about` 关于本站 / 免责声明 / 投稿方式（可选）

---

## 7. 内容模型（Astro Content Collections）
> 原则：更新要轻松。每周 10 分钟也能维护。

建议 collections：
- `schedule`：排班（按周）
- `streams`：直播记录（按场）
- `clips`：切片推荐
- `fanworks`：二创推荐
- `metrics`：数据快照（粉丝数/直播数据）

### 7.1 schedule（每周一条）
字段建议：
- `weekStart`（周一日期）
- `items[]`：每场直播
  - `startAt`（时间，含时区）
  - `member`（fiona/gladys/both）
  - `title`
  - `type`（杂谈/歌回/游戏/联动/特别企划…）
  - `link`（直播间/动态/预约链接）

示例（`src/content/schedule/2026-02-24.md`）：
---
weekStart: 2026-02-24
items:
  - startAt: 2026-02-25T20:00:00+08:00
    member: both
    title: "周三联动杂谈"
    type: "联动/杂谈"
    link: ""
  - startAt: 2026-02-27T19:30:00+08:00
    member: fiona
    title: "歌回｜春日主题"
    type: "歌回"
    link: ""
---

### 7.2 streams（每场一条）
字段建议：
- `date`
- `member`（fiona/gladys/both）
- `title`
- `durationMin`（可先空）
- `replayUrl`（回放/录播链接）
- `highlights[]`（亮点 bullet）
- `relatedClips[]`（clips 的 slug）
- `relatedFanworks[]`（fanworks 的 slug）
- `tags[]`

示例（`src/content/streams/2026-02-25-collab-talk.md`）：
---
date: 2026-02-25
member: both
title: "周三联动杂谈"
durationMin: 120
replayUrl: ""
highlights:
  - "开场 10min 互动梗密集"
  - "中段聊到企划幕后（建议补时间戳）"
tags: ["联动", "杂谈", "高能"]
relatedClips: []
relatedFanworks: []
---

### 7.3 clips / fanworks（推荐条目）
字段建议（通用）：
- `title`
- `author`（UP 名/作者名）
- `url`
- `member`（fiona/gladys/both）
- `platform`（bilibili/weibo/…）
- `reason`（一句推荐理由）
- `tags[]`
- `createdAt`（可选）

示例（`src/content/clips/xxx.md`）：
---
title: "【切片】XX名场面合集"
author: "UP主A"
url: "https://www.bilibili.com/video/..."
member: gladys
platform: bilibili
reason: "新粉最容易笑出来的一集，能快速感受她的节奏。"
tags: ["入坑必看", "高能", "梗"]
---

### 7.4 metrics（数据快照）
建议先用 CSV 或 JSON，每周/每天一条即可：
- `date`
- `member`
- `followers`
- （可选）`viewsDelta` `streamsCount` 等

---

## 8. 标签体系（建议先定一小套）
成员类：
- `#心宜` `#思诺` `#联动`

内容类型：
- `#杂谈` `#歌回` `#游戏` `#ASMR` `#特别企划`

推荐维度：
- `#入坑必看` `#高能` `#治愈` `#名场面` `#回坑推荐`

维护规则：
- MVP 先控制在 20 个以内
- 每新增一个标签，必须能解释“筛选它有什么价值”

---

## 9. 页面需求（关键交互）
### 9.1 首页 `/`
- 海报氛围背景 + 入场淡入（丝滑）
- 5 个入口卡片：入坑 / 排班 / 精选 / 直播记录 / 数据
- “本周排班”预览（显示最近 3 场）
- “最新推荐”预览（随机或按 createdAt）

### 9.2 入坑 `/start`
- 新粉 3 步路线（固定结构 + 可维护）
- 心宜/思诺简介卡片（可跳转成员页）
- “必看列表”（来自 library 的 `#入坑必看`）

### 9.3 排班 `/schedule`
- 本周/下周切换
- 条目支持按成员筛选（fiona/gladys/both）

### 9.4 精选库 `/library`
- 分类 Tab（切片/二创/回放推荐）
- 标签筛选（多选）
-（V1）搜索框（标题/作者）

### 9.5 直播记录 `/streams`
- 时间倒序
- 过滤：成员 / 类型 / 标签
- 点进详情页看亮点、回放、关联内容

### 9.6 数据 `/stats`
- 粉丝数折线（按成员）
- 里程碑卡片（可手动维护）
- 简单直播统计（场次、总时长、平均时长）

---

## 10. 视觉与体验原则（你要的“质感”）
- 圆角（统一半径体系，例如 12/16/24）
- 玻璃拟态（背景模糊 + 低对比边框 + 微阴影）
- 动效克制：淡入、轻微上浮、hover 细微位移；避免花里胡哨
- 字体层级明确：标题/副标题/正文/辅助信息
- 移动端优先：卡片纵向堆叠，排班可折叠
- 可访问性：对比度、焦点样式、减少动效（prefers-reduced-motion）

---

## 11. 技术实现建议（Astro + SCSS）
- Astro：页面骨架、路由、内容集合（Content Collections）
- SCSS：全局设计 token（圆角、阴影、模糊、间距、字体）
- 交互（筛选/搜索/图表）：用 Astro Islands（React/Svelte/Vue 任选其一）
- 图表：Chart.js 或 ECharts（只在 stats 页加载）
- SEO：OpenGraph、sitemap、基础 meta
- 部署：Cloudflare Pages / Vercel / Netlify（任选）

目录建议：
- `src/pages/` 路由页面
- `src/layouts/` 全局布局
- `src/components/` 卡片、标签、列表、Hero 等
- `src/content/` 五类集合
- `src/styles/` variables.scss, mixins.scss, globals.scss

---

## 12. 内容维护流程（每周 10 分钟版）
每周固定流程：
1) 更新 `schedule`：填本周/下周排班（没有链接先留空）
2) 每场直播后补 `streams`：标题、回放链接、2-5 条亮点
3) 看到好切片/二创：新增 `clips` / `fanworks` 一条（写一句推荐理由）
4) 每周末记录一次 `metrics`：粉丝数快照（心宜/思诺各一条）
5) 首页预览自动从这些数据聚合展示（无需手动改首页）

---

## 13. 里程碑计划
- Phase 1（MVP 上线）：首页 + start + schedule + library + stats（手动数据）
- Phase 2（V1 可用性）：搜索、更多筛选、streams 详情更完善
- Phase 3（V2 自动化）：数据抓取/半自动更新、iCal 订阅、更多统计维度

---

## 14. 免责声明（建议放 /about）
- 本站为非官方粉丝站，与官方/运营无隶属关系
- 内容引用遵循平台规则，侵删联系
- 统计数据可能存在误差，以平台显示为准