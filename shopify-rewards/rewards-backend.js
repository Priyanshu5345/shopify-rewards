/**
 * rewards-backend.js
 */

const express = require('express');
const crypto  = require('crypto');
const app     = express();

// Skip global JSON parsing for ALL webhook routes — they need raw bytes for HMAC
app.use((req, res, next) => {
  if (req.path.startsWith('/api/webhook/')) return next();
  express.json()(req, res, next);
});

const SHOP   = process.env.SHOPIFY_SHOP;
const TOKEN  = process.env.SHOPIFY_ACCESS_TOKEN;
const SECRET = process.env.SHOPIFY_API_SECRET;

const HEADERS = {
  'X-Shopify-Access-Token': TOKEN,
  'Content-Type': 'application/json'
};

/* ── Shopify Admin API helper ── */
async function shopifyFetch(path, options = {}) {
  const res = await fetch(`https://${SHOP}/admin/api/2024-04${path}`, {
    ...options,
    headers: { ...HEADERS, ...options.headers }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify API error ${res.status}: ${text}`);
  }
  return res.json();
}

/* ── GET metafield ── */
async function getMetafield(customerId, key) {
  const data = await shopifyFetch(
    `/customers/${customerId}/metafields.json?namespace=rewards&key=${key}`
  );
  const mf = (data.metafields || []).find(m => m.key === key);
  return mf ? { id: mf.id, value: mf.value } : null;
}

/* ── SET metafield ── */
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

/* ── Verify Shopify webhook HMAC ── */
function verifyHmac(req) {
  const hmac    = req.headers['x-shopify-hmac-sha256'];
  const hash    = crypto.createHmac('sha256', SECRET).update(req.body).digest('base64');
  console.log(`[hmac] received: ${hmac}`);
  console.log(`[hmac] computed: ${hash}`);
  return hmac === hash;
}

/* ── Parse raw webhook body to JSON ── */
function parseWebhookBody(req) {
  return JSON.parse(req.body.toString('utf8'));
}

/* ─────────────────────────────────────────
   ROUTE: GET /api/points
   ───────────────────────────────────────── */
app.get('/api/points', async (req, res) => {
  const { customer_id } = req.query;
  if (!customer_id) return res.status(400).json({ error: 'Missing customer_id' });

  try {
    const [balanceMF, historyMF, customerData] = await Promise.all([
      getMetafield(customer_id, 'balance'),
      getMetafield(customer_id, 'history'),
      shopifyFetch(`/customers/${customer_id}.json?fields=id,orders_count`)
    ]);

    const balance = balanceMF ? parseInt(balanceMF.value, 10) : 0;
    let history = [];
    if (historyMF) { try { history = JSON.parse(historyMF.value); } catch {} }

    const isFirstOrder = (customerData.customer?.orders_count ?? 0) === 0;
    res.json({ balance, history: history.slice(0, 20), is_first_order: isFirstOrder });
  } catch (e) {
    console.error('[points GET]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ─────────────────────────────────────────
   ROUTE: POST /api/apply
   ───────────────────────────────────────── */
app.post('/api/apply', async (req, res) => {
  const { customer_id, points_to_use, cart_total } = req.body;
  if (!customer_id || !points_to_use) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  const ptsInt = parseInt(points_to_use, 10);
  if (ptsInt <= 0) return res.status(400).json({ error: 'Invalid points' });

  try {
    const balanceMF = await getMetafield(customer_id, 'balance');
    const balance   = balanceMF ? parseInt(balanceMF.value, 10) : 0;
    if (ptsInt > balance) return res.status(400).json({ error: 'Insufficient points' });

    // ── Check if an unused RWRD code already exists for this customer + amount ──
    // This prevents duplicate codes if customer goes back and clicks Apply again.
    const historyMF = await getMetafield(customer_id, 'history');
    let history = [];
    if (historyMF) { try { history = JSON.parse(historyMF.value); } catch {} }

    const existingUse = history.find(
      h => h.type === 'use'
        && h.points === ptsInt
        && !h.refunded
        && h.discount_code
        && h.discount_code.startsWith('RWRD-')
        // Only reuse if created within the last 30 minutes
        && (Date.now() - new Date(h.created_at).getTime()) < 30 * 60 * 1000
    );

    if (existingUse) {
      // Return the existing code — no new code, no balance deduction
      console.log(`[apply] Reusing existing code ${existingUse.discount_code} for customer ${customer_id}`);
      return res.json({ discount_code: existingUse.discount_code, discount_amount: ptsInt });
    }

    const code = `RWRD-${customer_id}-${Date.now()}`;
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

    const priceRuleId = discountData.price_rule.id;
    await shopifyFetch(`/price_rules/${priceRuleId}/discount_codes.json`, {
      method: 'POST',
      body: JSON.stringify({ discount_code: { code } })
    });

    // history already fetched above — reuse it
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

    res.json({ discount_code: code, discount_amount: ptsInt });
  } catch (e) {
    console.error('[apply POST]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ─────────────────────────────────────────
   ROUTE: POST /api/update-apply
   Called when customer changes points amount after already applying.
   - Deletes old price rule
   - Adjusts balance for the difference
   - Creates new price rule + code
   Body: { customer_id, old_points, old_discount_code, new_points, cart_total }
   ───────────────────────────────────────── */
app.post('/api/update-apply', async (req, res) => {
  const { customer_id, old_points, old_discount_code, new_points, cart_total } = req.body;
  if (!customer_id || !new_points || !old_discount_code) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  const oldPts = parseInt(old_points, 10);
  const newPts = parseInt(new_points, 10);
  if (newPts <= 0) return res.status(400).json({ error: 'Invalid points' });

  try {
    // 1. Delete the old price rule
    try {
      await deleteRwrdCode(old_discount_code);
    } catch (e) {
      console.error('[update-apply] Could not delete old code:', e.message);
    }

    // 2. Adjust balance for the difference
    const balanceMF = await getMetafield(customer_id, 'balance');
    let balance = balanceMF ? parseInt(balanceMF.value, 10) : 0;

    // Restore old points first, then deduct new amount
    balance = balance + oldPts - newPts;
    if (balance < 0) return res.status(400).json({ error: 'Insufficient points' });

    // 3. Create new price rule + code
    const code = `RWRD-${customer_id}-${Date.now()}`;
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

    const priceRuleId = discountData.price_rule.id;
    await shopifyFetch(`/price_rules/${priceRuleId}/discount_codes.json`, {
      method: 'POST',
      body: JSON.stringify({ discount_code: { code } })
    });

    // 4. Update history — replace old use entry with new one
    const historyMF = await getMetafield(customer_id, 'history');
    let history = [];
    if (historyMF) { try { history = JSON.parse(historyMF.value); } catch {} }

    // Remove old use entry for this code
    history = history.filter(h => !(h.type === 'use' && h.discount_code === old_discount_code));

    // Add new use entry
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

    console.log(`[update-apply] Updated: ${oldPts}pts → ${newPts}pts. New balance: ${balance}`);
    res.json({ discount_code: code, discount_amount: newPts });
  } catch (e) {
    console.error('[update-apply]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ─────────────────────────────────────────
   ROUTE: POST /api/restore
   Called when customer removes applied points from cart
   ───────────────────────────────────────── */
app.post('/api/restore', async (req, res) => {
  const { customer_id, points } = req.body;
  if (!customer_id || !points) return res.status(400).json({ error: 'Missing fields' });

  try {
    const balanceMF = await getMetafield(customer_id, 'balance');
    const balance   = balanceMF ? parseInt(balanceMF.value, 10) : 0;
    const historyMF = await getMetafield(customer_id, 'history');
    let history = [];
    if (historyMF) { try { history = JSON.parse(historyMF.value); } catch {} }

    const idx = history.findIndex(h => h.type === 'use' && h.points === parseInt(points, 10) && !h.refunded);
    if (idx > -1) history.splice(idx, 1);

    await Promise.all([
      setMetafield(customer_id, 'balance', balance + parseInt(points, 10), 'integer'),
      setMetafield(customer_id, 'history', history, 'json')
    ]);

    res.json({ ok: true });
  } catch (e) {
    console.error('[restore POST]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ─────────────────────────────────────────
   WEBHOOK: POST /api/webhook/order-paid
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
    const amountPaid   = Math.round(parseFloat(order.total_price) * 100);
    const isFirstOrder = order.customer.orders_count === 1;
    const orderId      = order.id;

    const earnedPoints = isFirstOrder
      ? Math.floor(amountPaid / 200)    // 50% of paid amount
      : Math.floor(amountPaid / 10000); // 1% of paid amount

    console.log(`[order-paid] Order #${order.order_number} | paid=₹${amountPaid/100} | firstOrder=${isFirstOrder} | earns=${earnedPoints}pts`);

    const balanceMF = await getMetafield(customerId, 'balance');
    const balance   = balanceMF ? parseInt(balanceMF.value, 10) : 0;
    const historyMF = await getMetafield(customerId, 'history');
    let history = [];
    if (historyMF) { try { history = JSON.parse(historyMF.value); } catch {} }

    history.unshift({
      type:        'earn',
      description: `Order #${order.order_number} — ${earnedPoints} pts earned`,
      points:      earnedPoints,
      created_at:  new Date().toISOString(),
      order_id:    String(orderId)
    });

    const newBalance = balance + earnedPoints;
    await Promise.all([
      setMetafield(customerId, 'balance', newBalance, 'integer'),
      setMetafield(customerId, 'history', history, 'json')
    ]);

    console.log(`[order-paid] Balance: ${balance} + ${earnedPoints} = ${newBalance}`);

    // ── Clean up used RWRD- discount codes so they don't clutter Shopify Discounts ──
    const usedCodes = (order.discount_codes || [])
      .filter(d => d.code && d.code.startsWith('RWRD-'));

    for (const d of usedCodes) {
      try {
        // Find price rule by searching discount codes
        const searchData = await shopifyFetch(
          `/discount_codes/lookup.json?code=${encodeURIComponent(d.code)}`
        );
        const priceRuleId = searchData.discount_code?.price_rule_id;
        if (priceRuleId) {
          await shopifyFetch(`/price_rules/${priceRuleId}.json`, { method: 'DELETE' });
          console.log(`[order-paid] Deleted price rule ${priceRuleId} for code ${d.code}`);
        }
      } catch (err) {
        // Non-fatal — log and continue
        console.error(`[order-paid] Could not delete discount code ${d.code}:`, err.message);
      }
    }

    res.status(200).send('ok');
  } catch (e) {
    console.error('[order-paid]', e.message);
    res.status(500).send('error');
  }
});

/* ── Helper: delete a RWRD- price rule by code ── */
async function deleteRwrdCode(code) {
  try {
    const searchData = await shopifyFetch(
      `/discount_codes/lookup.json?code=${encodeURIComponent(code)}`
    );
    const priceRuleId = searchData.discount_code?.price_rule_id;
    if (priceRuleId) {
      await shopifyFetch(`/price_rules/${priceRuleId}.json`, { method: 'DELETE' });
      console.log(`[cleanup] Deleted price rule ${priceRuleId} for ${code}`);
    }
  } catch (e) {
    console.error(`[cleanup] Could not delete ${code}:`, e.message);
  }
}

/* ─────────────────────────────────────────
   WEBHOOK: POST /api/webhook/order-cancelled
   Reverses earned points + refunds used points
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
  if (!customerId) {
    console.log('[order-cancelled] No customer on order, skipping');
    return res.status(200).send('ok');
  }

  try {
    const orderId     = String(order.id);
    const orderNumber = order.order_number;

    console.log(`[order-cancelled] Order #${orderNumber} for customer ${customerId}`);

    const balanceMF = await getMetafield(customerId, 'balance');
    let balance     = balanceMF ? parseInt(balanceMF.value, 10) : 0;
    const historyMF = await getMetafield(customerId, 'history');
    let history     = [];
    if (historyMF) { try { history = JSON.parse(historyMF.value); } catch {} }

    let pointsDeducted = 0;
    let pointsCredited = 0;

    // ── 1. Reverse earned points for this order ──
    const earnEntry = history.find(
      h => h.type === 'earn' && String(h.order_id) === orderId && !h.reversed
    );
    if (earnEntry) {
      pointsDeducted     = earnEntry.points;
      earnEntry.reversed = true;
      balance            = Math.max(0, balance - pointsDeducted);
      console.log(`[order-cancelled] Reversing ${pointsDeducted} earned pts`);
    } else {
      console.log(`[order-cancelled] No earn entry found for order_id=${orderId}`);
    }

    // ── 2. Credit back any redeemed points (RWRD- discount codes) ──
    const rwrdCodes = (order.discount_codes || [])
      .filter(d => d.code && d.code.startsWith('RWRD-'))
      .map(d => Math.round(parseFloat(d.amount)));

    if (rwrdCodes.length > 0) {
      const refundPts = rwrdCodes.reduce((sum, a) => sum + a, 0);
      const useEntry  = history.find(
        h => h.type === 'use' && h.points === refundPts && !h.refunded
      );
      if (useEntry) {
        pointsCredited    = refundPts;
        useEntry.refunded = true;
        balance          += pointsCredited;
        console.log(`[order-cancelled] Crediting back ${pointsCredited} redeemed pts`);
      } else {
        console.log(`[order-cancelled] No matching use entry for ${refundPts} pts`);
      }
    }

    if (pointsDeducted === 0 && pointsCredited === 0) {
      console.log(`[order-cancelled] Nothing to adjust for order #${orderNumber}`);
      return res.status(200).send('ok');
    }

    // ── 3. Write history entry ──
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

    // Delete any unused RWRD- codes (order cancelled before use, or used ones already cleaned by order-paid)
    const codesToDelete = (order.discount_codes || []).filter(d => d.code && d.code.startsWith('RWRD-'));
    for (const d of codesToDelete) await deleteRwrdCode(d.code);

    res.status(200).send('ok');
  } catch (e) {
    console.error('[order-cancelled]', e.message);
    res.status(500).send('error');
  }
});

/* ─────────────────────────────────────────
   WEBHOOK: POST /api/webhook/refund-created
   Partial refund → proportional point reversal
   Full refund    → full reversal + credit back redeemed points
   ───────────────────────────────────────── */
app.post('/api/webhook/refund-created', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!verifyHmac(req)) {
    console.error('[webhook/refund-created] HMAC mismatch');
    return res.status(401).send('Unauthorized');
  }

  let refund;
  try { refund = parseWebhookBody(req); }
  catch (e) { return res.status(400).send('Bad JSON'); }

  // refund payload has order_id but not full order — fetch it
  const orderId = String(refund.order_id);
  let order;
  try {
    const orderData = await shopifyFetch(
      `/orders/${orderId}.json?fields=id,order_number,total_price,discount_codes,financial_status,customer`
    );
    order = orderData.order;
  } catch (e) {
    console.error('[refund-created] Could not fetch order:', e.message);
    return res.status(500).send('error');
  }

  const customerId = order.customer?.id;
  if (!customerId) return res.status(200).send('ok');

  try {
    const orderNumber   = order.order_number;
    const originalTotal = Math.round(parseFloat(order.total_price) * 100);

    // Sum successful refund transactions
    const refundAmount = Math.round(
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

    // ── Reverse earned points ──
    const earnEntry = history.find(
      h => h.type === 'earn' && String(h.order_id) === orderId && !h.reversed
    );
    if (earnEntry && earnEntry.points > 0) {
      if (isFullRefund) {
        pointsDeducted     = earnEntry.points;
        earnEntry.reversed = true;
      } else {
        // Proportional reversal
        const ratio       = Math.min(1, refundAmount / originalTotal);
        pointsDeducted    = Math.floor(earnEntry.points * ratio);
        earnEntry.points -= pointsDeducted;
      }
      balance = Math.max(0, balance - pointsDeducted);
      console.log(`[refund-created] Reversing ${pointsDeducted} earned pts`);
    }

    // ── Credit back redeemed points on full refund only ──
    if (isFullRefund) {
      const rwrdCodes = (order.discount_codes || [])
        .filter(d => d.code && d.code.startsWith('RWRD-'))
        .map(d => Math.round(parseFloat(d.amount)));

      if (rwrdCodes.length > 0) {
        const refundPts = rwrdCodes.reduce((sum, a) => sum + a, 0);
        const useEntry  = history.find(
          h => h.type === 'use' && h.points === refundPts && !h.refunded
        );
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

/* ── Start ── */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Rewards backend on :${PORT}`);


});
