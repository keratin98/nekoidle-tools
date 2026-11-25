// ==UserScript==
// @name         估值工艺
// @namespace    nekoidle.suite
// @version      2.2.5
// @description  只读工具集合：加工上限、资产统计、历史记录估值。市场图标显示原始最低收购价；行情每 5 分钟自动刷新。修复首次空行情导致图标缺标签、无买单时反复刷新，以及游戏连接未就绪时的「连接状态：NULL」弹窗。更新交给 Tampermonkey 原生 @updateURL 自动检查。不会自动点击、不会进行游戏操作。
// @author       NEKOIDLE 数据包
// @match        https://nekoidle.com/*
// @match        https://www.nekoidle.com/*
// @run-at       document-end
// @grant        none
// @noframes
// @updateURL    https://raw.githubusercontent.com/keratin98/nekoidle-tools/main/%E4%BC%B0%E5%80%BC%E5%B7%A5%E8%89%BA_v2.2.5.user.js
// @downloadURL  https://raw.githubusercontent.com/keratin98/nekoidle-tools/main/%E4%BC%B0%E5%80%BC%E5%B7%A5%E8%89%BA_v2.2.5.user.js
// ==/UserScript==