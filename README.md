# DS-Whalegirl·虹 — 伴学小鲸

中国矿业大学（北京）数字党校培训平台（`zhdj.cumtb.edu.cn`）的伴学脚本，油猴脚本形态（ScriptCat / Tampermonkey）。UI 沿用 DS-Whalegirl 的液态玻璃体系，配色改为红色族。

- 落地页：<https://dream-architect1026.github.io/ds-whalegirl-hong/>
- 脚本直链：<https://dream-architect1026.github.io/ds-whalegirl-hong/zhdj-shuavideo.user.js>
- 交流群：1128950753（与 DS-Whalegirl 正常版共用）

## 已实测

| 课程 | 结果 |
| --- | --- |
| 9402/737《马克思主义为什么行》 | 6 讲，17:19 → 17:49 全自动跑完，学时 7.7 → 8.4 |
| 9204/737《毛泽东思想的科学体系和历史地位》 | 2 讲 29:44 + 31:39，逐讲推进至 100% |
| 9397/736、9401/737 | 均已 100% |

## v0.6.4 修复（P0）

**现象**：一讲跑完自动退回课程页再点进下一讲，新页面里面板消失、脚本不再注入；回看上一页，脚本本体还在那里。

**根因**：站点换讲走前端路由，文档不刷新。React 重绘会把 `#zhdj-sv` 连同内部节点一起拔掉，而脚本只在 `document-idle` 注入一次，旧实例还挂在上一份 DOM 上——所以「本体留在上一页」。

**修法（三道防线）**：

1. `navUrlOf()` 从章节行/祖先/最近链接里取下一讲 `href`，`goLecture()` 写 `sessionStorage` 标记后 `location.assign()` **整页导航**，让脚本在新文档重新注入（直击「缓存刷新」思路）。
2. 只能点按钮时 `navGuard()` 盯 800ms×15：URL 变了但面板没了 → `forceFresh()` 整页刷新一次（每讲限一次，防死循环）。
3. 常驻 `revive()` 巡检（1.8s）+ `pageshow`：视频页上面板失踪就地 `buildUI()` 重挂，连续 3 次失败才整页刷新。

## 稳定使用办法

1. 用 Edge + ScriptCat，只保留一份脚本（同名不同版本会被视为新脚本，先删旧的）。
2. 从站点首页进课程列表，不要直连 `/training/learn`（会被重定向）。
3. 进入视频页，确认右下角面板状态行显示 `[LIVE] 1x · 计时`。
4. 标签留在前台，浏览器不要最小化。
5. 每 10 分钟扫一眼 LIVE 计时、进度条、日志时间戳。

## 固定 1x 的原因

站点侧对播放速率有校验，加速会被拉回并可能影响学时判定，因此固定 1x。

## 已知限制

- 后台标签受浏览器定时器节流影响，进度会变慢。
- 拖进度条、跳片尾均被服务端回拉，不做支持。
- 不支持多标签同时跑同一门课。
- 只做视频推进，不含答题与考试。
- 站点改版后需要重新对齐选择器。

## 目录

```
index.html                 落地页（单文件，样式内联）
assets/bg-1600.jpg         首屏立绘
assets/mascot-256.png      鲸娘头像 / favicon
assets/shot-*.webp         面板截图（同源渲染 + 一张真机实拍）
zhdj-shuavideo.user.js     脚本本体（Pages 同时作为自动更新源）
```

## 许可

MIT License

Developed by X.H
