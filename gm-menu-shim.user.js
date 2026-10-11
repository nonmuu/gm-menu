// ==UserScript==
// @name         GM 菜单垫片（共享菜单宿主）
// @namespace    gm-menu-shim
// @version      1.1.1
// @description  为不支持 GM_registerMenuCommand 的手机油猴管理器提供页面内共享菜单：各脚本用 GM_registerMenuCommand 注册菜单项后，页面右下角出现"菜单"按钮，点开展开列表。无菜单项时按钮不显示。一级按脚本分组：单项脚本点一下直接执行，多项脚本点进去看二级。
// @match        *://*/*
// @grant        none
// @run-at       document-start
// ==/UserScript==
//
// 协议（DOM CustomEvent，纯字符串 detail，可跨脚本沙盒）：
//   注册   window.dispatchEvent(new CustomEvent('__gmmenu:register',   {detail:{id, script, label}}))
//   注销   window.dispatchEvent(new CustomEvent('__gmmenu:unregister', {detail:{id}}))
//   发现   window.dispatchEvent(new CustomEvent('__gmmenu:ping'))  → 本垫片回 '__gmmenu:ready'
//   调用   本垫片 dispatch('__gmmenu:invoke', {id})，注册脚本收到后执行自己的回调
//
// 消费脚本不要手写以上事件，直接嵌入 gm-menu-helper.js 的片段，
// 它会提供与 Tampermonkey 同签名的 GM_registerMenuCommand(label, fn)。
//
// 限制（v1）：只在顶层窗口渲染；iframe 内脚本的注册事件发在子 frame 的
// window 上，顶层收不到，暂不支持。单例防重复。

(function () {
  'use strict';

  var isTop = false;
  try { isTop = (window.self === window.top); } catch (e) { isTop = false; }
  if (!isTop) return;
  if (window.__gmmenuShimV1) return;
  window.__gmmenuShimV1 = true;

  var items = [];   // [{id, script, label}]
  var fab = null, panel = null, listEl = null;
  var currentScript = null; // null = 一级（脚本列表），否则为二级（该脚本的菜单项）

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // 按脚本名分组，保持首次出现顺序
  function groups() {
    var g = [], seen = {};
    items.forEach(function (it) {
      var key = it.script || '(未命名脚本)';
      if (!seen[key]) { seen[key] = { script: key, items: [] }; g.push(seen[key]); }
      seen[key].items.push(it);
    });
    return g;
  }

  function findGroup(gs, name) {
    for (var i = 0; i < gs.length; i++) if (gs[i].script === name) return gs[i];
    return null;
  }

  function ensureUI() {
    if (fab || document.getElementById('gmm-fab')) return;
    if (!document.body) {
      // document-start 极早注册时 body 可能还不存在，等 DOM 就绪再建 UI
      if (!ensureUI._wait) {
        ensureUI._wait = true;
        document.addEventListener('DOMContentLoaded', function () {
          ensureUI._wait = false;
          ensureUI(); refreshFab();
        });
      }
      return;
    }
    var css = document.createElement('style');
    css.textContent = [
      '#gmm-fab{position:fixed;right:14px;bottom:calc(14px + env(safe-area-inset-bottom));z-index:1000000;',
      ' min-width:56px;height:56px;border-radius:28px;border:none;background:#1a73e8;color:#fff;',
      ' font-size:13px;font-weight:700;box-shadow:0 4px 14px rgba(26,115,232,.4);cursor:pointer;padding:0 14px;',
      ' font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;}',
      '#gmm-panel{position:fixed;right:14px;bottom:calc(82px + env(safe-area-inset-bottom));z-index:1000000;',
      ' background:#fff;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.22);',
      ' min-width:200px;max-width:78vw;max-height:60vh;overflow-y:auto;display:none;',
      ' font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;}',
      '#gmm-panel.open{display:block;}',
      '#gmm-panel .gmm-title{padding:10px 14px 4px;font-size:11px;color:#999;}',
      '#gmm-panel button.mi{display:block;width:100%;box-sizing:border-box;text-align:left;border:none;background:#fff;',
      ' padding:11px 14px;font-size:14px;color:#222;cursor:pointer;border-top:1px solid #f0f0f0;}',
      '#gmm-panel button.mi:active{background:#e8f0fe;}',
      '#gmm-panel button.mi .sc{display:block;font-size:11px;color:#999;margin-top:2px;}',
      '#gmm-panel button.mi.back{color:#1a73e8;font-size:13px;}'
    ].join('\n');
    (document.head || document.documentElement).appendChild(css);

    fab = document.createElement('button');
    fab.id = 'gmm-fab';
    fab.textContent = '菜单';
    fab.style.display = 'none'; // 初始隐藏；有菜单项注册时 refreshFab() 再显示
    document.body.appendChild(fab);

    panel = document.createElement('div');
    panel.id = 'gmm-panel';
    listEl = document.createElement('div');
    panel.appendChild(listEl);
    document.body.appendChild(panel);

    // 事件委托：所有行共用一个监听器。
    // 注意 stopPropagation：render() 会重建 DOM，被点的按钮随即 detached，
    // 若事件冒泡到 document 的"点外面关闭"处理器，contains() 对 detached 节点
    // 返回 false，会被误判为点外面而立刻关面板——二级就是这么打不开的。
    listEl.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var t = ev.target;
      var b = (t && t.closest) ? t.closest('button.mi') : null;
      if (!b || !listEl.contains(b)) return;
      var act = b.getAttribute('data-act');
      if (act === 'back') { currentScript = null; render(); return; }
      if (act === 'open') { currentScript = b.getAttribute('data-script'); render(); return; }
      if (act === 'invoke') {
        panel.classList.remove('open');
        currentScript = null; // 下次打开回到一级
        try {
          window.dispatchEvent(new CustomEvent('__gmmenu:invoke',
            { detail: { id: b.getAttribute('data-id') } }));
        } catch (e) {}
      }
    });

    fab.addEventListener('click', function (ev) {
      ev.stopPropagation();
      currentScript = null; // 每次打开都回到一级
      render();
      panel.classList.toggle('open');
    });
    document.addEventListener('click', function (ev) {
      if (panel && panel.classList.contains('open') &&
          !panel.contains(ev.target) && ev.target !== fab) {
        panel.classList.remove('open');
      }
    });
  }

  function render() {
    if (!listEl) return;
    var gs = groups();
    // 二级中的脚本已无菜单项时退回一级
    if (currentScript && !findGroup(gs, currentScript)) currentScript = null;
    var html = '';
    if (!currentScript) {
      // 一级：脚本列表。单项脚本直接显示菜单项点即执行；多项脚本显示"脚本名 N 项 ›"进二级
      html += '<div class="gmm-title">脚本菜单</div>';
      gs.forEach(function (gr) {
        if (gr.items.length === 1) {
          html += '<button class="mi" data-act="invoke" data-id="' + esc(gr.items[0].id) + '">' +
            esc(gr.items[0].label) + '<span class="sc">' + esc(gr.script) + '</span></button>';
        } else {
          html += '<button class="mi" data-act="open" data-script="' + esc(gr.script) + '">' +
            esc(gr.script) + '<span class="sc">' + gr.items.length + ' 项 ›</span></button>';
        }
      });
    } else {
      // 二级：该脚本的菜单项
      var cur = findGroup(gs, currentScript);
      html += '<button class="mi back" data-act="back">‹ 返回</button>';
      html += '<div class="gmm-title">' + esc(currentScript) + '</div>';
      cur.items.forEach(function (it) {
        html += '<button class="mi" data-act="invoke" data-id="' + esc(it.id) + '">' +
          esc(it.label) + '</button>';
      });
    }
    listEl.innerHTML = html;
  }

  function refreshFab() {
    if (!fab) return;
    fab.style.display = items.length ? '' : 'none';
    if (!items.length && panel) panel.classList.remove('open');
  }

  function onRegister(ev) {
    var d = ev && ev.detail;
    if (!d || !d.id || !d.label) return;
    for (var i = 0; i < items.length; i++) {
      if (items[i].id === d.id) { items[i].label = String(d.label); items[i].script = String(d.script || ''); render(); return; }
    }
    items.push({ id: String(d.id), script: String(d.script || ''), label: String(d.label) });
    ensureUI();
    refreshFab();
    if (panel && panel.classList.contains('open')) render();
  }

  function onUnregister(ev) {
    var d = ev && ev.detail;
    if (!d || !d.id) return;
    items = items.filter(function (it) { return it.id !== String(d.id); });
    refreshFab();
    if (panel && panel.classList.contains('open')) render();
  }

  function sendReady() {
    try {
      window.dispatchEvent(new CustomEvent('__gmmenu:ready', { detail: { version: '1.1.1' } }));
    } catch (e) {}
  }

  window.addEventListener('__gmmenu:register', onRegister);
  window.addEventListener('__gmmenu:unregister', onUnregister);
  window.addEventListener('__gmmenu:ping', sendReady);

  function boot() {
    // DOM 就绪后再广播一次 ready，照顾 document-start 时机错过的消费脚本
    sendReady();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
