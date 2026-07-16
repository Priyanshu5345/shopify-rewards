/**
 * rewards-backend.js
 *
 * Required env vars (set in Railway → Variables):
 *   SHOPIFY_SHOP          = cilvira-2.myshopify.com
 *   SHOPIFY_ACCESS_TOKEN  = shpat_xxxx
 *   SHOPIFY_API_SECRET    = xxxx  (from Shopify Admin → Settings → Notifications → Webhooks)
 *   ADMIN_SECRET          = your-chosen-password  (for /api/admin/*, /api/cron/birthday)
 *
 * Bonus coupon: FREE50
 *   Orders using this coupon earn 100% of amount paid (after discount) as points.
 *   All other orders earn 1% of amount paid (after discount).
 *
 * POINTS INVARIANT: balance == sum of remaining_points across every live
 *   (not expired, not reversed) earn entry. Every operation that changes
 *   balance must change remaining_points by the same amount, on the same
 *   side, or this invariant breaks and expiry starts double-counting
 *   already-spent points. Specifically:
 *     - Earning (welcome/order-paid/birthday/admin-add): new entry created
 *       with remaining_points == points. Balance and remaining_points rise
 *       together — invariant holds automatically.
 *     - Spending (apply/update-apply/admin-deduct): consumeFIFO() draws the
 *       spent amount down from live earn entries, soonest-expiring first,
 *       and records exactly which entries + amounts on the spending 'use'
 *       entry's consumed_from field.
 *     - Restoring (restore/update-apply's old-code path/the two abandoned-
 *       checkout sweeps/order-cancelled/refund-created credit-back):
 *       restoreFIFO() reverses a consumed_from ledger, crediting the exact
 *       origin entries back up (capped at their original points). If an
 *       origin entry has since expired, that portion becomes a new
 *       non-expiring adjustment entry instead, since it can no longer be
 *       cleanly reattached to an expired window.
 *     - Expiry (processExpiry): already reads remaining_points per entry;
 *       now that spends correctly decrement it, expiry stops over-counting.
 *
 *   CAVEAT: entries created before this fix deployed have no consumed_from
 *   history — any redemption that already happened against them isn't
 *   reflected in their remaining_points. This fix prevents the problem
 *   going forward; it does not retroactively correct existing data.
 *
 * Points expiry: every earn-type credit carries its own expires_at and
 *   expires independently, 6 months after credit by default. Manual
 *   credits require an explicit expires_at.
 *
 * Birthday points — INDEX-BACKED: see rewards/birthday_index shop metafield.
 *   Backfill once via /api/admin/backfill-birthday-index, then the monthly
 *   cron reads only the index — never the full customer list.
 *
 * Stale applied-points recovery — TWO LAYERS:
 *   1. PROACTIVE: an in-memory registry (pendingApplies), swept every
 *      SWEEP_INTERVAL_MS, resolving anything past STALE_APPLY_MS. In-memory
 *      only — a restart clears it.
 *   2. FALLBACK: GET /api/points runs the same stale-check on every
 *      cart-page load, regardless of what the in-memory registry knows.
 *   Both skip any entry with confirmed:true — see order-paid below for why
 *   that flag exists and is load-bearing.
 *
 * Rate limiting: every outbound Shopify call is serialized through a single
 *   throttled queue (~1.8 req/sec) with automatic 429 retry.
 *
 * Manual point admin: no admin panel exists. Credits/debits are sent by hand
 *   via ReqBin as raw POST requests. There is deliberately no "set balance to
 *   X" action — only additive add-points / deduct-points.
 */

const express = require('express');
const crypto  = require('crypto');
const app     = express();

// All webhook routes need raw bytes for HMAC verification — skip JSON parsing for them
app.use((req, res, next) => {
  if (req.path.startsWith('/api/webhook/')) return next();
  express.json()(req, res, next);
});

const SHOP         = process.env.SHOPIFY_SHOP;
const TOKEN        = process.env.SHOPIFY_ACCESS_TOKEN;
const SECRET       = process.env.SHOPIFY_API_SECRET;
const BONUS_COUPON         = 'FREE50';
const POINTS_EXPIRY_MONTHS = 6;

const STALE_APPLY_MS    = 30 * 60 * 1000; // 30 minutes — keep in sync with rewards-panel.js's STALE_MS
const SWEEP_INTERVAL_MS = 2 * 60 * 1000;

const HEADERS = {
  'X-Shopify-Access-Token': TOKEN,
  'Content-Type': 'application/json'
};

/* ─────────────────────────────────────────
   RATE LIMITER
   ───────────────────────────────────────── */
const MIN_INTERVAL_MS = 550;
const MAX_RETRIES     = 5;

let requestQueue = Promise.resolve();

function throttle(fn) {
  const run = requestQueue.then(async () => {
    const result = await fn();
    await new Promise(r => setTimeout(r, MIN_INTERVAL_MS));
    return result;
  });
  requestQueue = run.catch(() => {});
  return run;
}

async function throttledFetch(url, options = {}) {
  return throttle(async () => {
    let res;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      res = await fetch(url, options);
      if (res.status !== 429) break;

      if (attempt === MAX_RETRIES) {
        throw new Error(`Shopify API error 429 on ${options.method || 'GET'} ${url}: exceeded ${MAX_RETRIES} retries`);
      }

      const retryAfterHeader = res.headers.get('retry-after');
      const waitMs = retryAfterHeader
        ? Math.ceil(parseFloat(retryAfterHeader) * 1000)
        : 1000 * (attempt + 1);
      console.warn(`[rate-limit] 429 on ${url}, retry ${attempt + 1}/${MAX_RETRIES} in ${waitMs}ms`);
      await new Promise(r => setTimeout(r, waitMs));
    }
    return res;
  });
}

/* ─────────────────────────────────────────
   HELPERS — customer metafields
   ───────────────────────────────────────── */

async function shopifyFetch(path, options = {}) {
  const url = `https://${SHOP}/admin/api/2025-04${path}`;
  const res = await throttledFetch(url, {
    ...options,
    headers: { ...HEADERS, ...options.headers }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify API error ${res.status} on ${options.method || 'GET'} ${path}: ${text}`);
  }
  if (res.status === 204) return {};
  const text = await res.text();
  if (!text) return {};
  return JSON.parse(text);
}

async function getMetafield(customerId, key) {
  const data = await shopifyFetch(
    `/customers/${customerId}/metafields.json?namespace=rewards&key=${key}`
  );
  const mf = (data.metafields || []).find(m => m.key === key);
  return mf ? { id: mf.id, value: mf.value } : null;
}

async function setMetafield(customerId, key, value, type = 'integer') {
  const existing = await getMetafield(customerId, key);

  let mfType, mfValue;
  if (type === 'json')    { mfType = 'json';            mfValue = JSON.stringify(value); }
  else if (type === 'date') { mfType = 'date';          mfValue = String(value); }
  else                    { mfType = 'number_integer';   mfValue = String(value); }

  const body = {
    metafield: { namespace: 'rewards', key, value: mfValue, type: mfType }
  };
  if (existing) {
    return shopifyFetch(`/metafields/${existing.id}.json`, { method: 'PUT', body: JSON.stringify(body) });
  }
  return shopifyFetch(`/customers/${customerId}/metafields.json`, { method: 'POST', body: JSON.stringify(body) });
}

/* ─────────────────────────────────────────
   HELPERS — shop-level metafields (birthday index)
   ───────────────────────────────────────── */

async function getShopMetafield(key) {
  const data = await shopifyFetch(`/metafields.json?namespace=rewards&key=${key}`);
  const mf = (data.metafields || []).find(m => m.key === key);
  return mf ? { id: mf.id, value: mf.value } : null;
}

async function setShopMetafield(key, value) {
  const existing = await getShopMetafield(key);
  const body = {
    metafield: { namespace: 'rewards', key, value: JSON.stringify(value), type: 'json' }
  };
  if (existing) {
    return shopifyFetch(`/metafields/${existing.id}.json`, { method: 'PUT', body: JSON.stringify(body) });
  }
  return shopifyFetch('/metafields.json', { method: 'POST', body: JSON.stringify(body) });
}

/* ─────────────────────────────────────────
   IN-PROCESS INDEX LOCK (birthday_index)
   ───────────────────────────────────────── */
let indexQueue = Promise.resolve();

function withIndexLock(fn) {
  const run = indexQueue.then(fn);
  indexQueue = run.catch(() => {});
  return run;
}

function verifyHmac(req) {
  const hmac = req.headers['x-shopify-hmac-sha256'];
  if (!hmac) return false;
  const hash = crypto.createHmac('sha256', SECRET).update(req.body).digest('base64');
  return hmac === hash;
}

function parseWebhookBody(req) {
  return JSON.parse(req.body.toString('utf8'));
}

/* ─────────────────────────────────────────
   ENTRY IDS + FIFO CONSUMPTION LEDGER
   Every history entry gets a stable id, generated once at creation, so a
   spend can reference exactly which earn entries it drew from — and a
   later restore can reverse exactly that, rather than guessing.
   ───────────────────────────────────────── */
function generateEntryId() {
  return crypto.randomBytes(6).toString('hex');
}

// Live (spendable) earn entries, soonest-expiring first. Entries with no
// expires_at (permanent adjustment credits) sort last, since there's no
// urgency to draw them down before something that could actually expire.
function getLiveEarnEntriesSorted(history) {
  return history
    .filter(h => h.type === 'earn' && !h.expired && !h.reversed && (h.remaining_points ?? h.points) > 0)
    .sort((a, b) => {
      const aExp = a.expires_at ? new Date(a.expires_at).getTime() : Infinity;
      const bExp = b.expires_at ? new Date(b.expires_at).getTime() : Infinity;
      return aExp - bExp;
    });
}

// Draws `amount` points from live earn entries via FIFO-by-soonest-expiry,
// mutating remaining_points in place. Returns the ledger to attach to the
// spending 'use' entry's consumed_from field.
function consumeFIFO(history, amount) {
  const entries = getLiveEarnEntriesSorted(history);
  let remaining = amount;
  const consumedFrom = [];

  for (const entry of entries) {
    if (remaining <= 0) break;
    const available = entry.remaining_points ?? entry.points;
    const take = Math.min(available, remaining);
    if (take <= 0) continue;
    entry.remaining_points = available - take;
    consumedFrom.push({ id: entry.id, amount: take });
    remaining -= take;
  }

  if (remaining > 0) {
    console.warn(`[consumeFIFO] Could not attribute ${remaining}pts to any live earn entry — balance/remaining_points may be out of sync (likely pre-fix history).`);
  }

  return consumedFrom;
}

// Reverses a consumed_from ledger, crediting origin entries back up
// (capped at their original points). If an origin entry has already
// expired, that share becomes a new non-expiring adjustment entry instead
// — it can't be cleanly reattached to a window that's already closed.
function restoreFIFO(history, consumedFrom) {
  if (!consumedFrom || consumedFrom.length === 0) return;
  let orphaned = 0;

  for (const { id, amount } of consumedFrom) {
    const entry = history.find(h => h.id === id);
    if (entry && !entry.expired) {
      entry.remaining_points = Math.min(entry.points, (entry.remaining_points ?? 0) + amount);
    } else {
      orphaned += amount;
    }
  }

  if (orphaned > 0) {
    history.unshift({
      type: 'earn',
      id: generateEntryId(),
      description: `${orphaned} pts restored (original earn entry already expired)`,
      points: orphaned,
      remaining_points: orphaned,
      created_at: new Date().toISOString(),
      is_restoration_adjustment: true
      // deliberately no expires_at — can't reattach to the original
      // window, so this portion no longer expires.
    });
  }
}

/* ─────────────────────────────────────────
   SHARED CODE LOOKUP + CLEANUP
   usage_limit is always 1 on RWRD- price rules, so once found, a code can
   never be used again either way — safe to delete unconditionally.
   ───────────────────────────────────────── */
async function lookupAndCleanupCode(discountCode) {
  const lookup = await shopifyFetch(`/discount_codes/lookup.json?code=${encodeURIComponent(discountCode)}`);
  const priceRuleId = lookup.discount_code?.price_rule_id;
  if (!priceRuleId) return { usageCount: 0, existed: false };

  const codeData = await shopifyFetch(`/price_rules/${priceRuleId}/discount_codes.json`);
  const codeObj  = (codeData.discount_codes || []).find(c => c.code === discountCode);
  const usageCount = codeObj?.usage_count ?? 0;

  await shopifyFetch(`/price_rules/${priceRuleId}.json`, { method: 'DELETE' });
  console.log(`[cleanup] Deleted price rule ${priceRuleId} (${discountCode}), usage_count=${usageCount}`);

  return { usageCount, existed: true };
}

async function deleteRwrdCode(code) {
  try {
    await lookupAndCleanupCode(code);
  } catch (e) {
    console.error(`[cleanup] Could not delete ${code}:`, e.message);
  }
}

/* ─────────────────────────────────────────
   PER-ORDER PROCESSING LOCK
   Shopify can and does redeliver webhooks (slow response, retry after
   failure, or genuine duplicate delivery). This serializes order-paid
   processing per order_id so two near-simultaneous deliveries for the
   SAME order can't both read history before either has written — closing
   the race version of the duplicate-credit bug, not just the sequential
   version (which the order_id idempotency check below already covers on
   its own for deliveries spaced apart in time).
   ───────────────────────────────────────── */
/* ─────────────────────────────────────────
   PER-CUSTOMER PROCESSING LOCK
   Every route that reads-then-writes a customer's balance/history
   metafields must be serialized against every OTHER route touching that
   SAME customer — not just against retries of itself. Without this, an
   order-paid webhook and a concurrent /api/apply (or /api/restore, or the
   periodic sweep) for the same customer can both read balance before
   either writes, and whichever writes last silently overwrites the
   other's update — a real lost-update race, not theoretical: this is
   exactly what happened to a live customer, where a genuine points
   redemption's balance deduction was clobbered by a concurrently-running
   order-paid webhook that read a stale balance a few seconds later.
   A per-order lock (checking only "is this the same order_id") is not
   sufficient — it doesn't protect against a DIFFERENT route for the SAME
   customer racing in. Locking at the customer level is a strict superset
   of order-level locking, since every order belongs to exactly one
   customer.
   ───────────────────────────────────────── */
const customerLocks = new Map();

function withCustomerLock(customerId, fn) {
  const key  = String(customerId);
  const prev = customerLocks.get(key) || Promise.resolve();
  const run  = prev.then(fn);
  customerLocks.set(key, run.catch(() => {}));
  return run;
}

/* ─────────────────────────────────────────
   PROACTIVE SWEEP REGISTRY
   ───────────────────────────────────────── */
const pendingApplies = new Map();

function registerPendingApply(customerId, discountCode) {
  const key = String(customerId);
  if (!pendingApplies.has(key)) pendingApplies.set(key, new Map());
  pendingApplies.get(key).set(discountCode, Date.now());
}

function unregisterPendingApply(customerId, discountCode) {
  const key = String(customerId);
  const codes = pendingApplies.get(key);
  if (!codes) return;
  codes.delete(discountCode);
  if (codes.size === 0) pendingApplies.delete(key);
}

/* ─────────────────────────────────────────
   EXPIRY HELPER
   ───────────────────────────────────────── */
async function processExpiry(customerId, balance, history) {
  const now           = Date.now();
  let   expiredPoints = 0;

  for (const entry of history) {
    if (
      entry.type     !== 'earn' ||
      entry.expired  === true   ||
      entry.reversed === true   ||
      !entry.expires_at
    ) continue;

    const expiresAt = new Date(entry.expires_at).getTime();
    if (now >= expiresAt) {
      const remaining = entry.remaining_points ?? entry.points;
      if (remaining > 0) {
        expiredPoints += remaining;
        entry.expired = true;
        entry.remaining_points = 0;
        console.log(`[expiry] ${remaining} pts expired from entry: ${entry.description}`);
      } else {
        entry.expired = true;
      }
    }
  }

  if (expiredPoints > 0) {
    const newBalance = Math.max(0, balance - expiredPoints);
    history.unshift({
      type: 'use', id: generateEntryId(), description: `${expiredPoints} pts expired (6-month expiry)`,
      points: expiredPoints, created_at: new Date().toISOString(), is_expiry: true
    });

    await Promise.all([
      setMetafield(customerId, 'balance', newBalance, 'integer'),
      setMetafield(customerId, 'history', history, 'json')
    ]);

    console.log(`[expiry] Customer ${customerId}: ${expiredPoints} pts expired. Balance: ${balance} → ${newBalance}`);
    return { balance: newBalance, history, expired: expiredPoints };
  }

  return { balance, history, expired: 0 };
}

/* ─────────────────────────────────────────
   STALE APPLIED-POINTS RECOVERY — FALLBACK LAYER
   ───────────────────────────────────────── */
async function restoreStaleAppliedCodes(customerId, balance, history) {
  const now = Date.now();
  let changed = false;

  const staleEntries = history.filter(h =>
    h.type === 'use' &&
    !h.refunded &&
    !h.confirmed &&
    h.discount_code?.startsWith('RWRD-') &&
    (now - new Date(h.created_at).getTime()) > STALE_APPLY_MS
  );

  for (const entry of staleEntries) {
    try {
      const { usageCount } = await lookupAndCleanupCode(entry.discount_code);
      if (usageCount === 0) {
        restoreFIFO(history, entry.consumed_from);
        balance += entry.points;
        history  = history.filter(h => h !== entry);
        changed  = true;
        console.log(`[auto-restore] Customer ${customerId}: restored ${entry.points}pts from abandoned checkout (${entry.discount_code})`);
      }
      unregisterPendingApply(customerId, entry.discount_code);
    } catch (e) {
      console.log(`[auto-restore] Could not verify ${entry.discount_code}, skipping: ${e.message}`);
    }
  }

  return { balance, history, changed };
}

/* ─────────────────────────────────────────
   PROACTIVE SWEEP
   ───────────────────────────────────────── */
async function sweepPendingApplies() {
  const now = Date.now();

  for (const [customerId, codes] of pendingApplies) {
    for (const [discountCode, appliedAt] of codes) {
      if (now - appliedAt < STALE_APPLY_MS) continue;

      try {
        await withCustomerLock(customerId, async () => {
          const historyMF = await getMetafield(customerId, 'history');
          let history = [];
          if (historyMF) { try { history = JSON.parse(historyMF.value); } catch {} }

          const entry = history.find(h => h.type === 'use' && h.discount_code === discountCode && !h.refunded);

          if (!entry || entry.confirmed) {
            unregisterPendingApply(customerId, discountCode);
            return;
          }

          const { usageCount } = await lookupAndCleanupCode(discountCode);

          if (usageCount === 0) {
            const balanceMF = await getMetafield(customerId, 'balance');
            const balance   = balanceMF ? parseInt(balanceMF.value, 10) : 0;

            restoreFIFO(history, entry.consumed_from);
            const newBalance = balance + entry.points;
            const newHistory = history.filter(h => h !== entry);

            await Promise.all([
              setMetafield(customerId, 'balance', newBalance, 'integer'),
              setMetafield(customerId, 'history', newHistory, 'json')
            ]);

            console.log(`[auto-restore-sweep] Customer ${customerId}: restored ${entry.points}pts (${discountCode}). Balance ${balance} → ${newBalance}`);
          }

          unregisterPendingApply(customerId, discountCode);
        });
      } catch (e) {
        console.error(`[auto-restore-sweep] Error resolving ${discountCode} for customer ${customerId}:`, e.message);
      }
    }
  }
}

setInterval(() => {
  sweepPendingApplies().catch(e => console.error('[auto-restore-sweep] Unhandled error:', e.message));
}, SWEEP_INTERVAL_MS);

/* ─────────────────────────────────────────
   ROUTE: GET /api/points
   ───────────────────────────────────────── */
app.get('/api/points', async (req, res) => {
  const { customer_id } = req.query;
  if (!customer_id) return res.status(400).json({ error: 'Missing customer_id' });

  try {
    await withCustomerLock(customer_id, async () => {
      const [balanceMF, historyMF] = await Promise.all([
        getMetafield(customer_id, 'balance'),
        getMetafield(customer_id, 'history')
      ]);

      let balance = balanceMF ? parseInt(balanceMF.value, 10) : 0;
      let history = [];
      if (historyMF) { try { history = JSON.parse(historyMF.value); } catch {} }

      const expiryResult = await processExpiry(customer_id, balance, history);
      balance = expiryResult.balance;
      history = expiryResult.history;

      const staleResult = await restoreStaleAppliedCodes(customer_id, balance, history);
      if (staleResult.changed) {
        balance = staleResult.balance;
        history = staleResult.history;
        await Promise.all([
          setMetafield(customer_id, 'balance', balance, 'integer'),
          setMetafield(customer_id, 'history', history, 'json')
        ]);
      }

      const birthdayMF   = await getMetafield(customer_id, 'birthday');
      const has_birthday = !!birthdayMF;

      res.json({ balance, history: history.slice(0, 20), is_first_order: false, has_birthday });
    });
  } catch (e) {
    console.error('[points GET]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ─────────────────────────────────────────
   ROUTE: GET /api/check-code
   ───────────────────────────────────────── */
app.get('/api/check-code', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ valid: false, error: 'Missing code' });

  try {
    const data = await shopifyFetch(`/discount_codes/lookup.json?code=${encodeURIComponent(code)}`);
    const dc   = data.discount_code;
    if (!dc) return res.json({ valid: false, usage_count: 0 });

    const codeData = await shopifyFetch(`/price_rules/${dc.price_rule_id}/discount_codes.json`);
    const codeObj  = (codeData.discount_codes || []).find(c => c.code === code);

    res.json({ valid: !!codeObj, usage_count: codeObj?.usage_count ?? 0 });
  } catch (e) {
    res.json({ valid: false, usage_count: 0 });
  }
});

/* ─────────────────────────────────────────
   ROUTE: POST /api/apply
   Draws the spent amount via FIFO, tags the use entry with exactly which
   earn entries it came from.
   ───────────────────────────────────────── */
app.post('/api/apply', async (req, res) => {
  const { customer_id, points_to_use, cart_total } = req.body;
  if (!customer_id || !points_to_use) return res.status(400).json({ error: 'Missing fields' });

  const ptsInt    = parseInt(points_to_use, 10);
  const cartPaise = parseInt(cart_total, 10) || 0;

  if (ptsInt <= 0) return res.status(400).json({ error: 'Invalid points' });

  const maxAllowed = Math.floor(cartPaise / 200);
  if (ptsInt > maxAllowed) {
    return res.status(400).json({ error: `Max ${maxAllowed} pts allowed (50% of cart)` });
  }

  try {
    await withCustomerLock(customer_id, async () => {
      const balanceMF = await getMetafield(customer_id, 'balance');
      const balance   = balanceMF ? parseInt(balanceMF.value, 10) : 0;
      if (ptsInt > balance) { res.status(400).json({ error: 'Insufficient points' }); return; }

      const historyMF = await getMetafield(customer_id, 'history');
      let history = [];
      if (historyMF) { try { history = JSON.parse(historyMF.value); } catch {} }

      const existing = history.find(
        h => h.type === 'use' && h.points === ptsInt && !h.refunded
          && h.discount_code?.startsWith('RWRD-')
          && (Date.now() - new Date(h.created_at).getTime()) < STALE_APPLY_MS
      );
      if (existing) {
        console.log(`[apply] Reusing code ${existing.discount_code}`);
        registerPendingApply(customer_id, existing.discount_code);
        res.json({ discount_code: existing.discount_code, discount_amount: ptsInt });
        return;
      }

      const code         = `RWRD-${customer_id}-${Date.now()}`;
      const discountData = await shopifyFetch('/price_rules.json', {
        method: 'POST',
        body: JSON.stringify({
          price_rule: {
            title: `Rewards redemption ${code}`, target_type: 'line_item', target_selection: 'all',
            allocation_method: 'across', value_type: 'fixed_amount', value: `-${ptsInt}.00`,
            customer_selection: 'prerequisite', prerequisite_customer_ids: [parseInt(customer_id)],
            usage_limit: 1, once_per_customer: true, starts_at: new Date().toISOString()
          }
        })
      });

      await shopifyFetch(`/price_rules/${discountData.price_rule.id}/discount_codes.json`, {
        method: 'POST', body: JSON.stringify({ discount_code: { code } })
      });

      const consumedFrom = consumeFIFO(history, ptsInt);

      history.unshift({
        type: 'use', id: generateEntryId(), description: `${ptsInt} points redeemed`, points: ptsInt,
        discount_code: code, created_at: new Date().toISOString(), consumed_from: consumedFrom
      });

      await Promise.all([
        setMetafield(customer_id, 'balance', balance - ptsInt, 'integer'),
        setMetafield(customer_id, 'history', history, 'json')
      ]);

      registerPendingApply(customer_id, code);
      console.log(`[apply] Customer ${customer_id}: ${ptsInt}pts → code ${code}`);
      res.json({ discount_code: code, discount_amount: ptsInt });
    });
  } catch (e) {
    console.error('[apply]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ─────────────────────────────────────────
   ROUTE: POST /api/update-apply
   Reverses the OLD spend's consumed_from (if unused) before drawing a NEW
   consumed_from for the updated amount.
   ───────────────────────────────────────── */
app.post('/api/update-apply', async (req, res) => {
  const { customer_id, old_points, old_discount_code, new_points, cart_total } = req.body;
  if (!customer_id || !new_points || !old_discount_code) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  const oldPts    = parseInt(old_points, 10);
  const newPts    = parseInt(new_points, 10);
  const cartPaise = parseInt(cart_total, 10) || 0;

  if (newPts <= 0) return res.status(400).json({ error: 'Invalid points' });

  const maxAllowed = Math.floor(cartPaise / 200);
  if (newPts > maxAllowed) {
    return res.status(400).json({ error: `Max ${maxAllowed} pts allowed (50% of cart)` });
  }

  try {
    await withCustomerLock(customer_id, async () => {
      const balanceMF = await getMetafield(customer_id, 'balance');
      let balance     = balanceMF ? parseInt(balanceMF.value, 10) : 0;
      const historyMF = await getMetafield(customer_id, 'history');
      let history     = [];
      if (historyMF) { try { history = JSON.parse(historyMF.value); } catch {} }

      const oldEntry = history.find(h => h.type === 'use' && h.discount_code === old_discount_code);

      if (oldEntry?.confirmed) {
        res.status(409).json({ error: 'This redemption was already used in a completed order and cannot be modified.' });
        return;
      }
      if (oldEntry?.refunded) {
        res.status(409).json({ error: 'This redemption was already refunded and cannot be modified.' });
        return;
      }

      let oldCodeWasUsed;
      try {
        const { usageCount } = await lookupAndCleanupCode(old_discount_code);
        oldCodeWasUsed = usageCount > 0;
      } catch (e) {
        console.log(`[update-apply] Old code lookup failed for ${old_discount_code}: ${e.message} — refusing to proceed`);
        res.status(409).json({ error: 'Could not verify old code status — please reload and try again.' });
        return;
      }

      if (!oldCodeWasUsed) {
        if (oldEntry) restoreFIFO(history, oldEntry.consumed_from);
        balance = balance + oldPts;
        history = history.filter(h => !(h.type === 'use' && h.discount_code === old_discount_code));
        console.log(`[update-apply] Old code unused — restored ${oldPts}pts`);
      } else {
        console.log(`[update-apply] Old code was used — cannot restore ${oldPts}pts`);
      }
      unregisterPendingApply(customer_id, old_discount_code);

      balance = balance - newPts;
      if (balance < 0) { res.status(400).json({ error: 'Insufficient points' }); return; }

      const code         = `RWRD-${customer_id}-${Date.now()}`;
      const discountData = await shopifyFetch('/price_rules.json', {
        method: 'POST',
        body: JSON.stringify({
          price_rule: {
            title: `Rewards redemption ${code}`, target_type: 'line_item', target_selection: 'all',
            allocation_method: 'across', value_type: 'fixed_amount', value: `-${newPts}.00`,
            customer_selection: 'prerequisite', prerequisite_customer_ids: [parseInt(customer_id)],
            usage_limit: 1, once_per_customer: true, starts_at: new Date().toISOString()
          }
        })
      });

      await shopifyFetch(`/price_rules/${discountData.price_rule.id}/discount_codes.json`, {
        method: 'POST', body: JSON.stringify({ discount_code: { code } })
      });

      const consumedFrom = consumeFIFO(history, newPts);

      history.unshift({
        type: 'use', id: generateEntryId(), description: `${newPts} points redeemed`, points: newPts,
        discount_code: code, created_at: new Date().toISOString(), consumed_from: consumedFrom
      });

      await Promise.all([
        setMetafield(customer_id, 'balance', balance, 'integer'),
        setMetafield(customer_id, 'history', history, 'json')
      ]);

      registerPendingApply(customer_id, code);
      console.log(`[update-apply] ${oldPts}→${newPts}pts. Balance=${balance}`);
      res.json({ discount_code: code, discount_amount: newPts });
    });
  } catch (e) {
    console.error('[update-apply]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ─────────────────────────────────────────
   ROUTE: POST /api/restore
   ───────────────────────────────────────── */
app.post('/api/restore', async (req, res) => {
  const { customer_id, points, discount_code } = req.body;
  if (!customer_id || !points) return res.status(400).json({ error: 'Missing fields' });

  const pts = parseInt(points, 10);

  try {
    await withCustomerLock(customer_id, async () => {
      const balanceMF = await getMetafield(customer_id, 'balance');
      const balance   = balanceMF ? parseInt(balanceMF.value, 10) : 0;
      const historyMF = await getMetafield(customer_id, 'history');
      let history     = [];
      if (historyMF) { try { history = JSON.parse(historyMF.value); } catch {} }

      const useEntry = discount_code
        ? history.find(h => h.type === 'use' && h.discount_code === discount_code)
        : null;

      if (useEntry?.confirmed) {
        console.log(`[restore] Code ${discount_code} already confirmed used in order ${useEntry.redeemed_in_order} — refusing to restore`);
        res.json({ ok: true, restored: false, reason: 'already_confirmed_used' });
        return;
      }
      if (useEntry?.refunded) {
        console.log(`[restore] Code ${discount_code} already refunded — refusing to restore again`);
        res.json({ ok: true, restored: false, reason: 'already_refunded' });
        return;
      }

      let codeWasUsed = false;
      if (discount_code) {
        try {
          const { usageCount } = await lookupAndCleanupCode(discount_code);
          codeWasUsed = usageCount > 0;
        } catch (e) {
          console.log(`[restore] Code lookup failed for ${discount_code}: ${e.message} — refusing to restore automatically`);
          res.status(409).json({
            ok: false,
            error: 'Could not verify code status — refusing to restore automatically. This needs manual review.'
          });
          return;
        }
      }

      if (!codeWasUsed) {
        if (useEntry) restoreFIFO(history, useEntry.consumed_from);
        history = history.filter(h => !(h.type === 'use' && h.discount_code === discount_code));
        await Promise.all([
          setMetafield(customer_id, 'balance', balance + pts, 'integer'),
          setMetafield(customer_id, 'history', history, 'json')
        ]);
        console.log(`[restore] Restored ${pts}pts. New balance: ${balance + pts}`);
      } else {
        console.log(`[restore] Code was used — points not restored`);
      }

      if (discount_code) unregisterPendingApply(customer_id, discount_code);
      res.json({ ok: true, restored: !codeWasUsed });
    });
  } catch (e) {
    console.error('[restore]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ─────────────────────────────────────────
   WEBHOOK: POST /api/webhook/customer-created
   ───────────────────────────────────────── */
const WELCOME_POINTS = 100;

app.post('/api/webhook/customer-created', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!verifyHmac(req)) return res.status(401).send('Unauthorized');

  let customer;
  try { customer = parseWebhookBody(req); }
  catch (e) { return res.status(400).send('Bad JSON'); }

  const customerId = customer.id;
  if (!customerId) return res.status(200).send('ok');

  try {
    await withCustomerLock(customerId, async () => {
      const existing = await getMetafield(customerId, 'balance');
      if (existing) {
        console.log(`[customer-created] Customer ${customerId} already has points — skipping welcome bonus`);
        res.status(200).send('ok');
        return;
      }

      const expiresAt = new Date();
      expiresAt.setMonth(expiresAt.getMonth() + POINTS_EXPIRY_MONTHS);

      const history = [{
        type: 'earn', id: generateEntryId(), description: 'Welcome bonus', points: WELCOME_POINTS,
        remaining_points: WELCOME_POINTS, created_at: new Date().toISOString(),
        expires_at: expiresAt.toISOString(), is_welcome: true
      }];

      await Promise.all([
        setMetafield(customerId, 'balance', WELCOME_POINTS, 'integer'),
        setMetafield(customerId, 'history', history, 'json')
      ]);

      console.log(`[customer-created] Customer ${customerId} (${customer.email}) — ${WELCOME_POINTS} welcome pts credited`);
      res.status(200).send('ok');
    });
  } catch (e) {
    console.error('[customer-created]', e.message);
    res.status(500).send('error');
  }
});

/* ─────────────────────────────────────────
   WEBHOOK: POST /api/webhook/order-paid
   ───────────────────────────────────────── */
app.post('/api/webhook/order-paid', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!verifyHmac(req)) return res.status(401).send('Unauthorized');

  let order;
  try { order = parseWebhookBody(req); }
  catch (e) { return res.status(400).send('Bad JSON'); }

  const customerId = order.customer?.id;
  if (!customerId) return res.status(200).send('ok');

  const orderId = order.id;

  try {
    await withCustomerLock(customerId, async () => {
    const usedCoupons     = (order.discount_codes || []).map(d => (d.code || '').toUpperCase());
    const usedBonusCoupon = usedCoupons.includes(BONUS_COUPON.toUpperCase());
    const amountPaid      = Math.round(parseFloat(order.total_price) * 100);

    const earnedPoints = usedBonusCoupon
      ? Math.floor(amountPaid / 100)
      : Math.floor(amountPaid / 10000);

    console.log(`[order-paid] Order #${order.order_number} | paid=₹${amountPaid/100} | bonus=${usedBonusCoupon} | earns=${earnedPoints}pts`);

    const balanceMF = await getMetafield(customerId, 'balance');
    const balance   = balanceMF ? parseInt(balanceMF.value, 10) : 0;
    const historyMF = await getMetafield(customerId, 'history');
    let history     = [];
    if (historyMF) { try { history = JSON.parse(historyMF.value); } catch {} }

    // IDEMPOTENCY GUARD — Shopify redelivers webhooks. Without this check,
    // every redelivery of the same order credits it again. This is the
    // fix for the exact bug where order #1105 was credited 4 times.
    const alreadyCredited = history.some(
      h => h.type === 'earn' && h.order_id === String(orderId) && !h.reversed
    );
    if (alreadyCredited) {
      console.log(`[order-paid] Order #${order.order_number} already credited — skipping duplicate delivery`);
      return;
    }

    const newBalance = balance + earnedPoints;
    const expiresAt   = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + POINTS_EXPIRY_MONTHS);

    history.unshift({
      type: 'earn', id: generateEntryId(),
      description: `Order #${order.order_number} — ${earnedPoints} pts earned${usedBonusCoupon ? ' (100% bonus)' : ''}`,
      points: earnedPoints, remaining_points: earnedPoints,
      created_at: new Date().toISOString(), expires_at: expiresAt.toISOString(),
      order_id: String(orderId)
    });

    const rwrdCodes = (order.discount_codes || []).filter(d => d.code?.startsWith('RWRD-'));
    for (const d of rwrdCodes) {
      const useEntry = history.find(h => h.type === 'use' && h.discount_code === d.code && !h.refunded);
      if (useEntry) {
        useEntry.confirmed = true;
        useEntry.redeemed_in_order = String(orderId);
      }
      unregisterPendingApply(customerId, d.code);
    }

    await Promise.all([
      setMetafield(customerId, 'balance', newBalance, 'integer'),
      setMetafield(customerId, 'history', history, 'json')
    ]);

    console.log(`[order-paid] Balance: ${balance} + ${earnedPoints} = ${newBalance}`);

    for (const d of rwrdCodes) await deleteRwrdCode(d.code);
    }); // end withCustomerLock

    res.status(200).send('ok');
  } catch (e) {
    console.error('[order-paid]', e.message);
    res.status(500).send('error');
  }
});

/* ─────────────────────────────────────────
   WEBHOOK: POST /api/webhook/order-cancelled
   ───────────────────────────────────────── */
app.post('/api/webhook/order-cancelled', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!verifyHmac(req)) return res.status(401).send('Unauthorized');

  let order;
  try { order = parseWebhookBody(req); }
  catch (e) { return res.status(400).send('Bad JSON'); }

  const customerId = order.customer?.id;
  if (!customerId) return res.status(200).send('ok');

  try {
    await withCustomerLock(customerId, async () => {
      const orderId     = String(order.id);
      const orderNumber = order.order_number;

      const balanceMF = await getMetafield(customerId, 'balance');
      let balance     = balanceMF ? parseInt(balanceMF.value, 10) : 0;
      const historyMF = await getMetafield(customerId, 'history');
      let history     = [];
      if (historyMF) { try { history = JSON.parse(historyMF.value); } catch {} }

      let pointsDeducted = 0;
      let pointsCredited = 0;

      const earnEntry = history.find(h => h.type === 'earn' && String(h.order_id) === orderId && !h.reversed);
      if (earnEntry) {
        pointsDeducted             = earnEntry.points;
        earnEntry.reversed         = true;
        earnEntry.remaining_points = 0;
        balance                    = Math.max(0, balance - pointsDeducted);
        console.log(`[order-cancelled] Reversing ${pointsDeducted} earned pts`);
      }

      const rwrdCodes = (order.discount_codes || [])
        .filter(d => d.code?.startsWith('RWRD-'))
        .map(d => Math.round(parseFloat(d.amount)));

      if (rwrdCodes.length > 0) {
        const refundPts = rwrdCodes.reduce((sum, a) => sum + a, 0);
        const useEntry  = history.find(h => h.type === 'use' && h.points === refundPts && !h.refunded);
        if (useEntry) {
          restoreFIFO(history, useEntry.consumed_from);
          pointsCredited    = refundPts;
          useEntry.refunded = true;
          balance          += pointsCredited;
          console.log(`[order-cancelled] Crediting back ${pointsCredited} redeemed pts`);
        }
      }

      if (pointsDeducted === 0 && pointsCredited === 0) {
        console.log(`[order-cancelled] Order #${orderNumber}: no points to adjust`);
        res.status(200).send('ok');
        return;
      }

      const parts = [];
      if (pointsDeducted > 0) parts.push(`−${pointsDeducted} pts earned reversed`);
      if (pointsCredited > 0) parts.push(`+${pointsCredited} pts redeemed refunded`);

      history.unshift({
        type: pointsCredited >= pointsDeducted ? 'earn' : 'use', id: generateEntryId(),
        description: `Order #${orderNumber} cancelled: ${parts.join(', ')}`,
        points: pointsCredited - pointsDeducted, created_at: new Date().toISOString(),
        order_id: orderId, is_adjustment: true
      });

      await Promise.all([
        setMetafield(customerId, 'balance', balance, 'integer'),
        setMetafield(customerId, 'history', history, 'json')
      ]);

      console.log(`[order-cancelled] Done. New balance: ${balance}`);

      const codesToDelete = (order.discount_codes || []).filter(d => d.code?.startsWith('RWRD-'));
      for (const d of codesToDelete) {
        await deleteRwrdCode(d.code);
        unregisterPendingApply(customerId, d.code);
      }

      res.status(200).send('ok');
    });
  } catch (e) {
    console.error('[order-cancelled]', e.message);
    res.status(500).send('error');
  }
});

/* ─────────────────────────────────────────
   WEBHOOK: POST /api/webhook/refund-created
   Known residual edge case, flagged not fixed: the partial-refund branch
   below claws back a share of the ORIGINAL earn entry based on refund
   ratio, independent of whether some of that entry's points were already
   spent elsewhere via FIFO consumption. If a customer redeems from this
   entry, then this SAME order later gets partially refunded, the clawback
   math and the FIFO-consumed remainder can both compete for the same
   entry's remaining_points. balance is always adjusted correctly either
   way; the entry-level attribution in that specific overlap can be
   imprecise. Rare in practice — requires redemption from an entry before
   a later partial refund of that entry's own originating order.
   ───────────────────────────────────────── */
app.post('/api/webhook/refund-created', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!verifyHmac(req)) return res.status(401).send('Unauthorized');

  let refund;
  try { refund = parseWebhookBody(req); }
  catch (e) { return res.status(400).send('Bad JSON'); }

  const orderId = String(refund.order_id);
  let order;
  try {
    const data = await shopifyFetch(
      `/orders/${orderId}.json?fields=id,order_number,total_price,discount_codes,financial_status,customer`
    );
    order = data.order;
  } catch (e) {
    console.error('[refund-created] Could not fetch order:', e.message);
    return res.status(500).send('error');
  }

  const customerId = order.customer?.id;
  if (!customerId) return res.status(200).send('ok');

  try {
    await withCustomerLock(customerId, async () => {
      const orderNumber   = order.order_number;
      const originalTotal = Math.round(parseFloat(order.total_price) * 100);
      const refundAmount  = Math.round(
        (refund.transactions || [])
          .filter(t => t.kind === 'refund' && t.status === 'success')
          .reduce((sum, t) => sum + parseFloat(t.amount || 0), 0) * 100
      );
      const isFullRefund = order.financial_status === 'refunded' || refundAmount >= originalTotal;

      console.log(`[refund-created] Order #${orderNumber} | refund=₹${refundAmount/100} | full=${isFullRefund}`);

      const balanceMF = await getMetafield(customerId, 'balance');
      let balance     = balanceMF ? parseInt(balanceMF.value, 10) : 0;
      const historyMF = await getMetafield(customerId, 'history');
      let history     = [];
      if (historyMF) { try { history = JSON.parse(historyMF.value); } catch {} }

      let pointsDeducted = 0;
      let pointsCredited = 0;

      const earnEntry = history.find(h => h.type === 'earn' && String(h.order_id) === orderId && !h.reversed);
      if (earnEntry && earnEntry.points > 0) {
        if (isFullRefund) {
          pointsDeducted             = earnEntry.points;
          earnEntry.reversed         = true;
          earnEntry.remaining_points = 0;
        } else {
          const ratio      = Math.min(1, refundAmount / originalTotal);
          pointsDeducted    = Math.floor(earnEntry.points * ratio);
          earnEntry.points -= pointsDeducted;
          earnEntry.remaining_points = Math.max(
            0, (earnEntry.remaining_points ?? (earnEntry.points + pointsDeducted)) - pointsDeducted
          );
        }
        balance = Math.max(0, balance - pointsDeducted);
        console.log(`[refund-created] Reversing ${pointsDeducted} pts (${isFullRefund ? 'full' : 'partial'})`);
      }

      if (isFullRefund) {
        const rwrdCodes = (order.discount_codes || [])
          .filter(d => d.code?.startsWith('RWRD-'))
          .map(d => Math.round(parseFloat(d.amount)));

        if (rwrdCodes.length > 0) {
          const refundPts = rwrdCodes.reduce((sum, a) => sum + a, 0);
          const useEntry  = history.find(h => h.type === 'use' && h.points === refundPts && !h.refunded);
          if (useEntry) {
            restoreFIFO(history, useEntry.consumed_from);
            pointsCredited    = refundPts;
            useEntry.refunded = true;
            balance          += pointsCredited;
            console.log(`[refund-created] Crediting back ${pointsCredited} redeemed pts`);
          }
        }
      }

      if (pointsDeducted === 0 && pointsCredited === 0) {
        console.log(`[refund-created] Nothing to adjust for order #${orderNumber}`);
        res.status(200).send('ok');
        return;
      }

      const parts = [];
      if (pointsDeducted > 0) parts.push(`−${pointsDeducted} pts earned reversed`);
      if (pointsCredited > 0) parts.push(`+${pointsCredited} pts redeemed refunded`);

      history.unshift({
        type: pointsCredited >= pointsDeducted ? 'earn' : 'use', id: generateEntryId(),
        description: `Order #${orderNumber} ${isFullRefund ? 'refunded' : 'partial refund'}: ${parts.join(', ')}`,
        points: pointsCredited - pointsDeducted, created_at: new Date().toISOString(),
        order_id: orderId, is_adjustment: true
      });

      await Promise.all([
        setMetafield(customerId, 'balance', balance, 'integer'),
        setMetafield(customerId, 'history', history, 'json')
      ]);

      console.log(`[refund-created] Done. New balance: ${balance}`);
      res.status(200).send('ok');
    });
  } catch (e) {
    console.error('[refund-created]', e.message);
    res.status(500).send('error');
  }
});

/* ─────────────────────────────────────────
   ADMIN AUTH + RATE LIMIT
   ───────────────────────────────────────── */
const adminAttempts = new Map();

function requireAdminAuth(req, res, next) {
  const secret = req.body?.secret ?? req.query?.secret;
  const ip     = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  const now    = Date.now();
  const window = 15 * 60 * 1000;
  const record = adminAttempts.get(ip) || { count: 0, resetAt: now + window };
  if (now > record.resetAt) { record.count = 0; record.resetAt = now + window; }
  record.count++;
  adminAttempts.set(ip, record);
  if (record.count > 5) {
    return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  }

  const ADMIN_SECRET = process.env.ADMIN_SECRET;
  if (!ADMIN_SECRET || secret !== ADMIN_SECRET) {
    console.warn(`[admin] Invalid secret from ${ip}`);
    return res.status(403).json({ error: 'Unauthorized' });
  }

  adminAttempts.delete(ip);
  next();
}

/* ─────────────────────────────────────────
   ROUTE: POST /api/admin/add-points
   ───────────────────────────────────────── */
app.post('/api/admin/add-points', requireAdminAuth, async (req, res) => {
  const { customer_id, points, expires_at, note } = req.body;

  if (!customer_id || points === undefined || !expires_at) {
    return res.status(400).json({ error: 'Required: customer_id, points, expires_at (YYYY-MM-DD)' });
  }

  const ptsInt = parseInt(points, 10);
  if (isNaN(ptsInt) || ptsInt <= 0) {
    return res.status(400).json({ error: 'points must be a positive integer' });
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(expires_at)) {
    return res.status(400).json({ error: 'expires_at must be YYYY-MM-DD' });
  }
  const expiryDate = new Date(`${expires_at}T23:59:59`);
  if (isNaN(expiryDate.getTime()) || expiryDate <= new Date()) {
    return res.status(400).json({ error: 'expires_at must be a valid future date' });
  }

  try {
    await withCustomerLock(customer_id, async () => {
      const balanceMF = await getMetafield(customer_id, 'balance');
      const current   = balanceMF ? parseInt(balanceMF.value, 10) : 0;
      const historyMF = await getMetafield(customer_id, 'history');
      let history     = [];
      if (historyMF) { try { history = JSON.parse(historyMF.value); } catch {} }

      const newBalance = current + ptsInt;

      history.unshift({
        type: 'earn', id: generateEntryId(), description: note || `${ptsInt} pts added manually`, points: ptsInt,
        remaining_points: ptsInt, created_at: new Date().toISOString(),
        expires_at: expiryDate.toISOString(), is_manual: true
      });

      await Promise.all([
        setMetafield(customer_id, 'balance', newBalance, 'integer'),
        setMetafield(customer_id, 'history', history, 'json')
      ]);

      console.log(`[admin/add-points] Customer ${customer_id}: +${ptsInt}pts → balance ${current} → ${newBalance}, expires ${expires_at}`);
      res.json({ ok: true, previous_balance: current, new_balance: newBalance, expires_at: expiryDate.toISOString() });
    });
  } catch (e) {
    console.error('[admin/add-points]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ─────────────────────────────────────────
   ROUTE: POST /api/admin/deduct-points
   Draws the deducted amount via FIFO too, keeping the invariant intact
   even though this deduction was never tied to a discount code and will
   never itself be automatically restored.
   ───────────────────────────────────────── */
app.post('/api/admin/deduct-points', requireAdminAuth, async (req, res) => {
  const { customer_id, points, note } = req.body;

  if (!customer_id || points === undefined) {
    return res.status(400).json({ error: 'Required: customer_id, points' });
  }

  const ptsInt = parseInt(points, 10);
  if (isNaN(ptsInt) || ptsInt <= 0) {
    return res.status(400).json({ error: 'points must be a positive integer' });
  }

  try {
    await withCustomerLock(customer_id, async () => {
      const balanceMF = await getMetafield(customer_id, 'balance');
      const current   = balanceMF ? parseInt(balanceMF.value, 10) : 0;
      const historyMF = await getMetafield(customer_id, 'history');
      let history     = [];
      if (historyMF) { try { history = JSON.parse(historyMF.value); } catch {} }

      const newBalance = Math.max(0, current - ptsInt);
      const consumedFrom = consumeFIFO(history, ptsInt);

      history.unshift({
        type: 'use', id: generateEntryId(), description: note || `${ptsInt} pts deducted manually`,
        points: ptsInt, created_at: new Date().toISOString(), is_manual: true, consumed_from: consumedFrom
      });

      await Promise.all([
        setMetafield(customer_id, 'balance', newBalance, 'integer'),
        setMetafield(customer_id, 'history', history, 'json')
      ]);

      console.log(`[admin/deduct-points] Customer ${customer_id}: -${ptsInt}pts → balance ${current} → ${newBalance}`);
      res.json({ ok: true, previous_balance: current, new_balance: newBalance });
    });
  } catch (e) {
    console.error('[admin/deduct-points]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ─────────────────────────────────────────
   ROUTE: POST /api/save-birthday
   ───────────────────────────────────────── */
app.post('/api/save-birthday', async (req, res) => {
  const { customer_id, birthday } = req.body;
  if (!customer_id || !birthday) return res.status(400).json({ error: 'Missing fields' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthday)) {
    return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
  }

  try {
    await setMetafield(customer_id, 'birthday', birthday, 'date');

    const [, mm] = birthday.split('-');
    const month  = String(parseInt(mm, 10));
    const custId = String(customer_id);

    await withIndexLock(async () => {
      const indexMF = await getShopMetafield('birthday_index');
      let index = {};
      if (indexMF) { try { index = JSON.parse(indexMF.value); } catch {} }

      for (const m of Object.keys(index)) {
        index[m] = (index[m] || []).filter(id => id !== custId);
      }
      index[month] = index[month] || [];
      if (!index[month].includes(custId)) index[month].push(custId);

      await setShopMetafield('birthday_index', index);
    });

    console.log(`[save-birthday] Customer ${customer_id}: saved ${birthday}, indexed under month ${month}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[save-birthday]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ─────────────────────────────────────────
   ROUTE: POST /api/admin/backfill-birthday-index
   ───────────────────────────────────────── */
let backfillRunning = false;

app.post('/api/admin/backfill-birthday-index', requireAdminAuth, async (req, res) => {
  if (backfillRunning) {
    return res.status(409).json({ error: 'Backfill already in progress. Check Railway logs for completion.' });
  }
  backfillRunning = true;

  res.json({ ok: true, status: 'backfill_started' });

  try {
    const index = {};
    let scanned = 0, indexed = 0;
    let page = `https://${SHOP}/admin/api/2025-04/customers.json?limit=250&fields=id,email`;

    while (page) {
      let res2;
      try {
        res2 = await throttledFetch(page, { headers: HEADERS });
      } catch (e) {
        console.error('[backfill] Customer page fetch failed:', e.message);
        break;
      }
      if (!res2.ok) {
        console.error('[backfill] Failed to fetch customers:', res2.status);
        break;
      }

      const data      = await res2.json();
      const customers = data.customers || [];

      for (const customer of customers) {
        scanned++;
        try {
          const bdayMF = await getMetafield(customer.id, 'birthday');
          if (!bdayMF) continue;

          const [, mm] = bdayMF.value.split('-');
          const month  = String(parseInt(mm, 10));
          const custId = String(customer.id);

          index[month] = index[month] || [];
          if (!index[month].includes(custId)) index[month].push(custId);
          indexed++;
        } catch (e) {
          console.error(`[backfill] Error reading birthday for customer ${customer.id}:`, e.message);
        }
      }

      const linkHeader = res2.headers.get('link');
      const nextMatch  = linkHeader?.match(/<([^>]+)>;\s*rel="next"/);
      page = nextMatch ? nextMatch[1] : null;
    }

    await setShopMetafield('birthday_index', index);
    console.log(`[backfill] Finished. Scanned ${scanned} customers, indexed ${indexed} with a saved birthday.`);
  } catch (e) {
    console.error('[backfill] Failed:', e.message);
  } finally {
    backfillRunning = false;
  }
});

/* ─────────────────────────────────────────
   ROUTE: GET /api/cron/birthday
   ───────────────────────────────────────── */
const BIRTHDAY_POINTS = 100;

app.get('/api/cron/birthday', async (req, res) => {
  const { secret } = req.query;
  if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const today      = new Date();
  const todayMonth = today.getMonth() + 1;
  const thisYear   = today.getFullYear();

  if (today.getDate() !== 1) {
    return res.json({ ok: true, skipped_reason: 'not_first_of_month', date: today.toISOString().slice(0, 10) });
  }

  const monthEnd     = new Date(thisYear, todayMonth, 0, 23, 59, 59);
  const expiresAtISO = monthEnd.toISOString();

  let index = {};
  try {
    const indexMF = await getShopMetafield('birthday_index');
    if (indexMF) { try { index = JSON.parse(indexMF.value); } catch {} }
  } catch (e) {
    console.error('[cron/birthday] Failed to load birthday_index:', e.message);
    return res.status(500).json({ error: 'Could not load birthday index' });
  }

  const customerIds = index[String(todayMonth)] || [];

  res.json({ ok: true, status: 'processing_started', birth_month: todayMonth, matched: customerIds.length });

  console.log(`[cron/birthday] Started for birth-month ${todayMonth}. ${customerIds.length} customers matched. Expires ${expiresAtISO}`);

  let awarded = 0, skipped = 0, evicted = 0;
  const staleIds = [];

  for (const customerId of customerIds) {
    try {
      const historyMF = await getMetafield(customerId, 'history');
      let history = [];
      if (historyMF) { try { history = JSON.parse(historyMF.value); } catch {} }

      const alreadyAwarded = history.some(h => h.is_birthday && new Date(h.created_at).getFullYear() === thisYear);
      if (alreadyAwarded) {
        console.log(`[cron/birthday] Customer ${customerId}: already awarded this year`);
        skipped++;
        continue;
      }

      const balanceMF  = await getMetafield(customerId, 'balance');
      const balance    = balanceMF ? parseInt(balanceMF.value, 10) : 0;
      const newBalance = balance + BIRTHDAY_POINTS;

      history.unshift({
        type: 'earn', id: generateEntryId(), description: 'Birthday bonus 🎂 — expires end of this month',
        points: BIRTHDAY_POINTS, remaining_points: BIRTHDAY_POINTS,
        created_at: new Date().toISOString(), expires_at: expiresAtISO, is_birthday: true
      });

      await Promise.all([
        setMetafield(customerId, 'balance', newBalance, 'integer'),
        setMetafield(customerId, 'history', history, 'json')
      ]);

      console.log(`[cron/birthday] Customer ${customerId}: +${BIRTHDAY_POINTS} pts. Balance: ${balance} → ${newBalance}. Expires ${expiresAtISO}`);
      awarded++;
    } catch (e) {
      const looksDeleted = /error 404/i.test(e.message);
      if (looksDeleted) {
        staleIds.push(customerId);
        evicted++;
        console.log(`[cron/birthday] Customer ${customerId} not found — evicting from index`);
      } else {
        console.error(`[cron/birthday] Error for customer ${customerId}:`, e.message);
      }
    }
  }

  if (staleIds.length > 0) {
    try {
      index[String(todayMonth)] = (index[String(todayMonth)] || []).filter(id => !staleIds.includes(id));
      await withIndexLock(() => setShopMetafield('birthday_index', index));
    } catch (e) {
      console.error('[cron/birthday] Failed to persist index eviction:', e.message);
    }
  }

  console.log(`[cron/birthday] Finished. Awarded: ${awarded}, Skipped: ${skipped}, Evicted: ${evicted}`);
});

/* ── Start ── */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Rewards backend on :${PORT}`));
