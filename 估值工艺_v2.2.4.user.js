// ==UserScript==
// @name         估值工艺
// @namespace    nekoidle.suite
// @version      2.2.4
// @description  只读工具集合：加工上限、资产统计、历史记录估值。市场图标显示原始最低收购价；行情每 5 分钟自动刷新。修复首次空行情导致图标缺标签，并避免无买单时反复刷新。更新交给 Tampermonkey 原生 @updateURL 自动检查。不会自动点击、不会进行游戏操作。
// @author       NEKOIDLE 数据包
// @match        https://nekoidle.com/*
// @match        https://www.nekoidle.com/*
// @run-at       document-end
// @grant        none
// @noframes
// @updateURL    https://raw.githubusercontent.com/keratin98/nekoidle-tools/main/%E4%BC%B0%E5%80%BC%E5%B7%A5%E8%89%BA_v2.2.4.user.js
// @downloadURL  https://raw.githubusercontent.com/keratin98/nekoidle-tools/main/%E4%BC%B0%E5%80%BC%E5%B7%A5%E8%89%BA_v2.2.4.user.js
// ==/UserScript==
/*
 * 估值工艺 v2.2.4
 * ────────────────────────────────────────────────
 * 只读脚本，内部保留五个相互独立的模块：
 *   1. 加工上限（nkc-）：生产 / 烹饪 / 炼金上限与预计耗时
 *   2. 资产统计（nka-）：背包、货币、市场在售与求购冻结
 *   3. 历史记录估值（nkr-）：日志卡片估值与物品图标总价
 *   4. 通用功能（nkgu-）：首次进入自动刷新行情、检查更新栏目
 *   5. 市场收购价（nkm-）：市场商品图标左下角显示原始最低收购价
 *
 * 资产统计与历史记录估值共用 window.__NK_MARKET__，行情只拉一次。
 * 首次进入游戏（按自然日）自动刷新一次行情；此后每 5 分钟自动刷新一次。
 * 市场价格 = 收购价 × 98%（扣 2% 税）；无收购或未加载时回退出售价。
 * 市场图标显示的是原始最低收购价，不扣税，仅用于市场界面展示。
 * v2.2.4 修正：首次 bulk 行情为空时不标记当日已完成，自动重试；市场页渲染后补装饰；用缓存条数判断刷新成功，无买单时不反复刷新。新文件名绕过 Raw 缓存。
 * 更新检查使用 Tampermonkey 原生 @updateURL/@downloadURL，两者均指向完整脚本；脚本内不再自行抓版本、比版本。
 * 详细变更记录见同目录「更新日志.md」。
 */
/* ==================== 模块 1：加工上限 ==================== */(function () {
    'use strict';

    const VERSION = '2.2.4';
    const TAG = '[加工上限]';
    const DEBOUNCE = 180;
    const RESCAN_MS = 4000;

    // 重复加载保护：两条 @match 同时命中也只跑一份
    if (window.__NK_CRAFTLIMIT__) {
        console.warn(TAG, '已经加载过，跳过这一次重复注入');
        return;
    }

    const ZW = /[\u200b\u200c\u200d\ufeff]/g;
    const cleanName = s => String(s == null ? '' : s).replace(ZW, '').trim();

    const fmt = n => (n === Infinity) ? '∞'
        : (n == null || !isFinite(n)) ? '—'
        : Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');

    function fmtShort(n) {
        if (n === Infinity) return '∞';
        if (!isFinite(n)) return '—';
        if (n >= 100000000) return (n / 100000000).toFixed(1) + '亿';
        if (n >= 10000) return (n / 10000).toFixed(1) + '万';
        return fmt(n);
    }

    function durLong(sec) {
        if (!isFinite(sec) || sec <= 0) return '—';
        const m = Math.floor(sec / 60), s = Math.round(sec % 60);
        if (m < 60) return m ? m + ' 分' + (s ? ' ' + s + ' 秒' : '') : s + ' 秒';
        const h = Math.floor(m / 60), mm = m % 60;
        if (h < 24) return h + ' 小时' + (mm ? ' ' + mm + ' 分' : '');
        return Math.floor(h / 24) + ' 天 ' + (h % 24) + ' 小时';
    }

    function durSec(sec) {
        if (!isFinite(sec) || sec <= 0) return '—';
        if (sec < 10) return sec.toFixed(2) + ' 秒';
        if (sec < 60) return sec.toFixed(1) + ' 秒';
        return durLong(sec);
    }

    /* 队列角标用的紧凑耗时：7分21秒 / 3时05分 / 2天3时 */
    function durShort(sec) {
        if (!isFinite(sec) || sec <= 0) return '—';
        sec = Math.round(sec);
        const d = Math.floor(sec / 86400);
        const h = Math.floor((sec % 86400) / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = sec % 60;
        const pad = n => (n < 10 ? '0' + n : String(n));
        if (d > 0) return d + '天' + (h ? h + '时' : '');
        if (h > 0) return h + '时' + (m ? pad(m) + '分' : '');
        if (m > 0) return m + '分' + (s ? pad(s) + '秒' : '');
        return s + '秒';
    }

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[c]);
    }

    function game() {
        try {
            if (typeof UI === 'undefined' || !UI || !UI.game) return null;
            if (typeof Data === 'undefined' || !Data || !Data.actions) return null;
            return UI.game;
        } catch (e) { return null; }
    }

    function itemName(id) {
        try {
            const def = (UI.game && UI.game.getItem(id)) || (Data.items && Data.items[id]);
            return def ? cleanName(def.name) : ('#' + id);
        } catch (e) { return '#' + id; }
    }

    /* ---------------- 材料 / 次数 ---------------- */

    function limitFromCosts(costs, getHave) {
        let max = Infinity;
        const rows = [];
        (costs || []).forEach(c => {
            const have = getHave(c.itemId, c.enh || 0);
            const qty = +c.qty;
            const n = qty > 0 ? Math.floor(have / qty) : Infinity;
            rows.push({ itemId: c.itemId, qty: qty, baseQty: c.baseQty, enh: c.enh || 0, have: have, max: n });
            if (n < max) max = n;
        });
        return {
            max: isFinite(max) ? max : Infinity,
            rows: rows,
            bottleneck: rows.reduce((best, r) => (!best || r.max < best.max ? r : best), null)
        };
    }

    function inventoryStock(g) {
        const stock = new Map();
        (g.inventory || []).forEach(it => {
            if (!it || !(it.quantity > 0)) return;
            const key = it.item + '|' + (it.enhancement || 0);
            stock.set(key, (stock.get(key) || 0) + it.quantity);
        });
        return stock;
    }

    function stockHave(stock, itemId, enh) {
        return stock.get(itemId + '|' + (enh || 0)) || 0;
    }

    function deductCosts(stock, costs, count) {
        if (!(count > 0) || !isFinite(count)) return;
        (costs || []).forEach(c => {
            const key = c.itemId + '|' + (c.enh || 0);
            stock.set(key, Math.max(0, (stock.get(key) || 0) - c.qty * count));
        });
    }

    function sigOf(r) {
        if (!r) return '';
        return [
            r.kind, r.label, r.pendingSecondary ? 1 : 0, r.max,
            r.multiplier || 1, r.maxMultiplier || 1,
            (r.limits || []).map(x => x.m + ':' + x.max).join(','),
            isFinite(r.seconds) ? (+r.seconds).toFixed(3) : '-',
            r.succ, r.blocked ? 1 : 0, r.noQueue ? 1 : 0,
            (r.rows || []).map(x => x.itemId + ':' + x.qty + ':' + x.have + ':' + x.max).join(',')
        ].join('|');
    }

    /* ---------------- 三种玩法的计算 ---------------- */

    /* 批量工序信息：最高倍率 / 研究等级 / 熟练度（旧版本没有该机制时安全回退为 1 倍） */
    function batchInfo(g, action) {
        let maxMul = 1, researchLv = 0, prof = 0;
        try {
            if (action && +action.action === 6 && typeof UI.getCraftBatchMaxMultiplier === 'function') {
                let st = {};
                try {
                    const info = g.getLevelInfo(action.action);
                    if (typeof UI.getActionLevelState === 'function') {
                        st = UI.getActionLevelState(action, info) || {};
                    }
                } catch (e) { st = {}; }
                maxMul = Math.max(1, Math.min(5, Math.floor(+UI.getCraftBatchMaxMultiplier(action, st)) || 1));
            }
        } catch (e) { maxMul = 1; }
        try {
            if (typeof UI.getCraftBatchResearchLevel === 'function') {
                researchLv = Math.max(0, +UI.getCraftBatchResearchLevel() || 0);
            }
        } catch (e) { researchLv = 0; }
        try {
            prof = +(g.proficiency && g.proficiency.action && g.proficiency.action[action.id]) || 0;
        } catch (e) { prof = 0; }
        return { maxMul: maxMul, researchLv: researchLv, prof: prof };
    }

    function productionSpec(g, action, multiplier) {
        const mul = Math.max(1, Math.min(5, Math.floor(+multiplier) || 1));
        const baseCosts = (action.requirements || []).map(r => ({
            itemId: r.itemId, qty: +r.quantity, enh: 0
        }));
        const costs = baseCosts.map(c => ({
            itemId: c.itemId, qty: c.qty * mul, baseQty: c.qty, enh: c.enh
        }));
        const lim = limitFromCosts(costs, (id, enh) => g.getItemQuantity(id, enh));

        // 每个已解锁倍率下的材料上限（用于卡片 / 详情提示）
        const batch = batchInfo(g, action);
        const limits = [];
        for (let m = 1; m <= batch.maxMul; m++) {
            const scaled = baseCosts.map(c => ({ itemId: c.itemId, qty: c.qty * m, enh: c.enh }));
            const one = limitFromCosts(scaled, (id, enh) => g.getItemQuantity(id, enh));
            limits.push({ m: m, max: one.max, bottleneck: one.bottleneck });
        }

        let seconds = 0, succ = 1, blocked = false;
        try {
            const info = g.getLevelInfo(action.action);
            const st = (typeof UI.getActionLevelState === 'function')
                ? (UI.getActionLevelState(action, info) || {}) : {};
            blocked = !!(st.blocked || st.status === 'red');
            if (!blocked) {
                succ = st.successRate == null ? 1 : Math.max(0.01, Math.min(1, +st.successRate / 100));
                let eff = 1;
                try {
                    const fac = g.getResearchFacilityIdForAction
                        ? g.getResearchFacilityIdForAction(action) : undefined;
                    eff = g.getEfficiency(action.type, fac) || 1;
                } catch (e) {
                    try { eff = g.getEfficiency(action.type) || 1; } catch (e2) { eff = 1; }
                }
                seconds = (action.time / 1000) / eff * (st.timeRate || 1);
            }
        } catch (e) {
            seconds = action.time / 1000;
        }

        return {
            kind: 'production', label: cleanName(action.name), action: action,
            costs: costs, baseCosts: baseCosts,
            multiplier: mul, maxMultiplier: batch.maxMul, limits: limits,
            max: lim.max, rows: lim.rows, bottleneck: lim.bottleneck,
            seconds: seconds, succ: succ, blocked: blocked,
            totalSeconds: (seconds > 0 && lim.max !== Infinity) ? (lim.max * seconds / succ) : 0
        };
    }

    function cookingSpec(g, recipe) {
        const costs = (recipe.ingredients || []).map(i => ({
            itemId: i.itemId, qty: i.quantity, enh: 0
        }));
        const lim = limitFromCosts(costs, (id, enh) => g.getItemQuantity(id, enh));

        let seconds = 0, succ = 1, blocked = false;
        try {
            const st = (typeof UI.getCookingLevelState === 'function')
                ? (UI.getCookingLevelState(recipe) || {}) : {};
            blocked = !!st.blocked;
            if (!blocked) {
                succ = st.successRate == null ? 1 : Math.max(0.01, Math.min(1, +st.successRate / 100));
                let eff = 1;
                try { eff = g.getEfficiency(9, 12) || 1; } catch (e) { eff = 1; }
                seconds = (recipe.time / 1000) / eff * (st.timeRate || 1);
            }
        } catch (e) {
            seconds = recipe.time / 1000;
        }

        return {
            kind: 'cooking', label: cleanName(recipe.name), recipe: recipe,
            costs: costs, max: lim.max, rows: lim.rows, bottleneck: lim.bottleneck,
            seconds: seconds, succ: succ, blocked: blocked,
            totalSeconds: (seconds > 0 && lim.max !== Infinity) ? (lim.max * seconds / succ) : 0
        };
    }

    /*
     * 炼金操作号：
     *   原子  1 点金 / 2 分解 / 6 研究
     *   神秘  3 提纯 / 4 还原 / 5 转换
     *   禁忌  6 蚀刻 / 8 净化（不占队列）
     *   量子  9 升级
     */
    function alchemySpec(g, key, info) {
        key = +key;
        if (!info || !info.item) return null;

        const itemId = +info.item;
        const itemDef = g.getItem(itemId);
        if (!itemDef) return null;

        const enh = +info.enhancement || 0;
        let costs = [];
        let label = '';
        let baseSeconds = 20;
        let noQueue = false;
        let succ = 1;

        if (key === 0) {
            if (+info.type === 1) {
                costs = [{ itemId: itemId, qty: itemDef.auri || 1, enh: enh }];
                label = '点金'; baseSeconds = 16;
            } else if (+info.type === 2) {
                costs = [{ itemId: itemId, qty: 1, enh: enh }];
                label = '分解'; baseSeconds = 16;
            } else if (+info.type === 6) {
                costs = [{ itemId: itemId, qty: 1, enh: enh }];
                label = '研究'; baseSeconds = 16;
            } else {
                return null;
            }
        } else if (key === 1) {
            const op = { 3: 'up', 4: 'down', 5: 'change' }[+info.type];
            if (!op) return null;
            const def = Data.alchemyOccultism && Data.alchemyOccultism[itemId]
                && Data.alchemyOccultism[itemId][op];
            if (!def) return null;
            costs = [{ itemId: itemId, qty: def.quantity || 1, enh: enh }];
            label = { up: '提纯', down: '还原', change: '转换' }[op];
            baseSeconds = 20;
        } else if (key === 2) {
            if (+info.type === 6) {
                costs = [{ itemId: 1200, qty: 10, enh: 0 }];
                label = '蚀刻'; noQueue = true; baseSeconds = 0;
            } else if (+info.type === 8) {
                costs = [{ itemId: 1200, qty: 3, enh: 0 }];
                label = '净化'; noQueue = true; baseSeconds = 0;
            } else {
                return null;
            }
        } else if (key === 3) {
            label = '升级'; baseSeconds = 20;
            if (!info.secondaryItem) {
                return {
                    kind: 'alchemy', label: label, pendingSecondary: true,
                    costs: [], rows: [], max: 0, bottleneck: null,
                    seconds: 0, succ: 1, blocked: false, noQueue: false, totalSeconds: 0
                };
            }
            const list = Data.alchemyQuantum && Data.alchemyQuantum[itemId];
            const recipe = list && list.find(r => r.secondary == info.secondaryItem);
            if (!recipe) return null;
            costs = [
                { itemId: itemId, qty: 1, enh: enh },
                { itemId: +recipe.secondary, qty: recipe.quantity, enh: 0 }
            ];
            succ = Math.max(0.01, Math.min(1, (+recipe.rate || 100) / 100));
        } else {
            return null;
        }

        const lim = limitFromCosts(costs, (id, e) => g.getItemQuantity(id, e));
        let eff = 1;
        try { eff = g.getEfficiency(10) || 1; } catch (e) { eff = 1; }
        const seconds = baseSeconds > 0 ? baseSeconds / eff : 0;

        return {
            kind: 'alchemy', label: label, costs: costs,
            max: lim.max, rows: lim.rows, bottleneck: lim.bottleneck,
            seconds: seconds, succ: succ, blocked: false, noQueue: noQueue,
            totalSeconds: (seconds > 0 && lim.max !== Infinity) ? lim.max * seconds : 0
        };
    }

    /* ---------------- 查询队列项目对应的配方 ---------------- */

    function queueSpec(g, q) {
        if (!q) return null;

        if (q.type === 'action') {
            const action = g.getAction(q.id);
            return (action && +action.type === 7)
                ? productionSpec(g, action, q.multiplier) : null;
        }

        if (q.type === 'cooking') {
            const recipe = Data.cookingRecipes && Data.cookingRecipes[q.id];
            return recipe ? cookingSpec(g, recipe) : null;
        }

        if (q.type === 'alchemy') {
            const op = +q.id;
            const item = q.item || {};
            let key, type;
            if (op === 1 || op === 2 || op === 6) { key = 0; type = op; }
            else if (op === 3 || op === 4 || op === 5) { key = 1; type = op; }
            else if (op === 9) { key = 3; type = 9; }
            else return null;
            return alchemySpec(g, key, {
                item: item.primaryItem,
                enhancement: item.enhancement || 0,
                type: type,
                secondaryItem: item.secondaryItem
            });
        }

        return null;
    }

    /* 队列顺序模拟：从队首开始，按剩余次数预留前面项目的材料 */
    function queueResults(g) {
        const map = new Map();
        const queue = Array.isArray(g.queue) ? g.queue : [];
        const stock = inventoryStock(g);
        for (let i = 0; i < queue.length; i++) {
            const spec = queueSpec(g, queue[i]);
            if (!spec) continue;

            const seq = limitFromCosts(spec.costs, (id, enh) => stockHave(stock, id, enh));
            if (i > 0) {
                const indep = limitFromCosts(spec.costs, (id, enh) => g.getItemQuantity(id, enh));
                map.set(i, { spec: spec, indep: indep, seq: seq });
            }

            const q = queue[i];
            let remaining = q.remaining;
            if (remaining == null) remaining = q.count;
            const planned = (remaining == null || remaining === -1)
                ? seq.max : Math.min(remaining, seq.max);
            deductCosts(stock, spec.costs, planned);
        }
        return map;
    }

    /* ---------------- 内嵌样式 ---------------- */

    const CSS = `
.nkc-chip{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;
  height:20px;padding:0 5px;border-radius:4px;font-size:10.5px;font-weight:700;
  white-space:nowrap;cursor:help;font-variant-numeric:tabular-nums;letter-spacing:.2px;
  background:rgba(61,219,192,.16);color:#7ff0d4;border:1px solid rgba(61,219,192,.42)}
.nkc-chip.warn{background:rgba(251,191,36,.14);color:#fcd34d;border-color:rgba(251,191,36,.42)}
.nkc-chip.bad{background:rgba(248,113,113,.14);color:#fca5a5;border-color:rgba(248,113,113,.42)}
.select-action-card .nkc-chip{position:absolute;right:8px;bottom:8px;z-index:2}
.action-queue-top .nkc-chip,.action-title .nkc-chip{height:18px;font-size:10px;line-height:16px}
.nkc-cook-chip{margin-left:4px;font-size:10.5px;font-weight:700;color:#7ff0d4;
  font-variant-numeric:tabular-nums}
.nkc-cook-chip.bad{color:#fca5a5}
.nkc-cook-chip.warn{color:#fcd34d}
.nkc-inline-limit{font-size:10.5px;font-weight:700;color:#7ff0d4;font-variant-numeric:tabular-nums}
.nkc-block{margin:8px 0 2px;padding:8px 10px;border-radius:8px;
  background:rgba(61,219,192,.05);border:1px solid rgba(61,219,192,.22);
  font-size:12.5px;line-height:1.7;color:#cfe6e0}
.nkc-block .nkc-h{font-size:11px;color:#7fd6c4;letter-spacing:.5px;margin-bottom:3px}
.nkc-block b{color:#5eead4;font-variant-numeric:tabular-nums}
.nkc-block .warn{color:#fcd34d}
.nkc-block .bad{color:#fca5a5}
.nkc-block .nkc-dim{font-size:11px;color:#82a79c;margin-top:3px;letter-spacing:.2px}
.nkc-mats{margin-top:5px;padding-top:4px;border-top:1px dashed rgba(61,219,192,.18)}
.nkc-mat{display:flex;justify-content:space-between;gap:10px;font-size:11.5px;
  color:#b9d8cf;font-variant-numeric:tabular-nums}
.nkc-mat .nkc-mat-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nkc-mat .nkc-mat-val{color:#8fb8ad;white-space:nowrap}
.nkc-mat b{color:#5eead4}
.nkc-alchemy{margin:0 8px 8px;padding:6px 9px;border-radius:7px;
  background:rgba(61,219,192,.05);border:1px solid rgba(61,219,192,.22);
  font-size:11.5px;line-height:1.65;color:#cfe6e0}
.nkc-alchemy .nkc-h{font-size:10.5px;color:#7fd6c4;letter-spacing:.5px;margin-bottom:2px}
.nkc-alchemy b{color:#5eead4;font-variant-numeric:tabular-nums}
.nkc-alchemy .nkc-dim{font-size:10.5px;color:#82a79c;margin-top:2px}
.cooking-detail .nkc-block{margin-top:6px}
`;

    function injectCSS() {
        if (document.getElementById('nkc-style')) return;
        const st = document.createElement('style');
        st.id = 'nkc-style';
        st.textContent = CSS;
        document.head.appendChild(st);
    }

    /* ---------------- 小标签 ---------------- */

    function chipClass(result) {
        if (result.blocked) return 'nkc-chip bad';
        if (!(result.max > 0)) return 'nkc-chip bad';
        if (result.max < 10) return 'nkc-chip warn';
        return 'nkc-chip';
    }

    function chipText(result, withTime) {
        if (result.pendingSecondary) return '待选材料';
        let text = (result.multiplier > 1 ? '×' + result.multiplier + ' ' : '') + fmtShort(result.max) + '次';
        if (withTime && result.max !== Infinity && result.totalSeconds > 0) {
            text += ' · ' + durShort(result.totalSeconds);
        }
        return text;
    }

    function chipTitle(result, extra) {
        const parts = [];
        if (result.pendingSecondary) {
            parts.push('请先选择次要材料');
        } else {
            parts.push('库存材料最多可做 ' + fmt(result.max) + ' 次' +
                (result.multiplier > 1 ? '（当前批量 ×' + result.multiplier + '）' : ''));
            if (result.maxMultiplier > 1) {
                parts.push('批量工序最高 ' + result.maxMultiplier + ' 倍');
                if (result.limits && result.limits.length) {
                    parts.push(result.limits.map(x => x.m + '倍 ' + fmt(x.max) + ' 次').join(' / '));
                }
            }
            if (result.seconds > 0) {
                parts.push('单次 ' + durSec(result.seconds));
                if (result.max > 0) parts.push('预计 ' + durLong(result.totalSeconds));
            }
            if (result.noQueue) parts.push('不占用行动队列');
            if (result.blocked) parts.push('等级不足，暂时无法执行');
            else if (result.succ < 1) {
                if (result.kind === 'alchemy') {
                    parts.push('成功率 ' + Math.round(result.succ * 100) + '%，失败仅消耗次要材料');
                } else {
                    parts.push('成功率 ' + Math.round(result.succ * 100) + '%，失败不消耗材料，预计耗时已计入重试');
                }
            }
            if (result.bottleneck) {
                const b = result.bottleneck;
                parts.push('瓶颈：' + itemName(b.itemId) + '（需 ' + fmt(b.qty) + ' / 有 ' + fmt(b.have) + '）');
            }
        }
        if (extra) parts.push(extra);
        return parts.join(' · ');
    }

    function applyChip(chip, result, extra, withTime) {
        const text = chipText(result, withTime);
        const cls = chipClass(result);
        const title = chipTitle(result, extra);
        if (chip.textContent !== text) chip.textContent = text;
        if (chip.className !== cls) chip.className = cls;
        if (chip.title !== title) chip.title = title;
    }

    function ensureChip(parent, insertBefore) {
        if (!parent) return null;
        let chip = parent.querySelector('.nkc-chip');
        if (!chip) {
            chip = document.createElement('span');
            chip.className = 'nkc-chip';
            if (insertBefore && insertBefore.parentNode === parent) {
                parent.insertBefore(chip, insertBefore);
            } else {
                parent.appendChild(chip);
            }
        }
        return chip;
    }

    /* ---------------- 大块内容 ---------------- */

    function blockHTML(result, title) {
        if (!result) return '';

        let html = '<div class="nkc-h">' + esc(title || '加工上限') +
            (result.label && result.kind === 'alchemy' ? ' · ' + esc(result.label) : '') + '</div>';

        if (result.pendingSecondary) {
            return html + '<div class="nkc-dim">请先选择次要材料，再计算可加工次数。</div>';
        }

        if (result.blocked) {
            html += '<div class="bad">等级不足，暂时无法执行；库存材料上限 ' + fmt(result.max) + ' 次</div>';
        } else {
            html += '<div>库存最多可做 <b>' + fmt(result.max) + '</b> 次' +
                (result.multiplier > 1 ? '（当前批量 ×' + result.multiplier + '）' : '') + '</div>';
        }

        if (result.maxMultiplier > 1) {
            html += '<div class="nkc-dim">批量工序最高 <b>' + result.maxMultiplier +
                '</b> 倍' + (result.multiplier > 1 ? ' · 当前 ×' + result.multiplier : '') +
                '（倍率放大材料消耗，不缩短单次耗时）</div>';
            html += '<div class="nkc-mats">';
            (result.limits || []).forEach(x => {
                html += '<div class="nkc-mat"><span class="nkc-mat-name">' + x.m + ' 倍' +
                    (x.m === result.multiplier ? '（当前）' : '') + '</span>' +
                    '<span class="nkc-mat-val">' +
                    (x.bottleneck ? '瓶颈 ' + esc(itemName(x.bottleneck.itemId)) + ' · ' : '') +
                    '<b>' + fmtShort(x.max) + ' 次</b></span></div>';
            });
            html += '</div>';
        }

        if (result.seconds > 0) {
            html += '<div>单次 <b>' + durSec(result.seconds) + '</b>';
            if (result.max > 0) html += ' · 预计 <b>' + durLong(result.totalSeconds) + '</b>';
            html += '</div>';
        } else if (result.noQueue) {
            html += '<div class="nkc-dim">不占用行动队列，可立即执行</div>';
        }

        if (!result.blocked && result.succ < 1) {
            html += '<div class="warn">成功率 ' + Math.round(result.succ * 100) +
                '%，失败不消耗材料；预计耗时已计入失败重试</div>';
        }

        if (result.rows && result.rows.length) {
            html += '<div class="nkc-mats">';
            result.rows.forEach(r => {
                const qtyText = (r.baseQty && result.multiplier > 1)
                    ? fmt(r.qty) + '（' + fmt(r.baseQty) + '×' + result.multiplier + '）'
                    : fmt(r.qty);
                html += '<div class="nkc-mat"><span class="nkc-mat-name">' +
                    esc(itemName(r.itemId)) + (r.enh ? ' +' + r.enh : '') + '</span>' +
                    '<span class="nkc-mat-val">需 ' + qtyText + ' · 有 ' + fmt(r.have) +
                    ' · <b>' + fmtShort(r.max) + ' 次</b></span></div>';
            });
            html += '</div>';
        }

        if (result.bottleneck) {
            html += '<div class="nkc-dim">瓶颈：' + esc(itemName(result.bottleneck.itemId)) + '</div>';
        }
        return html;
    }

    /* ---------------- 生产卡片 ---------------- */

    function decorateProduction(g) {
        const map = UI.actionMap;
        if (!map || typeof map.forEach !== 'function') return;
        map.forEach((card, key) => {
            if (!card || !card.isConnected) return;
            const m = /^7-(\d+)$/.exec(String(key));
            if (!m) return;
            const action = Data.actions[m[1]];
            if (!action || +action.type !== 7) return;
            const titleRow = card.querySelector('.action-card-title');
            if (!titleRow) return;
            // 旧版本把角标塞在标题行里，长配方名会被挤到换行；这里顺手清掉
            const stray = titleRow.querySelector('.nkc-chip');
            if (stray) stray.remove();
            // 角标绝对定位在卡片右下角的空白处，不占标题行宽度
            const chip = ensureChip(card);
            if (!chip) return;
            applyChip(chip, productionSpec(g, action));
        });
    }

    /* ---------------- 详情弹窗（生产） ---------------- */

    let productionIndex = null;
    function productionByName(name, lvHint) {
        if (!productionIndex) {
            productionIndex = Object.create(null);
            Object.keys(Data.actions).forEach(id => {
                const a = Data.actions[id];
                if (!a || +a.type !== 7) return;
                const n = cleanName(a.name);
                (productionIndex[n] || (productionIndex[n] = [])).push(a);
            });
        }
        const list = productionIndex[cleanName(name)];
        if (!list || !list.length) return null;
        if (list.length === 1) return list[0];
        if (lvHint != null) {
            for (let i = 0; i < list.length; i++) {
                if ((+list[i].level || 1) === lvHint) return list[i];
            }
        }
        return list[0];
    }

    function decorateActionModal(g) {
        document.querySelectorAll('.action-modal-content .modal-body').forEach(body => {
            const wrap = body.closest('.action-modal-content');
            const titleEl = wrap && wrap.querySelector('.modal-title');
            if (!titleEl) return;

            const raw = cleanName(titleEl.textContent);
            const idx = raw.indexOf(':');
            const name = idx >= 0 ? raw.slice(idx + 1).trim() : raw;
            const lvEl = wrap.querySelector('.action-level-value');
            const lvMatch = lvEl && /(\d+)/.exec(lvEl.textContent || '');
            const action = productionByName(name, lvMatch ? +lvMatch[1] : null);

            let block = body.querySelector('.nkc-detail-block');
            if (!action) { if (block) block.remove(); return; }

            // 批量工序：读取当前选中的加工倍数；倍率改变时立即重算
            let mul = 1;
            const checked = body.querySelector('input[name^="craft-multiplier"]:checked');
            if (checked) mul = Math.max(1, Math.min(5, Math.floor(+checked.value) || 1));
            if (!body.dataset.nkcMulBound) {
                body.dataset.nkcMulBound = '1';
                body.addEventListener('change', e => {
                    const t = e.target;
                    if (t && t.name && t.name.indexOf('craft-multiplier') === 0) schedule();
                });
            }

            const result = productionSpec(g, action, mul);
            const sig = sigOf(result);
            if (block && block.dataset.nkcSig === sig) return;

            if (!block) {
                block = document.createElement('div');
                block.className = 'modal-box-item nkc-detail-block';
                const anchor = body.querySelector('.modal-box-item');
                if (anchor) anchor.after(block);
                else body.prepend(block);
            }
            block.dataset.nkcSig = sig;
            block.innerHTML = '<div class="nkc-block">' + blockHTML(result, '加工上限') + '</div>';
        });
    }

    /* ---------------- 烹饪 ---------------- */

    function isCookingUnlocked(g, recipe) {
        if (!recipe.unlock_item) return true;
        const list = g.character && g.character.cookingUnlocked;
        if (!Array.isArray(list)) return false;
        return list.some(id => +id === +recipe.id);
    }

    function decorateCookingList(g) {
        document.querySelectorAll('.cooking-recipe-item').forEach(el => {
            const recipe = el._recipe;
            const levelRow = el.querySelector('.cooking-recipe-level');
            const oldChip = el.querySelector('.nkc-cook-chip');
            if (!recipe || !levelRow || !isCookingUnlocked(g, recipe)) {
                if (oldChip) oldChip.remove();
                return;
            }
            const result = cookingSpec(g, recipe);
            let chip = oldChip;
            if (!chip) {
                chip = document.createElement('span');
                chip.className = 'nkc-cook-chip';
                levelRow.appendChild(chip);
            }
            const text = ' · 材料' + fmtShort(result.max);
            const cls = 'nkc-cook-chip' + (result.blocked || !(result.max > 0) ? ' bad'
                : (result.max < 10 ? ' warn' : ''));
            const title = chipTitle(result);
            if (chip.textContent !== text) chip.textContent = text;
            if (chip.className !== cls) chip.className = cls;
            if (chip.title !== title) chip.title = title;
        });
    }

    function decorateCookingDetail(g) {
        document.querySelectorAll('.cooking-detail').forEach(panel => {
            const page = panel.closest('.cooking-page');
            const recipe = page && page._activeRecipe;
            let wrap = panel.querySelector('.nkc-cook-detail');

            if (!recipe || !isCookingUnlocked(g, recipe)) {
                if (wrap) wrap.remove();
                return;
            }

            const result = cookingSpec(g, recipe);
            const sig = sigOf(result);
            if (wrap && wrap.dataset.nkcSig === sig) return;

            if (!wrap) {
                wrap = document.createElement('div');
                wrap.className = 'cooking-detail-section nkc-cook-detail';
                const header = panel.querySelector('.cooking-detail-header');
                if (header) header.after(wrap);
                else panel.prepend(wrap);
            }
            wrap.dataset.nkcSig = sig;
            wrap.innerHTML = '<div class="nkc-block">' + blockHTML(result, '加工上限') + '</div>';
        });
    }

    /* ---------------- 炼金 ---------------- */

    function alchemyFooterHTML(result) {
        let html = '<div class="nkc-h">' + esc(result.label || '炼金') + ' · 材料上限</div>';
        if (result.pendingSecondary) {
            return html + '<div class="nkc-dim">请先选择次要材料</div>';
        }
        html += '<div>库存可做 <b>' + fmt(result.max) + '</b> 次';
        if (result.seconds > 0) {
            html += ' · 单次 <b>' + durSec(result.seconds) + '</b>';
            if (result.max > 0) html += ' · 预计 <b>' + durLong(result.totalSeconds) + '</b>';
        } else if (result.noQueue) {
            html += ' · 不占队列';
        }
        html += '</div>';
        if (result.rows && result.rows.length > 1) {
            html += '<div class="nkc-mats">';
            result.rows.forEach(r => {
                html += '<div class="nkc-mat"><span class="nkc-mat-name">' +
                    esc(itemName(r.itemId)) + (r.enh ? ' +' + r.enh : '') + '</span>' +
                    '<span class="nkc-mat-val">需 ' + fmt(r.qty) + ' · 有 ' + fmt(r.have) +
                    ' · <b>' + fmtShort(r.max) + ' 次</b></span></div>';
            });
            html += '</div>';
        }
        if (result.succ < 1) {
            html += '<div class="nkc-dim">成功率 ' + Math.round(result.succ * 100) +
                '%，失败仅消耗次要材料</div>';
        }
        if (result.bottleneck) {
            html += '<div class="nkc-dim">瓶颈：' + esc(itemName(result.bottleneck.itemId)) +
                '（需 ' + fmt(result.bottleneck.qty) + ' / 有 ' + fmt(result.bottleneck.have) + '）</div>';
        }
        return html;
    }

    function decorateAlchemy(g) {
        const pages = UI.alchemyPages;
        const infos = UI.alchemyInfo || {};
        if (!pages) return;

        Object.keys(pages).forEach(key => {
            const page = pages[key];
            if (!page || !page.isConnected) return;

            const info = infos[key];
            const result = info ? alchemySpec(g, key, info) : null;
            let box = page.querySelector('.nkc-alchemy');

            if (!result) { if (box) box.remove(); return; }

            const sig = sigOf(result);
            if (box && box.dataset.nkcSig === sig) return;

            if (!box) {
                box = document.createElement('div');
                box.className = 'nkc-alchemy';
                page.appendChild(box);
            }
            box.dataset.nkcSig = sig;
            box.innerHTML = alchemyFooterHTML(result);
            box.title = chipTitle(result);
        });
    }

    /* ---------------- 队列 / 当前行动 ---------------- */

    function decorateQueue(g) {
        const map = queueResults(g);
        document.querySelectorAll('.action-queue-item').forEach(el => {
            const idx = +el._queueIndex;
            const entry = map.get(idx);
            const row = el.querySelector('.action-queue-top');
            const chip = el.querySelector('.nkc-chip');

            if (!entry || !row) {
                if (chip) chip.remove();
                return;
            }

            const btn = row.querySelector('.action-queue-btn');
            const target = chip || ensureChip(row, btn);
            if (!target) return;
            // 独立上限用 indep，但耗时 / 成功率 / 等级状态来自 spec，合并后悬停提示才完整
            const result = Object.assign({}, entry.spec, {
                max: entry.indep.max,
                rows: entry.indep.rows,
                bottleneck: entry.indep.bottleneck
            });
            // 耗时按当前显示的独立上限重算，保证「次数 · 时间」口径一致
            result.totalSeconds = (result.seconds > 0 && result.max !== Infinity)
                ? (result.max * result.seconds / result.succ) : 0;
            const q = g.queue && g.queue[idx];
            let remTxt = '';
            if (q) {
                const rem = q.remaining == null ? q.count : q.remaining;
                remTxt = '队列剩余 ' + (rem == null || rem === -1 ? '∞' : fmt(rem)) + ' 次 · ';
            }
            let seqTxt = '按队列顺序预留前面项目后约 ' + fmt(entry.seq.max) + ' 次';
            if (entry.seq.max !== Infinity && entry.spec.seconds > 0) {
                seqTxt += '（约 ' + durShort(entry.seq.max * entry.spec.seconds / entry.spec.succ) + '）';
            }
            applyChip(target, result, remTxt + seqTxt, true);
        });
    }

    function decorateActive(g) {
        const container = document.querySelector('.active-container');
        if (!container) return;
        const row = container.querySelector('.action-title');
        if (!row) return;

        const q = g.queue && g.queue[0];
        const spec = q ? queueSpec(g, q) : null;
        const chip = row.querySelector('.nkc-chip');

        if (!spec) { if (chip) chip.remove(); return; }

        const lim = limitFromCosts(spec.costs, (id, enh) => g.getItemQuantity(id, enh));
        const result = Object.assign({}, spec, lim);
        const target = chip || ensureChip(row, row.querySelector('.action-cancel-btn'));
        if (!target) return;
        applyChip(target, result, '当前行动');
    }

    /* ---------------- 调度 ---------------- */

    let pending = null;
    function schedule() {
        if (pending) return;
        pending = setTimeout(() => {
            pending = null;
            run();
        }, DEBOUNCE);
    }

    function run() {
        if (document.hidden) return;
        const g = game();
        if (!g) return;
        try { injectCSS(); } catch (e) { /* 忽略 */ }
        try { decorateProduction(g); } catch (e) { /* 忽略 */ }
        try { decorateActionModal(g); } catch (e) { /* 忽略 */ }
        try { decorateCookingList(g); } catch (e) { /* 忽略 */ }
        try { decorateCookingDetail(g); } catch (e) { /* 忽略 */ }
        try { decorateAlchemy(g); } catch (e) { /* 忽略 */ }
        try { decorateQueue(g); } catch (e) { /* 忽略 */ }
        try { decorateActive(g); } catch (e) { /* 忽略 */ }
    }

    function start() {
        if (!document.body) { setTimeout(start, 100); return; }
        injectCSS();
        schedule();
        try {
            new MutationObserver(schedule).observe(document.body, {
                childList: true, subtree: true, characterData: true
            });
        } catch (e) { /* 忽略 */ }
        setInterval(schedule, RESCAN_MS);
        document.addEventListener('visibilitychange', schedule);
        console.log(TAG, 'v' + VERSION + ' 已就绪（只读模式）');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }

    // 调试入口：可在控制台执行 __NK_CRAFTLIMIT__.decorate()
    window.__NK_CRAFTLIMIT__ = {
        version: VERSION,
        decorate: schedule,
        run: run,
    };
})();
/* ==================== 模块 2：资产统计 ==================== */(function () {
    'use strict';

    const VERSION = '2.2.4';
    const TAG = '[资产统计]';
    const BOOT_MS = 500;
    const MAX_ROWS = 200;

    if (window.__NK_ASSETS__) {
        console.warn(TAG, '已经加载过，跳过这一次重复注入');
        return;
    }

    /* ── 共享行情模块：两个助手共用同一份数据，避免重复请求 ── */
    (function () {
        const GLOBAL = '__NK_MARKET__';
        const MODE_KEY = 'nkr_mode';
        const REFRESH_MIN_MS = 30000;
        const TAX_RATE = 0.02;
        if (window[GLOBAL] && window[GLOBAL].version === '1.1') return;

        const listeners = new Set();
        const st = {
            prices: new Map(),
            mode: readMode(),
            loaded: false,
            loading: false,
            error: false,
            lastRequest: 0,
            updatedAt: 0,
            count: 0,
            cacheSize: 0,
            promise: null,
            attached: false
        };

        function readMode() {
            let v = 'sell';
            try {
                if (typeof Utils !== 'undefined' && typeof Utils.getData === 'function') {
                    v = Utils.getData(MODE_KEY, 'sell');
                } else {
                    v = localStorage.getItem(MODE_KEY);
                    try { v = JSON.parse(v); } catch (e) { /* 原样使用 */ }
                }
            } catch (e) { /* ignore */ }
            return v === 'market' ? 'market' : 'sell';
        }

        function writeMode(v) {
            try {
                if (typeof Utils !== 'undefined' && typeof Utils.setData === 'function') {
                    Utils.setData(MODE_KEY, v);
                } else {
                    localStorage.setItem(MODE_KEY, JSON.stringify(v));
                }
            } catch (e) { /* ignore */ }
        }

        function game() {
            return (typeof UI !== 'undefined' && UI.game) ? UI.game : null;
        }

        function emit(reason) {
            listeners.forEach(fn => {
                try { fn(reason); } catch (e) { console.warn('[共享行情] 订阅回调失败', e); }
            });
        }

        /* +0 优先；没有 +0 收购则取有收购等级中的最低价 */
        function rebuild(silent) {
            const g = game();
            if (!g || !g.marketCacheData || typeof g.marketCacheData.forEach !== 'function') return false;
            const map = new Map();
            g.marketCacheData.forEach((snapshot, key) => {
                const levels = snapshot && Array.isArray(snapshot.levels) ? snapshot.levels : [];
                let base = 0;
                const others = [];
                for (let i = 0; i < levels.length; i++) {
                    const level = levels[i] || {};
                    const qty = Number(level.demand_qty);
                    const price = Number(level.demand_price);
                    if (!(qty > 0) || !(price > 0)) continue;
                    if ((Number(level.enhancement) || 0) === 0) {
                        if (price > base) base = price;
                    } else {
                        others.push(price);
                    }
                }
                const chosen = base > 0 ? base : (others.length ? Math.min.apply(null, others) : 0);
                /* 收购价扣 2% 税，作为统一的市场估值单价 */
                const net = Math.round(chosen * (1 - TAX_RATE) * 100) / 100;
                if (net > 0) map.set(Number(key), net);
            });
            st.prices = map;
            st.count = map.size;
            st.cacheSize = (g && g.marketCacheData) ? g.marketCacheData.size : 0;
            st.loaded = true;
            st.error = false;
            st.updatedAt = Date.now();
            if (!silent) emit('data');
            return true;
        }

        /* 游戏自己收到行情缓存时被动重算，不发请求；只挂一次 */
        function attach() {
            const g = game();
            if (!g || st.attached) return st.attached;
            ['setMarketCacheAll', 'setMarketCache'].forEach(name => {
                const orig = g[name];
                if (typeof orig !== 'function' || orig.__nkm) return;
                const wrapped = function () {
                    const result = orig.apply(this, arguments);
                    try { rebuild(true); emit('data'); } catch (e) { console.warn('[共享行情] 缓存更新处理失败', e); }
                    return result;
                };
                wrapped.__nkm = true;
                g[name] = wrapped;
            });
            st.attached = true;
            return true;
        }

        function status() {
            let text;
            if (st.mode !== 'market') {
                text = '当前使用出售价格；切换到市场价格时会自动加载一次行情。';
            } else if (st.loading) {
                text = '行情加载中…（单条只读查询，不逐物品请求）';
            } else if (st.error) {
                text = '行情加载失败，已回退到出售价格；可点击「刷新行情」重试。';
            } else if (!st.loaded) {
                text = '行情未加载，当前回退到出售价格；点击「刷新行情」或切回再切入市场价格。';
            } else {
                const time = st.updatedAt ? new Date(st.updatedAt).toLocaleTimeString() : '';
                const gap = st.updatedAt ? Math.round((Date.now() - st.updatedAt) / 1000) + ' 秒前更新' : '';
                text = '行情已加载（收购价已扣 2% 税）：' + st.count + ' 件物品有收购价 · ' + time + '（' + gap + '）';
            }
            return {
                mode: st.mode, loaded: st.loaded, loading: st.loading, error: st.error,
                count: st.count, cacheSize: st.cacheSize, updatedAt: st.updatedAt, lastRequest: st.lastRequest, text: text
            };
        }

        /* 唯一行情入口：在途复用 + 30 秒节流，两个脚本共享 */
        function ensure(force) {
            attach();
            if (st.loading && st.promise) return st.promise;
            const now = Date.now();
            if (!force && st.loaded) return Promise.resolve(false);
            if (now - st.lastRequest < REFRESH_MIN_MS && !(force && (st.error || !st.cacheSize))) return Promise.resolve(false);

            const g = game();
            if (!g || typeof g.loadMarketCache !== 'function') {
                st.error = true;
                emit('status');
                return Promise.resolve(false);
            }

            st.loading = true;
            st.error = false;
            st.lastRequest = now;
            emit('status');

            let promise;
            try {
                promise = Promise.resolve(g.loadMarketCache(!!force)).then(() => {
                    st.loading = false;
                    st.promise = null;
                    const g2 = game();
                    if (!rebuild(true) || !g2 || !g2.marketCacheData || !g2.marketCacheData.size) {
                        st.error = true;
                    }
                    emit('data');
                    return true;
                }, err => {
                    st.loading = false;
                    st.promise = null;
                    st.error = true;
                    console.warn('[共享行情] 加载失败，已回退到出售价格', err);
                    emit('status');
                    return false;
                });
            } catch (err) {
                st.loading = false;
                st.error = true;
                console.warn('[共享行情] 请求失败，已回退到出售价格', err);
                emit('status');
                return Promise.resolve(false);
            }
            st.promise = promise;
            return promise;
        }

        function setMode(v) {
            const next = v === 'market' ? 'market' : 'sell';
            if (st.mode === next) return;
            st.mode = next;
            writeMode(next);
            emit('mode');
            if (next === 'market') ensure(false);
        }

        window[GLOBAL] = {
            version: '1.1',
            subscribe(fn) { if (typeof fn === 'function') listeners.add(fn); return () => listeners.delete(fn); },
            unsubscribe(fn) { listeners.delete(fn); },
            getMode() { return st.mode; },
            setMode: setMode,
            getPrices() { return st.prices; },
            priceOf(id, fallback) {
                if (st.mode !== 'market' || !st.loaded) return fallback;
                const p = st.prices.get(Number(id));
                return (p && p > 0) ? p : fallback;
            },
            hasPrice(id) {
                return st.mode === 'market' && st.loaded && (st.prices.get(Number(id)) > 0);
            },
            /* 有收购且税后净价高于系统出售价才算有效市场价 */
            isBetter(id, fallback) {
                if (st.mode !== 'market' || !st.loaded) return false;
                const p = st.prices.get(Number(id));
                const f = Number(fallback);
                return !!(p && p > 0) && (isFinite(f) ? p > f : true);
            },
            valueInfo(id, fallback) {
                const f0 = Number(fallback);
                const f = (isFinite(f0) && f0 > 0) ? f0 : 0;
                if (st.mode !== 'market' || !st.loaded) return { unit: f, better: false, hasMarket: false };
                const p = st.prices.get(Number(id));
                if (!(p && p > 0)) return { unit: f, better: false, hasMarket: false };
                return { unit: p, better: p > f, hasMarket: true };
            },
            status: status,
            ensure: ensure,
            ensureForMode() { return st.mode === 'market' ? ensure(false) : Promise.resolve(false); },
            refresh() { return ensure(true); },
            attach: attach,
            rebuild: rebuild
        };
    })();

    const ZW = /[\u200b\u200c\u200d\ufeff]/g;
    const cleanName = s => String(s == null ? '' : s).replace(ZW, '').trim();

    const state = {
        sec: null,
        data: null,
        lastAt: 0,
        search: '',
        filter: 'all'
    };

    function market() {
        return window.__NK_MARKET__;
    }

    function modeLabel() {
        const mk = market();
        return (mk && mk.getMode() === 'market') ? '市场收购价（税后）' : '系统出售价';
    }

    function syncModeUI(sec) {
        sec = sec || state.sec;
        if (!sec) return;
        const mk = market();
        const s = mk ? mk.status() : { mode: 'sell', loading: false, text: '' };
        const sel = sec.querySelector('.nka-mode-select');
        if (sel) sel.value = s.mode;
        const status = sec.querySelector('.nka-market-status');
        if (status) status.textContent = s.text;
        const btn = sec.querySelector('.nka-market-refresh');
        if (btn) {
            btn.disabled = s.mode !== 'market' || s.loading;
            btn.title = s.mode !== 'market' ? '请先切换到市场价格' :
                s.loading ? '正在加载…' : '两次刷新间隔至少 30 秒（与其他助手共用）';
        }
    }

    /* 模式 / 行情变化：重算统计与背包角标；仅状态变化时不重算 */
    function onMarketChange(reason) {
        syncModeUI();
        if (reason !== 'status') {
            state.data = collect();
            render(state.data);
            decorateInventoryValues();
        }
    }

    market().subscribe(onMarketChange);

    /* ── 格式化 ───────────────────────────────── */

    function fmt(n) {
        if (n == null || !isFinite(n)) return '—';
        const neg = n < 0;
        const abs = Math.abs(n);
        const s = (Math.round(abs * 100) / 100).toString();
        const parts = s.split('.');
        const ip = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        return (neg ? '-' : '') + ip + (parts[1] ? '.' + parts[1] : '');
    }

    function fmtShortFallback(n) {
        if (n == null || !isFinite(n)) return '—';
        const neg = n < 0;
        const abs = Math.abs(n);
        let s;
        if (abs >= 1e12) s = (abs / 1e12).toFixed(2) + ' 万亿';
        else if (abs >= 1e8) s = (abs / 1e8).toFixed(2) + ' 亿';
        else if (abs >= 1e4) s = (abs / 1e4).toFixed(2) + ' 万';
        else s = fmt(abs);
        return (neg ? '-' : '') + s;
    }

    /* 跟随游戏「系统设置 → 界面 → 计数单位」：K/M/B 或 万/亿/兆/京 */
    function fmtUnit(n) {
        if (n == null || !isFinite(n)) return '—';
        try {
            if (typeof Utils !== 'undefined' && typeof Utils.formatNumber === 'function') {
                return Utils.formatNumber(n, Utils.getNumberUnit());
            }
        } catch (e) { /* 回退到内置格式 */ }
        return fmtShortFallback(n);
    }

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[c]);
    }

    function timeStr(d) {
        const p = n => (n < 10 ? '0' + n : String(n));
        return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    }

    /* ── 数据访问 ─────────────────────────────── */

    function defOf(id) {
        const n = parseInt(id, 10);
        if (typeof Data === 'undefined' || !Data.items) return null;
        return Data.items[n] || null;
    }

    /* 与 ui.js 的 getItemIconId 保持一致 */
    function iconOf(id) {
        const n = parseInt(id, 10) || 0;
        if (n === 4) return 2;
        if (n === 107) return 202;
        if (n >= 9601 && n <= 9605) return 9601;
        if (n >= 9611 && n <= 9614) return 9611;
        if (n >= 3500 && n <= 3599) return 3500;
        return n;
    }

    /* 系统出售价：不可交易记 0 */
    function sellValue(def) {
        if (!def || !def.trade) return 0;
        const v = Number(def.value);
        return (isFinite(v) && v > 0) ? v : 0;
    }

    /* 统一估值信息：市场价已扣 2% 税；better 表示净价高于出售价 */
    function valueInfoOf(def) {
        const sell = sellValue(def);
        const mk = market();
        return mk ? mk.valueInfo(def.id, sell) : { unit: sell, better: false, hasMarket: false };
    }

    function unitValue(def) {
        return valueInfoOf(def).unit;
    }

    /* 物品图标上的数量文本可能带 K/M/万/亿 等单位 */
    function parseQuantityText(text) {
        const s = String(text == null ? '' : text).replace(/,/g, '').trim();
        const m = s.match(/^(-?\d+(?:\.\d+)?)\s*(万|亿|兆|京|K|M|B|T)?$/i);
        if (!m) return 0;
        const mult = {
            '万': 1e4, '亿': 1e8, '兆': 1e12, '京': 1e16,
            'K': 1e3, 'M': 1e6, 'B': 1e9, 'T': 1e12
        }[(m[2] || '').toUpperCase()] || 1;
        const value = parseFloat(m[1]) * mult;
        return isFinite(value) ? Math.round(value) : 0;
    }

    function makeRec(def, enh) {
        return {
            item: Number(def.id),
            name: cleanName(def.name) || ('#' + def.id),
            enh: enh,
            qty: 0,
            unit: unitValue(def),
            value: 0,
            rarity: Number(def.rarity) || 0
        };
    }

    function collect() {
        const g = (typeof UI !== 'undefined' && UI.game) ? UI.game : null;
        const out = {
            ok: false,
            inv: [],
            sell: [],
            currencies: [],
            invValue: 0,
            sellValue: 0,
            buyFrozen: 0,
            miao: 0,
            total: 0,
            invKinds: 0,
            invQty: 0,
            sellCount: 0,
            buyCount: 0
        };
        if (!g) return out;
        out.ok = true;

        const invMap = new Map();
        const curMap = new Map();
        const inventory = Array.isArray(g.inventory) ? g.inventory : [];

        inventory.forEach(row => {
            if (!row) return;
            const def = defOf(row.item);
            if (!def) return;
            const qty = Number(row.quantity) || 0;

            if (Number(def.type) === 1) {
                curMap.set(def.id, (curMap.get(def.id) || 0) + qty);
                return;
            }
            if (qty <= 0) return;

            const enh = Number(row.enhancement) || 0;
            const key = def.id + ':' + enh;
            let rec = invMap.get(key);
            if (!rec) {
                rec = makeRec(def, enh);
                invMap.set(key, rec);
            }
            rec.qty += qty;
        });

        invMap.forEach(rec => {
            rec.value = rec.qty * rec.unit;
            out.inv.push(rec);
            out.invValue += rec.value;
            out.invQty += rec.qty;
        });
        out.invKinds = out.inv.length;

        /* 货币：喵点始终显示，其余有余额才显示 */
        const CUR_ORDER = [1, 2, 4, 3, 501, 502, 503, 504];
        const curIds = new Set([...curMap.keys(), 1]);
        const curList = [];
        curIds.forEach(id => {
            const def = defOf(id);
            if (!def) return;
            curList.push({ id: Number(def.id), name: cleanName(def.name) || ('#' + def.id), qty: curMap.get(id) || 0 });
        });
        curList.sort((a, b) => {
            const ia = CUR_ORDER.indexOf(a.id);
            const ib = CUR_ORDER.indexOf(b.id);
            return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib) || a.id - b.id;
        });
        out.currencies = curList;
        out.miao = curMap.get(1) || 0;

        /* 市场挂单 */
        const sellMap = new Map();
        const orders = Array.isArray(g.order) ? g.order : [];
        orders.forEach(o => {
            if (!o) return;
            const side = Number(o.side);
            if (side === 1) {
                const qty = Math.max(0, (Number(o.quantity) || 0) - (Number(o.traded) || 0));
                if (qty <= 0) return;
                out.sellCount++;
                const def = defOf(o.item);
                if (!def) return;
                const enh = Number(o.enhancement) || 0;
                const key = def.id + ':' + enh;
                let rec = sellMap.get(key);
                if (!rec) {
                    rec = makeRec(def, enh);
                    sellMap.set(key, rec);
                }
                rec.qty += qty;
            } else if (side === 2) {
                const frozen = (Number(o.escrow) || 0) + (Number(o.deposit) || 0);
                if (frozen > 0) out.buyCount++;
                out.buyFrozen += frozen;
            }
        });
        sellMap.forEach(rec => {
            rec.value = rec.qty * rec.unit;
            out.sell.push(rec);
            out.sellValue += rec.value;
        });

        out.total = out.miao + out.invValue + out.sellValue + out.buyFrozen;
        return out;
    }

    /* ── 样式 ─────────────────────────────────── */

    function injectCSS() {
        if (document.getElementById('nka-style')) return;
        const st = document.createElement('style');
        st.id = 'nka-style';
        st.textContent = `
.nka-section { gap: 10px; }
.nka-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.nka-head .section-title { margin: 0; line-height: 22px; }
.nka-head-side { display: flex; align-items: center; gap: 8px; }
.nka-updated { font-size: 11px; opacity: .55; white-space: nowrap; }
.nka-refresh { flex: 0 0 auto; }
.nka-mode-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; }
.nka-mode-label { opacity: .7; flex: 0 0 auto; }
.nka-mode-select { flex: 0 0 auto; background: rgba(0, 0, 0, .35); border: 1px solid rgba(var(--r), var(--g), var(--b), .3); border-radius: 4px; color: inherit; padding: 4px 8px; font-size: 12px; font-family: inherit; outline: none; }
.nka-mode-select:focus { border-color: #74F9BC; }
.nka-market-refresh { flex: 0 0 auto; padding: 4px 9px; font-size: 12px; cursor: pointer; }
.nka-market-refresh:disabled { opacity: .4; cursor: default; }
.nka-market-status { font-size: 11px; opacity: .65; line-height: 1.5; min-height: 16px; }
.nka-item-value { position: absolute; left: 0; top: 0; z-index: 11; max-width: 50px; overflow: hidden; white-space: nowrap; height: 14px; padding: 2px 4px; box-sizing: content-box; border-radius: 0 0 6px 0; box-shadow: 0 4px 8px var(--c-mask-dim); line-height: 14px; background: rgba(254, 221, 51, .5); color: #FFFFFF; font-size: 12px; font-weight: 700; text-shadow: unset; pointer-events: none; }
.nka-item-value.nka-zero { opacity: .75; }
.nka-item-value.nka-market { background: rgba(116, 249, 188, .5); }
.nka-unit-price { position: absolute; left: 0; bottom: 0; z-index: 11; max-width: 44px; overflow: hidden; white-space: nowrap; padding: 1px 3px; box-sizing: border-box; border-radius: 0 5px 0 0; background: rgba(0, 0, 0, .58); color: #FFFFFF; font-size: 10px; line-height: 12px; font-weight: 600; text-shadow: unset; pointer-events: none; }
.small-icon .nka-item-value { max-width: 24px; height: 12px; line-height: 12px; padding: 1px 3px; font-size: 10px; border-radius: 0 0 4px 0; }
.small-icon .nka-unit-price { max-width: 28px; padding: 1px 2px; font-size: 9px; line-height: 11px; border-radius: 0 3px 0 0; }
.nka-cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.nka-card { background: rgba(var(--r), var(--g), var(--b), .1); border: 1px solid rgba(var(--r), var(--g), var(--b), .22); border-radius: 6px; padding: 8px 10px; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.nka-card-label { font-size: 12px; opacity: .7; }
.nka-card-value { font-size: 17px; font-weight: 600; color: #74F9BC; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nka-card-total .nka-card-value { color: #F7D732; }
.nka-card-sub { font-size: 11px; opacity: .55; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nka-currencies { display: flex; flex-wrap: wrap; gap: 6px; }
.nka-cur { display: flex; align-items: center; gap: 6px; background: rgba(var(--r), var(--g), var(--b), .08); border: 1px solid rgba(var(--r), var(--g), var(--b), .16); border-radius: 999px; padding: 3px 10px 3px 4px; font-size: 12px; }
.nka-cur-qty { font-weight: 600; color: #74F9BC; }
.nka-icon { width: 28px; height: 28px; flex: 0 0 28px; overflow: hidden; display: flex; align-items: center; justify-content: center; }
.nka-icon .itemicon { transform: scale(1); }
.nka-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.nka-search { flex: 1 1 140px; min-width: 120px; background: rgba(0, 0, 0, .35); border: 1px solid rgba(var(--r), var(--g), var(--b), .3); border-radius: 4px; color: inherit; padding: 5px 8px; font-size: 13px; outline: none; }
.nka-search:focus { border-color: #74F9BC; }
.nka-filters { display: flex; gap: 4px; flex-wrap: wrap; }
.nka-filter { padding: 4px 10px; border-radius: 4px; font-size: 12px; cursor: pointer; background: rgba(var(--r), var(--g), var(--b), .12); border: 1px solid transparent; user-select: none; }
.nka-filter:hover { background: rgba(var(--r), var(--g), var(--b), .22); }
.nka-filter.active { border-color: #74F9BC; color: #74F9BC; background: rgba(116, 249, 188, .12); }
.nka-list { max-height: 340px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; padding-right: 2px; }
.nka-row { display: grid; grid-template-columns: 28px minmax(0, 1fr) auto 64px 84px 44px; align-items: center; gap: 8px; padding: 4px 6px; border-radius: 4px; border-left: 3px solid var(--nka-r, #aaa); background: rgba(var(--r), var(--g), var(--b), .05); }
.nka-row:hover { background: rgba(var(--r), var(--g), var(--b), .14); }
.nka-name { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nka-enh { color: #F7D732; font-size: 11px; margin-left: 3px; }
.nka-qty, .nka-unit, .nka-sub { font-size: 12px; text-align: right; font-variant-numeric: tabular-nums; }
.nka-sub { color: #74F9BC; font-weight: 600; }
.nka-nosell { color: #888; font-weight: 400; }
.nka-src { font-size: 11px; text-align: center; border-radius: 3px; padding: 1px 0; }
.nka-src-inv { color: #7fd6ff; background: rgba(0, 212, 254, .12); }
.nka-src-sell { color: #F7D732; background: rgba(247, 215, 50, .12); }
.nka-empty { text-align: center; font-size: 12px; opacity: .5; padding: 14px 0; }
.nka-foot { font-size: 11px; opacity: .5; line-height: 1.5; }
.nka-r0 { --nka-r: #aaa; }
.nka-r1 { --nka-r: #92F75B; }
.nka-r2 { --nka-r: #00D4FE; }
.nka-r3 { --nka-r: #a846f0; }
.nka-r4 { --nka-r: #F74A82; }
.nka-r5 { --nka-r: #F7D732; }
.nka-r6 { --nka-r: #e9b9f1; }
@media (max-width: 720px) {
    .nka-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .nka-row { grid-template-columns: 28px minmax(0, 1fr) auto 84px; }
    .nka-unit, .nka-src { display: none; }
}
`;
        document.head.appendChild(st);
    }

    /* ── 界面 ─────────────────────────────────── */

    function buildSection() {
        state.search = '';
        state.filter = 'all';
        const sec = document.createElement('div');
        sec.className = 'neon-section nka-section';
        sec.innerHTML = `
            <div class="nka-head">
                <div class="section-title">资产统计</div>
                <div class="nka-head-side">
                    <span class="nka-updated">未统计</span>
                    <div class="btn s-btn nka-refresh">刷新</div>
                </div>
            </div>
            <div class="nka-mode-row">
                <span class="nka-mode-label">估值方式</span>
                <select class="nka-mode-select">
                    <option value="sell">出售价格</option>
                    <option value="market">市场价格</option>
                </select>
                <div class="btn s-btn nka-market-refresh">刷新行情</div>
                <span class="nka-market-status"></span>
            </div>
            <div class="nka-cards">
                <div class="nka-card" data-k="inv">
                    <div class="nka-card-label">背包可出售</div>
                    <div class="nka-card-value" data-v>—</div>
                    <div class="nka-card-sub" data-s>—</div>
                </div>
                <div class="nka-card" data-k="sell">
                    <div class="nka-card-label">市场在售</div>
                    <div class="nka-card-value" data-v>—</div>
                    <div class="nka-card-sub" data-s>—</div>
                </div>
                <div class="nka-card" data-k="frozen">
                    <div class="nka-card-label">求购冻结</div>
                    <div class="nka-card-value" data-v>—</div>
                    <div class="nka-card-sub" data-s>—</div>
                </div>
                <div class="nka-card nka-card-total" data-k="total">
                    <div class="nka-card-label">合计（喵点）</div>
                    <div class="nka-card-value" data-v>—</div>
                    <div class="nka-card-sub" data-s>—</div>
                </div>
            </div>
            <div class="nka-currencies"></div>
            <div class="nka-toolbar">
                <input class="nka-search" type="text" placeholder="搜索物品名称 / ID" autocomplete="off">
                <div class="nka-filters">
                    <div class="nka-filter active" data-f="all">全部</div>
                    <div class="nka-filter" data-f="inv">背包</div>
                    <div class="nka-filter" data-f="sell">在售</div>
                    <div class="nka-filter" data-f="zero">不可售</div>
                </div>
            </div>
            <div class="nka-list"><div class="nka-empty">尚未统计，点击右上角「刷新」</div></div>
            <div class="nka-foot">仅在你点击「刷新」时读取背包与市场数据，不做后台轮询</div>
        `;

        sec.querySelector('.nka-refresh').addEventListener('click', () => refresh());

        sec.querySelector('.nka-mode-select').addEventListener('change', e => {
            const mk = market();
            if (mk) mk.setMode(e.target.value);
        });
        sec.querySelector('.nka-market-refresh').addEventListener('click', () => {
            const mk = market();
            if (mk) mk.refresh();
        });
        syncModeUI(sec);

        const search = sec.querySelector('.nka-search');
        search.addEventListener('input', () => {
            state.search = search.value.trim().toLowerCase();
            renderList();
        });

        sec.querySelectorAll('.nka-filter').forEach(el => {
            el.addEventListener('click', () => {
                state.filter = el.dataset.f;
                sec.querySelectorAll('.nka-filter').forEach(x => {
                    x.classList.toggle('active', x === el);
                });
                renderList();
            });
        });

        return sec;
    }

    function setCard(sec, key, value, sub, title) {
        const card = sec.querySelector('.nka-card[data-k="' + key + '"]');
        if (!card) return;
        card.querySelector('[data-v]').textContent = value;
        card.querySelector('[data-s]').textContent = sub;
        if (title) card.title = title;
        else card.removeAttribute('title');
    }

    function renderCards(data) {
        const sec = state.sec;
        if (!sec) return;
        setCard(sec, 'inv',
            fmtUnit(data.invValue),
            data.invKinds + ' 种 / ' + fmtUnit(data.invQty) + ' 件',
            '背包可出售物品按' + modeLabel() + '合计 ' + fmt(data.invValue) + ' 喵点');
        setCard(sec, 'sell',
            fmtUnit(data.sellValue),
            data.sellCount + ' 个在售挂单',
            '市场在售物品按' + modeLabel() + '合计 ' + fmt(data.sellValue) + ' 喵点');
        setCard(sec, 'frozen',
            fmtUnit(data.buyFrozen),
            data.buyCount + ' 个求购挂单',
            '求购挂单冻结合计 ' + fmt(data.buyFrozen) + ' 喵点（托管 + 保证金）');
        setCard(sec, 'total',
            fmtUnit(data.total),
            '喵点余额 ' + fmtUnit(data.miao),
            '合计 = 喵点 ' + fmt(data.miao) +
            ' + 背包 ' + fmt(data.invValue) +
            ' + 在售 ' + fmt(data.sellValue) +
            ' + 求购冻结 ' + fmt(data.buyFrozen));
    }

    function renderCurrencies(data) {
        const sec = state.sec;
        if (!sec) return;
        const box = sec.querySelector('.nka-currencies');
        if (!data.currencies.length) {
            box.innerHTML = '';
            return;
        }
        box.innerHTML = data.currencies.map(c => {
            const full = fmt(c.qty);
            return '<div class="nka-cur" title="' + esc(c.name + ' × ' + full) + '">' +
                '<div class="nka-icon"><div class="itemicon itemicon-' + iconOf(c.id) + '"></div></div>' +
                '<div class="nka-cur-name">' + esc(c.name) + '</div>' +
                '<div class="nka-cur-qty">' + esc(fmtUnit(c.qty)) + '</div>' +
                '</div>';
        }).join('');
    }

    function renderList() {
        const sec = state.sec;
        const data = state.data;
        if (!sec || !data) return;

        const list = sec.querySelector('.nka-list');
        const foot = sec.querySelector('.nka-foot');
        const top = list.scrollTop;

        const rows = [];
        (data.inv || []).forEach(r => rows.push({ r: r, src: 'inv' }));
        (data.sell || []).forEach(r => rows.push({ r: r, src: 'sell' }));

        const q = state.search;
        const filtered = rows.filter(entry => {
            const r = entry.r;
            if (state.filter === 'inv' && entry.src !== 'inv') return false;
            if (state.filter === 'sell' && entry.src !== 'sell') return false;
            if (state.filter === 'zero' && r.unit > 0) return false;
            if (q) {
                const name = String(r.name || '').toLowerCase();
                if (name.indexOf(q) === -1 && String(r.item).indexOf(q) === -1) return false;
            }
            return true;
        });

        filtered.sort((a, b) => {
            const ra = a.r, rb = b.r;
            return (rb.value - ra.value) || (rb.qty - ra.qty) ||
                String(ra.name).localeCompare(String(rb.name), 'zh-CN');
        });

        const shown = filtered.slice(0, MAX_ROWS);
        let html = '';
        shown.forEach(entry => {
            const r = entry.r;
            const sellable = r.unit > 0;
            const title = r.name + (r.enh ? ' +' + r.enh : '') +
                '\n数量：' + fmt(r.qty) +
                '\n' + modeLabel() + '：' + (sellable ? fmt(r.unit) + ' 喵点' : '不可交易') +
                '\n小计：' + (sellable ? fmt(r.value) + ' 喵点' : '0') +
                '\n来源：' + (entry.src === 'inv' ? '背包' : '市场在售');
            html += '<div class="nka-row nka-r' + (r.rarity || 0) + '" title="' + esc(title) + '">' +
                '<div class="nka-icon"><div class="itemicon itemicon-' + iconOf(r.item) + '"></div></div>' +
                '<div class="nka-name">' + esc(r.name) +
                (r.enh ? '<span class="nka-enh">+' + r.enh + '</span>' : '') + '</div>' +
                '<div class="nka-qty">×' + esc(fmtUnit(r.qty)) + '</div>' +
                '<div class="nka-unit">' + (sellable ? esc(fmtUnit(r.unit)) : '—') + '</div>' +
                '<div class="nka-sub">' + (sellable ? esc(fmtUnit(r.value)) : '<span class="nka-nosell">不可售</span>') + '</div>' +
                '<div class="nka-src nka-src-' + entry.src + '">' + (entry.src === 'inv' ? '背包' : '在售') + '</div>' +
                '</div>';
        });

        if (!html) {
            html = '<div class="nka-empty">' +
                (data.ok ? '没有符合条件的物品' : '等待游戏数据加载…') + '</div>';
        }

        list.innerHTML = html;
        list.scrollTop = top;

        let footText = '共 ' + rows.length + ' 项 · 显示 ' + filtered.length + ' 项';
        if (filtered.length > MAX_ROWS) footText += '（仅列出前 ' + MAX_ROWS + ' 项）';
        footText += ' · 估值按' + modeLabel() + '，不可交易物品记 0';
        if (data.ok) footText += ' · 仅统计背包 / 货币 / 市场在售，已装备与时装未计入';
        foot.textContent = footText;
    }

    function render(data) {
        const sec = state.sec;
        if (!sec || !sec.isConnected) return;
        state.data = data;

        const up = sec.querySelector('.nka-updated');
        if (up) {
            up.textContent = data.ok
                ? ('更新于 ' + timeStr(new Date(state.lastAt || Date.now())))
                : '等待游戏数据加载…';
        }

        renderCards(data);
        renderCurrencies(data);
        renderList();
    }

    /* 只读缓存，不重新遍历背包 */
    function renderCached() {
        if (state.data) render(state.data);
    }

    function refresh() {
        if (!state.sec || !state.sec.isConnected) return;
        state.lastAt = Date.now();
        render(collect());
        decorateInventoryValues();
    }

    /* ── 背包物品图标左上角估值 ───────────────── */

    function decorateInventoryValues() {
        const grid = document.querySelector('.inventory-grid');
        if (!grid || typeof UI === 'undefined' || !UI.game) return;
        const byRow = new Map();
        const inv = Array.isArray(UI.game.inventory) ? UI.game.inventory : [];
        inv.forEach(row => { if (row && row.id != null) byRow.set(row.id, row); });

        grid.querySelectorAll('.item.inventory-item').forEach(el => {
            const st = el._itemTooltipState;
            const def = st && st.itemDef;
            if (!def) return;
            const rowId = st.param && st.param.item && st.param.item.id;
            const row = rowId != null ? byRow.get(rowId) : null;
            let qty = row ? Number(row.quantity)
                : parseQuantityText((el.querySelector('.item-quantity') || {}).textContent);
            if (!isFinite(qty) || qty <= 0) qty = 0;
            const info = valueInfoOf(def);
            const total = info.unit * qty;

            let tag = el.querySelector('.nka-item-value');
            if (!tag) {
                tag = document.createElement('div');
                el.appendChild(tag);
            }
            tag.className = 'nka-item-value' + (total > 0 ? '' : ' nka-zero') + (info.better ? ' nka-market' : '');
            tag.textContent = fmtUnit(total);

            let unitTag = el.querySelector('.nka-unit-price');
            if (info.better) {
                if (!unitTag) {
                    unitTag = document.createElement('div');
                    el.appendChild(unitTag);
                }
                unitTag.className = 'nka-unit-price';
                unitTag.textContent = fmtUnit(info.unit);
            } else if (unitTag) {
                unitTag.remove();
            }
        });
    }

    function wrapInventory() {
        if (typeof UI === 'undefined' || typeof UI.updateInventory !== 'function') return false;
        if (UI.updateInventory.__nka) return true;
        const orig = UI.updateInventory;
        const wrapped = function () {
            const result = orig.apply(this, arguments);
            try { decorateInventoryValues(); } catch (err) {
                console.warn(TAG, '背包图标估值失败', err);
            }
            return result;
        };
        wrapped.__nka = true;
        UI.updateInventory = wrapped;
        return true;
    }

    /* ── 注入 ─────────────────────────────────── */

    function injectInto(page) {
        if (!page || typeof page.querySelector !== 'function') return;
        const content = page.querySelector('.setting-content');
        if (!content) return;
        if (content.querySelector('.nka-section')) {
            renderCached();
            return;
        }
        const sec = buildSection();
        content.appendChild(sec);
        state.sec = sec;
        syncModeUI(sec);
        renderCached();
    }

    function wrapUI() {
        if (typeof UI === 'undefined' || typeof UI.updateSettingPage !== 'function') return false;
        if (UI.updateSettingPage.__nka) return true;

        const orig = UI.updateSettingPage;
        const wrapped = function (type, page) {
            const result = orig.apply(this, arguments);
            try {
                if (type === 'other') injectInto(page);
            } catch (err) {
                console.warn(TAG, '注入设置页失败', err);
            }
            return result;
        };
        wrapped.__nka = true;
        UI.updateSettingPage = wrapped;
        return true;
    }

    /* 启动时补注入（只查 DOM，不统计） */
    function scan() {
        if (!wrapUI()) return false;
        const contents = document.querySelectorAll('.setting-page .setting-content');
        let target = null;
        contents.forEach(c => {
            if (c.querySelector('.redeem-code')) target = c;
        });
        if (!target) return false;

        let sec = target.querySelector('.nka-section');
        if (!sec) {
            sec = buildSection();
            target.appendChild(sec);
            state.sec = sec;
            syncModeUI(sec);
            renderCached();
        } else if (state.sec !== sec) {
            state.sec = sec;
            syncModeUI(sec);
            renderCached();
        }
        return true;
    }

    /* ── 启动 ─────────────────────────────────── */

    injectCSS();

    // 等 UI 就绪后挂钩子；挂上后立即停表，之后不再有后台轮询
    function boot() {
        if (!wrapUI()) return false;
        market().attach();
        if (market().getMode() === 'market') market().rebuild();
        wrapInventory();
        decorateInventoryValues();
        scan();
        return true;
    }

    let bootTimer = setInterval(() => {
        if (boot()) {
            clearInterval(bootTimer);
            bootTimer = null;
        }
    }, BOOT_MS);

    if (boot()) {
        clearInterval(bootTimer);
        bootTimer = null;
    }

    window.__NK_ASSETS__ = {
        version: VERSION,
        refresh: () => refresh(),
        collect: collect,
        scan: scan,
        getMode: () => market().getMode(),
        getMarketStatus: () => market().status(),
        decorateInventory: decorateInventoryValues
    };

    console.log(TAG, 'v' + VERSION + ' 已加载（只读）');
})();
/* ==================== 模块 3：历史记录估值 ==================== */(function () {
    'use strict';

    const VERSION = '2.2.4';
    const TAG = '[历史记录估值]';
    const KEY = 'nkr_span';
    const BOOT_MS = 500;

    const SPANS = [
        { v: 60, label: '1 分钟', short: '分' },
        { v: 600, label: '10 分钟', short: '10分' },
        { v: 3600, label: '60 分钟', short: '时' },
        { v: 36000, label: '10 小时', short: '10时' },
        { v: 86400, label: '1 天', short: '天' }
    ];

    if (window.__NK_RECORDVALUE__) {
        console.warn(TAG, '已经加载过，跳过这一次重复注入');
        return;
    }

    /* ── 共享行情模块：两个助手共用同一份数据，避免重复请求 ── */
    (function () {
        const GLOBAL = '__NK_MARKET__';
        const MODE_KEY = 'nkr_mode';
        const REFRESH_MIN_MS = 30000;
        const TAX_RATE = 0.02;
        if (window[GLOBAL] && window[GLOBAL].version === '1.1') return;

        const listeners = new Set();
        const st = {
            prices: new Map(),
            mode: readMode(),
            loaded: false,
            loading: false,
            error: false,
            lastRequest: 0,
            updatedAt: 0,
            count: 0,
            cacheSize: 0,
            promise: null,
            attached: false
        };

        function readMode() {
            let v = 'sell';
            try {
                if (typeof Utils !== 'undefined' && typeof Utils.getData === 'function') {
                    v = Utils.getData(MODE_KEY, 'sell');
                } else {
                    v = localStorage.getItem(MODE_KEY);
                    try { v = JSON.parse(v); } catch (e) { /* 原样使用 */ }
                }
            } catch (e) { /* ignore */ }
            return v === 'market' ? 'market' : 'sell';
        }

        function writeMode(v) {
            try {
                if (typeof Utils !== 'undefined' && typeof Utils.setData === 'function') {
                    Utils.setData(MODE_KEY, v);
                } else {
                    localStorage.setItem(MODE_KEY, JSON.stringify(v));
                }
            } catch (e) { /* ignore */ }
        }

        function game() {
            return (typeof UI !== 'undefined' && UI.game) ? UI.game : null;
        }

        function emit(reason) {
            listeners.forEach(fn => {
                try { fn(reason); } catch (e) { console.warn('[共享行情] 订阅回调失败', e); }
            });
        }

        /* +0 优先；没有 +0 收购则取有收购等级中的最低价 */
        function rebuild(silent) {
            const g = game();
            if (!g || !g.marketCacheData || typeof g.marketCacheData.forEach !== 'function') return false;
            const map = new Map();
            g.marketCacheData.forEach((snapshot, key) => {
                const levels = snapshot && Array.isArray(snapshot.levels) ? snapshot.levels : [];
                let base = 0;
                const others = [];
                for (let i = 0; i < levels.length; i++) {
                    const level = levels[i] || {};
                    const qty = Number(level.demand_qty);
                    const price = Number(level.demand_price);
                    if (!(qty > 0) || !(price > 0)) continue;
                    if ((Number(level.enhancement) || 0) === 0) {
                        if (price > base) base = price;
                    } else {
                        others.push(price);
                    }
                }
                const chosen = base > 0 ? base : (others.length ? Math.min.apply(null, others) : 0);
                /* 收购价扣 2% 税，作为统一的市场估值单价 */
                const net = Math.round(chosen * (1 - TAX_RATE) * 100) / 100;
                if (net > 0) map.set(Number(key), net);
            });
            st.prices = map;
            st.count = map.size;
            st.cacheSize = (g && g.marketCacheData) ? g.marketCacheData.size : 0;
            st.loaded = true;
            st.error = false;
            st.updatedAt = Date.now();
            if (!silent) emit('data');
            return true;
        }

        /* 游戏自己收到行情缓存时被动重算，不发请求；只挂一次 */
        function attach() {
            const g = game();
            if (!g || st.attached) return st.attached;
            ['setMarketCacheAll', 'setMarketCache'].forEach(name => {
                const orig = g[name];
                if (typeof orig !== 'function' || orig.__nkm) return;
                const wrapped = function () {
                    const result = orig.apply(this, arguments);
                    try { rebuild(true); emit('data'); } catch (e) { console.warn('[共享行情] 缓存更新处理失败', e); }
                    return result;
                };
                wrapped.__nkm = true;
                g[name] = wrapped;
            });
            st.attached = true;
            return true;
        }

        function status() {
            let text;
            if (st.mode !== 'market') {
                text = '当前使用出售价格；切换到市场价格时会自动加载一次行情。';
            } else if (st.loading) {
                text = '行情加载中…（单条只读查询，不逐物品请求）';
            } else if (st.error) {
                text = '行情加载失败，已回退到出售价格；可点击「刷新行情」重试。';
            } else if (!st.loaded) {
                text = '行情未加载，当前回退到出售价格；点击「刷新行情」或切回再切入市场价格。';
            } else {
                const time = st.updatedAt ? new Date(st.updatedAt).toLocaleTimeString() : '';
                const gap = st.updatedAt ? Math.round((Date.now() - st.updatedAt) / 1000) + ' 秒前更新' : '';
                text = '行情已加载（收购价已扣 2% 税）：' + st.count + ' 件物品有收购价 · ' + time + '（' + gap + '）';
            }
            return {
                mode: st.mode, loaded: st.loaded, loading: st.loading, error: st.error,
                count: st.count, cacheSize: st.cacheSize, updatedAt: st.updatedAt, lastRequest: st.lastRequest, text: text
            };
        }

        /* 唯一行情入口：在途复用 + 30 秒节流，两个脚本共享 */
        function ensure(force) {
            attach();
            if (st.loading && st.promise) return st.promise;
            const now = Date.now();
            if (!force && st.loaded) return Promise.resolve(false);
            if (now - st.lastRequest < REFRESH_MIN_MS && !(force && (st.error || !st.cacheSize))) return Promise.resolve(false);

            const g = game();
            if (!g || typeof g.loadMarketCache !== 'function') {
                st.error = true;
                emit('status');
                return Promise.resolve(false);
            }

            st.loading = true;
            st.error = false;
            st.lastRequest = now;
            emit('status');

            let promise;
            try {
                promise = Promise.resolve(g.loadMarketCache(!!force)).then(() => {
                    st.loading = false;
                    st.promise = null;
                    const g2 = game();
                    if (!rebuild(true) || !g2 || !g2.marketCacheData || !g2.marketCacheData.size) {
                        st.error = true;
                    }
                    emit('data');
                    return true;
                }, err => {
                    st.loading = false;
                    st.promise = null;
                    st.error = true;
                    console.warn('[共享行情] 加载失败，已回退到出售价格', err);
                    emit('status');
                    return false;
                });
            } catch (err) {
                st.loading = false;
                st.error = true;
                console.warn('[共享行情] 请求失败，已回退到出售价格', err);
                emit('status');
                return Promise.resolve(false);
            }
            st.promise = promise;
            return promise;
        }

        function setMode(v) {
            const next = v === 'market' ? 'market' : 'sell';
            if (st.mode === next) return;
            st.mode = next;
            writeMode(next);
            emit('mode');
            if (next === 'market') ensure(false);
        }

        window[GLOBAL] = {
            version: '1.1',
            subscribe(fn) { if (typeof fn === 'function') listeners.add(fn); return () => listeners.delete(fn); },
            unsubscribe(fn) { listeners.delete(fn); },
            getMode() { return st.mode; },
            setMode: setMode,
            getPrices() { return st.prices; },
            priceOf(id, fallback) {
                if (st.mode !== 'market' || !st.loaded) return fallback;
                const p = st.prices.get(Number(id));
                return (p && p > 0) ? p : fallback;
            },
            hasPrice(id) {
                return st.mode === 'market' && st.loaded && (st.prices.get(Number(id)) > 0);
            },
            /* 有收购且税后净价高于系统出售价才算有效市场价 */
            isBetter(id, fallback) {
                if (st.mode !== 'market' || !st.loaded) return false;
                const p = st.prices.get(Number(id));
                const f = Number(fallback);
                return !!(p && p > 0) && (isFinite(f) ? p > f : true);
            },
            valueInfo(id, fallback) {
                const f0 = Number(fallback);
                const f = (isFinite(f0) && f0 > 0) ? f0 : 0;
                if (st.mode !== 'market' || !st.loaded) return { unit: f, better: false, hasMarket: false };
                const p = st.prices.get(Number(id));
                if (!(p && p > 0)) return { unit: f, better: false, hasMarket: false };
                return { unit: p, better: p > f, hasMarket: true };
            },
            status: status,
            ensure: ensure,
            ensureForMode() { return st.mode === 'market' ? ensure(false) : Promise.resolve(false); },
            refresh() { return ensure(true); },
            attach: attach,
            rebuild: rebuild
        };
    })();

    const state = {
        span: 60,
        mode: 'sell',
        data: null,
        market: {
            prices: new Map(),
            loaded: false,
            loading: false,
            error: false,
            lastRequest: 0,
            updatedAt: 0,
            count: 0,
            promise: null
        }
    };

    /* ── 格式化 ───────────────────────────────── */

    function fmt(n) {
        if (n == null || !isFinite(n)) return '—';
        const neg = n < 0;
        const abs = Math.abs(n);
        const s = (Math.round(abs * 100) / 100).toString();
        const parts = s.split('.');
        const ip = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        return (neg ? '-' : '') + ip + (parts[1] ? '.' + parts[1] : '');
    }

    function fmtUnit(n) {
        if (n == null || !isFinite(n)) return '—';
        const rounded = Math.round(n * 100) / 100;
        try {
            if (typeof Utils !== 'undefined' && typeof Utils.formatNumber === 'function') {
                return Utils.formatNumber(rounded, Utils.getNumberUnit());
            }
        } catch (e) { /* 回退 */ }
        const abs = Math.abs(rounded);
        const neg = rounded < 0;
        if (abs >= 1e8) return (neg ? '-' : '') + (abs / 1e8).toFixed(2) + ' 亿';
        if (abs >= 1e4) return (neg ? '-' : '') + (abs / 1e4).toFixed(2) + ' 万';
        return fmt(rounded);
    }

    /* 次数速率：小数保留 2 位，10 以上取整，过万走单位 */
    function fmtRate(n) {
        if (n == null || !isFinite(n)) return '—';
        const abs = Math.abs(n);
        if (abs >= 10000) return fmtUnit(n);
        if (abs >= 10) return fmt(Math.round(n));
        return fmt(n);
    }

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[c]);
    }

    function durationText(sec) {
        if (!isFinite(sec) || sec <= 0) return '—';
        const d = Math.floor(sec / 86400);
        const h = Math.floor((sec % 86400) / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = Math.round(sec % 60);
        const parts = [];
        if (d) parts.push(d + ' 天');
        if (h) parts.push(h + ' 小时');
        if (m) parts.push(m + ' 分');
        if (s || !parts.length) parts.push(s + ' 秒');
        return parts.join(' ');
    }

    function parseNum(text) {
        const n = Number(String(text == null ? '' : text).replace(/[^\d.-]/g, ''));
        return isFinite(n) ? n : 0;
    }

    /* ── 单位时间段设置 ───────────────────────── */

    function loadSpan() {
        let v = 60;
        try {
            if (typeof Utils !== 'undefined' && typeof Utils.getData === 'function') {
                v = Utils.getData(KEY, 60);
            } else {
                v = localStorage.getItem(KEY);
                try { v = JSON.parse(v); } catch (e) { /* 原样使用 */ }
            }
        } catch (e) { /* ignore */ }
        v = Number(v);
        return SPANS.some(s => s.v === v) ? v : 60;
    }

    function saveSpan(v) {
        try {
            if (typeof Utils !== 'undefined' && typeof Utils.setData === 'function') {
                Utils.setData(KEY, v);
            } else {
                localStorage.setItem(KEY, String(v));
            }
        } catch (e) { /* ignore */ }
    }

    function currentSpan() {
        return SPANS.find(s => s.v === state.span) || SPANS[0];
    }

    /* ── 估值方式：统一由共享行情模块管理 ─────── */

    function market() {
        return window.__NK_MARKET__;
    }

    function loadMode() {
        const mk = market();
        return mk ? mk.getMode() : 'sell';
    }

    function saveMode(v) {
        const mk = market();
        if (mk) mk.setMode(v);
    }

    /* 把共享模块的状态镜像到本脚本，供 API / 状态栏使用 */
    function syncMarket() {
        const mk = market();
        if (!mk) return;
        const s = mk.status();
        state.mode = s.mode;
        state.market.loaded = s.loaded;
        state.market.loading = s.loading;
        state.market.error = s.error;
        state.market.count = s.count;
        state.market.updatedAt = s.updatedAt;
        state.market.lastRequest = s.lastRequest;
        state.market.prices = mk.getPrices();
    }

    function onMarketChange(reason) {
        syncMarket();
        updateSettingStatus();
        const sel = document.querySelector('.nkr-mode-select');
        if (sel) sel.value = state.mode;
        if (reason !== 'status') decorateAll();
    }

    market().subscribe(onMarketChange);

    /* ── 估值 ─────────────────────────────────── */

    function itemDef(id) {
        const n = parseInt(id, 10);
        if (typeof Data === 'undefined' || !Data.items) return null;
        return Data.items[n] || null;
    }

    /* 系统出售价：与资产统计助手一致，不可交易或没有 value 记 0 */
    function sellValue(def) {
        if (!def || !def.trade) return 0;
        const v = Number(def.value);
        return (isFinite(v) && v > 0) ? v : 0;
    }

    /* 统一估值信息：市场价已扣 2% 税；better 表示净价高于出售价 */
    function valueInfoOf(id) {
        const def = itemDef(id);
        const sell = sellValue(def);
        const mk = market();
        return mk ? mk.valueInfo(id, sell) : { unit: sell, better: false, hasMarket: false };
    }

    /* 角标、图标总价、DOM 兜底都走这里 */
    function itemValue(id) {
        return valueInfoOf(id).unit;
    }

    function updateSettingStatus() {
        const mk = market();
        const s = mk ? mk.status() : { mode: 'sell', loading: false, text: '' };
        const status = document.querySelector('.nkr-market-status');
        if (status) status.textContent = s.text;
        const btn = document.querySelector('.nkr-refresh-btn');
        if (btn) {
            btn.disabled = s.mode !== 'market' || s.loading;
            btn.title = s.mode !== 'market' ? '请先切换到市场价格' :
                s.loading ? '正在加载…' : '两次刷新间隔至少 30 秒（与其他助手共用）';
        }
    }

    function ensureMarket(force) {
        const mk = market();
        if (!mk) return Promise.resolve(false);
        const p = force ? mk.refresh() : mk.ensureForMode();
        return p.then(value => { syncMarket(); return value; });
    }

    function sumXp(xp) {
        if (!xp) return 0;
        let s = 0;
        Object.keys(xp).forEach(k => {
            const v = Number(xp[k]);
            if (isFinite(v)) s += v;
        });
        return s;
    }

    function metricsFromRecord(record) {
        const start = Number(record.start_time) * 1000;
        const end = record.end_time ? Number(record.end_time) * 1000 : Date.now();
        const duration = Math.max(0, (end - start) / 1000);
        const count = Number(record.count) || 0;
        const xp = sumXp(record.xp);

        let output = 0;
        let cost = 0;
        (record.add_items || []).forEach(it => {
            output += itemValue(it.item) * (Number(it.quantity) || 0);
        });
        (record.remove_items || []).forEach(it => {
            cost += itemValue(it.item) * (Number(it.quantity) || 0);
        });

        const factor = duration > 0 ? state.span / duration : 0;
        const net = output - cost;
        return {
            duration: duration,
            count: count,
            xp: xp,
            output: output,
            cost: cost,
            net: net,
            countRate: count * factor,
            xpRate: xp * factor,
            outputRate: output * factor,
            netRate: net * factor
        };
    }

    /* ── DOM 兜底解析 ─────────────────────────── */

    function parseDuration(text) {
        let sec = 0;
        const re = /(\d+(?:\.\d+)?)\s*(天|小时|分|秒)/g;
        let m;
        while ((m = re.exec(text))) {
            const v = parseFloat(m[1]);
            sec += v * (m[2] === '天' ? 86400 : m[2] === '小时' ? 3600 : m[2] === '分' ? 60 : 1);
        }
        return sec;
    }

    /* 图标 ID 反查物品 ID（处理 getItemIconId 的合并区间） */
    function resolveIconId(iconId) {
        if (typeof Data === 'undefined' || !Data.items) return iconId;
        if (Data.items[iconId]) return iconId;
        const groups = [[9601, 9605], [9611, 9614], [3500, 3599]];
        for (let g = 0; g < groups.length; g++) {
            const a = groups[g][0];
            const b = groups[g][1];
            if (iconId === a) {
                for (let id = a; id <= b; id++) {
                    if (Data.items[id]) return id;
                }
            }
        }
        return iconId;
    }

    /* 数量文本可能带 K/M/B/万/亿 等单位，解析时还原倍数 */
    function parseQuantityText(text) {
        const s = String(text == null ? '' : text).replace(/,/g, '').trim();
        const m = s.match(/^(-?\d+(?:\.\d+)?)\s*(万|亿|兆|京|K|M|B|T)?$/i);
        if (!m) return parseNum(s);
        const mult = {
            '万': 1e4, '亿': 1e8, '兆': 1e12, '京': 1e16,
            'K': 1e3, 'M': 1e6, 'B': 1e9, 'T': 1e12
        }[(m[2] || '').toUpperCase()] || 1;
        const v = parseFloat(m[1]) * mult;
        return isFinite(v) ? Math.round(v) : 0;
    }

    /* 优先从物品浮层状态读取精确物品与数量，退回图标/显示文本 */
    function itemInfoFromEl(el) {
        let itemId = 0;
        let quantity = null;
        const st = el._itemTooltipState;
        if (st && st.itemDef && st.itemDef.id != null) itemId = Number(st.itemDef.id);
        if (st && st.param && st.param.item && st.param.item.quantity != null) {
            const q = Number(st.param.item.quantity);
            if (isFinite(q)) quantity = q;
        }
        if (!itemId) {
            const icon = el.querySelector('.itemicon');
            if (icon) {
                const m = icon.className.match(/itemicon-(\d+)/);
                if (m) itemId = resolveIconId(Number(m[1]));
            }
        }
        if (quantity == null) {
            const qEl = el.querySelector('.item-quantity');
            quantity = qEl ? parseQuantityText(qEl.textContent) : 0;
        }
        const info = valueInfoOf(itemId);
        return {
            id: itemId, quantity: quantity,
            value: info.unit, unit: info.unit,
            better: info.better, hasMarket: info.hasMarket
        };
    }

    function metricsFromDom(el) {
        const nameEl = el.querySelector('.record-name');
        const nameText = nameEl ? nameEl.textContent : '';
        const count = Number((nameText.match(/\((\d+)\s*次\)/) || [])[1]) || 0;

        let duration = 0;
        const spans = el.querySelectorAll('.action-item-container-value span');
        for (let i = 0; i < spans.length; i++) {
            if (spans[i].textContent.indexOf('持续时间') !== -1) {
                duration = parseDuration(spans[i].textContent);
                break;
            }
        }

        let output = 0;
        let cost = 0;
        let xp = 0;
        el.querySelectorAll('.record-action-item').forEach(group => {
            const titleEl = group.querySelector('.modal-container-title');
            const title = titleEl ? titleEl.textContent.trim() : '';
            if (title.indexOf('获得物品') !== -1) {
                group.querySelectorAll('.record-items .item').forEach(it => {
                    const info = itemInfoFromEl(it);
                    output += info.value * info.quantity;
                });
            } else if (title.indexOf('消耗物品') !== -1) {
                group.querySelectorAll('.record-items .item').forEach(it => {
                    const info = itemInfoFromEl(it);
                    cost += info.value * info.quantity;
                });
            } else if (title.indexOf('获得经验') !== -1) {
                group.querySelectorAll('.action-item-container').forEach(row => {
                    if (row.querySelector('.action-icon-exp')) {
                        const v = row.querySelector('.action-item-container-value span');
                        xp += parseNum(v && v.textContent);
                    }
                });
            }
        });

        const factor = duration > 0 ? state.span / duration : 0;
        const net = output - cost;
        return {
            duration: duration,
            count: count,
            xp: xp,
            output: output,
            cost: cost,
            net: net,
            countRate: count * factor,
            xpRate: xp * factor,
            outputRate: output * factor,
            netRate: net * factor
        };
    }

    /* 记录内物品图标左上角的总价估值 */
    function decorateItemValues(cardEl) {
        cardEl.querySelectorAll('.record-items .item').forEach(itemEl => {
            const info = itemInfoFromEl(itemEl);
            const total = info.value * info.quantity;

            let tag = itemEl.querySelector('.nkr-item-value');
            if (!tag) {
                tag = document.createElement('div');
                itemEl.appendChild(tag);
            }
            tag.className = 'nkr-item-value' + (total > 0 ? '' : ' nkr-zero') + (info.better ? ' nkr-market' : '');
            tag.textContent = fmtUnit(total);

            let unitTag = itemEl.querySelector('.nkr-unit-price');
            if (info.better) {
                if (!unitTag) {
                    unitTag = document.createElement('div');
                    itemEl.appendChild(unitTag);
                }
                unitTag.className = 'nkr-unit-price';
                unitTag.textContent = fmtUnit(info.unit);
            } else if (unitTag) {
                unitTag.remove();
            }
        });
    }

    /* ── 角标 ─────────────────────────────────── */

    function decorateItem(el, m) {
        if (!el || !m) return;
        const titleRow = el.querySelector('.record-action-item');
        if (!titleRow) return;

        titleRow.classList.add('nkr-title-row');
        let badge = titleRow.querySelector('.nkr-badge');
        if (!badge) {
            badge = document.createElement('div');
            badge.className = 'nkr-badge';
            titleRow.appendChild(badge);
        }

        const sp = currentSpan();
        const suffix = '/' + sp.short;
        const rows = [
            ['次数', fmtRate(m.countRate) + suffix, ''],
            ['经验', fmtUnit(m.xpRate) + suffix, ''],
            ['收益', fmtUnit(m.outputRate) + suffix, 'nkr-gold']
        ];
        /* 有消耗时才单独列出净收益，避免与收益重复 */
        if (m.cost > 0) {
            rows.push(['净收益', fmtUnit(m.netRate) + suffix, m.netRate < 0 ? 'nkr-neg' : 'nkr-gold']);
        }
        badge.innerHTML = rows.map(row =>
            '<div class="nkr-k">' + esc(row[0]) + '</div>' +
            '<div class="nkr-v' + (row[2] ? ' ' + row[2] : '') + '">' + esc(row[1]) + '</div>'
        ).join('');

        badge.title = [
            '统计单位：每 ' + sp.label,
            '记录时长：' + durationText(m.duration),
            '执行次数：' + fmt(m.count) + ' 次 → ' + fmtRate(m.countRate) + ' 次/' + sp.short,
            '获得经验：' + fmt(m.xp) + ' → ' + fmtUnit(m.xpRate) + '/' + sp.short,
            '产出价值：' + fmt(m.output) + ' 喵点 → ' + fmtUnit(m.outputRate) + '/' + sp.short,
            '消耗价值：' + fmt(m.cost) + ' 喵点',
            '净收益：' + fmt(m.net) + ' 喵点 → ' + fmtUnit(m.netRate) + '/' + sp.short,
            '估值方式：' + (state.mode === 'market' ? '市场收购价（税后）' : '系统出售价'),
            '估值口径：' + (state.mode === 'market'
                ? '收购价×98%（+0 优先，否则取有收购等级的最低价；无收购或行情不可用时回退出售价；净价高于出售价时图标标签变绿并显示净价数字）'
                : '直接售卖价'),
            '不可交易物品记 0；收益为产出物品价值，净收益已扣除消耗物品价值'
        ].join('\n');

        decorateItemValues(el);
    }

    function decorateAll() {
        const pages = document.querySelectorAll('.record-page');
        if (!pages.length) return false;
        const page = pages[pages.length - 1];
        const list = page.querySelector('.record-list');
        if (!list) return false;
        const items = list.querySelectorAll('.record-item');
        if (!items.length) return false;

        const data = state.data;
        if (data) {
            const recs = [];
            if (data.current) recs.push(data.current);
            if (Array.isArray(data.records)) recs.push.apply(recs, data.records);
            if (recs.length === items.length) {
                for (let i = 0; i < items.length; i++) {
                    decorateItem(items[i], metricsFromRecord(recs[i]));
                }
                return true;
            }
        }

        items.forEach(el => decorateItem(el, metricsFromDom(el)));
        return true;
    }

    /* ── 设置栏 ───────────────────────────────── */

    function buildSetting() {
        const sec = document.createElement('div');
        sec.className = 'neon-section nkr-setting';
        sec.innerHTML = `
            <div class="section-title">历史记录估值</div>
            <div class="setting-item">
                <div class="setting-name">单位时间段</div>
                <div class="setting-input">
                    <select class="nkr-span-select">
                        ${SPANS.map(s => '<option value="' + s.v + '">' + esc(s.label) + '</option>').join('')}
                    </select>
                </div>
            </div>
            <div class="setting-item">
                <div class="setting-name">估值方式</div>
                <div class="setting-input">
                    <select class="nkr-mode-select">
                        <option value="sell">出售价格</option>
                        <option value="market">市场价格</option>
                    </select>
                </div>
                <button class="btn nkr-refresh-btn" type="button">刷新行情</button>
            </div>
            <div class="nkr-market-status"></div>
            <div class="nkr-hint">日志卡片右上角显示每单位时间段的执行次数、获得经验与收益；有消耗的记录会额外显示净收益。记录内物品图标左上角显示总价；净价高于出售价时标签变绿，并在左下角只显示净价数字。市场价格按收购价扣 2% 税计算（+0 优先，否则取有收购等级的最低价；无收购或行情不可用时回退出售价），不可交易物品记 0。行情与资产统计助手共用，只拉一次，手动刷新间隔至少 30 秒。</div>
        `;
        const sel = sec.querySelector('.nkr-span-select');
        sel.value = String(state.span);
        sel.addEventListener('change', () => {
            const v = Number(sel.value);
            state.span = SPANS.some(s => s.v === v) ? v : 60;
            saveSpan(state.span);
            decorateAll();
        });

        const modeSel = sec.querySelector('.nkr-mode-select');
        modeSel.value = state.mode;
        modeSel.addEventListener('change', () => {
            saveMode(modeSel.value);
        });

        sec.querySelector('.nkr-refresh-btn').addEventListener('click', () => {
            ensureMarket(true);
        });
        updateSettingStatus();
        return sec;
    }

    function injectSetting(page) {
        if (!page || typeof page.querySelector !== 'function') return;
        const content = page.querySelector('.setting-content');
        if (!content || content.querySelector('.nkr-setting')) return;
        content.appendChild(buildSetting());
        updateSettingStatus();
    }

    /* ── 挂钩 ─────────────────────────────────── */

    function wrapRecordList() {
        if (typeof UI === 'undefined' || typeof UI.updateRecordList !== 'function') return false;
        if (UI.updateRecordList.__nkr) return true;

        const orig = UI.updateRecordList;
        const wrapped = function (data) {
            const result = orig.apply(this, arguments);
            try {
                state.data = data;
                decorateAll();
            } catch (err) {
                console.warn(TAG, '装饰日志失败', err);
            }
            return result;
        };
        wrapped.__nkr = true;
        UI.updateRecordList = wrapped;
        return true;
    }

    function wrapSetting() {
        if (typeof UI === 'undefined' || typeof UI.updateSettingPage !== 'function') return false;
        if (UI.updateSettingPage.__nkr) return true;

        const orig = UI.updateSettingPage;
        const wrapped = function (type, page) {
            const result = orig.apply(this, arguments);
            try {
                if (type === 'other') injectSetting(page);
            } catch (err) {
                console.warn(TAG, '注入设置栏失败', err);
            }
            return result;
        };
        wrapped.__nkr = true;
        UI.updateSettingPage = wrapped;
        return true;
    }

    /* 脚本加载时设置页已经打开 */
    function scanSetting() {
        const contents = document.querySelectorAll('.setting-page .setting-content');
        let target = null;
        contents.forEach(c => {
            if (c.querySelector('.redeem-code')) target = c;
        });
        if (!target) return false;
        if (!target.querySelector('.nkr-setting')) {
            target.appendChild(buildSetting());
            updateSettingStatus();
        }
        return true;
    }

    /* ── 样式 ─────────────────────────────────── */

    function injectCSS() {
        if (document.getElementById('nkr-style')) return;
        const st = document.createElement('style');
        st.id = 'nkr-style';
        st.textContent = `
.nkr-title-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 4px 8px; flex-wrap: wrap; }
.nkr-title-row .record-name { min-width: 0; }
.nkr-badge { display: grid; grid-template-columns: auto auto; gap: 1px 6px; padding: 3px 7px; border-radius: 5px; background: rgba(var(--r), var(--g), var(--b), .08); border: 1px solid rgba(var(--r), var(--g), var(--b), .16); font-size: 11px; line-height: 1.45; text-align: right; white-space: nowrap; flex: 0 0 auto; margin-left: auto; max-width: 100%; }
.nkr-k { opacity: .55; }
.nkr-v { font-weight: 600; color: #74F9BC; font-variant-numeric: tabular-nums; }
.nkr-v.nkr-gold { color: #F7D732; }
.nkr-v.nkr-neg { color: #F74A82; }
.nkr-item-value { position: absolute; left: 0; top: 0; z-index: 11; max-width: 50px; overflow: hidden; white-space: nowrap; height: 14px; padding: 2px 4px; box-sizing: content-box; border-radius: 0 0 6px 0; box-shadow: 0 4px 8px var(--c-mask-dim); line-height: 14px; background: rgba(254, 221, 51, .5); color: #FFFFFF; font-size: 12px; font-weight: 700; text-shadow: unset; pointer-events: none; }
.nkr-item-value.nkr-zero { opacity: .75; }
.nkr-item-value.nkr-market { background: rgba(116, 249, 188, .5); }
.nkr-unit-price { position: absolute; left: 0; bottom: 0; z-index: 11; max-width: 44px; overflow: hidden; white-space: nowrap; padding: 1px 3px; box-sizing: border-box; border-radius: 0 5px 0 0; background: rgba(0, 0, 0, .58); color: #FFFFFF; font-size: 10px; line-height: 12px; font-weight: 600; text-shadow: unset; pointer-events: none; }
.small-icon .nkr-item-value { max-width: 24px; height: 12px; line-height: 12px; padding: 1px 3px; font-size: 10px; border-radius: 0 0 4px 0; }
.small-icon .nkr-unit-price { max-width: 28px; padding: 1px 2px; font-size: 9px; line-height: 11px; border-radius: 0 3px 0 0; }
.nkr-setting .nkr-hint { font-size: 11px; opacity: .55; line-height: 1.5; }
.nkr-setting .setting-item { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.nkr-setting .setting-name { flex: 0 0 auto; }
.nkr-setting .setting-input { flex: 1 1 130px; min-width: 0; max-width: 220px; }
.nkr-span-select, .nkr-mode-select { width: 100%; min-width: 0; background: rgba(0, 0, 0, .35); border: 1px solid rgba(var(--r), var(--g), var(--b), .3); border-radius: 4px; color: inherit; padding: 5px 8px; font-size: 13px; font-family: inherit; outline: none; }
.nkr-span-select:focus, .nkr-mode-select:focus { border-color: #74F9BC; }
.nkr-refresh-btn { flex: 0 0 auto; padding: 5px 10px; font-size: 12px; cursor: pointer; }
.nkr-refresh-btn:disabled { opacity: .4; cursor: default; }
.nkr-market-status { font-size: 11px; opacity: .7; line-height: 1.5; min-height: 16px; }
@media (max-width: 640px) {
    .nkr-badge { font-size: 10px; padding: 2px 5px; }
}
`;
        document.head.appendChild(st);
    }

    /* ── 启动 ─────────────────────────────────── */

    injectCSS();

    function boot() {
        const a = wrapRecordList();
        const b = wrapSetting();
        if (a && b) {
            state.span = loadSpan();
            const mk = market();
            mk.attach();
            syncMarket();
            /* 若游戏已有行情缓存，直接复用，不发请求 */
            if (state.mode === 'market') mk.rebuild();
            scanSetting();
            if (document.querySelector('.record-page')) decorateAll();
            return true;
        }
        return false;
    }

    let bootTimer = setInterval(() => {
        if (boot()) {
            clearInterval(bootTimer);
            bootTimer = null;
        }
    }, BOOT_MS);

    if (boot()) {
        clearInterval(bootTimer);
        bootTimer = null;
    }

    window.__NK_RECORDVALUE__ = {
        version: VERSION,
        decorate: decorateAll,
        getSpan: () => state.span,
        getMode: () => state.mode,
        getMarketStatus: () => ({
            loaded: state.market.loaded,
            loading: state.market.loading,
            error: state.market.error,
            count: state.market.count,
            updatedAt: state.market.updatedAt,
            lastRequest: state.market.lastRequest,
            text: market().status().text
        }),
        refreshMarket: () => ensureMarket(true)
    };

    console.log(TAG, 'v' + VERSION + ' 已加载（只读）');
})();
/* ==================== 模块 4：通用功能与设置栏目 ==================== */
(function () {
    'use strict';

    const VERSION = '2.2.4';
    const TAG = '[通用功能]';
    const AUTO_KEY = 'nkgu_auto_market_day';
    const UPDATE_URL = 'https://raw.githubusercontent.com/keratin98/nekoidle-tools/main/%E4%BC%B0%E5%80%BC%E5%B7%A5%E8%89%BA_v2.2.4.user.js';
    const BOOT_MS = 500;

    if (window.__NK_GUJI_UPDATE__) {
        console.warn(TAG, '已经加载过，跳过这一次重复注入');
        return;
    }

    const state = {
        sec: null,
        autoText: '首次进入行情：等待游戏数据…',
        updateText: '更新检查由 Tampermonkey 自动完成'
    };
    let autoAttempts = 0;
    const AUTO_MAX_ATTEMPTS = 3;

    function pad(n) { return n < 10 ? '0' + n : String(n); }

    function dayKey() {
        const d = new Date();
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    }

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[c]);
    }

    function setAutoText(text) {
        state.autoText = text;
        const el = state.sec && state.sec.querySelector('.nkgu-auto-status');
        if (el) el.textContent = text;
    }

    function setUpdateText(text) {
        state.updateText = text;
        const el = state.sec && state.sec.querySelector('.nkgu-status');
        if (el) el.textContent = text;
    }

    function market() {
        return window.__NK_MARKET__ || null;
    }

    function gameReady() {
        try {
            return !!(typeof UI !== 'undefined' && UI.game &&
                typeof UI.game.loadMarketCache === 'function');
        } catch (e) { return false; }
    }

    /* 每个自然日首次进入游戏自动刷新一次；首次为空不算成功，延迟重试；掉线重连不会重新执行脚本 */
    function autoRefresh(force) {
        let marked = '';
        try { marked = localStorage.getItem(AUTO_KEY) || ''; } catch (e) { /* ignore */ }
        if (!force && marked === dayKey()) {
            setAutoText('首次进入行情：今日已刷新');
            return true;
        }
        if (!gameReady()) return false;

        const mk = market();
        if (!mk || typeof mk.refresh !== 'function') {
            setAutoText('首次进入行情：行情模块未就绪，可手动刷新');
            return false;
        }

        setAutoText('首次进入行情：正在刷新…');
        let settled = false;
        const finish = ok => {
            if (settled) return;
            settled = true;
            if (ok) {
                autoAttempts = 0;
                try { localStorage.setItem(AUTO_KEY, dayKey()); } catch (e) { /* ignore */ }
                setAutoText('首次进入行情：已刷新 · ' + new Date().toLocaleTimeString());
                return;
            }
            setAutoText('首次进入行情：行情为空，稍后自动重试');
            if (autoAttempts < AUTO_MAX_ATTEMPTS) {
                autoAttempts++;
                setTimeout(() => autoRefresh(false), 3000);
            } else {
                setAutoText('首次进入行情：刷新失败，可点击「刷新行情」重试');
            }
        };

        try {
            Promise.resolve(mk.refresh()).then(() => {
                const st = (mk && typeof mk.status === 'function') ? mk.status() : null;
                finish(!!(st && st.loaded && !st.error && st.cacheSize > 0));
            }, () => finish(false));
        } catch (e) {
            finish(false);
        }
        return true;
    }

    /* 更新检查交给 Tampermonkey：@updateURL 与 @downloadURL 均指向完整脚本，不在页面内自行抓版本 */
    function injectCSS() {
        if (document.getElementById('nkgu-style')) return;
        const st = document.createElement('style');
        st.id = 'nkgu-style';
        st.textContent = `
.nkgu-section { gap: 10px; }
.nkgu-section .setting-item { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.nkgu-section .setting-name { flex: 0 0 auto; }
.nkgu-section .setting-input { flex: 1 1 150px; min-width: 0; max-width: 320px; }
.nkgu-current { color: #74F9BC; font-weight: 600; font-variant-numeric: tabular-nums; }
.nkgu-link { color: #74F9BC; font-size: 12px; word-break: break-all; }
.nkgu-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.nkgu-btn { display: inline-flex; align-items: center; padding: 5px 10px; font-size: 12px; cursor: pointer; text-decoration: none; }
.nkgu-btn:disabled { opacity: .4; cursor: default; }
.nkgu-status, .nkgu-auto-status { font-size: 11px; opacity: .7; line-height: 1.5; min-height: 16px; }
.nkgu-hint { font-size: 11px; opacity: .55; line-height: 1.6; }
`;
        document.head.appendChild(st);
    }

    function buildSection() {
        const sec = document.createElement('div');
        sec.className = 'neon-section nkgu-section';
        sec.innerHTML = `
            <div class="section-title">检查更新</div>
            <div class="setting-item">
                <div class="setting-name">当前版本</div>
                <div class="setting-input nkgu-current">v${VERSION}</div>
            </div>
            <div class="setting-item">
                <div class="setting-name">更新方式</div>
                <div class="setting-input nkgu-hint">Tampermonkey 自动检查</div>
            </div>
            <div class="setting-item">
                <div class="setting-name">脚本地址</div>
                <div class="setting-input"><a class="nkgu-link" href="${UPDATE_URL}" target="_blank" rel="noopener">${UPDATE_URL}</a></div>
            </div>
            <div class="nkgu-actions">
                <a class="btn nkgu-btn" href="${UPDATE_URL}" target="_blank" rel="noopener">打开脚本地址</a>
            </div>
            <div class="nkgu-status"></div>
            <div class="nkgu-auto-status"></div>
            <div class="nkgu-hint">@updateURL 与 @downloadURL 均指向上面的完整脚本文件，更新检查由 Tampermonkey 按其设置自动完成；也可在 Tampermonkey 控制台 → 已安装脚本 → 检查更新手动触发。更新后刷新游戏页生效。首次进入游戏会按自然日自动刷新一次行情；掉线重连不会触发。</div>
        `;
        setAutoText(state.autoText);
        setUpdateText(state.updateText);
        return sec;
    }

    function injectInto(page) {
        if (!page || typeof page.querySelector !== 'function') return;
        const content = page.querySelector('.setting-content');
        if (!content || content.querySelector('.nkgu-section')) return;
        const sec = buildSection();
        content.appendChild(sec);
        state.sec = sec;
        setAutoText(state.autoText);
        setUpdateText(state.updateText);
    }

    function wrapSetting() {
        if (typeof UI === 'undefined' || typeof UI.updateSettingPage !== 'function') return false;
        if (UI.updateSettingPage.__nkgu) return true;
        const orig = UI.updateSettingPage;
        const wrapped = function (type, page) {
            const result = orig.apply(this, arguments);
            try {
                if (type === 'other') injectInto(page);
            } catch (err) {
                console.warn(TAG, '注入检查更新栏目失败', err);
            }
            return result;
        };
        wrapped.__nkgu = true;
        UI.updateSettingPage = wrapped;
        return true;
    }

    function scanSetting() {
        const contents = document.querySelectorAll('.setting-page .setting-content');
        let target = null;
        contents.forEach(c => {
            if (c.querySelector('.redeem-code')) target = c;
        });
        if (!target) return false;
        injectInto(target);
        return true;
    }

    injectCSS();

    let attempts = 0;
    function boot() {
        const wrapped = wrapSetting();
        const auto = autoRefresh(false);
        scanSetting();
        return wrapped && auto;
    }

    if (!boot()) {
        const bootTimer = setInterval(() => {
            attempts++;
            if (boot() || attempts >= 120) {
                clearInterval(bootTimer);
                if (attempts >= 120) setAutoText('首次进入行情：游戏数据未就绪，可手动刷新');
            }
        }, BOOT_MS);
    }

    window.__NK_GUJI_UPDATE__ = {
        version: VERSION,
        scan: scanSetting,
        autoRefresh: force => autoRefresh(!!force),
        getStatus: () => ({ auto: state.autoText, update: state.updateText })
    };

    console.log(TAG, 'v' + VERSION + ' 已加载（只读）');
})();
/* ==================== 模块 5：市场收购价显示 ==================== */
(function () {
    'use strict';

    const VERSION = '2.2.4';
    const TAG = '[市场收购价]';
    const AUTO_MS = 5 * 60 * 1000;
    const BOOT_MS = 500;

    if (window.__NK_MARKET_PRICE__) {
        console.warn(TAG, '已经加载过，跳过这一次重复注入');
        return;
    }

    let rawMin = new Map();
    let attempts = 0;
    let marketRetryPending = false;
    let observer = null;
    let observedRoot = null;

    function market() {
        return window.__NK_MARKET__ || null;
    }

    function game() {
        try {
            return (typeof UI !== 'undefined' && UI.game) ? UI.game : null;
        } catch (e) { return null; }
    }

    function fmtFull(n) {
        const v = Number(n);
        if (!isFinite(v)) return '0';
        return v.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
    }

    function fmtUnit(n) {
        const v = Number(n);
        if (!(v > 0) || !isFinite(v)) return '';
        try {
            if (typeof Utils !== 'undefined' && typeof Utils.formatNumber === 'function') {
                const unit = (typeof Utils.getNumberUnit === 'function') ? Utils.getNumberUnit() : false;
                return Utils.formatNumber(v, unit);
            }
        } catch (e) { /* 回退到下面 */ }
        if (v >= 100000000) return (v / 100000000).toFixed(1) + '亿';
        if (v >= 10000) return (v / 10000).toFixed(1) + '万';
        const rounded = Math.round(v * 100) / 100;
        return String(rounded);
    }

    /* 原始最低收购价：所有有求购量的等级中取最低 demand_price，不扣税 */
    function rebuildRaw() {
        rawMin = new Map();
        const g = game();
        if (!g || !g.marketCacheData || typeof g.marketCacheData.forEach !== 'function') {
            decorateMarket();
            return false;
        }

        g.marketCacheData.forEach((snapshot, key) => {
            const levels = snapshot && Array.isArray(snapshot.levels) ? snapshot.levels : [];
            let lowest = 0;
            for (let i = 0; i < levels.length; i++) {
                const level = levels[i] || {};
                const qty = Number(level.demand_qty);
                const price = Number(level.demand_price);
                if (!(qty > 0) || !(price > 0)) continue;
                if (!(lowest > 0) || price < lowest) lowest = price;
            }
            if (lowest > 0) rawMin.set(Number(key), lowest);
        });

        decorateMarket();
        return true;
    }

    function itemIdOf(el) {
        const st = el && el._itemTooltipState;
        if (st && st.itemDef && st.itemDef.id != null) return Number(st.itemDef.id);
        const paramId = st && st.param && st.param.item && st.param.item.id;
        return paramId == null ? null : Number(paramId);
    }

    function decorateMarket() {
        const grids = document.querySelectorAll('.marketplace-page .marketplace-grid');
        grids.forEach(grid => {
            grid.querySelectorAll('.marketplace-item').forEach(el => {
                const id = itemIdOf(el);
                const price = (id == null) ? 0 : (rawMin.get(id) || 0);
                let tag = el.querySelector('.nkm-buy-price');
                if (!(price > 0)) {
                    if (tag) tag.remove();
                    return;
                }
                if (!tag) {
                    tag = document.createElement('div');
                    el.appendChild(tag);
                }
                const text = fmtUnit(price);
                const title = '最低收购价：' + fmtFull(price) + ' 喵点（原始价，未扣 2% 税）';
                if (tag.className !== 'nkm-buy-price') tag.className = 'nkm-buy-price';
                if (tag.textContent !== text) tag.textContent = text;
                if (tag.title !== title) tag.title = title;
            });
        });
    }

    /* 只在行情为空/失败时补一次 bulk 刷新，不逐物品请求 */
    function ensureMarketData() {
        const mk = market();
        if (!mk || typeof mk.refresh !== 'function') return;
        const st = (typeof mk.status === 'function') ? mk.status() : null;
        if (st && st.loaded && !st.error && st.cacheSize > 0) return;
        if (marketRetryPending) return;
        marketRetryPending = true;
        try {
            Promise.resolve(mk.refresh()).then(() => {
                marketRetryPending = false;
                rebuildRaw();
                decorateMarket();
            }, () => { marketRetryPending = false; });
        } catch (e) {
            marketRetryPending = false;
        }
    }

    /* 市场图标晚插入时自动补标签；只观察当前市场根节点 */
    function watchMarket() {
        const root = document.querySelector('.marketplace-page') || document.body;
        if (observer && observedRoot === root) return;
        if (observer) observer.disconnect();
        observedRoot = root;
        observer = new MutationObserver(() => {
            if (!document.querySelector('.marketplace-page')) return;
            decorateMarket();
        });
        observer.observe(root, { childList: true, subtree: true });
    }

    function wrapUI(name) {
        if (typeof UI === 'undefined' || typeof UI[name] !== 'function') return false;
        if (UI[name].__nkm) return true;
        const orig = UI[name];
        const wrapped = function () {
            const result = orig.apply(this, arguments);
            try {
                watchMarket();
                decorateMarket();
                ensureMarketData();
            } catch (err) {
                console.warn(TAG, '装饰市场图标失败', err);
            }
            return result;
        };
        wrapped.__nkm = true;
        UI[name] = wrapped;
        return true;
    }

    function injectCSS() {
        if (document.getElementById('nkm-style')) return;
        const st = document.createElement('style');
        st.id = 'nkm-style';
        st.textContent = `
.marketplace-grid .marketplace-item { position: relative; }
.nkm-buy-price { position: absolute; left: 0; bottom: 0; z-index: 11; max-width: 44px; overflow: hidden; white-space: nowrap; padding: 1px 3px; box-sizing: border-box; border-radius: 0 5px 0 0; background: rgba(116, 249, 188, .58); color: #FFFFFF; font-size: 10px; line-height: 12px; font-weight: 700; font-variant-numeric: tabular-nums; text-shadow: unset; pointer-events: none; }
.small-icon .nkm-buy-price { max-width: 28px; padding: 1px 2px; font-size: 9px; line-height: 11px; border-radius: 0 3px 0 0; }
`;
        document.head.appendChild(st);
    }

    function boot() {
        const a = wrapUI('updateMarketplaceList');
        const b = wrapUI('showMarketplaceFavorites');
        const c = wrapUI('updatePage');
        const mk = market();
        if (mk && typeof mk.subscribe === 'function') mk.subscribe(rebuildRaw);
        rebuildRaw();
        watchMarket();
        decorateMarket();
        ensureMarketData();
        return a && b && c;
    }

    injectCSS();

    if (!boot()) {
        const bootTimer = setInterval(() => {
            attempts++;
            if (boot() || attempts >= 120) clearInterval(bootTimer);
        }, BOOT_MS);
    }

    /* 行情每 5 分钟自动拉取一次；共享模块内部仍保留 30 秒手动节流与在途复用 */
    setInterval(() => {
        const mk = market();
        if (!mk || typeof mk.refresh !== 'function') return;
        try {
            Promise.resolve(mk.refresh()).then(() => {
                rebuildRaw();
                decorateMarket();
            }, () => { /* 失败时等待下一次自动刷新 */ });
        } catch (err) {
            console.warn(TAG, '自动刷新行情失败', err);
        }
    }, AUTO_MS);

    window.__NK_MARKET_PRICE__ = {
        version: VERSION,
        autoMs: AUTO_MS,
        rebuild: rebuildRaw,
        decorate: decorateMarket,
        ensureMarketData: ensureMarketData,
        getPrices: () => rawMin
    };

    console.log(TAG, 'v' + VERSION + ' 已加载（只读）');
})();
/* ==================== 合并入口 ==================== */
window.__NK_GUJI_GONGYI__ = {
    version: '2.2.4',
    craft: window.__NK_CRAFTLIMIT__ || null,
    assets: window.__NK_ASSETS__ || null,
    record: window.__NK_RECORDVALUE__ || null,
    market: window.__NK_MARKET__ || null,
    update: window.__NK_GUJI_UPDATE__ || null,
    marketPrice: window.__NK_MARKET_PRICE__ || null
};