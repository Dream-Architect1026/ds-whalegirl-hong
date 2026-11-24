// ==UserScript==
// @name         DS-Whalegirl·虹（ZHDJ 视频增强）
// @namespace    zhdj.cumtb.shuavideo
// @version      0.6.6
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
    if (now - lastHardReload < 6 * 60 * 1000) return false;
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
          if (!nextChapter()) { allDone = true; note = '最后一讲已完成'; render(); }
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
      mediaErr++;
      log('媒体错误 ' + mediaErr);
      if (mediaErr >= 3) { mediaErr = 0; hardReload('媒体解码错误'); }
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
        if (!nextChapter()) { allDone = true; note = '最后一讲已完成'; render(); }
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
    var rows = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var t = (el.innerText || '').trim();
      if (!t || t.length > 160) continue;
      var m = t.match(new RegExp(TIME_RE.source, 'g'));
      if (!m || m.length !== 1) continue;
      if (el.querySelector('video')) continue;
      var r = el.getBoundingClientRect();
      if (r.height > 140 || r.height < 20) continue;
      rows.push(el);
    }
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

  function nextChapter() {
    var rows = chapterRows();
    if (!rows.length) return false;
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
    var clickable = target.querySelector('a,button') || target;
    realClick(clickable);          // 只在本讲内点下一段，绝不导航、绝不换课
    log('本讲内切下一段');
    return true;
  }

  /* ---------------- 面板自愈（v0.6.6 · 只补挂，不导航、不刷新） ----------------
     v0.6.6 起彻底取消跨讲/跨课自动跳转：整页导航、换讲守卫、强制刷新全部删除，
     换讲与换课由用户手动点。这里只做一件事——面板节点被站点重绘拔掉时，就地补挂。 */
  var reviveFail = 0;

  function revive() {
    if (!isVideoPage()) return;
    if (document.getElementById('zhdj-sv') || document.getElementById('zhdj-sv-mini')) { reviveFail = 0; return; }
    reviveFail++;
    try { buildUI(); } catch (e) {}
  }

  /* ---------------- 两级换课（v0.6.6）：讲内自动，本课刷完自动回列表换下一门 ----------------
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
  var uiTab = (uiSaved && ['whale', 'cfg', 'guide', 'tip'].indexOf(uiSaved.tab) >= 0) ? uiSaved.tab : 'status';
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
  var DONATE_SIG = 'e2b3aed1';
  var DONATE_SALT = 'HXWHALE-DONATE-V1';
  var DONATE_B64 = [
    "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",
    "ZZU86ndqoA=="
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
      '--zr-photo:image-set(url("https://dream-architect1026.github.io/ds-whalegirl-hong/assets/bg-1600.jpg") 1x);',
      '--zr-t:background .28s ease,border-color .28s ease,box-shadow .28s ease,transform .28s cubic-bezier(.34,1.2,.64,1),backdrop-filter .28s ease,-webkit-backdrop-filter .28s ease,color .2s ease;',
      'color-scheme:dark;',
      '--zr-font:"HarmonyOS Sans SC","MiSans","PingFang SC","Microsoft YaHei",system-ui,sans-serif;',
      'position:fixed;right:14px;bottom:74px;z-index:2147483000;box-sizing:border-box;',
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
      'background-image:var(--zr-spec),var(--zr-tint-hi),linear-gradient(180deg,rgba(16,3,6,.80),rgba(16,3,6,.90)),var(--zr-photo);',
      'background-color:rgba(22,4,8,.72);background-repeat:no-repeat;',
      'background-size:auto,auto,auto,cover;background-position:0 0,0 0,0 0,50% 22%;',
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
      /* 运行日志（复刻 log / timeline） */
      '#zhdj-sv .sv-log{border:1px solid var(--zr-edge);border-radius:12px;background:var(--zr-tint);',
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
      '#zhdj-sv .sv-pane-guide .sv-box{padding:7px 10px;margin:0 0 4px}',
      '#zhdj-sv .sv-pane-guide .sv-box-h{margin:0 0 3px}',
      '#zhdj-sv .sv-pane-guide .sv-copy{line-height:1.4;font-size:11px}',
      '#zhdj-sv .sv-pane-guide .sv-donate{display:flex;gap:10px;align-items:center;padding:6px 10px;margin:0 0 2px}',
      '#zhdj-sv .sv-pane-guide .sv-donate-txt{flex:1 1 auto;min-width:0}',
      '#zhdj-sv .sv-pane-guide .sv-donate h3{margin:0 0 3px;font-size:12px}',
      '#zhdj-sv .sv-pane-guide .sv-donate p{margin:0 0 3px;line-height:1.3}',
      '#zhdj-sv .sv-pane-guide .sv-donate img{flex:0 0 80px;width:80px;height:80px;object-fit:cover;border-radius:8px}',
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
    var ver = mk('span', 'sv-ver'); ver.textContent = 'v0.6.6';
    var zoomBtn = mk('button', 'sv-icon'); zoomBtn.textContent = '⤢'; zoomBtn.title = '展开 / 收起';
    var minBtn = mk('button', 'sv-icon'); minBtn.textContent = '—'; minBtn.title = '最小化';
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
    paneGuide.appendChild(hero('引导', '装上就能用，无需任何配置', '自动播放'));
    paneGuide.appendChild(box('01', '先看一遍再说', '脚本会自动点「继续播放」并在被暂停时拉起播放，你只需保持页面开着。'));
    paneGuide.appendChild(box('02', '进度怎么算', '站点口径：完整看一遍、出现「播放完毕」提示框才算完成。任何跳播都会被拉回，所以脚本不做加速。'));
    paneGuide.appendChild(box('03', '一节课刷完了', '最后一讲结束后由站点自身跳转下一课；若没有自动跳转，脚本会回到课程页继续找下一门。'));

    var di = donateImage();
    if (di) {
      var dc = mk('div', 'sv-donate');
      var dt = mk('div', 'sv-donate-txt');
      var h3 = mk('h3'); h3.textContent = '赞助开发 · 随缘打赏';
      var p1 = mk('p');
      p1.innerHTML = '如果脚本帮到了你，欢迎扫码请作者喝杯奶茶～<br>· 单人打赏<b>上限 1.88 元</b>。<br>· <b>矿大北京的学弟学妹们不要白嫖哦</b>。';
      var img = mk('img'); img.src = di; img.alt = '支付宝赞助码';
      var p2 = mk('p', 'sv-donate-cap'); p2.textContent = '打开支付宝「扫一扫」';
      dt.appendChild(h3); dt.appendChild(p1); dt.appendChild(p2);
      dc.appendChild(dt); dc.appendChild(img);
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
    var fm = mk('p', 'sv-meta'); fm.textContent = 'DS-Whalegirl·虹 v0.6.6 · MIT License';
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
      log('v0.6.6 已注入 · ' + (location.pathname + location.search));
      if (window.console && console.info) console.info('[ZHDJ-SV] injected v0.6.6 @ ' + location.href);
    } catch (e) {}
    var oldNav = ['zhdj', 'sv', 'nav', 'v1'].join('_');   // 清掉旧版残留的死标记
    try { sessionStorage.removeItem(oldNav); } catch (e) {}

    document.addEventListener('pointerdown', function () { lastPointerDown = Date.now(); }, true);

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
    b.textContent = 'DS-Whalegirl·虹 v0.6.6';
    b.style.cssText = 'position:fixed;right:14px;bottom:74px;z-index:2147483000;background:rgba(60,10,14,.88);color:#fff0ee;font:12px/1.4 system-ui,sans-serif;padding:8px 10px;border-radius:10px;border:1px solid rgba(255,120,110,.4)';
    (document.body || document.documentElement).appendChild(b);
  }

  // 非视频页：反复找「继续学习 / 开始学习 / 去学习」入口，接管下一门课
  var advTimer = 0, advTries = 0;
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
      if (advTries > 45) {
        clearInterval(advTimer); advTimer = 0;
        note = '未找到下一门课程入口，请手动进入';
      }
      }, 2000, '换课');
  }

  function route() {
    if (isVideoPage()) {
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
