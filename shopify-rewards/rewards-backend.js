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
  app.post('/api/webhook/order-paid', express.raw({ type: 'application/json' }), async (req, res) => {
  // Verify HMAC using RAW body bytes (not re-serialized JSON)
  const hmac    = req.headers['x-shopify-hmac-sha256'];
  const rawBody = req.body; // Buffer, because of express.raw()
  const hash    = crypto.createHmac('sha256', SECRET).update(rawBody).digest('base64');

  console.log('[webhook] received hmac:', hmac);
  console.log('[webhook] computed hash:', hash);
  console.log('[webhook] secret used:', SECRET ? SECRET.slice(0,6) + '...' : 'MISSING');

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Rewards backend on :${PORT}`));
