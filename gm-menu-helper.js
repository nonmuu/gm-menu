/* ============================================================
 * GM 菜单 helper —— @require 远程库（v3）
 * ------------------------------------------------------------
 * 配合 gm-menu-shim.user.js（共享菜单宿主）使用，给不支持
 * GM_registerMenuCommand 的手机油猴管理器（Userscripts app 等）
 * 提供页面内共享菜单。
 *
 * 消费脚本用法（两步）：
 *  1. 元数据块加一行：
 *       // @require https://你的域名/gm-menu-helper.js
 *  2. 脚本顶部（IIFE 内靠前）加：
 *       var __gm = (typeof window.__gmmenuInit === 'function')
 *         ? window.__gmmenuInit('你的脚本名') : null;
 *       var GM_registerMenuCommand   = __gm ? __gm.register   : function () {};
 *       var GM_unregisterMenuCommand = __gm ? __gm.unregister : function () {};
 *     之后直接 GM_registerMenuCommand('菜单文本', fn) 即可，
 *     返回的 id 可用于 GM_unregisterMenuCommand(id)。
 *
 * 设计要点：
 *  - 工厂函数：每次 init(scriptName) 返回该脚本专用的闭包
 *    {register, unregister}，状态（回调表/排队）各自独立；
 *    多脚本同页互不干扰（v1 把闭包挂共享 window 上导致串名的
 *    教训不再重演；库本身是无状态的，重复加载覆盖也无害）。
 *  - 原生支持（Tampermonkey 等）时直接返回原生实现。
 *  - 垫片未安装时 register/unregister 为无操作，不报错。
 *  - 跨脚本沙盒通信走 DOM CustomEvent（detail 只传字符串，
 *    回调按随机 id 间接调用），加载顺序不影响（排队 + ping/ready
 *    握手 + DOMContentLoaded 重广播）。
 *
 * 注意（Userscripts app 的 @require 行为）：远程文件只在保存脚本
 * 时下载一次存本地，之后不再检查更新；本库有更新时，需在 App 里
 * 把该 @require 删掉、保存、重新添加一次。
 * ============================================================ */
window.__gmmenuInit = function (scriptName) {
  'use strict';
  scriptName = String(scriptName || '');

  // 原生检测：真原生才用（本库不再污染 window.GM_registerMenuCommand，
  // 所以这里看到的要么是真原生，要么是别的东西——一律只认无标记的）
  var nativeReg = null, nativeUnreg = null;
  try {
    if (typeof window.GM_registerMenuCommand === 'function' &&
        !window.GM_registerMenuCommand.__gmmenuShim) {
      nativeReg = window.GM_registerMenuCommand;
    }
    if (window.GM && typeof window.GM.unregisterMenuCommand === 'function') {
      nativeUnreg = window.GM.unregisterMenuCommand;
    }
  } catch (e) { nativeReg = null; nativeUnreg = null; }

  var cbs = {};      // id -> 回调（函数不能跨脚本沙盒，用 id 间接调用）
  var queue = [];    // 垫片就绪前暂存的注册项
  var ready = false;

  function send(name, detail) {
    try { window.dispatchEvent(new CustomEvent(name, { detail: detail })); } catch (e) {}
  }

  window.addEventListener('__gmmenu:ready', function () {
    ready = true;
    for (var i = 0; i < queue.length; i++) send('__gmmenu:register', queue[i]);
    queue = [];
  });
  window.addEventListener('__gmmenu:invoke', function (ev) {
    var d = ev && ev.detail;
    var fn = d && cbs[d.id];
    if (fn) { try { fn(); } catch (e) {} }
  });

  function register(label, fn) {
    if (nativeReg) {
      try { nativeReg.call(window, String(label), fn); } catch (e) {}
      return 'native';
    }
    var id = 'gmm' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    cbs[id] = fn;
    var item = { id: id, script: scriptName, label: String(label) };
    if (ready) send('__gmmenu:register', item);
    else queue.push(item);
    return id;
  }

  function unregister(id) {
    if (id === 'native') return;
    if (nativeReg) {
      if (nativeUnreg) { try { nativeUnreg.call(window.GM, id); } catch (e) {} }
      return;
    }
    delete cbs[id];
    send('__gmmenu:unregister', { id: String(id) });
  }

  if (!nativeReg) send('__gmmenu:ping'); // 垫片若已就绪会回 ready，避免错过广播

  return { register: register, unregister: unregister };
};
