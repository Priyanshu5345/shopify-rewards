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
  // 204 No Content (e.g. DELETE) returns empty body — don't parse as JSON
  if (res.status === 204 || res.headers.get('content-length') === '0') {
    return {};
  }
  const text = await res.text();
  if (!text) return {};
  return JSON.parse(text);
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

    // 50% bonus now triggered by FIRST50 coupon — is_first_order always false

    res.json({ balance, history: history.slice(0, 20), is_first_order: false });
  } catch (e) {
    console.error('[points GET]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ─────────────────────────────────────────
   ROUTE: GET /api/check-code?code=RWRD-xxx
   Checks if a discount code still exists and hasn't been used.
   Returns { valid: bool, usage_count: int }
   ───────────────────────────────────────── */
app.get('/api/check-code', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ valid: false, error: 'Missing code' });

  try {
    const data = await shopifyFetch(
      `/discount_codes/lookup.json?code=${encodeURIComponent(code)}`
    );
    const dc = data.discount_code;
    if (!dc) return res.json({ valid: false, usage_count: 0 });

    // Get full details including usage_count
    const priceRuleId = dc.price_rule_id;
    const codeData    = await shopifyFetch(
      `/price_rules/${priceRuleId}/discount_codes.json`
    );
    const codeObj = (codeData.discount_codes || []).find(c => c.code === code);

    res.json({
      valid:       !!codeObj,
      usage_count: codeObj?.usage_count ?? 0
    });
  } catch (e) {
    // Code not found = deleted/used
    res.json({ valid: false, usage_count: 0 });
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

  const ptsInt    = parseInt(points_to_use, 10);
  const cartPaise = parseInt(cart_total, 10) || 0;
  if (ptsInt <= 0) return res.status(400).json({ error: 'Invalid points' });

  // Max discount = 50% of cart total
  const maxAllowedPts = Math.floor(cartPaise / 200); // 50% of cart in rupees
  if (ptsInt > maxAllowedPts) {
    return res.status(400).json({
      error: `Max points allowed is ${maxAllowedPts} (50% of cart value)`
    });
  }

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

  const oldPts    = parseInt(old_points, 10);
  const newPts    = parseInt(new_points, 10);
  const cartPaise = parseInt(cart_total, 10) || 0;
  if (newPts <= 0) return res.status(400).json({ error: 'Invalid points' });

  // Max discount = 50% of cart total
  const maxAllowedPts = Math.floor(cartPaise / 200);
  if (newPts > maxAllowedPts) {
    return res.status(400).json({
      error: `Max points allowed is ${maxAllowedPts} (50% of cart value)`
    });
  }

  try {
    // ── 1. Check if old code was actually USED in a completed order ──
    // Search Shopify for any order that used this discount code
    let oldCodeWasUsed = false;
    try {
      const searchData = await shopifyFetch(
        `/discount_codes/lookup.json?code=${encodeURIComponent(old_discount_code)}`
      );
      const priceRuleId = searchData.discount_code?.price_rule_id;
      if (priceRuleId) {
        // Get usage count from the discount code itself
        const codeData = await shopifyFetch(
          `/price_rules/${priceRuleId}/discount_codes.json`
        );
        const codeObj = (codeData.discount_codes || []).find(
          c => c.code === old_discount_code
        );
        oldCodeWasUsed = codeObj ? codeObj.usage_count > 0 : false;
        console.log(`[update-apply] Old code ${old_discount_code} usage_count=${codeObj?.usage_count}`);
      }
    } catch (e) {
      // Code not found — likely already deleted or expired
      console.log(`[update-apply] Old code lookup failed (probably already deleted): ${e.message}`);
    }

    // ── 2. Load balance and history ──
    const balanceMF = await getMetafield(customer_id, 'balance');
    let balance = balanceMF ? parseInt(balanceMF.value, 10) : 0;
    const historyMF = await getMetafield(customer_id, 'history');
    let history = [];
    if (historyMF) { try { history = JSON.parse(historyMF.value); } catch {} }

    if (!oldCodeWasUsed) {
      // ── Old code was NOT used — safe to delete and fully refund old points ──
      try { await deleteRwrdCode(old_discount_code); } catch {}

      // Restore old points fully (as if they were never deducted)
      balance = balance + oldPts;

      // Remove old use entry from history completely — no trace
      history = history.filter(
        h => !(h.type === 'use' && h.discount_code === old_discount_code)
      );

      console.log(`[update-apply] Old code unused — deleted cleanly. Balance restored to ${balance}`);

    } else {
      // ── Old code WAS used — cannot delete or restore those points ──
      // Just proceed with fresh deduction for new amount
      console.log(`[update-apply] Old code was used in an order — cannot restore those ${oldPts} pts`);
    }

    // ── 3. Deduct new points ──
    balance = balance - newPts;
    if (balance < 0) return res.status(400).json({ error: 'Insufficient points' });

    // ── 4. Create new price rule + code ──
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

    // ── 5. Add new use entry to history ──
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

    console.log(`[update-apply] Done. Old=${oldPts}pts used=${oldCodeWasUsed} → New=${newPts}pts. Balance=${balance}`);
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
  const { customer_id, points, discount_code } = req.body;
  if (!customer_id || !points) return res.status(400).json({ error: 'Missing fields' });

  const pts = parseInt(points, 10);

  try {
    // ── Check if discount code was actually used before restoring ──
    let codeWasUsed = false;
    if (discount_code) {
      try {
        const searchData = await shopifyFetch(
          `/discount_codes/lookup.json?code=${encodeURIComponent(discount_code)}`
        );
        const priceRuleId = searchData.discount_code?.price_rule_id;
        if (priceRuleId) {
          const codeData = await shopifyFetch(
            `/price_rules/${priceRuleId}/discount_codes.json`
          );
          const codeObj = (codeData.discount_codes || []).find(c => c.code === discount_code);
          codeWasUsed = codeObj ? codeObj.usage_count > 0 : false;

          // Delete the price rule if unused
          if (!codeWasUsed) {
            await shopifyFetch(`/price_rules/${priceRuleId}.json`, { method: 'DELETE' });
            console.log(`[restore] Deleted unused price rule ${priceRuleId}`);
          }
        }
      } catch (e) {
        console.log(`[restore] Code lookup failed (may already be deleted): ${e.message}`);
      }
    }

    const balanceMF = await getMetafield(customer_id, 'balance');
    const balance   = balanceMF ? parseInt(balanceMF.value, 10) : 0;
    const historyMF = await getMetafield(customer_id, 'history');
    let history = [];
    if (historyMF) { try { history = JSON.parse(historyMF.value); } catch {} }

    if (!codeWasUsed) {
      // Code never used — remove the history entry completely (no trace)
      history = history.filter(
        h => !(h.type === 'use' && h.discount_code === discount_code)
      );
      // Restore points fully
      await Promise.all([
        setMetafield(customer_id, 'balance', balance + pts, 'integer'),
        setMetafield(customer_id, 'history', history, 'json')
      ]);
      console.log(`[restore] Unused code removed cleanly. ${pts} pts restored.`);
    } else {
      // Code was used in a completed order — don't restore points
      // The order-paid webhook handles points earning separately
      console.log(`[restore] Code was used in order — points not restored.`);
    }

    res.json({ ok: true, restored: !codeWasUsed });
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
    const orderId       = order.id;

    // ── Check if FIRST50 coupon was used ──
    // This coupon triggers 50% points on total excluding discount
    const BONUS_COUPON     = 'FIRST50'; // change this anytime
    const usedCouponCodes  = (order.discount_codes || []).map(d => (d.code || '').toUpperCase());
    const usedBonusCoupon  = usedCouponCodes.includes(BONUS_COUPON.toUpperCase());

    // Amount actually paid = total_price (after all discounts)
    const amountPaid = Math.round(parseFloat(order.total_price) * 100);

    // For bonus coupon: 50% of amount paid (after discount — so FIRST50 discount already excluded)
    // For all other orders: 1% of amount paid
    const earnedPoints = usedBonusCoupon
      ? Math.floor(amountPaid / 200)   // 50% of total after discount
      : Math.floor(amountPaid / 10000); // 1% of total after discount

    console.log(`[order-paid] amountPaid=₹${amountPaid/100} | usedBonusCoupon=${usedBonusCoupon} | earns=${earnedPoints}pts | coupons=${usedCouponCodes.join(',')}`);

    console.log(`[order-paid] Order #${order.order_number} | paid=₹${amountPaid/100} | earns=${earnedPoints}pts`);

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
