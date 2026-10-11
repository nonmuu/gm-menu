# gm-menu

`GM_registerMenuCommand` shim for mobile userscript managers that don't implement it
(e.g. the iOS [Userscripts](https://github.com/quoid/userscripts) app, where it's still
an open feature request). A true polyfill is impossible — a userscript can't reach the
manager's native UI — so this provides an **in-page shared menu** instead.

- `gm-menu-shim.user.js` — the shared menu host. Install once (`@match *://*/*`).
  Renders a floating "menu" button (bottom-right, hidden when no items are registered);
  level 1 groups by script (single-item scripts invoke directly, multi-item scripts
  drill into level 2 with a back button).
- `gm-menu-helper.js` — `@require` library for consumer scripts. Exposes
  `window.__gmmenuInit(scriptName)`, which returns per-script `{register, unregister}`
  closures. Uses the native `GM_registerMenuCommand` when the manager supports it;
  silently no-ops when the shim isn't installed.

Cross-sandbox communication uses DOM `CustomEvent`s
(`__gmmenu:register` / `unregister` / `ping` / `ready` / `invoke`) with string-only
details; callbacks are invoked by random id, since functions can't cross sandboxes.

## Usage (consumer script)

```js
// ==UserScript==
// @name         My script
// ...
// @require      https://raw.githubusercontent.com/nonmuu/gm-menu/main/gm-menu-helper.js
// ==/UserScript==

var __gm = (typeof window.__gmmenuInit === 'function')
  ? window.__gmmenuInit('My script name') : null;
var GM_registerMenuCommand   = __gm ? __gm.register   : function () {};
var GM_unregisterMenuCommand = __gm ? __gm.unregister : function () {};

GM_registerMenuCommand('Do something', function () {
  // ...
});
```

Note: the Userscripts app downloads `@require` resources once at save time and never
re-checks them — after this library is updated, remove and re-add the `@require` line
in the app to pick up the new copy.
