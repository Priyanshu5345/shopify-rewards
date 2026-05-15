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

app.use(express.json());

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
app.post('/api/webhook/order-paid', async (req, res) => {
  // Verify HMAC
  const hmac = req.headers['x-shopify-hmac-sha256'];
  const body  = JSON.stringify(req.body);
  const hash  = crypto.createHmac('sha256', SECRET).update(body).digest('base64');
  if (hash !== hmac) return res.status(401).send('Unauthorized');

  const order      = req.body;
  const customerId = order.customer?.id;
  if (!customerId) return res.status(200).send('ok');

  try {
    const orderTotal     = Math.round(parseFloat(order.total_price) * 100); // in paise
    const discountAmount = Math.round(parseFloat(order.total_discounts || 0) * 100);
    const isFirstOrder   = order.customer.orders_count === 1;
    const orderId        = order.id;

    // Points earning rule
    let earnedPoints;
    if (isFirstOrder) {
      earnedPoints = Math.floor(orderTotal / 200);          // 50% of order total (₹)
    } else {
      const payable = Math.max(0, orderTotal - discountAmount);
      earnedPoints  = Math.floor(payable / 10000);           // 1% of payable (₹)
    }

    if (earnedPoints > 0) {
      const balanceMF = await getMetafield(customerId, 'balance');
      const balance   = balanceMF ? parseInt(balanceMF.value, 10) : 0;
      const historyMF = await getMetafield(customerId, 'history');
      let history = [];
      if (historyMF) { try { history = JSON.parse(historyMF.value); } catch {} }

      history.unshift({
        type:        'earn',
        description: `Order #${order.order_number} — ${earnedPoints} points earned`,
        points:      earnedPoints,
        created_at:  new Date().toISOString()
      });

      await Promise.all([
        setMetafield(customerId, 'balance', balance + earnedPoints, 'integer'),
        setMetafield(customerId, 'history', history, 'json')
      ]);

      console.log(`[webhook] Customer ${customerId} earned ${earnedPoints} pts on order ${orderId}`);
    }

    res.status(200).send('ok');
  } catch (e) {
    console.error('[webhook order-paid]', e.message);
    res.status(500).send('error');
  }
});
/* POST /api/restore — called when customer removes applied points */
app.post('/api/restore', async (req, res) => {
  const { customer_id, points, discount_code } = req.body;
  if (!customer_id || !points) return res.status(400).json({ error: 'Missing fields' });

  try {
    const balanceMF = await getMetafield(customer_id, 'balance');
    const balance   = balanceMF ? parseInt(balanceMF.value, 10) : 0;
    const historyMF = await getMetafield(customer_id, 'history');
    let history = [];
    if (historyMF) { try { history = JSON.parse(historyMF.value); } catch {} }

    // Remove the matching "use" entry from history
    const idx = history.findIndex(
      h => h.type === 'use' && h.points === parseInt(points, 10)
    );
    if (idx > -1) history.splice(idx, 1);

    await Promise.all([
      setMetafield(customer_id, 'balance', balance + parseInt(points, 10), 'integer'),
      setMetafield(customer_id, 'history', history, 'json')
    ]);

    // Optionally delete the discount code so it can't be used
    // (find by code title via price rules API if needed)

    res.json({ ok: true, new_balance: balance + parseInt(points, 10) });
  } catch (e) {
    console.error('[restore POST]', e.message);
    res.status(500).json({ error: e.message });
  }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Rewards backend on :${PORT}`));
