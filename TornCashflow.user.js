// ==UserScript==
// @name         TornCashflow
// @namespace    torn-cashflow-ledger
// @version      0.5.2
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
  const VERSION = '0.5.2'; // keep in sync with @version above
  const API = 'https://api.torn.com/v2';
  // Bump when group labels / section classification change so stored movements
  // (which carry their group label) get cleared and re-backfilled cleanly.
  const SCHEMA = 9;
  const DAY = 86400;
  const BACKFILL_DAYS = 30;
  const CALL_GAP_MS = 1100;       // ~55/min — leaves headroom for your other scripts on the same key
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
    8155: { field: 'money_mugged', sign: +1, group: 'Mugging' },         // YOU mug someone (gain)
    8156: { field: 'money_mugged', sign: -1, group: 'Mugged by others' }, // you get mugged (loss)
    // 8166 "Attack arrest receive" = YOU get arrested; wanted_reward is the
    // bounty someone else claimed on you, not your money. Neutral → not mapped
    // (see IGNORE_IDS).
    // --- Casino: handled by category in toMovement (covers every game incl.
    //     high-low's pot mechanic), not by per-logtype rules here. ---
    // --- Markets: buy = expense, sell = income ---
    1112: { field: 'cost_total', sign: -1, group: 'Item market' },
    1225: { field: 'cost_total', sign: -1, group: 'Bazaar buy' },
    1226: { field: 'cost_total', sign: +1, group: 'Bazaar sell' },
    4200: { field: 'cost_total', sign: -1, group: 'Shops' },
    4201: { field: 'cost_total', sign: -1, group: 'Travel goods' },
    5010: { field: 'cost_total', sign: -1, group: 'Points market bought' },
    // Selling points to another player = cash in (field mirrors the verified
    // 5010 buy entry; not verified against a raw 5011 dump — confirm the total).
    5011: { field: 'cost_total', sign: +1, group: 'Points market sold' },
    // --- Trades: final movements only (the "add" steps are intermediate) ---
    4440: { field: 'money', sign: -1, group: 'Trades (out)' },
    4441: { field: 'money', sign: +1, group: 'Trades (in)' },
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
    // --- Stocks: dividends are income; buy/sell principal is your own money
    //     moving (transfer) — the gain/loss shows in net worth. ---
    5531: { field: 'money', sign: +1, group: 'Dividends' },
    5530: { kind: 'item', sign: +1, group: 'Dividends (items)', items: d => d.item },
    5510: { field: 'worth', sign: -1, group: 'Stock buy/sell' },
    5511: { field: 'worth', sign: +1, group: 'Stock buy/sell' },
    // --- Bank: the invest entry carries worth (principal+interest) and amount
    //     (principal); the interest = worth - amount is the profit, recognized
    //     when you lock it in (it's guaranteed). Principal itself is just your
    //     own money locked (in net worth), not counted. Withdraw is ignored
    //     (returns principal + already-counted interest) — see IGNORE_IDS. ---
    5450: { kind: 'compute', compute: d => (Number(d.worth) || 0) - (Number(d.amount) || 0), group: 'Bank interest' },
    // --- Property rental income + upkeep ---
    5937: { field: 'rent', sign: +1, group: 'Property rent' },
    5920: { field: 'upkeep_paid', sign: -1, group: 'Property upkeep' },
    // --- Consumption / fees ---
    5960: { field: 'cost', sign: -1, group: 'Education' },
    6005: { field: 'cost', sign: -1, group: 'Rehab' },
    5555: { field: 'value', sign: -1, group: 'Subscription' },
    9071: { field: 'money_lost', sign: -1, group: 'Crime costs' },
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

  // Casino categories — handled generically (one net rule covers every game,
  // including high-low's pot mechanic). Verified fields: bet_amount/cost out,
  // won_amount/money in, plus `pot` on high-low cash-in.
  const CASINO_CATS = new Set([
    'Casino', 'Slots', 'Roulette', 'High-low', 'Keno', 'Craps', 'Lottery',
    'Blackjack', 'Spin the wheel', 'Russian roulette', 'Poker', 'Bookie',
  ]);

  function casinoNet(data, title) {
    let c = 0;
    c += Number(data.won_amount) || 0;
    c += Number(data.money) || 0;
    if (/cash in/i.test(title)) c += Number(data.pot) || 0; // high-low payout
    c -= Number(data.bet_amount) || 0;
    c -= Number(data.cost) || 0;
    return c;
  }

  // ---------------------------------------------------------------------------
  // API client (api.torn.com only, rate-limited)
  // ---------------------------------------------------------------------------
  let lastCall = 0;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function apiGet(path) {
    const key = store.get('apikey', '');
    if (!key) throw new Error('No API key set');
    const sep = path.includes('?') ? '&' : '?';
    const url = `${API}${path}${sep}key=${encodeURIComponent(key)}`;
    for (let attempt = 0; ; attempt++) {
      const wait = Math.max(0, CALL_GAP_MS - (Date.now() - lastCall));
      if (wait) await sleep(wait);
      lastCall = Date.now();
      const res = await fetch(url);
      const json = await res.json();
      if (json && json.error) {
        // code 5 = "Too many requests" (shared key with your other scripts).
        // Back off and retry instead of failing the whole sync.
        if (json.error.code === 5 && attempt < 4) { await sleep(4000 * (attempt + 1)); continue; }
        throw new Error(`API ${json.error.code}: ${json.error.error}`);
      }
      return json;
    }
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
    const det = entry.details || {};
    const data = entry.data || {};
    // Casino is handled generically by category (covers every game).
    if (CASINO_CATS.has(det.category)) {
      const c = casinoNet(data, det.title || '');
      if (!c) return null;
      return { t: entry.timestamp, g: 'Casino', c };
    }
    const map = LOGMAP[det.id];
    if (!map) return null;
    if (map.kind === 'compute') {
      const c = map.compute(data);
      if (!c) return null;
      return { t: entry.timestamp, g: map.group, c };
    }
    if (map.kind === 'item') {
      const items = itemList(map.items(data)).map(x => ({ id: x.id, qty: x.qty, sign: map.sign }));
      if (!items.length) return null;
      return { t: entry.timestamp, g: map.group, c: 0, items };
    }
    const amount = Number(data[map.field]) || 0;
    if (!amount) return null;
    return { t: entry.timestamp, g: map.group, c: amount * map.sign };
  }

  // Cash-movement field names — used to detect unmapped logtypes that actually
  // move money (so we don't flag money-category entries with no cash, e.g. a
  // "Crime success" outcome row or a "Bazaar add" listing).
  const CASH_FIELDS = [
    'money', 'money_gained', 'money_lost', 'money_given', 'money_mugged', 'cost',
    'cost_total', 'worth', 'pay', 'fee', 'fees', 'amount', 'won_amount',
    'bet_amount', 'paid', 'wanted_reward', 'upkeep_paid', 'winnings', 'prize',
    'payout', 'balance_change',
  ];

  // Intermediate trade-window steps — money moves here but the trade settles
  // via Trades in/out (4440/4441), so these must NOT be counted or surfaced.
  const IGNORE_IDS = new Set([4442, 4443, 4480, 8166, 5451]);

  // Track unmapped logtypes that actually carry a cash field, so they're
  // surfaced (never silently dropped) and can be classified later.
  function recordUnmapped(entry) {
    const d = entry.details || {};
    if (LOGMAP[d.id] || IGNORE_IDS.has(d.id)) return;
    if (CASINO_CATS.has(d.category)) return; // handled generically
    if (!MONEY_CATS.has(d.category)) return;
    const data = entry.data || {};
    const hasCash = CASH_FIELDS.some(f => Number(data[f]) > 0);
    if (!hasCash) return; // money category but no actual cash moved
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
  let syncProgress = 0; // 0..1 fraction of the 30-day window backfilled

  function updateSyncBar() {
    const bar = document.getElementById('tcf-bar');
    if (bar) bar.style.width = Math.round(syncProgress * 100) + '%';
    const lbl = document.getElementById('tcf-bar-lbl');
    if (lbl) lbl.textContent = `Loading… ${Math.round(syncProgress * 100)}%`;
  }

  async function fetchLogPage(to) {
    const q = `/user/log?limit=100&sort=desc${to ? '&to=' + to : ''}`;
    const data = await apiGet(q);
    return data.log || [];
  }

  async function runSync(onProgress) {
    if (syncing) return;
    syncing = true;
    syncProgress = 0;
    render(); // show the progress bar
    try {
      // Classification changed? Drop stored movements and force a full backfill
      // so historical entries are re-labelled under the current scheme.
      // IMPORTANT: don't wipe stored data up front — if the backfill then fails
      // (e.g. rate limit on a shared key), we'd be left with nothing. Instead
      // force a full backfill and only REPLACE on success (below).
      const movements = store.get('movements', []);
      // Full backfill on schema change OR whenever we have no data at all
      // (self-heals a panel that somehow ended up empty).
      const fullBackfill = store.get('schema', 0) !== SCHEMA || movements.length === 0;
      // The unmapped warning list is non-critical — safe to reset up front so it
      // rebuilds during this backfill (recordUnmapped appends as we go).
      if (fullBackfill) store.set('unmapped', {});
      const sync = store.get('sync', { newest: 0 });
      const seenNewest = fullBackfill ? 0 : (sync.newest || 0);
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
        // Progress = how far back toward the 30-day cutoff we've reached.
        syncProgress = Math.min(0.99, Math.max(0, (nowTs - oldest) / (nowTs - cutoff)));
        updateSyncBar();
        if (!seenNewest && oldest <= cutoff) break; // backfill done
        if (oldest <= cutoff) break;                // safety
        to = oldest;
        if (onProgress) onProgress(calls, oldest);
      }

      // Merge + prune to BACKFILL window. On a full backfill we REPLACE
      // (collected is the complete set); otherwise we merge with existing.
      const base = fullBackfill ? [] : movements;
      const merged = base.concat(collected).filter(m => m.t >= cutoff);
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

  // Realized bank interest is computed from the invest log entries
  // (worth - amount). Here we just snapshot the ACTIVE investment's term/rate/
  // maturity from user/money for an informational line in the panel.
  async function refreshBankProfit() {
    try {
      const data = await apiGet('/user/money');
      const cb = data.money && data.money.city_bank;
      if (cb && cb.invested_at) {
        store.set('bankcurrent', {
          duration: cb.duration || 0, rate: cb.interest_rate || 0, until: cb.until || 0,
        });
      } else {
        store.set('bankcurrent', null);
      }
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
    'Crimes': 'earn', 'Crime loot': 'earn', 'Mugging': 'earn',
    'Casino': 'earn', 'Job pay': 'earn', 'Faction payout': 'earn', 'Dividends': 'earn',
    'Dividends (items)': 'earn', 'Property rent': 'earn', 'Item finds': 'earn',
    'Bazaar sell': 'earn', 'Trades (in)': 'earn', 'Points market sold': 'earn',
    'Education': 'spend', 'Rehab': 'spend', 'Subscription': 'spend',
    'Item market': 'spend', 'Shops': 'spend', 'Bazaar buy': 'spend',
    'Travel goods': 'spend', 'Points market bought': 'spend', 'Trades (out)': 'spend',
    'Property upkeep': 'spend', 'Crime costs': 'spend', 'Mugged by others': 'spend',
    'Bank interest': 'earn',
    'Faction vault (own money)': 'transfer', 'Money sent': 'transfer', 'Money received': 'transfer',
    'Items received': 'transfer', 'Items sent': 'transfer',
    'Stock buy/sell': 'transfer',
  };

  function aggregate(periodSec) {
    const now = Math.floor(Date.now() / 1000);
    const from = now - periodSec;
    const movements = store.get('movements', []).filter(m => m.t >= from);
    const prices = (store.get('itemcache', {}) || {}).prices || {};

    // Net value per group. ALIAS merges renamed groups so movements stored
    // under an old label still land on the current one.
    const ALIAS = { 'Faction': 'Faction vault (own money)', 'Points market': 'Points market bought' };
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

    // (Bank interest now flows through movements as a 'Bank interest' group,
    // computed from each invest entry's worth - amount.)

    for (const k of Object.keys(sections)) {
      sections[k].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    }

    // Net-worth-based total profit over the period (nearest earlier snapshot).
    const snaps = store.get('networth', []);
    let nwProfit = null, nwApprox = false, nwSpanSec = 0;
    if (snaps.length) {
      const start = snaps.filter(s => s.t <= from).pop() || snaps[0];
      const end = snaps[snaps.length - 1];
      if (start && end && end.t > start.t) {
        nwProfit = end.total - start.total;
        nwSpanSec = end.t - start.t;
        // Snapshots are taken ~every 12h, so for short windows the start
        // snapshot can sit well before `from`, making the number cover a longer
        // span than requested. Flag it approximate when the start point deviates
        // from the requested window start by more than half the period (or 18h,
        // whichever is smaller).
        const dev = Math.abs(start.t - from);
        nwApprox = dev > Math.min(periodSec * 0.5, 18 * 3600);
      }
    }

    const netActivities = sums.earn + sums.spend; // profit-from-activities (excl. transfers)
    const periodDays = Math.max(1, periodSec / DAY);

    return {
      sections, sums,
      netActivities,
      avgPerDay: netActivities / periodDays,
      // Gap between measured net-worth change and logged cash activity — mostly
      // unrealised stock/asset value drift that never appears as a transaction.
      untracked: nwProfit !== null ? nwProfit - netActivities : null,
      bankCurrent: store.get('bankcurrent', null),
      nwProfit, nwApprox, nwSpanSec, count: movements.length,
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

  // Tiny inline net-worth trend line from stored snapshots (no external assets;
  // pure SVG). Green if the trend is up over the visible range, red if down.
  function sparkline(snaps) {
    if (!snaps || snaps.length < 2) return '';
    const w = 240, h = 32, pad = 3;
    const xs = snaps.map(s => s.t), ys = snaps.map(s => s.total);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const sx = t => pad + (maxX > minX ? (t - minX) / (maxX - minX) : 0) * (w - 2 * pad);
    const sy = v => (h - pad) - (maxY > minY ? (v - minY) / (maxY - minY) : 0.5) * (h - 2 * pad);
    const pts = snaps.map(s => `${sx(s.t).toFixed(1)},${sy(s.total).toFixed(1)}`).join(' ');
    const up = ys[ys.length - 1] >= ys[0];
    return `<svg width="100%" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="display:block;margin:0 0 8px 0">
      <polyline points="${pts}" fill="none" stroke="${up ? '#5ec46a' : '#e06a6a'}" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>`;
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
      .tcf-sechead.tcf-warn{color:#e0a85e}
      #tcf-progress{height:6px;background:#2a2a2a;border-radius:3px;overflow:hidden;margin:6px 0 2px 0}
      #tcf-bar{height:100%;background:#5ec46a;width:0;transition:width .25s ease}
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

  // Mount the panel just ABOVE the page's content title (the "Home" bar), i.e.
  // directly under Torn's top status/money bar — not above the whole header.
  // Anchors on the content title first; falls back to the top of the content
  // area, then body, so it doesn't depend on one exact node.
  function mountPanel() {
    let panel = document.getElementById('tcf-panel');
    if (panel && panel.isConnected) return panel;
    injectStyle();
    panel = document.createElement('div');
    panel.id = 'tcf-panel';
    // Preferred anchor: insert right before the content title so the panel sits
    // between the money/status bar and the "Home" heading.
    const titleBar = document.querySelector('.content-title') ||
                     document.querySelector('[class*="titleContainer"]') ||
                     document.querySelector('[class*="appHeader"]');
    if (titleBar && titleBar.parentNode) {
      titleBar.parentNode.insertBefore(panel, titleBar);
      return panel;
    }
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
    const collapsed = store.get('collapsed', false);
    panel.classList.toggle('tcf-collapsed', collapsed);
    const hasKey = !!store.get('apikey', '');
    const sync = store.get('sync', {});

    if (!hasKey) {
      panel.innerHTML = `
        <div id="tcf-head"><span class="tcf-title">TornCashflow</span><span>v${VERSION}</span></div>
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
    // For short windows the measured span can exceed the requested period (see
    // nwApprox in aggregate) — say so honestly instead of pretending it's exact.
    const spanLbl = a.nwApprox
      ? ` <span style="font-weight:normal;font-size:10px;color:#999">(≈ last ${Math.round(a.nwSpanSec / 3600)}h)</span>`
      : '';
    const headline = a.nwProfit !== null
      ? `<div class="tcf-headline"><span>Net worth change${spanLbl}</span>
         <span class="${a.nwProfit >= 0 ? 'tcf-pos' : 'tcf-neg'}">${a.nwApprox ? '≈ ' : ''}${fmt(a.nwProfit)}</span></div>`
      : `<div class="tcf-headline tcf-pending">Net worth change — needs 2+ snapshots ~12h apart (collecting…)</div>`;

    // Net-worth trend line from snapshots (whole stored range, up to ~90 days).
    const spark = sparkline(store.get('networth', []));

    // Informational line: the currently active bank investment's term + rate
    // (its interest is already counted under "Bank interest" when it was made).
    const bc = a.bankCurrent;
    const bankLine = bc && bc.duration
      ? `<div class="tcf-note">Active bank investment: ${bc.duration}d @ ${bc.rate}%</div>`
      : '';

    const hasAny = a.sections.earn.length || a.sections.spend.length || a.sections.transfer.length;

    // Safety net: any money-category logtype we don't classify is surfaced here
    // (never silently dropped). Cumulative across all synced data.
    const unmapped = store.get('unmapped', {});
    const umKeys = Object.keys(unmapped).sort((x, y) => unmapped[y].count - unmapped[x].count);
    const umSection = umKeys.length ? `
      <div class="tcf-sechead tcf-warn">⚠ Uncategorized money types — not in totals</div>
      ${umKeys.map(k => `<div class="tcf-row"><span class="tcf-grp">${unmapped[k].title} <span style="opacity:.55">#${k}</span></span>
        <span class="tcf-grp">×${unmapped[k].count}</span></div>`).join('')}
      <div class="tcf-note">These money logtypes aren't classified yet, so they're excluded from every total above. Report the #id so they can be mapped.</div>` : '';

    panel.innerHTML = `
      <div id="tcf-head"><span class="tcf-title">TornCashflow</span><span>${collapsed ? '▲' : '▼'}</span></div>
      <div id="tcf-body">
        <div id="tcf-tabs">${tabs}</div>
        ${syncing ? `<div id="tcf-progress"><div id="tcf-bar" style="width:${Math.round(syncProgress * 100)}%"></div></div>
          <div id="tcf-bar-lbl" class="tcf-note">Loading… ${Math.round(syncProgress * 100)}%</div>` : ''}
        ${headline}
        ${spark}
        ${hasAny ? '' : '<div class="tcf-note">No movements in this period. Run a sync.</div>'}
        ${section('Earnings', a.sections.earn, 'Earnings total', a.sums.earn)}
        ${section('Spending', a.sections.spend, 'Spending total', a.sums.spend)}
        ${hasAny ? `<div class="tcf-row tcf-tot tcf-activities"><span>Net from activities</span>
          <span class="${a.netActivities >= 0 ? 'tcf-pos' : 'tcf-neg'}">${fmt(a.netActivities)}</span></div>` : ''}
        ${hasAny ? `<div class="tcf-row"><span class="tcf-grp">Avg / day</span>
          <span class="${a.avgPerDay >= 0 ? 'tcf-pos' : 'tcf-neg'}">${fmt(a.avgPerDay)}</span></div>` : ''}
        ${a.untracked !== null ? `<div class="tcf-row"><span class="tcf-grp">Unrealised / untracked</span>
          <span class="${a.untracked >= 0 ? 'tcf-pos' : 'tcf-neg'}">${fmt(a.untracked)}</span></div>
          <div class="tcf-note">Gap between your net-worth change and logged cash activity — mostly stock/asset value drift that isn't recorded as a transaction.</div>` : ''}
        ${hasAny ? '<div class="tcf-note">Item gains/losses are valued at today\'s market price, not the price when they moved.</div>' : ''}
        ${bankLine}
        ${section('Transfers — not counted as profit', a.sections.transfer, null, 0)}
        <div class="tcf-note">Transfers are value you already own moving around — faction-vault money (already in net worth), stock/bank moves, and money/items to-from other players. Not counted as profit. Net-worth change above is the reliable bottom line.</div>
        ${umSection}
      </div>
      <div id="tcf-foot">
        <button id="tcf-sync">${syncing ? 'Syncing…' : 'Sync now'}</button>
        <span>Last: ${lastRun}</span>
      </div>`;

    document.getElementById('tcf-head').onclick = () => {
      store.set('collapsed', !store.get('collapsed', false));
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
