/**
 * rewards-backend.js
 * 
 * Minimal Express.js App Proxy server.
 * Deploy to Railway, Render, Vercel, or any Node host.
 * 
 * Shopify App Proxy config:
 *   Subpath prefix:  rewards
 *   Proxy URL:       https://your-backend.example.com/api
 *   → /apps/rewards/points  calls  https://your-backend.example.com/api/points
 * 
 * Required env vars:
 *   SHOPIFY_SHOP          = yourstore.myshopify.com
 *   SHOPIFY_ACCESS_TOKEN  = shpat_xxxx   (from private app or custom app)
 *   SHOPIFY_API_SECRET    = xxxx         (for webhook HMAC verification)
 * 
 * Customer metafields used (namespace: rewards):
 *   balance  (integer)  – current points balance
 *   history  (json)     – array of { type, description, points, created_at }
 */

const express = require('express');
const crypto  = require('crypto');
const app     = express();

// Parse JSON for all routes EXCEPT the webhook (which needs raw bytes for HMAC)
app.use((req, res, next) => {
  if (req.path === '/api/webhook/order-paid') return next();
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

/* ── GET metafield value for a customer ── */
async function getMetafield(customerId, key) {
  const data = await shopifyFetch(
    `/customers/${customerId}/metafields.json?namespace=rewards&key=${key}`
  );
  const mf = (data.metafields || []).find(m => m.key === key);
  return mf ? { id: mf.id, value: mf.value } : null;
}

/* ── SET (create or update) a metafield ── */
async function setMetafield(customerId, key, value, type = 'integer') {
  const existing = await getMetafield(customerId, key);
  const body = {
    metafield: {
      namespace: 'rewards',
      key,
      value: type === 'json' ? JSON.stringify(value) : String(value),
      type: type === 'json' ? 'json' : 'number_integer'
    }
  };

  if (existing) {
    return shopifyFetch(`/metafields/${existing.id}.json`, {
      method: 'PUT',
      body: JSON.stringify(body)
    });
  } else {
    return shopifyFetch(`/customers/${customerId}/metafields.json`, {
      method: 'POST',
      body: JSON.stringify(body)
    });
  }
}

/* ─────────────────────────────────────────
   ROUTE: GET /api/points?customer_id=X
   Returns balance + history + is_first_order
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
    if (historyMF) {
      try { history = JSON.parse(historyMF.value); } catch {}
    }

    const isFirstOrder = (customerData.customer?.orders_count ?? 0) === 0;

    res.json({ balance, history: history.slice(0, 20), is_first_order: isFirstOrder });
  } catch (e) {
    console.error('[points GET]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ─────────────────────────────────────────
   ROUTE: POST /api/apply
   Creates a Shopify discount code for the
   exact rupee amount of points redeemed.
   Body: { customer_id, points_to_use, cart_total }
   ───────────────────────────────────────── */
app.post('/api/apply', async (req, res) => {
  const { customer_id, points_to_use, cart_total } = req.body;
  if (!customer_id || !points_to_use) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  const ptsInt = parseInt(points_to_use, 10);
  if (ptsInt <= 0) return res.status(400).json({ error: 'Invalid points' });

  try {
    // 1. Verify balance is sufficient
    const balanceMF = await getMetafield(customer_id, 'balance');
    const balance = balanceMF ? parseInt(balanceMF.value, 10) : 0;
    if (ptsInt > balance) return res.status(400).json({ error: 'Insufficient points' });

    // 2. Create a one-time discount code
    const code = `RWRD-${customer_id}-${Date.now()}`;
    const discountData = await shopifyFetch('/price_rules.json', {
      method: 'POST',
      body: JSON.stringify({
        price_rule: {
          title:                   `Rewards redemption ${code}`,
          target_type:             'line_item',
          target_selection:        'all',
          allocation_method:       'across',
          value_type:              'fixed_amount',
          value:                   `-${ptsInt}.00`,          // ₹ amount
          customer_selection:      'prerequisite',
          prerequisite_customer_ids: [parseInt(customer_id)],
          usage_limit:             1,
          once_per_customer:       true,
          starts_at:               new Date().toISOString()
        }
      })
    });

    const priceRuleId = discountData.price_rule.id;

    await shopifyFetch(`/price_rules/${priceRuleId}/discount_codes.json`, {
      method: 'POST',
      body: JSON.stringify({ discount_code: { code } })
    });

    // 3. Temporarily deduct points (confirmed on order webhook)
    const newBalance = balance - ptsInt;
    const historyMF  = await getMetafield(customer_id, 'history');
    let history = [];
    if (historyMF) { try { history = JSON.parse(historyMF.value); } catch {} }

    history.unshift({
      type:        'use',
      description: `${ptsInt} points redeemed`,
      points:      ptsInt,
      created_at:  new Date().toISOString()
    });

    await Promise.all([
      setMetafield(customer_id, 'balance', newBalance, 'integer'),
      setMetafield(customer_id, 'history', history,    'json')
    ]);

    res.json({ discount_code: code, discount_amount: ptsInt });
  } catch (e) {
    console.error('[apply POST]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ─────────────────────────────────────────
   ROUTE: POST /api/webhook/order-paid
   Called by Shopify order-paid webhook.
   Awards points on completed purchase.
   ───────────────────────────────────────── */
/* ── Webhook needs raw body for HMAC — add rawBody middleware before routes ── */
app.post('/api/webhook/order-paid', express.raw({ type: 'application/json' }), async (req, res) => {
  // Verify HMAC using RAW body bytes (not re-serialized JSON)
  const hmac    = req.headers['x-shopify-hmac-sha256'];
  const rawBody = req.body; // Buffer, because of express.raw()
  const hash    = crypto.createHmac('sha256', SECRET).update(rawBody).digest('base64');

  console.log('[webhook] received hmac:', hmac);
  console.log('[webhook] computed hash:', hash);
  console.log('[webhook] secret first6:', SECRET ? SECRET.slice(0,6) + '...' : 'MISSING');

  if (hash !== hmac) {
    console.error('[webhook] HMAC mismatch — check SHOPIFY_API_SECRET');
    return res.status(401).send('Unauthorized');
  }

  let order;
  try {
    order = JSON.parse(rawBody.toString('utf8'));
  } catch (e) {
    return res.status(400).send('Bad JSON');
  }

  const customerId = order.customer?.id;
  if (!customerId) return res.status(200).send('ok');

  try {
    // Use total_price as what customer actually paid (already has discount applied)
    const amountPaid     = Math.round(parseFloat(order.total_price) * 100);   // paise
    const discountAmount = Math.round(parseFloat(order.total_discounts || 0) * 100); // paise
    const isFirstOrder   = order.customer.orders_count === 1;
    const orderId        = order.id;

    console.log(`[webhook] Order #${order.order_number} | paid=₹${amountPaid/100} | discount=₹${discountAmount/100} | firstOrder=${isFirstOrder}`);

    // Points earning rule
    // First order: 50% of amount paid
    // Other orders: 1% of amount paid (discount already reflected in total_price)
    let earnedPoints;
    if (isFirstOrder) {
      earnedPoints = Math.floor(amountPaid / 200);   // 50% → paise/200 = rupees*0.5
    } else {
      earnedPoints = Math.floor(amountPaid / 10000); // 1%  → paise/10000 = rupees*0.01
    }
    earnedPoints = Math.max(0, earnedPoints); // never negative

    console.log(`[webhook] Customer ${customerId} earns ${earnedPoints} pts`);

    // Always update — even if earnedPoints is 0, we log it
    const balanceMF = await getMetafield(customerId, 'balance');
    const balance   = balanceMF ? parseInt(balanceMF.value, 10) : 0;
    const historyMF = await getMetafield(customerId, 'history');
    let history = [];
    if (historyMF) { try { history = JSON.parse(historyMF.value); } catch {} }

    const newBalance = balance + earnedPoints;

    history.unshift({
      type:        'earn',
      description: `Order #${order.order_number} — ${earnedPoints} pts earned`,
      points:      earnedPoints,
      created_at:  new Date().toISOString(),
      order_id:    orderId
    });

    await Promise.all([
      setMetafield(customerId, 'balance', newBalance, 'integer'),
      setMetafield(customerId, 'history', history, 'json')
    ]);

    console.log(`[webhook] Balance updated: ${balance} + ${earnedPoints} = ${newBalance}`);

    res.status(200).send('ok');
  } catch (e) {
    console.error('[webhook order-paid]', e.message);
    res.status(500).send('error');
  }
});


/* ─────────────────────────────────────────
   SHARED HELPER — process a cancellation or refund on an order.

   Logic:
   - Find the original "earn" history entry for this order_id
     → DEDUCT those earned points (they were based on money now returned)
   - Find any "use" history entry for this order_id
     → CREDIT those points back (customer paid with points, now refunded)
   - Write a clear history entry for both actions
   - Never let balance go below 0
   ───────────────────────────────────────── */
async function processRefundOrCancel(customerId, order, reason) {
  const orderId     = order.id;
  const orderNumber = order.order_number;

  const balanceMF = await getMetafield(customerId, 'balance');
  let balance     = balanceMF ? parseInt(balanceMF.value, 10) : 0;

  const historyMF = await getMetafield(customerId, 'history');
  let history     = [];
  if (historyMF) { try { history = JSON.parse(historyMF.value); } catch {} }

  let pointsDeducted = 0; // earned points to take back
  let pointsCredited = 0; // used points to give back
  let changed        = false;

  // ── 1. Find earned points for this order and reverse them ──
  const earnEntry = history.find(
    h => h.type === 'earn' && String(h.order_id) === String(orderId) && !h.reversed
  );
  if (earnEntry) {
    pointsDeducted    = earnEntry.points;
    earnEntry.reversed = true; // mark so duplicate webhooks don't double-reverse
    balance           = Math.max(0, balance - pointsDeducted);
    changed           = true;
    console.log(`[${reason}] Reversing ${pointsDeducted} earned pts for order #${orderNumber}`);
  }

  // ── 2. Find used/redeemed points for this order and refund them ──
  // The "use" entry is written at apply-time, not tied to order_id yet.
  // We match by looking for a "use" entry within 10 minutes of the order.
  // For robustness we also check order.discount_codes for our RWRD- prefix.
  const rwrdCodes = (order.discount_codes || [])
    .filter(d => d.code && d.code.startsWith('RWRD-'))
    .map(d => Math.round(parseFloat(d.amount))); // rupee amounts

  if (rwrdCodes.length > 0) {
    const refundPts = rwrdCodes.reduce((sum, a) => sum + a, 0);
    // Find the matching "use" entry that hasn't been credited back yet
    const useEntry = history.find(
      h => h.type === 'use' && h.points === refundPts && !h.refunded
    );
    if (useEntry) {
      pointsCredited  = refundPts;
      useEntry.refunded = true;
      balance        += pointsCredited;
      changed         = true;
      console.log(`[${reason}] Crediting back ${pointsCredited} redeemed pts for order #${orderNumber}`);
    }
  }

  if (!changed) {
    console.log(`[${reason}] No points to adjust for order #${orderNumber}`);
    return;
  }

  // ── 3. Write a single clear history entry summarising what happened ──
  const parts = [];
  if (pointsDeducted > 0) parts.push(`−${pointsDeducted} pts earned reversed`);
  if (pointsCredited > 0) parts.push(`+${pointsCredited} pts redeemed refunded`);

  history.unshift({
    type:        pointsCredited > 0 ? 'earn' : 'use',
    description: `Order #${orderNumber} ${reason}: ${parts.join(', ')}`,
    points:      pointsCredited - pointsDeducted, // net change (can be negative)
    created_at:  new Date().toISOString(),
    order_id:    orderId,
    is_adjustment: true
  });

  await Promise.all([
    setMetafield(customerId, 'balance', balance, 'integer'),
    setMetafield(customerId, 'history', history, 'json')
  ]);

  console.log(`[${reason}] Order #${orderNumber} done. New balance: ${balance}`);
}

/* ─────────────────────────────────────────
   ROUTE: POST /api/webhook/order-cancelled
   Fires when an entire order is cancelled.
   Reverses all earned points + refunds used points.
   ───────────────────────────────────────── */
app.post('/api/webhook/order-cancelled', express.raw({ type: 'application/json' }), async (req, res) => {
  const hmac = req.headers['x-shopify-hmac-sha256'];
  const hash = crypto.createHmac('sha256', SECRET).update(req.body).digest('base64');
  if (hash !== hmac) {
    console.error('[webhook/cancel] HMAC mismatch');
    return res.status(401).send('Unauthorized');
  }

  let order;
  try { order = JSON.parse(req.body.toString('utf8')); }
  catch (e) { return res.status(400).send('Bad JSON'); }

  const customerId = order.customer?.id;
  if (!customerId) return res.status(200).send('ok');

  try {
    await processRefundOrCancel(customerId, order, 'cancelled');
    res.status(200).send('ok');
  } catch (e) {
    console.error('[webhook/cancel]', e.message);
    res.status(500).send('error');
  }
});

/* ─────────────────────────────────────────
   ROUTE: POST /api/webhook/refund-created
   Fires on partial OR full refunds.
   For partial refunds, reverses only the proportional earned points.
   Always refunds any redeemed points if the full order is refunded.
   ───────────────────────────────────────── */
app.post('/api/webhook/refund-created', express.raw({ type: 'application/json' }), async (req, res) => {
  const hmac = req.headers['x-shopify-hmac-sha256'];
  const hash = crypto.createHmac('sha256', SECRET).update(req.body).digest('base64');
  if (hash !== hmac) {
    console.error('[webhook/refund] HMAC mismatch');
    return res.status(401).send('Unauthorized');
  }

  let refund;
  try { refund = JSON.parse(req.body.toString('utf8')); }
  catch (e) { return res.status(400).send('Bad JSON'); }

  const customerId = refund.order?.customer?.id ?? null;
  if (!customerId) return res.status(200).send('ok');

  try {
    const orderId     = refund.order_id;
    const orderNumber = refund.order?.order_number ?? orderId;

    // Fetch the original order to get full context
    const orderData = await shopifyFetch(`/orders/${orderId}.json?fields=id,order_number,total_price,discount_codes,financial_status`);
    const order     = orderData.order;

    // Work out refund amount
    const refundAmount = Math.round(
      (refund.transactions || [])
        .filter(t => t.kind === 'refund' && t.status === 'success')
        .reduce((sum, t) => sum + parseFloat(t.amount || 0), 0) * 100
    ); // paise

    const originalTotal = Math.round(parseFloat(order.total_price) * 100);
    const isFullRefund  = refund.order?.financial_status === 'refunded' ||
                          refundAmount >= originalTotal;

    console.log(`[refund] Order #${orderNumber} | refund=₹${refundAmount/100} | full=${isFullRefund}`);

    const balanceMF = await getMetafield(customerId, 'balance');
    let balance     = balanceMF ? parseInt(balanceMF.value, 10) : 0;
    const historyMF = await getMetafield(customerId, 'history');
    let history     = [];
    if (historyMF) { try { history = JSON.parse(historyMF.value); } catch {} }

    let pointsDeducted = 0;
    let pointsCredited = 0;

    // ── Reverse earned points (proportional for partial, full for complete refund) ──
    const earnEntry = history.find(
      h => h.type === 'earn' && String(h.order_id) === String(orderId) && !h.reversed
    );
    if (earnEntry && earnEntry.points > 0) {
      if (isFullRefund) {
        pointsDeducted     = earnEntry.points;
        earnEntry.reversed = true;
      } else {
        // Proportional: refund_amount / original_total * earned
        const ratio        = Math.min(1, refundAmount / originalTotal);
        pointsDeducted     = Math.floor(earnEntry.points * ratio);
        earnEntry.points  -= pointsDeducted; // reduce remaining earnable
      }
      balance = Math.max(0, balance - pointsDeducted);
      console.log(`[refund] Reversing ${pointsDeducted} earned pts (${isFullRefund ? 'full' : 'partial'})`);
    }

    // ── Credit back redeemed points only on FULL refund ──
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
          console.log(`[refund] Crediting back ${pointsCredited} redeemed pts`);
        }
      }
    }

    if (pointsDeducted === 0 && pointsCredited === 0) {
      console.log(`[refund] No points to adjust for order #${orderNumber}`);
      return res.status(200).send('ok');
    }

    const parts = [];
    if (pointsDeducted > 0) parts.push(`−${pointsDeducted} pts earned reversed`);
    if (pointsCredited > 0) parts.push(`+${pointsCredited} pts redeemed refunded`);

    history.unshift({
      type:          pointsCredited > pointsDeducted ? 'earn' : 'use',
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

    console.log(`[refund] Done. New balance: ${balance}`);
    res.status(200).send('ok');
  } catch (e) {
    console.error('[webhook/refund]', e.message);
    res.status(500).send('error');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Rewards backend on :${PORT}`);

  // Self-ping every 4 minutes to prevent Railway free tier from sleeping
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN;
  if (domain) {
    const pingUrl = `https://${domain}/api/points?customer_id=keepalive`;
    setInterval(async () => {
      try {
        await fetch(pingUrl);
        console.log('[keepalive] ping ok');
      } catch (e) {
        console.error('[keepalive] ping failed:', e.message);
      }
    }, 4 * 60 * 1000); // every 4 minutes
  }
});
