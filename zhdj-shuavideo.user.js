// ==UserScript==
// @name         DS-Whalegirl·虹（ZHDJ 视频增强）
// @namespace    zhdj.cumtb.shuavideo
// @version      0.6.16
// @description  伴学小鲸：中国矿业大学（北京）数字党校培训平台的伴学脚本——本讲内自动点「确定」、自动点下一段；本课刷完自动回列表换下一门未学完的课；断流自动拉起、固定 1x。液态玻璃面板（红色主题，卡片带立绘底纹）。不含答题/测试/提交。
// @author       X.H
// @match        *://zhdj.cumtb.edu.cn/*
// @match        *://*.zhdj.cumtb.edu.cn/*
// @run-at       document-idle
// @grant        none
// @homepageURL  https://dream-architect1026.github.io/ds-whalegirl-hong/
// @supportURL   https://github.com/Dream-Architect1026/ds-whalegirl-hong/issues
// @updateURL    https://dream-architect1026.github.io/ds-whalegirl-hong/zhdj-shuavideo.user.js
// @downloadURL  https://dream-architect1026.github.io/ds-whalegirl-hong/zhdj-shuavideo.user.js
// @icon         https://dream-architect1026.github.io/ds-whalegirl-hong/assets/mascot-256.png
// ==/UserScript==

(function () {
  'use strict';

  // 单实例守卫：脚本被重复注入（更新/重装/多次 match 命中）时只跑一份，杜绝双面板与双定时器
  if (window.__ZHDJ_SV_ALIVE__) return;
  window.__ZHDJ_SV_ALIVE__ = true;

  var CFG_KEY = 'zhdj_sv_cfg_v1';
  var REFRESH_KEY = 'zhdj_sv_refresh_ts';
  var RATE = 1;                 // 固定 1x
  var RELOAD_CAP = 60;          // 10 分钟内自动刷新次数（仅作极端保护）
  var RELOAD_WIN = 10 * 60 * 1000;
  var EMBLEM = 'https://aka.doubaocdn.com/s/TIDxOM7CrV';

  var cfg = { on: true };
  try {
    var saved = JSON.parse(localStorage.getItem(CFG_KEY) || '{}');
    if (typeof saved.on === 'boolean') cfg.on = saved.on;
  } catch (e) { cfg.on = true; }   // 配置读坏了就回默认，别让脚本因脏数据停摆

  var video = null;
  var userPaused = false;
  var lastPointerDown = 0;
  var gestureArmed = false;
  var unmuteTried = false;
  var lastProgressTime = -1;
  var lastProgressAt = 0;
  var allDone = false;          // 已是最后一讲，别再刷"播放完毕"

  // 只有在"真的播不动"（暂停 / 时间不再推进）时才动弹窗
  function stalled() {
    if (!video) return true;      // 还没拿到 video：当作未在正常播放
    var now = Date.now();
    if (video.currentTime > lastProgressTime + 0.01) {
      lastProgressTime = video.currentTime;
      lastProgressAt = now;
      return false;
    }
    if (video.paused) return true;
    return (now - lastProgressAt) > 3000;
  }
  var lastDialogClick = 0;
  var handledCount = 0;
  var sameKw = { kw: '', n: 0, at: 0 };   // 同一弹窗反复出现的计数（防和站点死磕）
  var note = '';

  function saveCfg() {
    storeSet(CFG_KEY, JSON.stringify({ on: cfg.on }));
  }

  /* ---------------- 稳定内核（v0.6.1）：隔离异常 / 定时器托管 / 存储容错 / 自愈 ---------------- */

  var errCount = 0, lastErrAt = 0;

  // 任何回调抛错都被吞掉并记一笔：一次异常不能拖垮整轮巡检
  function guard(tag, fn) {
    return function () {
      try { return fn.apply(this, arguments); }
      catch (e) {
        errCount++;
        var now = Date.now();
        if (now - lastErrAt > 3000) {
          lastErrAt = now;
          try { log('自愈 › ' + tag + (e && e.message ? '：' + e.message : '')); } catch (x) {}
        }
      }
      return undefined;
    };
  }

  function safeInterval(fn, ms, tag) {
    return setInterval(guard(tag || 'interval', fn), ms);
  }

  function safeTimeout(fn, ms, tag) {
    return setTimeout(guard(tag || 'timeout', fn), ms);
  }

  // 存储一律容错：隐私模式 / 配额满 / 被禁用时退回内存值，不抛错
  var memStore = {};
  function storeGet(k, useSession) {
    try {
      var s = useSession ? sessionStorage : localStorage;
      return s.getItem(k);
    } catch (e) { return memStore[k] == null ? null : memStore[k]; }
  }
  function storeSet(k, v, useSession) {
    memStore[k] = v;
    try {
      var s = useSession ? sessionStorage : localStorage;
      s.setItem(k, v);
      return true;
    } catch (e) { return false; }
  }
  function jsonOf(s, dflt) {
    try { var o = JSON.parse(s); return o == null ? dflt : o; } catch (e) { return dflt; }
  }

  window.addEventListener('error', guard('onerror', function (ev) {
    errCount++;
    if (errCount <= 3) log('页面错误 › ' + ((ev && ev.message) || 'unknown'));
  }), true);

  window.addEventListener('unhandledrejection', guard('unhandled', function (ev) {
    errCount++;
    var r = ev && ev.reason;
    if (errCount <= 3) log('异常自愈 › ' + ((r && r.message) || r || 'promise'));
  }));

  // 断网/恢复：断网期间不刷页，恢复后立刻补拉播放
  var netDown = (typeof navigator !== 'undefined' && navigator.onLine === false);
  window.addEventListener('offline', guard('offline', function () {
    netDown = true; note = '网络已断开，等待恢复'; render();
  }));
  window.addEventListener('online', guard('online', function () {
    netDown = false; note = ''; tryPlay(); ensure(); render();
  }));

  /* ---------------- 弹窗自动确认（最高优先级） ---------------- */

  // 关键词 -> 需要点击的按钮文案
  var DIALOG_RULES = [
    { kw: '网络不稳定', labels: ['确定', '刷新', '确定刷新', '知道了'], reload: true },
    { kw: '请刷新页面', labels: ['确定', '刷新', '知道了'], reload: true },
    { kw: '上次观看到', labels: ['继续播放', '继续'], reload: false },
    { kw: '是否继续播放', labels: ['继续播放', '继续'], reload: false },
    { kw: '已播放完毕', labels: ['确定'], reload: false, next: true },
    { kw: '完整观看', labels: ['我知道了', '确定'], reload: false },
    { kw: '视频已暂停', labels: ['确定'], reload: false },
    { kw: '点击确定按钮继续学习', labels: ['确定'], reload: false }
  ];

  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') return false;
    if (parseFloat(st.opacity) === 0) return false;
    return true;
  }

  function realClick(el) {
    try { el.click(); } catch (e) {}
    try {
      ['mousedown', 'mouseup', 'click'].forEach(function (t) {
        el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
      });
    } catch (e) {}
  }

  function canReload() {
    var now = Date.now();
    var ts = jsonOf(storeGet(REFRESH_KEY, true), []);
    if (!ts || typeof ts.filter !== 'function') ts = [];
    ts = ts.filter(function (t) { return now - t < RELOAD_WIN; });
    ts.push(now);
    storeSet(REFRESH_KEY, JSON.stringify(ts), true);
    return ts.length <= RELOAD_CAP;
  }

  // 统一自愈刷新：本地节流 + 断网不刷 + 全局限流，三层都过才刷
  var lastHardReload = 0, mediaErr = 0, noVideoTries = 0, playFail = 0;
  function hardReload(reason) {
    var now = Date.now();
    if (now - lastHardReload < 20 * 60 * 1000) return false;
    if (netDown) { note = '网络断开，暂不刷新'; render(); return false; }
    if (!canReload()) { note = '刷新过于频繁，已暂停自动刷新'; render(); return false; }
    lastHardReload = now;
    log('自愈刷页 › ' + (reason || '未知'));
    safeTimeout(function () { try { location.reload(); } catch (e) {} }, 1500, 'reload');
    return true;
  }


  // 按文案找最深的可点击元素（不依赖站点 class 命名）
  function findTextButton(labels) {
    var nodes = document.querySelectorAll('button,a,li,div,span,i');
    var best = null;
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var t = (el.textContent || '').replace(/[\s\u00a0，,。.、:：×x✕]/g, '');
      if (!t || t.length > 10) continue;
      var hit = false;
      for (var j = 0; j < labels.length; j++) {
        var lb = labels[j].replace(/[\s\u00a0，,。.、:：×x✕]/g, '');
        if (t === lb || t.indexOf(lb) >= 0) { hit = true; break; }
      }
      if (!hit) continue;
      if (el.children && el.children.length > 2) continue;
      if (!visible(el)) continue;
      if (!best || best.contains(el)) best = el;
    }
    return best;
  }

  // 兜底：在可见弹层里找主按钮
  function modalPrimary() {
    var boxes = document.querySelectorAll('.el-message-box,.el-dialog,.ant-modal,.van-dialog,.modal,[class*="dialog"],[class*="modal"]');
    for (var i = 0; i < boxes.length; i++) {
      var b = boxes[i];
      if (!visible(b)) continue;
      var btns = b.querySelectorAll('button,.el-button,[role="button"]');
      for (var k = btns.length - 1; k >= 0; k--) {
        if (visible(btns[k])) return btns[k];
      }
    }
    return null;
  }

  // 只认「可见弹层」里的文字，避免把页面正文里的提示句当成弹窗
  function visibleDialogText() {
    var boxes = document.querySelectorAll('.el-dialog,.el-message-box,.el-message,.ant-modal,.van-dialog,[class*="dialog"],[class*="modal"],[class*="message-box"],[class*="popup"]');
    var out = '';
    for (var i = 0; i < boxes.length; i++) {
      var b = boxes[i];
      if (b.id === 'zhdj-sv' || (b.closest && b.closest('#zhdj-sv'))) continue;
      if (!visible(b)) continue;
      var t = b.innerText || '';
      if (!t) continue;
      out += ' ' + t;
    }
    return out.replace(/\s+/g, ' ').trim();
  }

  function handleDialogs() {
    if (!document.body) return false;
    if (Date.now() - lastDialogClick < 2500) return false;
    var txt = visibleDialogText();
    if (!txt || !/网络不稳定|请刷新页面|上次观看到|是否继续播放|已播放完毕|完整观看|视频已暂停|点击确定按钮继续学习/.test(txt)) {
      if (note === '弹窗已出现但未找到按钮') { note = ''; render(); }
      return false;
    }
    for (var i = 0; i < DIALOG_RULES.length; i++) {
      var rule = DIALOG_RULES[i];
      if (txt.indexOf(rule.kw) < 0) continue;
      if (allDone && (rule.next || rule.kw === '视频已暂停' || rule.kw === '点击确定按钮继续学习')) continue;
      if (rule.reload && !stalled()) continue;   // 正常播放中：网络提示不处理，避免无谓刷新
      var btn = findTextButton(rule.labels) || modalPrimary();
      if (!btn) { note = '弹窗已出现但未找到按钮'; return false; }
      if (rule.reload && !canReload()) { note = '网络异常过多，已暂停自动刷新'; return false; }
      // 同一类弹窗在 5 分钟内反复弹：点够次数就退让，别跟站点来回死磕
      var now2 = Date.now();
      if (sameKw.kw === rule.kw && now2 - sameKw.at < 5 * 60 * 1000) {
        sameKw.n++;
        if (sameKw.n > 12) { note = '弹窗反复出现，已暂停自动确认'; render(); return false; }
      } else { sameKw.kw = rule.kw; sameKw.n = 1; sameKw.at = now2; }
      lastDialogClick = Date.now();
      handledCount++;
      userPaused = false;
      note = '';
      realClick(btn);
      log('确认弹窗 › ' + rule.kw);
      render();
      safeTimeout(function () { ensure(); tryPlay(); }, 800, 'dlg');
      safeTimeout(function () { ensure(); tryPlay(); }, 2500, 'dlg');
      if (rule.next) {
        setTimeout(function () {
          endOfChapter();
        }, 1200);
      }
      return true;
    }
    return false;
  }

  /* ---------------- 播放控制 ---------------- */

  function findVideo() {
    return document.querySelector('video#video') ||
           document.querySelector('video.video-js') ||
           document.querySelector('.video-js video') ||
           document.querySelector('.palyContBox video') ||
           document.querySelector('video');
  }

  function tryPlay() {
    if (!video || !cfg.on || video.paused === false) return;
    if (allDone && isFinite(video.duration) && video.duration > 10 &&
        video.currentTime > video.duration - 2) return;   // 最后一讲已完，别重播
    var p;
    try { p = video.play(); } catch (e) { return; }
    if (p && p.catch) {
      p.catch(function (err) {
        if (video && video.paused === false) { playFail = 0; return; }   // 其实已经播起来了，不算失败
        if (!err || err.name !== 'NotAllowedError') {
          playFail++;
          if (playFail >= 5) { playFail = 0; hardReload('播放启动失败'); }
          return;
        }
        playFail = 0;
        // 自动播放被拦截：先静音起播，再尝试恢复声音
        if (unmuteTried) {
          try { video.muted = true; video.play(); } catch (e) { armGesture(); }
          return;
        }
        unmuteTried = true;
        try {
          video.muted = true;
          var p2 = video.play();
          if (p2 && p2.catch) p2.catch(function () { armGesture(); });
          setTimeout(function () {
            if (!video || !cfg.on || video.paused) return;
            try { video.muted = false; } catch (e) { return; }
            setTimeout(function () {
              if (video && video.paused) {   // 恢复声音又被拦，保持静音继续
                try { video.muted = true; video.play(); } catch (e) {}
              }
              render();
            }, 600);
          }, 1500);
        } catch (e) { armGesture(); }
      });
    }
  }

  function armGesture() {
    if (gestureArmed) return;
    gestureArmed = true;
    var once = function () {
      document.removeEventListener('pointerdown', once, true);
      document.removeEventListener('keydown', once, true);
      gestureArmed = false;
      if (cfg.on && !userPaused) tryPlay();
    };
    document.addEventListener('pointerdown', once, true);
    document.addEventListener('keydown', once, true);
  }

  function applyRate() {
    if (!video || !cfg.on) return;
    if (Math.abs(video.playbackRate - RATE) > 0.01) {
      try { video.playbackRate = RATE; } catch (e) {}
    }
  }

  function attach(v) {
    if (video === v) return;
    video = v;

    v.addEventListener('play', function () { applyRate(); });
    v.addEventListener('ratechange', function () { applyRate(); });

    // 媒体层事件：加载、报错、缓冲都要有交代，不能静默停住
    v.addEventListener('loadedmetadata', function () { applyRate(); if (cfg.on && !userPaused) tryPlay(); });
    v.addEventListener('canplay', function () { if (cfg.on && !userPaused) tryPlay(); });
    v.addEventListener('playing', function () { mediaErr = 0; });
    v.addEventListener('error', function () {
      // 只有真的加载/解码失败才算致命；P2P 播放器切片段的瞬时报错不计入，避免把正常播放刷成「自愈刷页」
      var fatal = !!v.error && v.readyState === 0;
      mediaErr = fatal ? mediaErr + 1 : 0;
      log(fatal ? ('媒体错误 ' + mediaErr) : '片段抖动，已忽略');
      if (mediaErr >= 5) { mediaErr = 0; hardReload('媒体解码错误'); }
    });
    v.addEventListener('stalled', function () { log('缓冲停滞'); });
    v.addEventListener('waiting', function () { log('缓冲中'); });

    // 站点偶尔会把倍速改回去：靠 timeupdate 每 2 秒校一次，成本极低
    var lastRateFix = 0;
    v.addEventListener('timeupdate', function () {
      var now = Date.now();
      if (now - lastRateFix < 2000) return;
      lastRateFix = now;
      applyRate();
    });

    v.addEventListener('ended', function () {
      setTimeout(function () {
        endOfChapter();
      }, 800);
    });
    v.addEventListener('pause', function () {
      if (!cfg.on || userPaused) return;
      if (Date.now() - lastPointerDown < 1500) {   // 视为用户手动暂停
        userPaused = true;
        render();
        return;
      }
      setTimeout(function () {
        if (!cfg.on || userPaused) return;
        if (handleDialogs()) return;               // 弹窗未处理前不抢播放
        tryPlay();
      }, 400);
    });

    applyRate();
    if (cfg.on) tryPlay();
    render();
  }

  function ensure() {
    var v = findVideo();
    if (v && v !== video) attach(v);
    if (video && cfg.on) applyRate();
    // 整课已 100%（被站点甩回已完成课时的自救：直接判本课结束并换课）
    if (!allDone && video && lessonsAllDone()) {
      log('本课已全部学完');
      setTimeout(function () { courseFinished(); }, 3000);
    }
    render();
  }

  function lessonsAllDone() {
    var rows = chapterRows();
    if (rows.length < 2) return false;
    for (var i = 0; i < rows.length; i++) { if (!isDone(rows[i])) return false; }
    return true;
  }

  /* ---------------- 章节 / 自动下一讲 ---------------- */

  var TIME_RE = /\d{1,2}:\d{2}(:\d{2})?/;

  function chapterRows() {
    var scope = document.querySelector('.video-detail') || document.querySelector('main') || document.body;
    var all = scope.querySelectorAll('div,li,a');
    var loose = [], strict = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var t = (el.innerText || '').trim();
      if (!t || t.length > 160) continue;
      var m = t.match(new RegExp(TIME_RE.source, 'g'));
      if (!m || m.length !== 1) continue;
      if (el.querySelector('video')) continue;
      var r = el.getBoundingClientRect();
      if (r.height > 140 || r.height < 20) continue;
      loose.push(el);
      // v0.6.16：分讲行必须「百分比 + 标题」齐全，排掉只有时间/只有百分比的碎片节点，
      // 否则 rows 里混进碎片会导致 currentIndex 认错、在同一段上反复点
      if (!/\d+\s*%/.test(t)) continue;
      if (t.replace(/[0-9:%.、,，\s]/g, '').length < 4) continue;
      strict.push(el);
    }
    // 兜底：严格规则一条都没命中（百分比文字不在行节点内）时退回宽松集合，绝不空转
    var rows = strict.length ? strict : loose;
    return rows.filter(function (el) {
      return !rows.some(function (o) { return o !== el && el.contains(o); });
    });
  }

  function isDone(el) {
    var html = el.innerHTML;
    var txt = el.innerText || '';
    if (/100%/.test(txt)) return true;
    if (/check|dui|finish|complete|success|done/i.test(el.className || '')) return true;
    if (el.querySelector('img[src*="check"],img[src*="finish"],svg[class*="check"],[class*="check"],[class*="finish"]')) return true;
    return /已完成|已学完/.test(html);
  }

  var lastAdvEl = null, lastAdvAt = 0;

  function nextChapter() {
    var rows = chapterRows();
    if (!rows.length) return false;
    // v0.6.16：本课所有分讲都已 100% → 不再在末尾反复点，直接进二级换课
    if (rows.length >= 2 && rows.every(isDone)) { courseFinished(); return false; }
    var idx = -1;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].classList.contains('active') ||
          rows[i].className.indexOf('active') >= 0 ||
          rows[i].getAttribute('aria-current')) { idx = i; break; }
    }
    if (idx < 0) {
      // 没有 active 标记：把"最后一个 100% 的条目"当作当前讲
      for (var k = 0; k < rows.length; k++) {
        if (/100%/.test(rows[k].innerText || '')) idx = k;
      }
    }
    if (idx < 0) {
      // 再兜底：第一条未完成的
      for (var m = 0; m < rows.length; m++) {
        if (!isDone(rows[m])) { idx = m; break; }
      }
    }
    var target = rows[idx + 1] || null;
    if (!target) {                      // 本讲已是最后一段 → 交回「换下一门课」那一级
      courseFinished();
      return false;
    }
    var curTxt = (rows[idx].innerText || '').replace(/\s+/g, '');
    var nxtTxt = (target.innerText || '').replace(/\s+/g, '');
    if (curTxt === nxtTxt) return false;
    // 同一个目标 25 秒内只点一次，防止在讲末反复点、把自己卡死在缓冲里
    if (lastAdvEl === target && Date.now() - lastAdvAt < 25 * 1000) return false;
    lastAdvEl = target; lastAdvAt = Date.now();
    var clickable = target.querySelector('a,button') || target;
    realClick(clickable);          // 只在本讲内点下一段，绝不导航、绝不换课
    log('本讲内切下一段');
    return true;
  }

  // v0.6.16：讲末统一收口——全 100% 就换课；还有下一段就推进；都没有就等平台结算（限次）
  var endTries = 0;
  function endOfChapter() {
    var rows = chapterRows();
    if (rows.length >= 2 && rows.every(isDone)) { endTries = 0; courseFinished(); return true; }
    if (nextChapter()) { endTries = 0; return true; }
    if (endTries >= 6) { note = '本讲已播完，平台未结算，请手动'; render(); return false; }
    endTries++;
    safeTimeout(function () { try { endOfChapter(); } catch (e) {} }, 5000, 'ending');
    return false;
  }

  /* ---------------- 面板自愈（v0.6.16 · 只补挂，不导航、不刷新） ----------------
     v0.6.16 起彻底取消跨讲/跨课自动跳转：整页导航、换讲守卫、强制刷新全部删除，
     换讲与换课由用户手动点。这里只做一件事——面板节点被站点重绘拔掉时，就地补挂。 */
  var reviveFail = 0;

  function revive() {
    if (!isVideoPage()) return;
    if (document.getElementById('zhdj-sv') || document.getElementById('zhdj-sv-mini')) { reviveFail = 0; return; }
    reviveFail++;
    try { buildUI(); } catch (e) {}
  }

  /* ---------------- 两级换课（v0.6.16）：讲内自动，本课刷完自动回列表换下一门 ----------------
     一级：本讲（分讲）之间，翻页内点下一段（在 nextChapter 里做，不跳文档）；
     二级：本课四段全 100% 后，回 /training/learn 由 courseAdvanceLoop 接管下一门未学完的课。
     两条都带节流，避免在已完成课上反复弹。 */
  var backTimer = 0, backLastAt = 0, backTries = 0;
  function backToLearn(reason) {
    if (backTimer) return false;
    var now = Date.now();
    if (now - backLastAt < 90 * 1000) return false;      // 90 秒内只换一次，防抖
    if (backTries >= 10) { note = '换课次数过多，已停下，请手动'; render(); return false; }
    backLastAt = now; backTries++;
    backTimer = setTimeout(function () {
      backTimer = 0;
      log('回课程页换下一门 › ' + reason);
      try { location.href = 'https://zhdj.cumtb.edu.cn/training/learn'; } catch (e) {}
    }, 4000);
    return true;
  }

  function courseFinished() {
    if (!allDone) {
      allDone = true;
      note = '本课已全部学完，正在换下一门';
      log('本课已全部学完');
      render();
    }
    backToLearn('本课学完');
  }

  function pctOf(txt) {
    var m = String(txt || '').match(/(\d+(?:\.\d+)?)\s*%/);
    return m ? parseFloat(m[1]) : -1;
  }

  function cardOf(el) {
    var p = el;
    for (var k = 0; k < 8 && p.parentElement; k++) {
      p = p.parentElement;
      var tx = p.innerText || '';
      if (tx.length > 40 && /必修完成情况|学习进度|获得学时|共\s*\d+\s*讲|选修完成情况/.test(tx)) return p;
    }
    return null;
  }

  // 「必修完成情况 3/8」这类进度：返回 [已完成, 总数]，识别不到返回 null
  function doneOf(txt) {
    var m = String(txt || '').match(/必修完成情况\s*[：:]?\s*(\d+)\s*\/\s*(\d+)/) ||
            String(txt || '').match(/必修完成\s*[：:]?\s*(\d+)\s*\/\s*(\d+)/);
    if (!m) return null;
    return [parseInt(m[1], 10), parseInt(m[2], 10)];
  }

  var tickDone = false;
  function tickUnfinishedOnly() {
    if (tickDone) return;
    var labels = document.querySelectorAll('label,span,div');
    for (var i = 0; i < labels.length; i++) {
      var el = labels[i], t = (el.innerText || '').replace(/\s+/g, '');
      if (t.length > 8) continue;
      if (t !== '仅看未完成' && t !== '只看未完成' && t !== '仅看必修') continue;
      if (!visible(el)) continue;
      var box = el.querySelector('input') || (el.parentElement && el.parentElement.querySelector('input'));
      if (box && box.checked) { tickDone = true; return; }
      realClick(box && box.parentElement ? box.parentElement : el);
      tickDone = true;
      return;
    }
    tickDone = true;
  }

  var menuClicked = false;
  function clickLearnMenu() {
    if (menuClicked) return false;
    if (/我的课程/.test(document.body ? document.body.innerText : '')) return false;
    var all = document.querySelectorAll('a,li,div,span');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var t = (el.innerText || '').replace(/\s+/g, '');
      if (t !== '学习' && t !== '课程学习' && t !== '首页') continue;
      var r = el.getBoundingClientRect();
      if (!r.width || r.left > window.innerWidth * 0.45 || r.height > 60) continue;
      menuClicked = true;
      realClick(el);
      log('点开「' + t + '」回到课程列表');
      return true;
    }
    return false;
  }

  function onLearnPage() {
    if (!/^\/training/.test(location.pathname)) return false;   // 只在培训平台内动作，门户首页不碰
    if (/video-?details?/i.test(location.pathname)) return false;
    tickUnfinishedOnly();
    if (clickLearnMenu()) return true;

    // 课程列表页：只点「必修完成情况 x/y」里 x<y 的那门；x==y 的全跳过
    var labels = document.querySelectorAll('a,button,span,div');
    var fallback = null;
    for (var i = 0; i < labels.length; i++) {
      var el = labels[i], t = (el.innerText || '').replace(/\s+/g, '');
      if (!t || t.length > 6) continue;
      if (!/^(继续学习|开始学习|继续观看|去学习|立即学习|已开始)$/.test(t)) continue;
      if (!visible(el)) continue;
      var target = el.querySelector('a,button') || (el.closest && el.closest('button,a')) || el;
      var card = cardOf(el);
      if (!card) { if (!fallback) fallback = target; continue; }
      var txt = card.innerText || '';
      var dn = doneOf(txt);
      if (dn) {
        if (dn[0] >= dn[1]) continue;              // 这门已完成，跳过
        log('接续未学完课程 ' + dn[0] + '/' + dn[1]);
        realClick(target);
        return true;
      }
      var pct = pctOf(txt);
      if (pct >= 100) continue;
      if (pct > 0) { log('接续未学完课程 ' + pct + '%'); realClick(target); return true; }
      if (!fallback) fallback = target;
    }
    if (fallback) {
      log('进入下一门课程');
      realClick(fallback);
      return true;
    }
    return false;
  }

  /* ---------------- 悬浮控件（DS-Whalegirl·虹 · 液态玻璃） ---------------- */

  var panel, badge, statTxt, fill, bodyEl;
  var tabStatus, tabWhale, tabCfg, tabGuide, tabTip;
  var paneStatus, paneWhale, paneCfg, paneGuide, paneTip;

  var UI_KEY = 'zhdj_sv_ui_v1';
  var uiOpen = false;
  try {
    var uiSaved = JSON.parse(localStorage.getItem(UI_KEY) || '{}');
    if (typeof uiSaved.open === 'boolean') uiOpen = uiSaved.open;
  } catch (e) {}
  var uiTab = 'status';   // 固定落在「状态」页，保证一进来就能看到日志与底纹
  var lastPct = -1;

  var logs = [], logBox = null, lastLog = { s: '', at: 0 };
  function log(s) {
    var now = Date.now();
    if (lastLog.s === s && now - lastLog.at < 3000) return;
    lastLog.s = s; lastLog.at = now;
    var d = new Date();
    var tm = [d.getHours(), d.getMinutes(), d.getSeconds()].map(function (n) {
      return ('0' + n).slice(-2);
    }).join(':');
    logs.unshift({ t: tm, s: s });
    if (logs.length > 30) logs.length = 30;
    paintLog();
  }
  function paintLog() {
    if (!logBox) return;
    var keep = logBox.scrollTop;
    var atTop = keep <= 14;          // 用户没往上翻：直接贴到最新一条
    logBox.innerHTML = '';
    if (!logs.length) {
      var em = mk('div', 'sv-log-em'); em.textContent = '等待事件…';
      logBox.appendChild(em);
      return;
    }
    logs.forEach(function (it) {
      var r = mk('div', 'sv-log-it');
      var t = mk('span', 'sv-log-t'); t.textContent = it.t;
      var c = mk('span'); c.textContent = it.s;
      r.appendChild(t); r.appendChild(c);
      logBox.appendChild(r);
    });
    // 新日志立即回滚到最新，不隔 10 秒；手动翻看历史时不打断
    logBox.scrollTop = atTop ? 0 : Math.min(keep, logBox.scrollHeight);
  }
  var BG = 'https://aka.doubaocdn.com/s/BWr6rp7qUR';

  /* ---- 打赏图：与 DS-Whalegirl 同一套 XOR+盐+校验 加密绑定 ---- */
  var DONATE_KEY = 'WjyR5yvUaK8=';
  var DONATE_SIG = 'cf585524';
  var DONATE_SALT = 'HXWHALE-DONATE-V1';
  var DONATE_B64 = [
    "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",
    "d3jeqWqALYIMDQ=="
  ];

  function donateImage() {
    try {
      var key = atob(DONATE_KEY);
      var raw = atob(DONATE_B64.join(''));
      var bytes = [];
      for (var i = 0; i < raw.length; i++) bytes.push(raw.charCodeAt(i) ^ key.charCodeAt(i % key.length));
      var cut = bytes.length - DONATE_SALT.length;
      var tail = '';
      for (var j = cut; j < bytes.length; j++) tail += String.fromCharCode(bytes[j]);
      if (tail !== DONATE_SALT) return '';
      var digest = 7;
      for (var k = 0; k < cut; k++) {
        digest = ((digest * 33 + bytes[k]) >>> 0) + (k % 7);
        digest = digest >>> 0;
      }
      if (digest.toString(16) !== DONATE_SIG) return '';
      var bin = '', step = 8192;
      for (var m = 0; m < cut; m += step) {
        bin += String.fromCharCode.apply(null, bytes.slice(m, m + step));
      }
      return 'data:image/jpeg;base64,' + btoa(bin);
    } catch (e) { return ''; }
  }

  function saveUI() {
    try { localStorage.setItem(UI_KEY, JSON.stringify({ open: uiOpen, tab: uiTab })); } catch (e) {}
  }

  function mk(tag, cls) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    return el;
  }

  function css() {
    if (document.getElementById('zhdj-sv-style')) return;
    var s = document.createElement('style');
    s.id = 'zhdj-sv-style';
    s.textContent = [
      /* ===== 设计令牌：DS-Whalegirl·虹 · 液态玻璃体系 ===== */
      '#zhdj-sv{--zr-a:#FF5A5A;--zr-b:#C8102E;--zr-c:#FF8A5C;',
      '--zr-ink:#FFF0EE;--zr-dim:#E3ADA6;--zr-line:rgba(255,120,110,.20);',
      '--zr-glass:rgba(38,10,14,.55);--zr-glass2:rgba(56,14,20,.42);',
      /* 液态玻璃：逐条移植正版 --lg-rim / --lg-rim-dim / --lg-edge / --lg-tint-hi / --lg-shadow-hi，红族取值 */
      '--zr-rim:rgba(255,255,255,.30);--zr-rim-dim:rgba(255,255,255,.14);',
      '--zr-edge:rgba(255,150,140,.22);',
      '--zr-tint:linear-gradient(155deg,rgba(255,255,255,.10),rgba(255,255,255,.028) 40%,rgba(28,6,10,.30));',
      '--zr-tint-hi:linear-gradient(155deg,rgba(255,255,255,.20),rgba(255,255,255,.07) 34%,rgba(34,6,10,.34) 100%);',
      '--zr-tint-flat:linear-gradient(160deg,rgba(255,255,255,.075),rgba(255,255,255,.018) 58%,rgba(24,5,9,.20));',
      '--zr-spec:linear-gradient(160deg,rgba(255,255,255,.24),rgba(255,255,255,.05) 42%,transparent 74%);',
      '--zr-shadow:0 8px 22px rgba(10,2,4,.30),inset 0 1px 0 var(--zr-rim-dim);',
      '--zr-shadow-hi:0 12px 28px rgba(10,2,4,.42),0 0 20px rgba(255,90,90,.16),inset 0 1px 0 var(--zr-rim);',
      /* 卡片底纹：赤红立绘出血图，压在玻璃层下方，只用来看得见一点形，不抢字 */
      '--zr-photo:url(https://dream-architect1026.github.io/ds-whalegirl-hong/assets/bg-1600.jpg);',
      '--zr-t:background .28s ease,border-color .28s ease,box-shadow .28s ease,transform .28s cubic-bezier(.34,1.2,.64,1),backdrop-filter .28s ease,-webkit-backdrop-filter .28s ease,color .2s ease;',
      'color-scheme:dark;',
      '--zr-font:"HarmonyOS Sans SC","MiSans","PingFang SC","Microsoft YaHei",system-ui,sans-serif;',
      'position:fixed;right:14px;bottom:74px;z-index:2147483647;box-sizing:border-box;',
      'font-family:var(--zr-font);color:var(--zr-ink);user-select:none;',
      'font-variant-numeric:tabular-nums;letter-spacing:.02em}',
      /* 折叠态：35px 最小化条 */
      '#zhdj-sv .sv-bar{display:flex;align-items:center;gap:7px;box-sizing:border-box;width:310px;height:35px;',
      'padding:0 8px 0 6px;border-radius:12px;cursor:pointer;overflow:hidden;',
      'background:linear-gradient(120deg,rgba(255,90,90,.16) 0%,rgba(200,16,46,.09) 48%,rgba(255,138,92,.16) 100%),var(--zr-tint);',
      'border:1px solid var(--zr-edge);box-shadow:var(--zr-shadow);',
      '-webkit-backdrop-filter:blur(14px) saturate(155%);backdrop-filter:blur(14px) saturate(155%);',
      'transition:var(--zr-t)}',
      '#zhdj-sv .sv-bar:hover{transform:translateY(-1px);border-color:rgba(255,180,170,.42);background:var(--zr-tint-hi);box-shadow:var(--zr-shadow-hi)}',
      '#zhdj-sv .sv-bar .sv-txt{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
      'font-size:12px;color:var(--zr-dim)}',
      '#zhdj-sv .sv-bar .sv-min{margin-left:2px}',
      /* 展开态：310 x 500 玻璃窗口 */
      '#zhdj-sv .sv-card{display:none;box-sizing:border-box;width:310px;height:500px;max-height:calc(100vh - 110px);',
      'flex-direction:column;border-radius:16px;overflow:hidden;position:relative;',
      'background-image:var(--zr-spec),var(--zr-tint-hi),linear-gradient(180deg,rgba(16,3,6,.26),rgba(16,3,6,.44)),var(--zr-photo);',
      'background-color:rgba(22,4,8,.30);background-repeat:no-repeat;',
      'background-size:auto,auto,auto,cover;background-position:0 0,0 0,0 0,50% 34%;',
      'border:1px solid var(--zr-edge);box-shadow:var(--zr-shadow-hi);',
      '-webkit-backdrop-filter:blur(18px) saturate(155%);backdrop-filter:blur(18px) saturate(155%)}',
      '#zhdj-sv.sv-open .sv-card{display:flex}',
      '#zhdj-sv.sv-open .sv-bar{display:none}',
      '#zhdj-sv.sv-off{filter:saturate(.45);opacity:.72}',
      /* 标题栏：玻璃 + 极光描边（复刻 card-header） */
      '#zhdj-sv .sv-head{flex:0 0 auto;position:relative;z-index:3;display:flex;align-items:center;justify-content:space-between;gap:8px;',
      'padding:11px 13px;',
      'background:linear-gradient(120deg,rgba(255,90,90,.16) 0%,rgba(200,16,46,.10) 48%,rgba(255,138,92,.16) 100%);',
      'border-bottom:1px solid var(--zr-line);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px)}',
      '#zhdj-sv .sv-head::after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:1px;',
      'background:linear-gradient(90deg,transparent,var(--zr-a),var(--zr-c),transparent);opacity:.75}',
      '#zhdj-sv .sv-title{display:flex;align-items:center;gap:7px;min-width:0}',
      '#zhdj-sv .sv-title span{font-size:14px;font-weight:700;letter-spacing:.4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;',
      'background:linear-gradient(92deg,#ffffff 0%,var(--zr-a) 55%,var(--zr-c) 100%);',
      '-webkit-background-clip:text;background-clip:text;color:transparent;text-shadow:0 0 18px rgba(255,90,90,.25)}',
      '#zhdj-sv .sv-head-r{display:flex;align-items:center;gap:6px;flex:0 0 auto}',
      '#zhdj-sv .sv-ver{font-size:10.5px;padding:1px 7px;border-radius:999px;border:1px solid rgba(255,90,90,.42);',
      'background:rgba(255,90,90,.12);color:var(--zr-a)}',
      '#zhdj-sv .sv-icon{width:22px;height:22px;padding:0;display:flex;align-items:center;justify-content:center;',
      'border-radius:7px;font-size:13px;line-height:1}',
      /* 主体 */
      '#zhdj-sv .sv-body{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;padding:10px 12px 14px;',
      'box-sizing:border-box;scrollbar-width:none;-ms-overflow-style:none;overscroll-behavior:contain}',
      '#zhdj-sv .sv-body::-webkit-scrollbar{width:0;height:0;display:none}',
      '#zhdj-sv .sv-body::-webkit-scrollbar-thumb{display:none}',
      '#zhdj-sv .sv-body::-webkit-scrollbar-track{display:none}',
      /* 全局滚动条：全部移除，滚动动作交给滚轮 / 触摸，不再露出白底原生条 */
      '#zhdj-sv *{scrollbar-width:none;-ms-overflow-style:none}',
      '#zhdj-sv *::-webkit-scrollbar{width:0;height:0;display:none}',
      /* 标签页：科技指示条（复刻 demo-tabs） */
      '#zhdj-sv .sv-tabs{display:flex;gap:2px;padding:0 12px;margin:0;border-bottom:1px solid var(--zr-line);',
      'background:linear-gradient(180deg,rgba(40,10,14,.86),rgba(40,10,14,.52));',
      '-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);position:relative;z-index:3;flex:0 0 auto}',
      '#zhdj-sv .sv-tab{position:relative;flex:1 1 0;min-width:0;height:34px;line-height:34px;padding:0;text-align:center;border:0;background:transparent;',
      'color:var(--zr-dim);font-size:13px;font-weight:600;letter-spacing:.3px;cursor:pointer;transition:color .2s}',
      '#zhdj-sv .sv-tab:hover{color:var(--zr-a)}',
      '#zhdj-sv .sv-tab.is-active{color:#fff}',
      '#zhdj-sv .sv-tab.is-active::after{content:"";position:absolute;left:8px;right:8px;bottom:-1px;height:2px;border-radius:2px;',
      'background:linear-gradient(90deg,var(--zr-a),var(--zr-c));box-shadow:0 0 10px rgba(255,90,90,.75)}',
      /* 通用玻璃块（复刻 guide-card） */
      '#zhdj-sv .sv-box{border:1px solid var(--zr-edge);border-radius:12px;background:var(--zr-tint);',
      '-webkit-backdrop-filter:blur(12px) saturate(150%);backdrop-filter:blur(12px) saturate(150%);',
      'box-shadow:0 5px 16px rgba(10,2,4,.24),inset 0 1px 0 var(--zr-rim-dim);',
      'padding:11px 12px;margin:0 0 8px;transition:var(--zr-t)}',
      '#zhdj-sv .sv-box:last-child{margin-bottom:2px}',
      '#zhdj-sv .sv-box:hover{transform:translateY(-1px);border-color:rgba(255,180,170,.38);background:var(--zr-tint-hi);box-shadow:var(--zr-shadow-hi)}',
      '#zhdj-sv .sv-box-h{display:flex;align-items:center;gap:8px;margin:0 0 7px;padding:0}',
      '#zhdj-sv .sv-num{width:20px;height:20px;flex:0 0 20px;border-radius:6px;display:flex;align-items:center;justify-content:center;',
      'font-size:11px;font-weight:700;color:#2A0407;background:linear-gradient(135deg,var(--zr-a),var(--zr-b));',
      'box-shadow:0 0 10px rgba(255,90,90,.35)}',
      '#zhdj-sv .sv-box-t{font-size:12.5px;font-weight:600;color:#FFE6E2;letter-spacing:.3px}',
      '#zhdj-sv .sv-copy{font-size:11.5px;line-height:1.62;color:var(--zr-dim)}',
      '#zhdj-sv .sv-copy b{color:var(--zr-a);font-weight:600}',
      '#zhdj-sv .sv-copy div{margin:2px 0}',
      /* 顶部说明块（复刻 guide-header） */
      '#zhdj-sv .sv-hero{position:relative;border:1px solid rgba(255,150,140,.24);border-radius:12px;padding:12px 13px;margin:0 0 9px;',
      'background:linear-gradient(120deg,rgba(255,90,90,.16),rgba(255,138,92,.09) 46%,rgba(200,16,46,.14)),var(--zr-tint);',
      'box-shadow:0 6px 18px rgba(10,2,4,.26),inset 0 1px 0 var(--zr-rim-dim);',
      '-webkit-backdrop-filter:blur(16px) saturate(155%);backdrop-filter:blur(16px) saturate(155%);transition:var(--zr-t)}',
      '#zhdj-sv .sv-hero-t{font-size:13.5px;font-weight:600;color:#fff;letter-spacing:.3px}',
      '#zhdj-sv .sv-hero-s{margin-top:3px;font-size:11px;color:var(--zr-dim);padding-right:52px}',
      '#zhdj-sv .sv-tag{position:absolute;right:11px;top:11px;font-size:9.5px;padding:1px 7px;border-radius:999px;',
      'border:1px solid rgba(255,90,90,.42);background:rgba(255,90,90,.12);color:var(--zr-a);letter-spacing:.8px}',
      /* 运行日志（复刻 log / timeline）；底纹用立绘出血图，压暗只留形，不抢字 */
      '#zhdj-sv .sv-log{border:1px solid var(--zr-edge);border-radius:12px;',
      'background-image:linear-gradient(180deg,rgba(16,3,6,.60),rgba(16,3,6,.78)),var(--zr-photo);',
      'background-size:auto,cover;background-position:0 0,50% 30%;background-repeat:no-repeat;',
      'box-shadow:0 6px 18px rgba(10,2,4,.28),inset 0 1px 0 var(--zr-rim-dim);',
      '-webkit-backdrop-filter:blur(14px) saturate(150%);backdrop-filter:blur(14px) saturate(150%);',
      'padding:8px 11px;margin:8px 0 0;flex:1 1 auto;min-height:88px;overflow-y:auto;overscroll-behavior:contain}',
      '#zhdj-sv .sv-log-it{display:flex;gap:8px;font-size:11px;line-height:1.55;color:var(--zr-dim);padding:2px 0}',
      '#zhdj-sv .sv-log-it:first-child{color:#FFE6E2}',
      '#zhdj-sv .sv-log-t{flex:0 0 auto;font-size:10px;color:rgba(255,205,200,.5)}',
      '#zhdj-sv .sv-log-em{font-size:11px;color:rgba(255,205,200,.45)}',
      /* 小鲸页：鲸娘 hero + 答题区预留（复刻 whale-hero / empty） */
      '#zhdj-sv .sv-whale{display:flex;flex-direction:column;align-items:center;gap:9px;padding:4px 0 10px}',
      '#zhdj-sv .sv-whale-av{display:block;width:44px;height:44px;object-fit:cover;border-radius:18px;',
      'background:radial-gradient(circle at 50% 42%,rgba(255,90,90,.20),rgba(14,3,6,.32));',
      'border:1px solid rgba(255,90,90,.26);box-shadow:0 2px 10px rgba(10,2,4,.32),inset 0 1px 0 rgba(255,255,255,.18)}',
      '#zhdj-sv .sv-whale-bub{display:flex;flex-direction:column;gap:3px;align-items:center;padding:6px 12px;',
      'border:1px solid var(--zr-edge);border-radius:14px;background:var(--zr-tint);max-width:100%;box-sizing:border-box;',
      'backdrop-filter:blur(16px) saturate(150%);-webkit-backdrop-filter:blur(16px) saturate(150%);',
      'box-shadow:0 6px 18px rgba(10,2,4,.26),inset 0 1px 0 var(--zr-rim-dim)}',
      '#zhdj-sv .sv-whale-txt{font-size:11.5px;line-height:1.6;color:var(--zr-ink);text-align:center}',
      '#zhdj-sv .sv-whale-lv{font-size:10.5px;color:var(--zr-dim)}',
      '#zhdj-sv .sv-whale-lv b{color:var(--zr-a);font-weight:600}',
      '#zhdj-sv .sv-qa{border:1px solid var(--zr-edge);border-radius:12px;background:var(--zr-tint);',
      'padding:10px 11px;box-shadow:0 5px 16px rgba(10,2,4,.24),inset 0 1px 0 var(--zr-rim-dim)}',
      '#zhdj-sv .sv-qa-h{display:flex;align-items:center;gap:8px;margin:0 0 8px}',
      '#zhdj-sv .sv-qa-empty{display:flex;align-items:center;justify-content:center;min-height:118px;padding:10px 8px;',
      'font-size:11px;line-height:1.7;color:var(--zr-dim);text-align:center;border-radius:9px;',
      'border:1px dashed rgba(255,120,110,.22);background:rgba(255,255,255,.02)}',
      /* 配置页（复刻 setting 卡片） */
      '#zhdj-sv .sv-setting{display:grid;gap:8px}',
      '#zhdj-sv .sv-cfg-it{display:grid;grid-template-columns:64px 1fr;gap:4px 8px;padding:9px 11px;border:1px solid var(--zr-edge);',
      'border-radius:12px;background:var(--zr-tint-flat);',
      '-webkit-backdrop-filter:blur(13px) saturate(152%);backdrop-filter:blur(13px) saturate(152%);',
      'box-shadow:0 5px 14px rgba(10,2,4,.22),inset 0 1px 0 var(--zr-rim-dim);transition:var(--zr-t)}',
      '#zhdj-sv .sv-cfg-it:hover{transform:translateY(-1px);border-color:rgba(255,180,170,.38);background:var(--zr-tint-hi);box-shadow:var(--zr-shadow-hi)}',
      '#zhdj-sv .sv-cfg-k{font-size:11.5px;color:var(--zr-dim)}',
      '#zhdj-sv .sv-cfg-v{font-size:11.5px;font-weight:600;color:#fff;text-align:right}',
      '#zhdj-sv .sv-cfg-h{grid-column:1/-1;font-size:10.5px;line-height:1.55;color:rgba(255,205,200,.55)}',
      '#zhdj-sv .sv-donate-cap{margin:9px 0 0;text-align:center;font-size:11px}',
      /* 版本声明：本机出品规范样式——圆角卡片内两行居中，X.H 取主题强调色（红色适配） */
      '#zhdj-sv .sv-foot{margin:14px 0 2px;padding:12px 12px 11px;border-radius:14px;text-align:center;',
      'border:1px solid var(--zr-edge);background:var(--zr-tint);',
      'box-shadow:0 8px 20px rgba(10,2,4,.26),inset 0 1px 0 var(--zr-rim);',
      '-webkit-backdrop-filter:blur(12px) saturate(150%);backdrop-filter:blur(12px) saturate(150%)}',
      '#zhdj-sv .sv-sign{margin:0;font-size:11.5px;line-height:1.5;letter-spacing:.2px;color:rgba(255,236,232,.88)}',
      '#zhdj-sv .sv-sign b{font-weight:700;background:linear-gradient(100deg,var(--zr-a),var(--zr-c));',
      '-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}',
      '#zhdj-sv .sv-meta{margin:4px 0 0;font-size:10.5px;line-height:1.5;color:rgba(255,205,200,.52)}',
      /* 标题栏可拖动 */
      '#zhdj-sv .sv-head{cursor:move}',
      /* 状态行 */
      '#zhdj-sv .sv-row{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11.5px;color:var(--zr-dim)}',
      '#zhdj-sv .sv-row b{color:#fff;font-weight:600}',
      '#zhdj-sv .sv-track{height:4px;margin-top:8px;border-radius:999px;background:rgba(255,255,255,.10);overflow:hidden}',
      '#zhdj-sv .sv-fill{height:100%;width:0;border-radius:999px;',
      'background:linear-gradient(90deg,var(--zr-a),var(--zr-b));box-shadow:0 0 10px rgba(255,90,90,.55);transition:width .6s linear}',
      /* 按钮（复刻 el-button / primary） */
      '#zhdj-sv button{border:1px solid var(--zr-line);border-radius:8px;font-weight:600;letter-spacing:.2px;',
      'background:rgba(255,90,90,.08);color:var(--zr-ink);cursor:pointer;',
      'transition:all .2s}',
      '#zhdj-sv button:hover{background:rgba(255,90,90,.18);border-color:var(--zr-a);color:#fff;box-shadow:0 0 12px rgba(255,90,90,.28)}',
      '#zhdj-sv button:active{transform:translateY(1px)}',
      '#zhdj-sv .sv-primary{border:0;background:linear-gradient(120deg,var(--zr-a),var(--zr-b));color:#2A0407}',
      '#zhdj-sv .sv-primary:hover{box-shadow:0 0 18px rgba(255,90,90,.45);color:#2A0407}',
      /* 状态页：LIVE 徽标 + 进度 + 状态刷新（日志区延伸到底） */
      '#zhdj-sv .sv-body.sv-t-status{display:flex;flex-direction:column;overflow:hidden}',
      '#zhdj-sv .sv-pane-status{display:flex;flex-direction:column;flex:1 1 auto;min-height:0}',
      '#zhdj-sv .sv-live-line{display:flex;align-items:center;gap:8px;margin:0 0 6px}',
      '#zhdj-sv .sv-live{flex:0 0 auto;font-size:9.5px;font-weight:700;letter-spacing:1.2px;padding:2px 7px;border-radius:999px;',
      'background:linear-gradient(120deg,var(--zr-a),var(--zr-b));color:#2A0407}',
      '#zhdj-sv .sv-live-txt{flex:1 1 auto;min-width:0;font-size:11.5px;color:var(--zr-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '#zhdj-sv .sv-live-txt b{color:#fff;font-weight:600}',
      '#zhdj-sv .sv-off .sv-dot{background:rgba(255,255,255,.30);box-shadow:none;animation:none}',
      '#zhdj-sv .sv-dot{width:6px;height:6px;flex:0 0 6px;border-radius:50%;background:var(--zr-a);',
      'box-shadow:0 0 0 1px rgba(255,255,255,.24),0 0 9px rgba(255,90,90,.85);animation:svPulse 2.2s ease-in-out infinite}',
      '@keyframes svPulse{0%,100%{opacity:.55;transform:scale(.90)}50%{opacity:1;transform:scale(1.16)}}',
      /* 打赏卡（复刻 donate-card，红色主题） */
      '#zhdj-sv .sv-donate{border:1px solid rgba(255,190,110,.28);border-radius:12px;',
      'background:linear-gradient(150deg,rgba(255,90,90,.10),rgba(255,140,190,.10));',
      'backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);padding:11px 12px;margin:0 0 8px}',
      '#zhdj-sv .sv-donate h3{margin:0 0 7px;font-size:13px;font-weight:600;color:#FFD9A0}',
      '#zhdj-sv .sv-donate p{margin:0 0 9px;font-size:11.5px;line-height:1.6;color:var(--zr-dim)}',
      '#zhdj-sv .sv-donate img{display:block;width:236px;margin:0 auto;border-radius:10px;',
      'background:#fff;padding:5px;box-shadow:0 8px 24px rgba(0,0,0,.42)}',
      /* 引导页作用域压缩：仅 guide 页收紧间距/行高，打赏卡改横向排布，保证 500px 卡内完整放下；其余四页签规则不动 */
      '#zhdj-sv .sv-pane-guide .sv-hero{padding:7px 11px;margin:0 0 4px}',
      '#zhdj-sv .sv-pane-guide .sv-box{padding:6px 10px;margin:0 0 3px}',
      '#zhdj-sv .sv-pane-guide .sv-box-h{margin:0 0 3px}',
      '#zhdj-sv .sv-pane-guide .sv-copy{line-height:1.4;font-size:11px}',
      '#zhdj-sv .sv-pane-guide .sv-donate{display:flex;flex-direction:column;gap:6px;align-items:center;padding:8px 10px;margin:0 0 2px}',
      '#zhdj-sv .sv-pane-guide .sv-donate-txt{flex:0 0 auto;width:100%;min-width:0}',
      '#zhdj-sv .sv-pane-guide .sv-donate h3{margin:0 0 3px;font-size:12px}',
      '#zhdj-sv .sv-pane-guide .sv-donate p{margin:0 0 3px;line-height:1.3}',
      '#zhdj-sv .sv-pane-guide .sv-donate img{flex:0 0 auto;width:124px;height:auto;max-width:100%;object-fit:contain;border-radius:10px;background:#fff;box-shadow:0 4px 14px rgba(10,2,4,.34)}',
      '#zhdj-sv .sv-pane-guide .sv-donate-cap{text-align:center;width:100%;margin:0;font-size:11px;opacity:.86}',
      '#zhdj-sv .sv-emblem{width:22px;height:22px;flex:0 0 22px;border-radius:50%;object-fit:cover;display:block;',
      'box-shadow:0 0 0 1px rgba(255,255,255,.34),0 3px 10px rgba(255,60,60,.34)}'
    ].join('');
    (document.head || document.documentElement).appendChild(s);
  }

  function fmt(n) {
    if (!isFinite(n)) return '--:--';
    n = Math.max(0, Math.floor(n));
    var m = Math.floor(n / 60), s = n % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  var lastText = { badge: '', stat: '', play: '', power: '', cls: '' };

  function setText(el, key, val) {
    if (!el || lastText[key] === val) return;
    lastText[key] = val;
    el.textContent = val;
  }

  function render() {
    if (!panel) return;
    var cls = (cfg.on ? '' : 'sv-off') + (uiOpen ? ' sv-open' : '');
    if (lastText.cls !== cls) { panel.className = cls; lastText.cls = cls; }
    var t = video ? fmt(video.currentTime) + ' / ' + fmt(video.duration) : '等待视频';
    // 状态栏只说刷课状态：有条目提示就显示提示，否则显示倍速与进度
    setText(badge, 'badge', 'LIVE · ' + RATE + 'x · ' + t);
    setText(statTxt, 'stat', (cfg.on ? (note || (RATE + 'x · ' + t)) : ('已停用 · ' + t)));
    var pct = 0;
    if (video && isFinite(video.duration) && video.duration > 0) {
      pct = Math.min(1, Math.max(0, video.currentTime / video.duration));
    }
    if (fill && Math.abs(pct - lastPct) > 0.004) {
      fill.style.width = (pct * 100).toFixed(1) + '%';
      lastPct = pct;
    }
  }

  function box(num, title, html) {
    var b = mk('div', 'sv-box');
    if (title) {
      var h = mk('div', 'sv-box-h');
      var n = mk('span', 'sv-num'); n.textContent = num;
      var t = mk('span', 'sv-box-t'); t.textContent = title;
      h.appendChild(n); h.appendChild(t);
      b.appendChild(h);
    }
    var c = mk('div', 'sv-copy');
    c.innerHTML = html;
    b.appendChild(c);
    return b;
  }

  function switchTab(name) {
    uiTab = name;
    saveUI();
    var map = {
      status: [tabStatus, paneStatus], whale: [tabWhale, paneWhale], cfg: [tabCfg, paneCfg],
      guide: [tabGuide, paneGuide], tip: [tabTip, paneTip]
    };
    Object.keys(map).forEach(function (k) {
      var pair = map[k];
      if (pair[0]) pair[0].className = 'sv-tab' + (k === name ? ' is-active' : '');
      if (pair[1]) pair[1].style.display = (k === name ? (k === 'status' ? 'flex' : 'block') : 'none');
    });
    // 状态页要占满剩余高度，日志才会延伸并自己滚动
    if (bodyEl) bodyEl.className = 'sv-body' + (name === 'status' ? ' sv-t-status' : '');
    if (name === 'status' && logBox) logBox.scrollTop = 0;
  }

  function buildUI() {
    var ex = document.getElementById('zhdj-sv');
    if (ex) { panel = ex; return; }
    css();
    panel = mk('div');
    panel.id = 'zhdj-sv';

    /* ---- 折叠态最小化条 ---- */
    var bar = mk('div', 'sv-bar');
    var emblem = mk('img', 'sv-emblem');
    emblem.alt = '';
    emblem.src = EMBLEM;
    emblem.onerror = function () { emblem.style.display = 'none'; };
    var dot = mk('span', 'sv-dot');
    badge = mk('span', 'sv-txt');
    var barBtn = mk('button', 'sv-min'); barBtn.textContent = '展开';
    bar.appendChild(emblem); bar.appendChild(dot); bar.appendChild(badge); bar.appendChild(barBtn);

    /* ---- 展开态窗口 ---- */
    var card = mk('div', 'sv-card');
    var head = mk('div', 'sv-head');
    var title = mk('div', 'sv-title');
    title.appendChild(emblem.cloneNode(true));
    var nameSpan = mk('span'); nameSpan.textContent = 'DS-Whalegirl·虹';
    title.appendChild(nameSpan);
    var headR = mk('div', 'sv-head-r');
    var ver = mk('span', 'sv-ver'); ver.textContent = 'v0.6.16';
    var zoomBtn = mk('button', 'sv-icon'); zoomBtn.textContent = '⤢'; zoomBtn.title = '展开 / 收起'; zoomBtn.id = 'sv-zoom-btn';
    var minBtn = mk('button', 'sv-icon'); minBtn.textContent = '—'; minBtn.title = '最小化'; minBtn.id = 'sv-min-btn';
    headR.appendChild(ver); headR.appendChild(minBtn); headR.appendChild(zoomBtn);   // 减在左、全屏在右
    head.appendChild(title); head.appendChild(headR);

    var body = mk('div', 'sv-body');
    bodyEl = body;
    var tabs = mk('div', 'sv-tabs');
    tabStatus = mk('button', 'sv-tab is-active'); tabStatus.textContent = '状态';
    tabWhale = mk('button', 'sv-tab'); tabWhale.textContent = '小鲸';
    tabCfg = mk('button', 'sv-tab'); tabCfg.textContent = '配置';
    tabGuide = mk('button', 'sv-tab'); tabGuide.textContent = '引导';
    tabTip = mk('button', 'sv-tab'); tabTip.textContent = '须知';
    tabs.appendChild(tabStatus); tabs.appendChild(tabWhale);
    tabs.appendChild(tabCfg); tabs.appendChild(tabGuide); tabs.appendChild(tabTip);

    function hero(t, s, tag) {
      var h = mk('div', 'sv-hero');
      var a = mk('div', 'sv-hero-t'); a.textContent = t;
      var b = mk('div', 'sv-hero-s'); b.textContent = s;
      var g = mk('span', 'sv-tag'); g.textContent = tag;
      h.appendChild(a); h.appendChild(b); h.appendChild(g);
      return h;
    }

    /* ① 状态页：只有刷课状态 + 状态刷新（日志） */
    paneStatus = mk('div', 'sv-pane-status');
    var liveLine = mk('div', 'sv-live-line');
    var liveTag = mk('span', 'sv-live'); liveTag.textContent = 'LIVE';
    statTxt = mk('span', 'sv-live-txt'); statTxt.textContent = '1x · 等待视频';
    liveLine.appendChild(liveTag); liveLine.appendChild(statTxt);
    paneStatus.appendChild(liveLine);

    var track = mk('div', 'sv-track'); fill = mk('div', 'sv-fill'); track.appendChild(fill);
    paneStatus.appendChild(track);

    logBox = mk('div', 'sv-log');
    paneStatus.appendChild(logBox);
    paintLog();

    /* ② 小鲸页（鲸娘 + 答题区预留） */
    paneWhale = mk('div'); paneWhale.style.display = 'none';
    var wh = mk('div', 'sv-whale');
    var wa = mk('img', 'sv-whale-av'); wa.src = EMBLEM; wa.alt = ''; wa.onerror = function () { wa.style.display = 'none'; };
    var wb = mk('div', 'sv-whale-bub');
    var wt = mk('div', 'sv-whale-txt'); wt.textContent = '在陪着主人刷党课，鲸娘数着进度不挪窝～';
    var wl = mk('div', 'sv-whale-lv'); wl.innerHTML = 'Lv.1 初见 · <b>本页累计 0 讲</b>';
    wb.appendChild(wt); wb.appendChild(wl);
    wh.appendChild(wa); wh.appendChild(wb);
    paneWhale.appendChild(wh);

    var qa = mk('div', 'sv-qa');
    var qh = mk('div', 'sv-qa-h');
    var qn = mk('span', 'sv-num'); qn.textContent = '题';
    var qt = mk('span', 'sv-box-t'); qt.textContent = '答题区 · 预留';
    qh.appendChild(qn); qh.appendChild(qt);
    var qe = mk('div', 'sv-qa-empty');
    qe.textContent = '暂无题目。答题能力已预留，接入党课题库后在此显示题干、选项与参考答案。';
    qa.appendChild(qh); qa.appendChild(qe);
    paneWhale.appendChild(qa);

    /* ③ 配置页 */
    paneCfg = mk('div'); paneCfg.style.display = 'none';
    function cfgRow(k, v, hint) {
      var r = mk('div', 'sv-cfg-it');
      var l = mk('div', 'sv-cfg-k'); l.textContent = k;
      var val = mk('div', 'sv-cfg-v'); val.textContent = v;
      r.appendChild(l); r.appendChild(val);
      if (hint) { var h = mk('div', 'sv-cfg-h'); h.textContent = hint; r.appendChild(h); }
      return r;
    }
    paneCfg.appendChild(hero('配置', '全部为固定策略，无需手动调参', 'FIXED'));
    var setBox = mk('div', 'sv-setting');
    setBox.appendChild(cfgRow('倍速', '1x 固定', '不改倍速，避免被站方限速或判为异常'));
    setBox.appendChild(cfgRow('弹窗', '自动确认', '四类弹窗自动点；正常播放时不打扰'));
    setBox.appendChild(cfgRow('连播', '讲完自动续播', '本讲播完自动切下一讲'));
    setBox.appendChild(cfgRow('刷新保护', '60 次 / 10 分钟', '只在真的播不动时才刷新'));
    setBox.appendChild(cfgRow('快捷键', 'Alt+N', '手动切下一讲'));
    paneCfg.appendChild(setBox);

    /* ④ 引导页（含打赏卡） */
    paneGuide = mk('div', 'sv-pane-guide'); paneGuide.style.display = 'none';
    paneGuide.appendChild(box('01', '先看一遍再说', '脚本会自动点「继续播放」并在被暂停时拉起播放，你只需保持页面开着。'));
    paneGuide.appendChild(box('02', '进度怎么算', '完整看一遍、出现「播放完毕」提示框才算完成；任何跳播都会被拉回，所以脚本不做加速。'));
    paneGuide.appendChild(box('03', '一节课刷完了', '最后一讲结束后由站点自身跳转下一课；若没有自动跳转，脚本会回到课程页继续找下一门。'));

    var di = donateImage();
    if (di) {
      var dc = mk('div', 'sv-donate');
      var dt = mk('div', 'sv-donate-txt');
      var h3 = mk('h3'); h3.textContent = '赞助开发 · 随缘打赏';
      var p1 = mk('p');
      p1.innerHTML = '扫码请作者喝杯奶茶，上限 <b>1.88 元</b>，别白嫖哦～';
      var img = mk('img'); img.src = di; img.alt = '支付宝赞助码';
      var p2 = mk('p', 'sv-donate-cap'); p2.textContent = '打开支付宝「扫一扫」';
      dt.appendChild(h3); dt.appendChild(p1);
      dc.appendChild(dt); dc.appendChild(img); dc.appendChild(p2);
      paneGuide.appendChild(dc);
    }

    /* ⑤ 须知页（隐私条款 + 版本徽标） */
    paneTip = mk('div'); paneTip.style.display = 'none';
    paneTip.appendChild(hero('使用须知', '使用前，请仔细阅读以下声明。', '共 6 项'));
    paneTip.appendChild(box('01', '学习与研究用途', '本脚本仅供个人学习与研究使用。请遵守学校的教学管理规定与平台服务条款，勿用于代写、替考等违规用途。'));
    paneTip.appendChild(box('02', '账号安全', '脚本不会收集、上传或保存你的账号密码，登录态只存在于本机浏览器。'));
    paneTip.appendChild(box('03', '数据与隐私', '全部逻辑在本地运行，不上传学习记录、浏览历史或设备信息；本地仅存开关 <b>zhdj_sv_cfg_v1</b> 与刷新计数 <b>zhdj_sv_refresh_ts</b>。'));
    paneTip.appendChild(box('04', '费用', '脚本本身完全免费，不含任何付费接口调用；打赏纯属自愿。'));
    paneTip.appendChild(box('05', '风险自担', '使用脚本可能与平台规则产生冲突，由此产生的一切后果由使用者自行承担。'));
    paneTip.appendChild(box('06', '开发者权利', '本脚本为个人自用辅助工具，<b>非学校官方工具</b>；最终解释权归开发者所有。'));

    // 版本声明：本机出品规范样式（圆角卡片 + 两行居中）
    var foot = mk('div', 'sv-foot');
    var fs = mk('p', 'sv-sign'); fs.innerHTML = 'Developed by <b>X.H</b>';
    var fm = mk('p', 'sv-meta'); fm.textContent = 'DS-Whalegirl·虹 v0.6.16 · MIT License';
    foot.appendChild(fs); foot.appendChild(fm);
    paneTip.appendChild(foot);

    body.appendChild(paneStatus); body.appendChild(paneWhale); body.appendChild(paneCfg);
    body.appendChild(paneGuide); body.appendChild(paneTip);
    card.appendChild(head); card.appendChild(tabs); card.appendChild(body);   // 导航栏固定在头部，正文单独滚动

    panel.appendChild(bar); panel.appendChild(card);

    /* 交互 */
    barBtn.onclick = function (e) { e.stopPropagation(); uiOpen = true; saveUI(); render(); };
    minBtn.onclick = function (e) { e.stopPropagation(); uiOpen = false; saveUI(); render(); };
    tabStatus.onclick = function () { switchTab('status'); };
    tabWhale.onclick = function () { switchTab('whale'); };
    tabCfg.onclick = function () { switchTab('cfg'); };
    tabGuide.onclick = function () { switchTab('guide'); };
    tabTip.onclick = function () { switchTab('tip'); };
    zoomBtn.onclick = function (e) { e.stopPropagation(); uiOpen = !uiOpen; saveUI(); render(); };

    (document.body || document.documentElement).appendChild(panel);
    switchTab(uiTab);
    render();
  }

  /* ---------------- 启动 / 路由 ---------------- */

  var booted = false;

  function isVideoPage() {
    // 站点真实路径是 /training/videodetails/8627/737（小写 d），旧正则只认大写 D，导致真机从不启动
    return /\/training\/video-?details?\/|\/training-m\/video-?detail/i.test(location.pathname);
  }

  function bootPanel() {
    if (booted) return;
    booted = true;

    // 注入留痕：每次注入都写一行，方便一眼看出「这页到底注没注入、装的是哪版」
    try {
      log('v0.6.16 已注入 · ' + (location.pathname + location.search));
      if (window.console && console.info) console.info('[ZHDJ-SV] injected v0.6.16 @ ' + location.href);
    } catch (e) {}
    var oldNav = ['zhdj', 'sv', 'nav', 'v1'].join('_');   // 清掉旧版残留的死标记
    try { sessionStorage.removeItem(oldNav); } catch (e) {}

    document.addEventListener('pointerdown', function () { lastPointerDown = Date.now(); }, true);

    // 面板交互兜底：站点路由层有可能在 document 捕获阶段把点击吞掉，这里在最外层 window 捕获阶段先接一手
    var TAB_BY_LABEL = { '状态': 'status', '小鲸': 'whale', '配置': 'cfg', '引导': 'guide', '须知': 'tip' };
    window.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest || !panel || !panel.contains(t)) return;
      var hit = false;
      var tabEl = t.closest('.sv-tab');
      if (tabEl) {
        var k = TAB_BY_LABEL[(tabEl.textContent || '').trim()];
        if (k) { switchTab(k); hit = true; }
      }
      if (!hit && t.closest('#sv-min-btn')) { uiOpen = false; saveUI(); render(); hit = true; }
      if (!hit && t.closest('#sv-zoom-btn')) { uiOpen = !uiOpen; saveUI(); render(); hit = true; }
      if (!hit && t.closest('.sv-bar')) { uiOpen = true; saveUI(); render(); hit = true; }
      if (hit) { e.preventDefault(); e.stopPropagation(); }
    }, true);

    // 让面板始终是 body 的最后一个节点，避免被站点后插入的高层级覆盖
    function keepOnTop() {
      try {
        if (panel && panel.parentNode === document.body && document.body.lastElementChild !== panel) {
          document.body.appendChild(panel);
        }
      } catch (e) {}
    }
    setInterval(keepOnTop, 3000);

    // Alt+N：本讲内下一段（不会离开本讲）
    document.addEventListener('keydown', function (e) {
      if (e.altKey && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); nextChapter(); }
    }, true);

    document.addEventListener('visibilitychange', function () {
      if (cfg.on) setTimeout(function () { if (!handleDialogs()) tryPlay(); }, 300);
    });
    window.addEventListener('focus', function () {
      if (cfg.on) setTimeout(function () { if (!handleDialogs()) tryPlay(); }, 300);
    });

    var moTimer = 0;
    var mo = new MutationObserver(function () {
      if (moTimer) return;
      moTimer = setTimeout(function () { moTimer = 0; ensure(); }, 250);
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });

    // 主巡检：弹窗 → 视频 → 面板，整轮包在 guard 里，单点异常不影响后续
    safeInterval(function () {
      handleDialogs();
      ensure();
      var ex = document.getElementById('zhdj-sv');
      if (ex) { if (ex !== panel) panel = ex; } else buildUI();
      render();
    }, 1200, '巡检');

    // 面板自愈：页面重绘/路由切换把节点删掉时多轮补挂
    [0, 600, 1500, 3000, 6000, 10000].forEach(function (d) { setTimeout(buildUI, d); });
    // 常驻复活巡检：换讲、重绘、路由切换后面板失踪就地补挂（含整页刷新兜底）
    try { window.setInterval(function () { try { revive(); } catch (e) {} }, 1800); } catch (e) {}
    window.addEventListener('pageshow', function () { try { revive(); } catch (e) {} });

    // 弹窗监视独立高频通道（最高优先级）
    safeInterval(function () {
      if (!handleDialogs() && cfg.on && video && video.paused && !userPaused) tryPlay();
    }, 600, '弹窗');

    // 长跑看门狗：45 秒不推进 → 重新拉起播放（不换讲、不刷新，绝不打断连续性）
    var lastCt = -1, lastMoveAt = Date.now(), stallRounds = 0;
    function watchdog() {
      // 后台标签页会被浏览器节流，这一轮不做停滞判定，避免自己把自己重启
      if (document.hidden && video && !video.paused) return;
      // 停在讲末：不当成「停滞」，直接走讲末收口（全 100% → 换课；否则推进）
      if (video && isFinite(video.duration) && video.duration > 10 &&
          video.currentTime >= video.duration - 2) { endOfChapter(); return; }
      if (video && !video.paused && !video.seeking && video.currentTime > (lastCt + 0.05)) {
        lastCt = video.currentTime; lastMoveAt = Date.now(); stallRounds = 0; return;
      }
      if (Date.now() - lastMoveAt < 45 * 1000) return;
      stallRounds++; lastMoveAt = Date.now();
      if (stallRounds === 1) { log('停滞：尝试拉起播放'); tryPlay(); }
      else if (stallRounds === 2) { log('停滞：再拉一次播放'); tryPlay(); }
      else { stallRounds = 0; log('停滞：等你自己处理，我不换讲也不刷新'); }
    }
    safeInterval(watchdog, 15000, '看门狗');

    // 视频元素重绑：P2P 播放器切讲/重载会重建 <video>，旧句柄失效就换绑
    safeInterval(function () {
      var v = findVideo();
      if (v && v !== video) { attach(v); log('视频元素重绑'); }
      if (v) { noVideoTries = 0; return; }
      if (!isVideoPage() || !cfg.on) return;
      if (++noVideoTries >= 20) { noVideoTries = 0; hardReload('页面找不到视频元素'); }
    }, 3000, '重绑');

    // 单页内路由切换：重置页面级状态、重建面板、重新盯视频
    var lastHref = location.href;
    safeInterval(function () {
      if (location.href === lastHref) return;
      lastHref = location.href;
      allDone = false; userPaused = false; mediaErr = 0; playFail = 0;
      tickDone = false; menuClicked = false;
      log('页面切换');
      try { buildUI(); } catch (e) {}
      ensure(); tryPlay();
    }, 1000, '路由');

    window.addEventListener('load', function () { try { handleDialogs(); ensure(); } catch (e) {} try { buildUI(); } catch (e) { miniBar(); } });
    try { handleDialogs(); ensure(); } catch (e) {}
    try { buildUI(); } catch (e) { miniBar(); }
  }

  // 兜底：面板构建失败时至少留一个标识，说明脚本已注入
  function miniBar() {
    if (document.getElementById('zhdj-sv-mini')) return;
    var b = document.createElement('div');
    b.id = 'zhdj-sv-mini';
    b.textContent = 'DS-Whalegirl·虹 v0.6.16';
    b.style.cssText = 'position:fixed;right:14px;bottom:74px;z-index:2147483647;background:rgba(60,10,14,.88);color:#fff0ee;font:12px/1.4 system-ui,sans-serif;padding:8px 10px;border-radius:10px;border:1px solid rgba(255,120,110,.4)';
    (document.body || document.documentElement).appendChild(b);
  }

  // 非视频页：反复找「继续学习 / 开始学习 / 去学习」入口，接管下一门课
  // v0.6.16：本课刷完后平台常把页面停在「本组课程全 100%」的课程组页，当前页没有可学入口，
  // 只等 90 秒就会彻底停住。这里改成 30 秒找不到就强制重进一次 /training/learn（最多 2 次）。
  var advTimer = 0, advTries = 0;
  var advReenter = 0;
  try { advReenter = parseInt(sessionStorage.getItem('zhdj_sv_reenter') || '0', 10) || 0; } catch (e) { advReenter = 0; }

  function courseAdvanceLoop() {
    if (advTimer) return;
    advTries = 0;
    advTimer = safeInterval(function () {
      advTries++;
      if (onLearnPage()) {
        clearInterval(advTimer); advTimer = 0;
        var from = location.href;
        setTimeout(function () {
          if (location.href === from) {
            note = '继续学习入口无效，请手动进课';
            try { sessionStorage.setItem('zhdj_sv_stuck', String(Date.now())); } catch (e) {}
          }
        }, 9000);
        return;
      }
      if (advTries >= 15 && advReenter < 2 && !/video-?details?/i.test(location.pathname)) {
        advTries = 0; advReenter++;
        try { sessionStorage.setItem('zhdj_sv_reenter', String(advReenter)); } catch (e) {}
        log('本页没有可学课程，重进学习页 ' + advReenter + '/2');
        clearInterval(advTimer); advTimer = 0;
        try { location.href = 'https://zhdj.cumtb.edu.cn/training/learn?sv=' + Date.now(); } catch (e) {}
        return;
      }
      if (advTries > 45) {
        clearInterval(advTimer); advTimer = 0;
        note = '未找到下一门课程入口，请手动进入';
      }
      }, 2000, '换课');
  }

  function route() {
    if (isVideoPage()) {
      try { sessionStorage.removeItem('zhdj_sv_reenter'); } catch (e) {}
      try { revive(); } catch (e) {}
      bootPanel();
    } else if (!booted) {
      courseAdvanceLoop();
    }
  }

  if (isVideoPage()) { bootPanel(); }
  else { route(); safeTimeout(route, 1500, 'route-init'); }
  // 路由巡检：SPA 从列表页跳进视频页时也能把面板拉起来；异常不外溢
  safeInterval(route, 2000, 'route');
})();
