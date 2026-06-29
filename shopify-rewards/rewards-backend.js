/**
 * rewards-backend.js
 *
 * Required env vars (set in Railway → Variables):
 *   SHOPIFY_SHOP          = cilvira-2.myshopify.com
 *   SHOPIFY_ACCESS_TOKEN  = shpat_xxxx
 *   SHOPIFY_API_SECRET    = xxxx  (from Shopify Admin → Settings → Notifications → Webhooks)
 *   ADMIN_SECRET          = your-chosen-password  (for /api/admin/set-points)
 *
 * Bonus coupon: FREE50
 *   Orders using this coupon earn 50% of amount paid (after discount) as points.
 *   All other orders earn 1% of amount paid (after discount).
 *   To change the coupon name, update BONUS_COUPON below and redeploy.
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
const BONUS_COUPON         = 'FREE50'; // change this to update the 50% bonus trigger
const POINTS_EXPIRY_MONTHS = 6;        // points expire 6 months after being earned

const HEADERS = {
  'X-Shopify-Access-Token': TOKEN,
  'Content-Type': 'application/json'
};

/* ─────────────────────────────────────────
   HELPERS
   ───────────────────────────────────────── */

async function shopifyFetch(path, options = {}) {
  const res = await fetch(`https://${SHOP}/admin/api/2025-04${path}`, {
    ...options,
    headers: { ...HEADERS, ...options.headers }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify API error ${res.status}: ${text}`);
  }
  // DELETE returns 204 No Content — don't parse
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
  const body = {
    metafield: {
      namespace: 'rewards',
      key,
      value: type === 'json' ? JSON.stringify(value) : String(value),
      type:  type === 'json' ? 'json' : 'number_integer'
    }
  };
  if (existing) {
    return shopifyFetch(`/metafields/${existing.id}.json`, {
      method: 'PUT',
      body: JSON.stringify(body)
    });
  }
  return shopifyFetch(`/customers/${customerId}/metafields.json`, {
    method: 'POST',
    body: JSON.stringify(body)
  });
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
    const data = await shopifyFetch(
      `/discount_codes/lookup.json?code=${encodeURIComponent(code)}`
    );
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
   Checks history for expired earn entries, deducts expired points
   from balance, marks entries as expired.
   Returns { balance, history, expired } — expired = pts removed this call.
   Called on every /api/points GET so expiry is always up to date.
   ───────────────────────────────────────── */
async function processExpiry(customerId, balance, history) {
  const now              = Date.now();
  let   expiredPoints    = 0;
  let   historyChanged   = false;

  for (const entry of history) {
    // Only expire earn entries that haven't already expired or been reversed
    if (
      entry.type        !== 'earn' ||
      entry.expired     === true   ||
      entry.reversed    === true   ||
      !entry.expires_at
    ) continue;

    const expiresAt = new Date(entry.expires_at).getTime();
    if (now >= expiresAt) {
      // How many points from this entry are still "live" (not already spent)
      // We track remaining points on the entry itself for accuracy
      const remaining = entry.remaining_points ?? entry.points;
      if (remaining > 0) {
        expiredPoints    += remaining;
        entry.expired     = true;
        entry.remaining_points = 0;
        historyChanged    = true;
        console.log(`[expiry] ${remaining} pts expired from entry: ${entry.description}`);
      } else {
        entry.expired = true;
        historyChanged = true;
      }
    }
  }

  if (expiredPoints > 0) {
    const newBalance = Math.max(0, balance - expiredPoints);

    // Add a single expiry deduction entry to history
    history.unshift({
      type:        'use',
      description: `${expiredPoints} pts expired (6-month expiry)`,
      points:      expiredPoints,
      created_at:  new Date().toISOString(),
      is_expiry:   true
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
   ROUTE: GET /api/points
   Returns balance + history for a customer.
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

    // Run expiry check on every load — no cron job needed
    const result = await processExpiry(customer_id, balance, history);
    balance = result.balance;
    history = result.history;

    res.json({ balance, history: history.slice(0, 20), is_first_order: false });
  } catch (e) {
    console.error('[points GET]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ─────────────────────────────────────────
   ROUTE: GET /api/check-code
   Verifies a RWRD- discount code is still valid and unused.
   ───────────────────────────────────────── */
app.get('/api/check-code', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ valid: false, error: 'Missing code' });

  try {
    const data        = await shopifyFetch(`/discount_codes/lookup.json?code=${encodeURIComponent(code)}`);
    const dc          = data.discount_code;
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
   Creates a one-time discount code for points redemption.
   ───────────────────────────────────────── */
app.post('/api/apply', async (req, res) => {
  const { customer_id, points_to_use, cart_total } = req.body;
  if (!customer_id || !points_to_use) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  const ptsInt    = parseInt(points_to_use, 10);
  const cartPaise = parseInt(cart_total, 10) || 0;

  if (ptsInt <= 0) return res.status(400).json({ error: 'Invalid points' });

  // Cap: max 50% of cart value
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

    // Reuse existing unused code if created within last 30 minutes
    const existing = history.find(
      h => h.type === 'use'
        && h.points === ptsInt
        && !h.refunded
        && h.discount_code?.startsWith('RWRD-')
        && (Date.now() - new Date(h.created_at).getTime()) < 30 * 60 * 1000
    );
    if (existing) {
      console.log(`[apply] Reusing code ${existing.discount_code}`);
      return res.json({ discount_code: existing.discount_code, discount_amount: ptsInt });
    }

    // Create new price rule + discount code
    const code         = `RWRD-${customer_id}-${Date.now()}`;
    const discountData = await shopifyFetch('/price_rules.json', {
      method: 'POST',
      body: JSON.stringify({
        price_rule: {
          title:                     `Rewards redemption ${code}`,
          target_type:               'line_item',
          target_selection:          'all',
          allocation_method:         'across',
          value_type:                'fixed_amount',
          value:                     `-${ptsInt}.00`,
          customer_selection:        'prerequisite',
          prerequisite_customer_ids: [parseInt(customer_id)],
          usage_limit:               1,
          once_per_customer:         true,
          starts_at:                 new Date().toISOString()
        }
      })
    });

    await shopifyFetch(`/price_rules/${discountData.price_rule.id}/discount_codes.json`, {
      method: 'POST',
      body: JSON.stringify({ discount_code: { code } })
    });

    history.unshift({
      type:          'use',
      description:   `${ptsInt} points redeemed`,
      points:        ptsInt,
      discount_code: code,
      created_at:    new Date().toISOString()
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
   Updates an existing applied code to a new points amount.
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
    // Check if old code was already used in a completed order
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
      // Safe to delete old code and restore points
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
          title:                     `Rewards redemption ${code}`,
          target_type:               'line_item',
          target_selection:          'all',
          allocation_method:         'across',
          value_type:                'fixed_amount',
          value:                     `-${newPts}.00`,
          customer_selection:        'prerequisite',
          prerequisite_customer_ids: [parseInt(customer_id)],
          usage_limit:               1,
          once_per_customer:         true,
          starts_at:                 new Date().toISOString()
        }
      })
    });

    await shopifyFetch(`/price_rules/${discountData.price_rule.id}/discount_codes.json`, {
      method: 'POST',
      body: JSON.stringify({ discount_code: { code } })
    });

    history.unshift({
      type:          'use',
      description:   `${newPts} points redeemed`,
      points:        newPts,
      discount_code: code,
      created_at:    new Date().toISOString()
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
   Restores points when customer removes applied discount.
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
   Awards 100 welcome points to new customers on registration.
   Only credits once — checked via existing balance metafield presence.
   ───────────────────────────────────────── */
const WELCOME_POINTS = 100;

app.post('/api/webhook/customer-created', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!verifyHmac(req)) {
    console.error('[webhook/customer-created] HMAC mismatch');
    return res.status(401).send('Unauthorized');
  }

  let customer;
  try { customer = parseWebhookBody(req); }
  catch (e) { return res.status(400).send('Bad JSON'); }

  const customerId = customer.id;
  if (!customerId) return res.status(200).send('ok');

  try {
    // Check if balance metafield already exists — prevents double crediting
    const existing = await getMetafield(customerId, 'balance');
    if (existing) {
      console.log(`[customer-created] Customer ${customerId} already has points — skipping welcome bonus`);
      return res.status(200).send('ok');
    }

    const expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + POINTS_EXPIRY_MONTHS);

    const history = [{
      type:             'earn',
      description:      'Welcome bonus',
      points:           WELCOME_POINTS,
      remaining_points: WELCOME_POINTS,
      created_at:       new Date().toISOString(),
      expires_at:       expiresAt.toISOString(),
      is_welcome:       true
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
   Awards points after a completed purchase.
   Bonus coupon FREE50 → 50% of amount paid.
   All other orders → 1% of amount paid.
   ───────────────────────────────────────── */
app.post('/api/webhook/order-paid', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!verifyHmac(req)) {
    console.error('[webhook/order-paid] HMAC mismatch');
    return res.status(401).send('Unauthorized');
  }

  let order;
  try { order = parseWebhookBody(req); }
  catch (e) { return res.status(400).send('Bad JSON'); }

  const customerId = order.customer?.id;
  if (!customerId) return res.status(200).send('ok');

  try {
    const orderId = order.id;

    // Check if FREE50 bonus coupon was used
    const usedCoupons     = (order.discount_codes || []).map(d => (d.code || '').toUpperCase());
    const usedBonusCoupon = usedCoupons.includes(BONUS_COUPON.toUpperCase());

    // Amount paid in paise (after all discounts)
    const amountPaid = Math.round(parseFloat(order.total_price) * 100);

    // Points calculation
    const earnedPoints = usedBonusCoupon
      ? Math.floor(amountPaid / 100)    // 100% of amount paid
      : Math.floor(amountPaid / 10000); // 1% of amount paid

    console.log(`[order-paid] Order #${order.order_number} | paid=₹${amountPaid/100} | bonus=${usedBonusCoupon} | earns=${earnedPoints}pts`);

    const balanceMF = await getMetafield(customerId, 'balance');
    const balance   = balanceMF ? parseInt(balanceMF.value, 10) : 0;
    const historyMF = await getMetafield(customerId, 'history');
    let history     = [];
    if (historyMF) { try { history = JSON.parse(historyMF.value); } catch {} }

    const newBalance = balance + earnedPoints;

    // Calculate expiry date — 6 months from now
    const expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + POINTS_EXPIRY_MONTHS);

    history.unshift({
      type:             'earn',
      description:      `Order #${order.order_number} — ${earnedPoints} pts earned${usedBonusCoupon ? ' (50% bonus)' : ''}`,
      points:           earnedPoints,
      remaining_points: earnedPoints, // tracked for partial expiry accuracy
      created_at:       new Date().toISOString(),
      expires_at:       expiresAt.toISOString(),
      order_id:         String(orderId)
    });

    await Promise.all([
      setMetafield(customerId, 'balance', newBalance, 'integer'),
      setMetafield(customerId, 'history', history, 'json')
    ]);

    console.log(`[order-paid] Balance: ${balance} + ${earnedPoints} = ${newBalance}`);

    // Delete used RWRD- discount codes from Shopify
    const rwrdCodes = (order.discount_codes || []).filter(d => d.code?.startsWith('RWRD-'));
    for (const d of rwrdCodes) {
      await deleteRwrdCode(d.code);
    }

    res.status(200).send('ok');
  } catch (e) {
    console.error('[order-paid]', e.message);
    res.status(500).send('error');
  }
});

/* ─────────────────────────────────────────
   WEBHOOK: POST /api/webhook/order-cancelled
   Reverses earned points and refunds used points.
   ───────────────────────────────────────── */
app.post('/api/webhook/order-cancelled', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!verifyHmac(req)) {
    console.error('[webhook/order-cancelled] HMAC mismatch');
    return res.status(401).send('Unauthorized');
  }

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

    // Reverse earned points for this order
    const earnEntry = history.find(
      h => h.type === 'earn' && String(h.order_id) === orderId && !h.reversed
    );
    if (earnEntry) {
      pointsDeducted     = earnEntry.points;
      earnEntry.reversed = true;
      balance            = Math.max(0, balance - pointsDeducted);
      console.log(`[order-cancelled] Reversing ${pointsDeducted} earned pts`);
    }

    // Credit back redeemed points
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
      console.log(`[order-cancelled] Nothing to adjust for order #${orderNumber}`);
      return res.status(200).send('ok');
    }

    const parts = [];
    if (pointsDeducted > 0) parts.push(`−${pointsDeducted} pts earned reversed`);
    if (pointsCredited > 0) parts.push(`+${pointsCredited} pts redeemed refunded`);

    history.unshift({
      type:          pointsCredited >= pointsDeducted ? 'earn' : 'use',
      description:   `Order #${orderNumber} cancelled: ${parts.join(', ')}`,
      points:        pointsCredited - pointsDeducted,
      created_at:    new Date().toISOString(),
      order_id:      orderId,
      is_adjustment: true
    });

    await Promise.all([
      setMetafield(customerId, 'balance', balance, 'integer'),
      setMetafield(customerId, 'history', history, 'json')
    ]);

    console.log(`[order-cancelled] Done. New balance: ${balance}`);

    // Clean up RWRD codes
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
   Partial refund → proportional point reversal.
   Full refund    → full reversal + credit back redeemed points.
   ───────────────────────────────────────── */
app.post('/api/webhook/refund-created', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!verifyHmac(req)) {
    console.error('[webhook/refund-created] HMAC mismatch');
    return res.status(401).send('Unauthorized');
  }

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

    // Reverse earned points
    const earnEntry = history.find(
      h => h.type === 'earn' && String(h.order_id) === orderId && !h.reversed
    );
    if (earnEntry && earnEntry.points > 0) {
      if (isFullRefund) {
        pointsDeducted     = earnEntry.points;
        earnEntry.reversed = true;
      } else {
        const ratio       = Math.min(1, refundAmount / originalTotal);
        pointsDeducted    = Math.floor(earnEntry.points * ratio);
        earnEntry.points -= pointsDeducted;
      }
      balance = Math.max(0, balance - pointsDeducted);
      console.log(`[refund-created] Reversing ${pointsDeducted} pts (${isFullRefund ? 'full' : 'partial'})`);
    }

    // Credit back redeemed points on full refund only
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
      type:          pointsCredited >= pointsDeducted ? 'earn' : 'use',
      description:   `Order #${orderNumber} ${isFullRefund ? 'refunded' : 'partial refund'}: ${parts.join(', ')}`,
      points:        pointsCredited - pointsDeducted,
      created_at:    new Date().toISOString(),
      order_id:      orderId,
      is_adjustment: true
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
   ROUTE: POST /api/admin/set-points
   Manually adjust a customer's points balance.
   Protected by ADMIN_SECRET env variable.
   Body: { secret, customer_id, action, points, note }
   action: 'set' | 'add' | 'deduct'
   ───────────────────────────────────────── */
const adminAttempts = new Map();

app.post('/api/admin/set-points', async (req, res) => {
  const { secret, customer_id, action, points, note } = req.body;

  // Rate limiting: 5 attempts per IP per 15 minutes
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

  if (!customer_id || !action || points === undefined) {
    return res.status(400).json({ error: 'Missing fields: customer_id, action, points' });
  }

  const ptsInt = parseInt(points, 10);
  if (isNaN(ptsInt) || ptsInt < 0) {
    return res.status(400).json({ error: 'Invalid points value' });
  }

  try {
    const balanceMF = await getMetafield(customer_id, 'balance');
    const current   = balanceMF ? parseInt(balanceMF.value, 10) : 0;
    const historyMF = await getMetafield(customer_id, 'history');
    let history     = [];
    if (historyMF) { try { history = JSON.parse(historyMF.value); } catch {} }

    let newBalance, description;

    if (action === 'set') {
      newBalance  = ptsInt;
      description = note || `Balance set to ${ptsInt} pts`;
    } else if (action === 'add') {
      newBalance  = current + ptsInt;
      description = note || `${ptsInt} pts added`;
    } else if (action === 'deduct') {
      newBalance  = Math.max(0, current - ptsInt);
      description = note || `${ptsInt} pts deducted`;
    } else {
      return res.status(400).json({ error: 'action must be: set | add | deduct' });
    }

    const adminExpiresAt = new Date();
    adminExpiresAt.setMonth(adminExpiresAt.getMonth() + POINTS_EXPIRY_MONTHS);
    const addedPts = action === 'deduct' ? ptsInt : newBalance - current;

    history.unshift({
      type:             action === 'deduct' ? 'use' : 'earn',
      description:      description,
      points:           addedPts,
      remaining_points: action === 'deduct' ? undefined : addedPts,
      created_at:       new Date().toISOString(),
      expires_at:       action === 'deduct' ? undefined : adminExpiresAt.toISOString(),
      is_manual:        true
    });

    await Promise.all([
      setMetafield(customer_id, 'balance', newBalance, 'integer'),
      setMetafield(customer_id, 'history', history, 'json')
    ]);

    console.log(`[admin] Customer ${customer_id}: ${action} ${ptsInt}pts → balance: ${current} → ${newBalance}`);
    res.json({ ok: true, previous_balance: current, new_balance: newBalance });
  } catch (e) {
    console.error('[admin/set-points]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ── Start ── */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Rewards backend on :${PORT}`));
