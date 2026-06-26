// ==UserScript==
// @name         TornCashflow
// @namespace    torn-cashflow-ledger
// @version      0.3.2
// @description  Running profit & loss ledger for Torn. Categorizes every money movement in/out (job, crimes, market, casino, travel, dividends, etc.) from your own API key, values item gains/losses at market price, and shows a live cashflow panel on the home page. Auto-syncs from api.torn.com on page load (hourly at most) plus a manual sync button. All data comes from api.torn.com only and is stored locally in your browser; nothing goes to third parties. TornPDA: set injection time to END.
// @author       AeC3
// @match        https://www.torn.com/*
// @grant        None
// @license      MIT
// @run-at       document-end
// ==/UserScript==

// NOTE: @updateURL / @downloadURL are added after the first Greasy Fork upload
// (they require the assigned script ID).

(function () {
  'use strict';

  // Only run on the home page (index.php or "/").
  if (!/^\/(index\.php)?$/.test(location.pathname)) return;

  // ---------------------------------------------------------------------------
  // Storage (GM fallback to localStorage; TornPDA has no GM_*).
  // ---------------------------------------------------------------------------
  const store = {
    get: (key, def) => {
      if (typeof GM_getValue === 'function') return GM_getValue(key, def);
      try {
        const v = localStorage.getItem('tcf_' + key);
        return v !== null ? JSON.parse(v) : def;
      } catch (e) { return def; }
    },
    set: (key, val) => {
      if (typeof GM_setValue === 'function') return GM_setValue(key, val);
      try { localStorage.setItem('tcf_' + key, JSON.stringify(val)); } catch (e) {}
    },
  };

  // ---------------------------------------------------------------------------
  // Config / constants
  // ---------------------------------------------------------------------------
  const API = 'https://api.torn.com/v2';
  // Bump when group labels / section classification change so stored movements
  // (which carry their group label) get cleared and re-backfilled cleanly.
  const SCHEMA = 2;
  const DAY = 86400;
  const BACKFILL_DAYS = 30;
  const CALL_GAP_MS = 700;        // stay under 100 calls/min
  const ITEM_CACHE_TTL = 6 * 3600; // refresh item prices every 6h
  const NW_SNAPSHOT_GAP = 12 * 3600; // one networth snapshot per ~12h

  // Money-bearing logtypes -> how to read the amount and classify it.
  // kind: 'income' | 'expense' | 'casino' | 'item'
  //   income/expense: read `field`, apply `sign`, count as cash.
  //   casino: read each [field, sign] in `fields`, net them (bet vs win).
  //   item:   read item id(s)+qty from a custom `items()` extractor, value at market.
  // Internal transfers (bank invest/withdraw, vault, trade money "add" steps,
  // stock buy/sell) are deliberately NOT listed: they move your own money around
  // without being profit or loss, so they would distort the ledger. Realised
  // stock gains/losses and unrealised drift are captured by networth snapshots.
  // Verified against one account's real 30-day log (June 2026); unseen types fall
  // through to the "uncategorized" bucket so nothing disappears silently.
  const LOGMAP = {
    // --- Crimes ---
    9015: { field: 'money_gained', sign: +1, group: 'Crimes' },
    9020: { kind: 'item', sign: +1, group: 'Crime loot', items: d => d.items_gained },
    // --- Attacking ---
    8156: { field: 'money_mugged', sign: +1, group: 'Mugging' },
    8166: { field: 'wanted_reward', sign: +1, group: 'Arrest rewards' },
    // --- Casino (net bet vs winnings) ---
    8300: { kind: 'casino', fields: [['won_amount', +1], ['bet_amount', -1]], group: 'Casino' },
    8301: { kind: 'casino', fields: [['bet_amount', -1]], group: 'Casino' },
    8340: { kind: 'casino', fields: [['cost', -1]], group: 'Casino' },
    8370: { kind: 'casino', fields: [['cost', -1]], group: 'Casino' },
    8374: { kind: 'casino', fields: [['money', +1]], group: 'Casino' },
    // --- Markets: buy = expense, sell = income ---
    1112: { field: 'cost_total', sign: -1, group: 'Item market' },
    1225: { field: 'cost_total', sign: -1, group: 'Bazaar buy' },
    1226: { field: 'cost_total', sign: +1, group: 'Bazaar sell' },
    4200: { field: 'cost_total', sign: -1, group: 'Shops' },
    4201: { field: 'cost_total', sign: -1, group: 'Travel goods' },
    5010: { field: 'cost_total', sign: -1, group: 'Points market' },
    // --- Trades: final movements only (the "add" steps are intermediate) ---
    4440: { field: 'money', sign: -1, group: 'Trades' },
    4441: { field: 'money', sign: +1, group: 'Trades' },
    // --- Direct money transfers ---
    4800: { field: 'money', sign: -1, group: 'Money sent' },
    4810: { field: 'money', sign: +1, group: 'Money received' },
    // --- Job / company ---
    6221: { field: 'pay', sign: +1, group: 'Job pay' },
    // --- Faction ---
    // 6736 = withdrawing your OWN money back out of the faction vault (already
    // in your net worth) — a pure internal move, not income. Only OC payouts
    // (6795) are real earnings.
    6736: { field: 'money_given', sign: +1, group: 'Faction vault (own money)' },
    6795: { field: 'balance_change', sign: +1, group: 'Faction payout' },
    // --- Stocks: only dividends are income (buy/sell handled by networth) ---
    5531: { field: 'money', sign: +1, group: 'Dividends' },
    5530: { kind: 'item', sign: +1, group: 'Dividends (items)', items: d => d.item },
    // --- Property rental income ---
    5937: { field: 'rent', sign: +1, group: 'Property rent' },
    // --- Consumption / fees ---
    5960: { field: 'cost', sign: -1, group: 'Education' },
    6005: { field: 'cost', sign: -1, group: 'Rehab' },
    5555: { field: 'value', sign: -1, group: 'Subscription' },
    // --- Item finds / transfers (valued at market) ---
    7011: { kind: 'item', sign: +1, group: 'Item finds', items: d => d.item },
    4103: { kind: 'item', sign: +1, group: 'Items received', items: d => d.items },
    4102: { kind: 'item', sign: -1, group: 'Items sent', items: d => d.items },
  };

  // Log categories that involve money — used to detect UNMAPPED money types so
  // we can surface them instead of dropping them.
  const MONEY_CATS = new Set([
    'Money', 'Money outgoing', 'Money incoming', 'Money sending', 'Item market',
    'Bazaars', 'Auctions', 'Shops', 'Points market', 'Token shop', 'Bank',
    'Offshore bank', 'Vault', 'Piggy bank', 'Loan', 'Checks', 'Stocks',
    'Property', 'Property rental', 'Upkeep', 'Estate agents', 'Company', 'Job',
    'Casino', 'Slots', 'Roulette', 'High-low', 'Keno', 'Craps', 'Lottery',
    'Blackjack', 'Spin the wheel', 'Russian roulette', 'Poker', 'Bookie',
    'Crimes', 'Organized crimes', 'Missions', 'Racing', 'Travel', 'Bounties',
    'Bail', 'Revive', 'Trades', 'Faction', 'Credits', 'Refills', 'City finds',
  ]);

  // ---------------------------------------------------------------------------
  // API client (api.torn.com only, rate-limited)
  // ---------------------------------------------------------------------------
  let lastCall = 0;
  async function apiGet(path) {
    const key = store.get('apikey', '');
    if (!key) throw new Error('No API key set');
    const wait = Math.max(0, CALL_GAP_MS - (Date.now() - lastCall));
    if (wait) await new Promise(r => setTimeout(r, wait));
    lastCall = Date.now();
    const sep = path.includes('?') ? '&' : '?';
    const res = await fetch(`${API}${path}${sep}key=${encodeURIComponent(key)}`);
    const json = await res.json();
    if (json && json.error) throw new Error(`API ${json.error.code}: ${json.error.error}`);
    return json;
  }

  // ---------------------------------------------------------------------------
  // Item price cache (torn/items market value)
  // ---------------------------------------------------------------------------
  async function getItemPrices() {
    const cache = store.get('itemcache', null);
    if (cache && (Date.now() / 1000 - cache._fetched) < ITEM_CACHE_TTL) return cache.prices;
    const data = await apiGet('/torn/items');
    const prices = {};
    const items = data.items || [];
    for (const it of items) {
      const mp = it.value && it.value.market_price;
      if (mp) prices[it.id] = mp;
    }
    store.set('itemcache', { _fetched: Math.floor(Date.now() / 1000), prices });
    return prices;
  }

  // Normalize an "item" data shape into [{id, qty}].
  function itemList(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw.map(x => ({ id: x.id, qty: x.qty || 1 }));
    if (typeof raw === 'object') return Object.entries(raw).map(([id, qty]) => ({ id: +id, qty }));
    if (typeof raw === 'number') return [{ id: raw, qty: 1 }];
    return [];
  }

  // ---------------------------------------------------------------------------
  // Convert a raw log entry into a stored movement, or null if not money.
  // Stored compactly: {t, g, c, items:[{id,qty}]}
  //   t = timestamp, g = group, c = signed cash amount, items = item movement
  // ---------------------------------------------------------------------------
  function toMovement(entry) {
    const id = entry.details && entry.details.id;
    const map = LOGMAP[id];
    const data = entry.data || {};
    if (!map) return null;
    if (map.kind === 'item') {
      const items = itemList(map.items(data)).map(x => ({ id: x.id, qty: x.qty, sign: map.sign }));
      if (!items.length) return null;
      return { t: entry.timestamp, g: map.group, c: 0, items };
    }
    if (map.kind === 'casino') {
      let c = 0;
      for (const [f, s] of map.fields) c += (Number(data[f]) || 0) * s;
      return { t: entry.timestamp, g: map.group, c };
    }
    const amount = Number(data[map.field]) || 0;
    if (!amount) return null;
    return { t: entry.timestamp, g: map.group, c: amount * map.sign };
  }

  // Track money-category logtypes we have NO mapping for (so we can show them).
  function recordUnmapped(entry) {
    const d = entry.details || {};
    if (LOGMAP[d.id]) return;
    if (!MONEY_CATS.has(d.category)) return;
    const um = store.get('unmapped', {});
    const k = String(d.id);
    if (!um[k]) um[k] = { title: d.title, category: d.category, count: 0 };
    um[k].count++;
    store.set('unmapped', um);
  }

  // ---------------------------------------------------------------------------
  // Sync: backfill 30 days, then incremental forward.
  // IMPORTANT: the API's `prev` cursor dies after ~500 entries, so we paginate
  // manually with &to=<oldest timestamp seen>. The `prev` link also omits the
  // key. Verified against real data.
  // ---------------------------------------------------------------------------
  let syncing = false;

  async function fetchLogPage(to) {
    const q = `/user/log?limit=100&sort=desc${to ? '&to=' + to : ''}`;
    const data = await apiGet(q);
    return data.log || [];
  }

  async function runSync(onProgress) {
    if (syncing) return;
    syncing = true;
    try {
      // Classification changed? Drop stored movements and force a full backfill
      // so historical entries are re-labelled under the current scheme.
      if (store.get('schema', 0) !== SCHEMA) {
        store.set('movements', []);
        store.set('sync', { newest: 0 });
      }
      const sync = store.get('sync', { newest: 0 });
      const movements = store.get('movements', []);
      const seenNewest = sync.newest || 0;
      const nowTs = Math.floor(Date.now() / 1000);
      const cutoff = nowTs - BACKFILL_DAYS * DAY;
      const collected = [];
      let to = 0;
      let calls = 0;
      let stop = false;
      let newNewest = seenNewest;

      while (!stop && calls < 400) {
        const page = await fetchLogPage(to);
        calls++;
        if (!page.length) break;
        for (const e of page) {
          if (e.timestamp > newNewest) newNewest = e.timestamp;
          // Incremental: stop once we reach entries we already have.
          if (seenNewest && e.timestamp <= seenNewest) { stop = true; continue; }
          recordUnmapped(e);
          const m = toMovement(e);
          if (m) collected.push(m);
        }
        const oldest = page[page.length - 1].timestamp;
        if (!seenNewest && oldest <= cutoff) break; // backfill done
        if (oldest <= cutoff) break;                // safety
        to = oldest;
        if (onProgress) onProgress(calls, oldest);
      }

      // Merge + prune to BACKFILL window.
      const merged = movements.concat(collected).filter(m => m.t >= cutoff);
      merged.sort((a, b) => a.t - b.t);
      store.set('movements', merged);
      store.set('sync', { newest: newNewest, lastRun: nowTs, calls });
      store.set('schema', SCHEMA);

      // Networth snapshot (for unrealised P&L).
      await maybeSnapshotNetworth(nowTs);
      // Bank interest (current accrued profit).
      await refreshBankProfit();
      // Refresh item prices opportunistically.
      try { await getItemPrices(); } catch (e) {}
    } finally {
      syncing = false;
    }
  }

  async function maybeSnapshotNetworth(nowTs) {
    const snaps = store.get('networth', []);
    const last = snaps[snaps.length - 1];
    if (last && (nowTs - last.t) < NW_SNAPSHOT_GAP) return;
    const data = await apiGet('/user/networth');
    const nw = data.networth || {};
    snaps.push({ t: nowTs, total: nw.total || 0 });
    // keep ~90 days of snapshots
    const keep = snaps.filter(s => s.t >= nowTs - 90 * DAY);
    store.set('networth', keep);
  }

  async function refreshBankProfit() {
    try {
      const data = await apiGet('/user/money');
      const cb = data.money && data.money.city_bank;
      if (cb) store.set('bankprofit', { profit: cb.profit || 0, until: cb.until || 0, t: Math.floor(Date.now() / 1000) });
    } catch (e) {}
  }

  // ---------------------------------------------------------------------------
  // Aggregation for a period (seconds back from now).
  // ---------------------------------------------------------------------------
  // Which section each group belongs to:
  //   earn     = genuine value created by gameplay (counts toward profit)
  //   spend    = genuine value consumed (counts toward profit, negative)
  //   transfer = value just MOVED, not created/destroyed — EXCLUDED from profit.
  //              Covers player<->player money, your own faction-balance payouts,
  //              and cash<->asset conversions (all item/market/bazaar/points
  //              buying AND selling). Trading profit shows up in net-worth delta
  //              instead, so counting either side here would over/understate.
  const GROUP_SECTION = {
    'Crimes': 'earn', 'Crime loot': 'earn', 'Mugging': 'earn', 'Arrest rewards': 'earn',
    'Casino': 'earn', 'Job pay': 'earn', 'Faction payout': 'earn', 'Dividends': 'earn',
    'Dividends (items)': 'earn', 'Property rent': 'earn', 'Item finds': 'earn',
    'Education': 'spend', 'Rehab': 'spend', 'Subscription': 'spend',
    'Item market': 'spend', 'Shops': 'spend', 'Bazaar buy': 'spend',
    'Bazaar sell': 'earn',
    'Faction vault (own money)': 'transfer', 'Money sent': 'transfer', 'Money received': 'transfer',
    'Trades': 'transfer', 'Travel goods': 'transfer', 'Points market': 'transfer',
    'Items received': 'transfer', 'Items sent': 'transfer',
  };

  function aggregate(periodSec) {
    const now = Math.floor(Date.now() / 1000);
    const from = now - periodSec;
    const movements = store.get('movements', []).filter(m => m.t >= from);
    const prices = (store.get('itemcache', {}) || {}).prices || {};

    // Net value per group. ALIAS merges renamed groups so movements stored
    // under an old label still land on the current one.
    const ALIAS = { 'Faction': 'Faction vault (own money)' };
    const groups = {};
    for (const m of movements) {
      let val = 0;
      if (m.items) {
        for (const it of m.items) val += (prices[it.id] || 0) * it.qty * it.sign;
      } else {
        val = m.c;
      }
      const g = ALIAS[m.g] || m.g;
      groups[g] = (groups[g] || 0) + val;
    }

    // Bucket groups into sections. Unknown groups default to 'transfer'
    // (conservative — never inflate profit with something unclassified).
    const sections = { earn: [], spend: [], transfer: [] };
    const sums = { earn: 0, spend: 0, transfer: 0 };
    for (const [g, net] of Object.entries(groups)) {
      const sec = GROUP_SECTION[g] || 'transfer';
      sections[sec].push([g, net]);
      sums[sec] += net;
    }
    for (const k of Object.keys(sections)) {
      sections[k].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    }

    // Net-worth-based total profit over the period (nearest earlier snapshot).
    const snaps = store.get('networth', []);
    let nwProfit = null;
    if (snaps.length) {
      const start = snaps.filter(s => s.t <= from).pop() || snaps[0];
      const end = snaps[snaps.length - 1];
      if (start && end && end.t > start.t) nwProfit = end.total - start.total;
    }

    return {
      sections, sums,
      netActivities: sums.earn + sums.spend, // profit-from-activities (excl. transfers)
      nwProfit, count: movements.length,
    };
  }

  // ---------------------------------------------------------------------------
  // UI (inline panel mounted at the top of the page content)
  // ---------------------------------------------------------------------------
  const PERIODS = [
    { label: 'Today', sec: DAY },
    { label: '7 days', sec: 7 * DAY },
    { label: '30 days', sec: 30 * DAY },
  ];
  let activePeriod = 2;

  function fmt(n) {
    const neg = n < 0;
    const s = '$' + Math.round(Math.abs(n)).toLocaleString('en-US');
    return neg ? '-' + s : s;
  }

  function injectStyle() {
    if (document.getElementById('tcf-style')) return;
    const css = `
      #tcf-panel{display:block;width:100%;max-width:640px;margin:0 auto 12px auto;box-sizing:border-box;
        background:#1c1c1c;color:#e8e8e8;font:12px/1.4 Arial,sans-serif;border:1px solid #444;
        border-radius:8px;box-shadow:0 2px 6px rgba(0,0,0,.3);overflow:hidden}
      #tcf-head{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;
        background:#262626;cursor:pointer;font-weight:bold}
      #tcf-head .tcf-title{color:#5ec46a}
      #tcf-body{padding:10px}
      #tcf-tabs{display:flex;gap:4px;margin-bottom:8px}
      #tcf-tabs button{flex:1;padding:4px;background:#2e2e2e;color:#ccc;border:1px solid #444;
        border-radius:4px;cursor:pointer}
      #tcf-tabs button.active{background:#3a5a3a;color:#fff;border-color:#5ec46a}
      .tcf-row{display:flex;justify-content:space-between;padding:2px 0;border-bottom:1px solid #2a2a2a}
      .tcf-grp{color:#bbb}
      .tcf-pos{color:#5ec46a}
      .tcf-neg{color:#e06a6a}
      .tcf-tot{margin-top:4px;padding-top:6px;border-top:1px solid #555;font-weight:bold}
      .tcf-sechead{margin-top:12px;margin-bottom:2px;font-weight:bold;color:#9ab;text-transform:uppercase;font-size:10px;letter-spacing:.5px}
      .tcf-headline{display:flex;justify-content:space-between;align-items:center;margin:4px 0 8px 0;
        padding:8px 10px;background:#202a20;border:1px solid #3a5a3a;border-radius:6px;font-size:14px;font-weight:bold}
      .tcf-headline.tcf-pending{display:block;color:#999;font-weight:normal;font-size:11px;background:#222;border-color:#444}
      .tcf-activities{border-top-width:2px}
      #tcf-foot{padding:8px 10px;background:#262626;font-size:11px;color:#999}
      #tcf-foot button{background:#3a5a3a;color:#fff;border:1px solid #5ec46a;border-radius:4px;
        padding:4px 8px;cursor:pointer;margin-right:6px}
      #tcf-key{width:100%;box-sizing:border-box;padding:6px;background:#111;color:#eee;
        border:1px solid #444;border-radius:4px;margin:6px 0}
      .tcf-collapsed #tcf-body,.tcf-collapsed #tcf-foot{display:none}
      .tcf-note{color:#888;font-size:10px;margin-top:6px}
    `;
    const style = document.createElement('style');
    style.id = 'tcf-style';
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  // Mount the panel at the TOP of the page content (normal flow, not sticky).
  // Uses a host-selector fallback chain so it doesn't depend on one exact node.
  function mountPanel() {
    let panel = document.getElementById('tcf-panel');
    if (panel && panel.isConnected) return panel;
    injectStyle();
    panel = document.createElement('div');
    panel.id = 'tcf-panel';
    const host = [
      document.querySelector('.content-wrapper'),
      document.querySelector('[role="main"]'),
      document.querySelector('#mainContainer'),
      document.querySelector('main'),
      document.querySelector('#react-root'),
      document.body,
    ].find(el => el !== null) || document.documentElement;
    host.insertBefore(panel, host.firstChild);
    return panel;
  }

  function render() {
    const panel = mountPanel();
    const collapsed = panel.classList.contains('tcf-collapsed');
    const hasKey = !!store.get('apikey', '');
    const sync = store.get('sync', {});

    if (!hasKey) {
      panel.innerHTML = `
        <div id="tcf-head"><span class="tcf-title">TornCashflow</span><span>v0.2.0</span></div>
        <div id="tcf-body">
          <div>Enter your Torn API key (reads log/money/networth only):</div>
          <input id="tcf-key" type="text" placeholder="API key" />
          <button id="tcf-save" style="width:100%;padding:6px;background:#3a5a3a;color:#fff;border:1px solid #5ec46a;border-radius:4px;cursor:pointer">Save & sync</button>
          <div class="tcf-note">The key is stored only locally in your browser. Data is fetched only from api.torn.com.</div>
        </div>`;
      document.getElementById('tcf-save').onclick = () => {
        const v = document.getElementById('tcf-key').value.trim();
        if (v) { store.set('apikey', v); render(); runSync().then(render); }
      };
      return;
    }

    const a = aggregate(PERIODS[activePeriod].sec);
    const bank = store.get('bankprofit', null);

    const groupRows = (list) => list.map(([g, net]) => `
      <div class="tcf-row"><span class="tcf-grp">${g}</span>
      <span class="${net >= 0 ? 'tcf-pos' : 'tcf-neg'}">${fmt(net)}</span></div>`).join('');

    const section = (title, list, totalLabel, total, cls) => {
      if (!list.length) return '';
      const totalRow = totalLabel ? `<div class="tcf-row tcf-tot"><span>${totalLabel}</span>
        <span class="${total >= 0 ? 'tcf-pos' : 'tcf-neg'} ${cls || ''}">${fmt(total)}</span></div>` : '';
      return `<div class="tcf-sechead">${title}</div>${groupRows(list)}${totalRow}`;
    };

    const tabs = PERIODS.map((p, i) =>
      `<button class="${i === activePeriod ? 'active' : ''}" data-i="${i}">${p.label}</button>`).join('');

    const lastRun = sync.lastRun ? new Date(sync.lastRun * 1000).toLocaleString('en-US') : 'never';

    // Headline = net-worth change (the only fully reliable profit number).
    const headline = a.nwProfit !== null
      ? `<div class="tcf-headline"><span>Net worth change</span>
         <span class="${a.nwProfit >= 0 ? 'tcf-pos' : 'tcf-neg'}">${fmt(a.nwProfit)}</span></div>`
      : `<div class="tcf-headline tcf-pending">Net worth change — needs 2+ daily snapshots (collecting…)</div>`;

    const bankLine = bank
      ? `<div class="tcf-row"><span class="tcf-grp">Accrued bank interest</span><span class="tcf-pos">${fmt(bank.profit)}</span></div>`
      : '';

    const hasAny = a.sections.earn.length || a.sections.spend.length || a.sections.transfer.length;

    panel.innerHTML = `
      <div id="tcf-head"><span class="tcf-title">TornCashflow</span><span>${collapsed ? '▲' : '▼'}</span></div>
      <div id="tcf-body">
        <div id="tcf-tabs">${tabs}</div>
        ${headline}
        ${hasAny ? '' : '<div class="tcf-note">No movements in this period. Run a sync.</div>'}
        ${section('Earnings', a.sections.earn, 'Earnings total', a.sums.earn)}
        ${section('Spending', a.sections.spend, 'Spending total', a.sums.spend)}
        ${hasAny ? `<div class="tcf-row tcf-tot tcf-activities"><span>Net from activities</span>
          <span class="${a.netActivities >= 0 ? 'tcf-pos' : 'tcf-neg'}">${fmt(a.netActivities)}</span></div>` : ''}
        ${bankLine}
        ${section('Transfers — not counted as profit', a.sections.transfer, null, 0)}
        <div class="tcf-note">Transfers are value you already own moving around — faction-vault money (already in net worth), points, money/items to-from other players. Not counted as profit. Net-worth change above is the reliable bottom line.</div>
      </div>
      <div id="tcf-foot">
        <button id="tcf-sync">${syncing ? 'Syncing…' : 'Sync now'}</button>
        <span>Last: ${lastRun}</span>
      </div>`;

    document.getElementById('tcf-head').onclick = () => {
      panel.classList.toggle('tcf-collapsed');
      render();
    };
    panel.querySelectorAll('#tcf-tabs button').forEach(b => {
      b.onclick = (e) => { e.stopPropagation(); activePeriod = +b.dataset.i; render(); };
    });
    const syncBtn = document.getElementById('tcf-sync');
    if (syncBtn) syncBtn.onclick = (e) => {
      e.stopPropagation();
      if (syncing) return;
      render();
      runSync().then(render).catch(err => { alert('TornCashflow: ' + err.message); render(); });
    };
  }

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  function init() {
    render();
    // Auto-sync on load if it's been a while (>1h) and a key exists.
    const sync = store.get('sync', {});
    const now = Math.floor(Date.now() / 1000);
    const schemaChanged = store.get('schema', 0) !== SCHEMA;
    if (store.get('apikey', '') && (schemaChanged || !sync.lastRun || now - sync.lastRun > 3600)) {
      runSync().then(render).catch(() => {});
    }
    // The home page is a React SPA: the content host may mount after us, and
    // re-renders can drop our panel. Re-mount if it ever goes missing.
    const keepAlive = new MutationObserver(() => {
      const p = document.getElementById('tcf-panel');
      if (!p || !p.isConnected) render();
    });
    if (document.body) keepAlive.observe(document.body, { childList: true, subtree: true });
  }

  if (document.body) init();
  else window.addEventListener('DOMContentLoaded', init);
})();
