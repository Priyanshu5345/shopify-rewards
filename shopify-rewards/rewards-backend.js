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
 * Points expiry: every earn-type credit (purchase, welcome, birthday, manual)
 *   carries its own expires_at and expires independently, 6 months after credit
 *   by default. Manual credits require an explicit expires_at.
 *
 * Birthday points — INDEX-BACKED: see rewards/birthday_index shop metafield.
 *   Backfill once via /api/admin/backfill-birthday-index, then the monthly
 *   cron reads only the index — never the full customer list.
 *
 * Stale applied-points recovery: a customer can apply points on the cart
 *   page, which immediately deducts balance and creates a one-time Shopify
 *   discount code — BEFORE any order exists. If they abandon checkout before
 *   paying, no order-cancelled or refund-created webhook ever fires (no order
 *   was created), so nothing would otherwise restore those points. GET
 *   /api/points — already called on every cart-page load — now also checks
 *   for applied codes older than STALE_APPLY_MS that were never actually used
 *   in a completed order, restores the points, and deletes the unused
 *   Shopify price rule/discount code. This uses the exact same
 *   delete-then-credit sequence as the customer-initiated /api/restore route.
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

// How long an applied-but-unused RWRD- code is given before it's treated as
// abandoned. Used both for /api/apply's "reuse an existing code" check and
// for the auto-restore sweep in GET /api/points — one constant, so the two
// can't silently drift apart. Front-end localStorage windows in
// rewards-panel.js should be kept in sync with this value.
const STALE_APPLY_MS = 30 * 60 * 1000; // 30 minutes

const HEADERS = {
  'X-Shopify-Access-Token': TOKEN,
  'Content-Type': 'application/json'
};

/* ─────────────────────────────────────────
   RATE LIMITER
   ───────────────────────────────────────── */
const MIN_INTERVAL_MS = 550; // ≈1.8 req/sec, under Shopify's 2/sec ceiling
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
   HELPERS — shop-level metafields (used for the birthday index)
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
   IN-PROCESS INDEX LOCK
   Serializes concurrent birthday_index read-modify-writes on this single
   process. Does not protect against multiple horizontally-scaled instances.
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

async function deleteRwrdCode(code) {
  try {
    const data = await shopifyFetch(`/discount_codes/lookup.json?code=${encodeURIComponent(code)}`);
    const priceRuleId = data.discount_code?.price_rule_id;
    if (priceRuleId) {
      await shopifyFetch(`/price_rules/${priceRuleId}.json`, { method: 'DELETE' });
      console.log(`[cleanup] Deleted price rule ${priceRuleId} for ${code}`);
    }
  } catch (e) {
    console.error(`[cleanup] Could not delete ${code}:`, e.message);
  }
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
      type: 'use', description: `${expiredPoints} pts expired (6-month expiry)`,
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
   STALE APPLIED-POINTS RECOVERY
   Finds 'use' entries with an RWRD- discount code, not yet refunded, older
   than STALE_APPLY_MS. For each, checks Shopify directly whether the code
   was ever actually used in a completed order:
     - usage_count === 0 → genuinely abandoned. Delete the unused price rule
       (same call /api/restore already makes), remove the history entry
       entirely (matches /api/restore's semantics — nothing ever happened),
       and credit the points back to balance.
     - usage_count > 0   → an order WAS placed with this code. Leave it
       alone; order-paid already accounts for it correctly elsewhere.
   A lookup failure (code already gone, network hiccup) is treated as
   "nothing to restore" rather than surfaced as an error — consistent with
   how /api/check-code already fails safe on the same kind of lookup.
   ───────────────────────────────────────── */
async function restoreStaleAppliedCodes(customerId, balance, history) {
  const now = Date.now();
  let changed = false;

  const staleEntries = history.filter(h =>
    h.type === 'use' &&
    !h.refunded &&
    h.discount_code?.startsWith('RWRD-') &&
    (now - new Date(h.created_at).getTime()) > STALE_APPLY_MS
  );

  for (const entry of staleEntries) {
    try {
      const lookup = await shopifyFetch(`/discount_codes/lookup.json?code=${encodeURIComponent(entry.discount_code)}`);
      const priceRuleId = lookup.discount_code?.price_rule_id;

      let usageCount = 0;
      if (priceRuleId) {
        const codeData = await shopifyFetch(`/price_rules/${priceRuleId}/discount_codes.json`);
        const codeObj  = (codeData.discount_codes || []).find(c => c.code === entry.discount_code);
        usageCount = codeObj?.usage_count ?? 0;
      }

      if (usageCount === 0) {
        if (priceRuleId) {
          await shopifyFetch(`/price_rules/${priceRuleId}.json`, { method: 'DELETE' });
          console.log(`[auto-restore] Deleted unused price rule ${priceRuleId} (${entry.discount_code})`);
        }
        balance += entry.points;
        history  = history.filter(h => h !== entry);
        changed  = true;
        console.log(`[auto-restore] Customer ${customerId}: restored ${entry.points}pts from abandoned checkout (${entry.discount_code})`);
      }
      // usageCount > 0 means an order actually completed with this code —
      // nothing stale about it, leave it exactly as-is.
    } catch (e) {
      console.log(`[auto-restore] Could not verify ${entry.discount_code}, skipping: ${e.message}`);
    }
  }

  return { balance, history, changed };
}

/* ─────────────────────────────────────────
   ROUTE: GET /api/points
   Runs expiry, THEN the stale-applied-points sweep, writing back once
   if either made a change. Both are lazy checks — no cron needed — since
   this route is already called on every cart-page load.
   ───────────────────────────────────────── */
app.get('/api/points', async (req, res) => {
  const { customer_id } = req.query;
  if (!customer_id) return res.status(400).json({ error: 'Missing customer_id' });

  try {
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
    const balanceMF = await getMetafield(customer_id, 'balance');
    const balance   = balanceMF ? parseInt(balanceMF.value, 10) : 0;
    if (ptsInt > balance) return res.status(400).json({ error: 'Insufficient points' });

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
      return res.json({ discount_code: existing.discount_code, discount_amount: ptsInt });
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

    history.unshift({
      type: 'use', description: `${ptsInt} points redeemed`, points: ptsInt,
      discount_code: code, created_at: new Date().toISOString()
    });

    await Promise.all([
      setMetafield(customer_id, 'balance', balance - ptsInt, 'integer'),
      setMetafield(customer_id, 'history', history, 'json')
    ]);

    console.log(`[apply] Customer ${customer_id}: ${ptsInt}pts → code ${code}`);
    res.json({ discount_code: code, discount_amount: ptsInt });
  } catch (e) {
    console.error('[apply]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ─────────────────────────────────────────
   ROUTE: POST /api/update-apply
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
    let oldCodeWasUsed = false;
    try {
      const searchData  = await shopifyFetch(`/discount_codes/lookup.json?code=${encodeURIComponent(old_discount_code)}`);
      const priceRuleId = searchData.discount_code?.price_rule_id;
      if (priceRuleId) {
        const codeData = await shopifyFetch(`/price_rules/${priceRuleId}/discount_codes.json`);
        const codeObj  = (codeData.discount_codes || []).find(c => c.code === old_discount_code);
        oldCodeWasUsed = codeObj ? codeObj.usage_count > 0 : false;
      }
    } catch (e) {
      console.log(`[update-apply] Old code lookup failed: ${e.message}`);
    }

    const balanceMF = await getMetafield(customer_id, 'balance');
    let balance     = balanceMF ? parseInt(balanceMF.value, 10) : 0;
    const historyMF = await getMetafield(customer_id, 'history');
    let history     = [];
    if (historyMF) { try { history = JSON.parse(historyMF.value); } catch {} }

    if (!oldCodeWasUsed) {
      try { await deleteRwrdCode(old_discount_code); } catch {}
      balance = balance + oldPts;
      history = history.filter(h => !(h.type === 'use' && h.discount_code === old_discount_code));
      console.log(`[update-apply] Old code unused — restored ${oldPts}pts`);
    } else {
      console.log(`[update-apply] Old code was used — cannot restore ${oldPts}pts`);
    }

    balance = balance - newPts;
    if (balance < 0) return res.status(400).json({ error: 'Insufficient points' });

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

    history.unshift({
      type: 'use', description: `${newPts} points redeemed`, points: newPts,
      discount_code: code, created_at: new Date().toISOString()
    });

    await Promise.all([
      setMetafield(customer_id, 'balance', balance, 'integer'),
      setMetafield(customer_id, 'history', history, 'json')
    ]);

    console.log(`[update-apply] ${oldPts}→${newPts}pts. Balance=${balance}`);
    res.json({ discount_code: code, discount_amount: newPts });
  } catch (e) {
    console.error('[update-apply]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ─────────────────────────────────────────
   ROUTE: POST /api/restore
   Customer-initiated instant restore — identical delete-then-credit
   sequence to the automatic sweep above.
   ───────────────────────────────────────── */
app.post('/api/restore', async (req, res) => {
  const { customer_id, points, discount_code } = req.body;
  if (!customer_id || !points) return res.status(400).json({ error: 'Missing fields' });

  const pts = parseInt(points, 10);

  try {
    let codeWasUsed = false;
    if (discount_code) {
      try {
        const searchData  = await shopifyFetch(`/discount_codes/lookup.json?code=${encodeURIComponent(discount_code)}`);
        const priceRuleId = searchData.discount_code?.price_rule_id;
        if (priceRuleId) {
          const codeData = await shopifyFetch(`/price_rules/${priceRuleId}/discount_codes.json`);
          const codeObj  = (codeData.discount_codes || []).find(c => c.code === discount_code);
          codeWasUsed    = codeObj ? codeObj.usage_count > 0 : false;
          if (!codeWasUsed) {
            await shopifyFetch(`/price_rules/${priceRuleId}.json`, { method: 'DELETE' });
            console.log(`[restore] Deleted unused price rule ${priceRuleId}`);
          }
        }
      } catch (e) {
        console.log(`[restore] Code lookup failed: ${e.message}`);
      }
    }

    const balanceMF = await getMetafield(customer_id, 'balance');
    const balance   = balanceMF ? parseInt(balanceMF.value, 10) : 0;
    const historyMF = await getMetafield(customer_id, 'history');
    let history     = [];
    if (historyMF) { try { history = JSON.parse(historyMF.value); } catch {} }

    if (!codeWasUsed) {
      history = history.filter(h => !(h.type === 'use' && h.discount_code === discount_code));
      await Promise.all([
        setMetafield(customer_id, 'balance', balance + pts, 'integer'),
        setMetafield(customer_id, 'history', history, 'json')
      ]);
      console.log(`[restore] Restored ${pts}pts. New balance: ${balance + pts}`);
    } else {
      console.log(`[restore] Code was used — points not restored`);
    }

    res.json({ ok: true, restored: !codeWasUsed });
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
    const existing = await getMetafield(customerId, 'balance');
    if (existing) {
      console.log(`[customer-created] Customer ${customerId} already has points — skipping welcome bonus`);
      return res.status(200).send('ok');
    }

    const expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + POINTS_EXPIRY_MONTHS);

    const history = [{
      type: 'earn', description: 'Welcome bonus', points: WELCOME_POINTS,
      remaining_points: WELCOME_POINTS, created_at: new Date().toISOString(),
      expires_at: expiresAt.toISOString(), is_welcome: true
    }];

    await Promise.all([
      setMetafield(customerId, 'balance', WELCOME_POINTS, 'integer'),
      setMetafield(customerId, 'history', history, 'json')
    ]);

    console.log(`[customer-created] Customer ${customerId} (${customer.email}) — ${WELCOME_POINTS} welcome pts credited`);
    res.status(200).send('ok');
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

  try {
    const orderId = order.id;

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

    const newBalance = balance + earnedPoints;
    const expiresAt   = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + POINTS_EXPIRY_MONTHS);

    history.unshift({
      type: 'earn',
      description: `Order #${order.order_number} — ${earnedPoints} pts earned${usedBonusCoupon ? ' (100% bonus)' : ''}`,
      points: earnedPoints, remaining_points: earnedPoints,
      created_at: new Date().toISOString(), expires_at: expiresAt.toISOString(),
      order_id: String(orderId)
    });

    await Promise.all([
      setMetafield(customerId, 'balance', newBalance, 'integer'),
      setMetafield(customerId, 'history', history, 'json')
    ]);

    console.log(`[order-paid] Balance: ${balance} + ${earnedPoints} = ${newBalance}`);

    const rwrdCodes = (order.discount_codes || []).filter(d => d.code?.startsWith('RWRD-'));
    for (const d of rwrdCodes) await deleteRwrdCode(d.code);

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
        pointsCredited    = refundPts;
        useEntry.refunded = true;
        balance          += pointsCredited;
        console.log(`[order-cancelled] Crediting back ${pointsCredited} redeemed pts`);
      }
    }

    if (pointsDeducted === 0 && pointsCredited === 0) {
      console.log(`[order-cancelled] Order #${orderNumber}: no points to adjust`);
      return res.status(200).send('ok');
    }

    const parts = [];
    if (pointsDeducted > 0) parts.push(`−${pointsDeducted} pts earned reversed`);
    if (pointsCredited > 0) parts.push(`+${pointsCredited} pts redeemed refunded`);

    history.unshift({
      type: pointsCredited >= pointsDeducted ? 'earn' : 'use',
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
    for (const d of codesToDelete) await deleteRwrdCode(d.code);

    res.status(200).send('ok');
  } catch (e) {
    console.error('[order-cancelled]', e.message);
    res.status(500).send('error');
  }
});

/* ─────────────────────────────────────────
   WEBHOOK: POST /api/webhook/refund-created
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
          pointsCredited    = refundPts;
          useEntry.refunded = true;
          balance          += pointsCredited;
          console.log(`[refund-created] Crediting back ${pointsCredited} redeemed pts`);
        }
      }
    }

    if (pointsDeducted === 0 && pointsCredited === 0) {
      console.log(`[refund-created] Nothing to adjust for order #${orderNumber}`);
      return res.status(200).send('ok');
    }

    const parts = [];
    if (pointsDeducted > 0) parts.push(`−${pointsDeducted} pts earned reversed`);
    if (pointsCredited > 0) parts.push(`+${pointsCredited} pts redeemed refunded`);

    history.unshift({
      type: pointsCredited >= pointsDeducted ? 'earn' : 'use',
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
    const balanceMF = await getMetafield(customer_id, 'balance');
    const current   = balanceMF ? parseInt(balanceMF.value, 10) : 0;
    const historyMF = await getMetafield(customer_id, 'history');
    let history     = [];
    if (historyMF) { try { history = JSON.parse(historyMF.value); } catch {} }

    const newBalance = current + ptsInt;

    history.unshift({
      type: 'earn', description: note || `${ptsInt} pts added manually`, points: ptsInt,
      remaining_points: ptsInt, created_at: new Date().toISOString(),
      expires_at: expiryDate.toISOString(), is_manual: true
    });

    await Promise.all([
      setMetafield(customer_id, 'balance', newBalance, 'integer'),
      setMetafield(customer_id, 'history', history, 'json')
    ]);

    console.log(`[admin/add-points] Customer ${customer_id}: +${ptsInt}pts → balance ${current} → ${newBalance}, expires ${expires_at}`);
    res.json({ ok: true, previous_balance: current, new_balance: newBalance, expires_at: expiryDate.toISOString() });
  } catch (e) {
    console.error('[admin/add-points]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ─────────────────────────────────────────
   ROUTE: POST /api/admin/deduct-points
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
    const balanceMF = await getMetafield(customer_id, 'balance');
    const current   = balanceMF ? parseInt(balanceMF.value, 10) : 0;
    const historyMF = await getMetafield(customer_id, 'history');
    let history     = [];
    if (historyMF) { try { history = JSON.parse(historyMF.value); } catch {} }

    const newBalance = Math.max(0, current - ptsInt);

    history.unshift({
      type: 'use', description: note || `${ptsInt} pts deducted manually`,
      points: ptsInt, created_at: new Date().toISOString(), is_manual: true
    });

    await Promise.all([
      setMetafield(customer_id, 'balance', newBalance, 'integer'),
      setMetafield(customer_id, 'history', history, 'json')
    ]);

    console.log(`[admin/deduct-points] Customer ${customer_id}: -${ptsInt}pts → balance ${current} → ${newBalance}`);
    res.json({ ok: true, previous_balance: current, new_balance: newBalance });
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
        type: 'earn', description: 'Birthday bonus 🎂 — expires end of this month',
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
