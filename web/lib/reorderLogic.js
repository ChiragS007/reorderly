/**
 * Inventory risk & reorder decisions from last-30-day sales and catalog.
 *
 * "No data" = missing SKU (cannot reliably identify the line item).
 * "No recent sales" = SKU present but zero units sold in the lookback (velocity unknown — not "safe").
 *
 * Status checks run in that order: zero velocity wins before zero stock, so OOS + no 30d sales
 * stays "No recent sales"; OOS + positive velocity is "Out of stock". For the latter,
 * reorder_qty = ceil(reorder_point − stock) equals ceil(reorder_point) and can look large
 * (e.g. velocity × lead × (1+buffer)) — that target cover is intentional, not a bug.
 */
export function buildReorderList(ordersAggregated, productVariants, settings) {
  const { lead_time_days, buffer_pct } = settings;
  const soldMap = new Map();
  for (const row of ordersAggregated) {
    if (!row.variantId) continue;
    soldMap.set(
      row.variantId,
      (soldMap.get(row.variantId) || 0) + row.quantity,
    );
  }

  const statusRank = {
    "Out of stock": 0,
    Urgent: 1,
    Warning: 2,
    Safe: 3,
    "No recent sales": 4,
    "No data": 5,
  };

  /** @type {Array<{
   *   product_title: string;
   *   variant_id: string;
   *   sku: string;
   *   current_inventory: number;
   *   last_30_days_sales: number;
   *   daily_sales: number;
   *   days_left: number | null;
   *   reorder_point: number;
   *   reorder_qty: number;
   *   status: 'No data' | 'No recent sales' | 'Out of stock' | 'Urgent' | 'Warning' | 'Safe';
   * }>} */
  const items = [];

  for (const v of productVariants) {
    if (v.isGiftCard) continue;

    const last30DaysSales = soldMap.get(v.variantId) ?? 0;
    const dailySales = last30DaysSales / 30;
    const currentInventory = Number.isFinite(v.currentInventory)
      ? v.currentInventory
      : 0;
    const sku = (v.sku ?? "").trim();

    let daysLeft;
    if (dailySales === 0) {
      daysLeft = Number.POSITIVE_INFINITY;
    } else {
      daysLeft = currentInventory / dailySales;
    }

    const reorderPoint = dailySales * lead_time_days * (1 + buffer_pct);
    // When stock is 0, qty is ceil(reorderPoint); large values reflect lead+buffer cover at current velocity.
    const reorderQty = Math.max(0, Math.ceil(reorderPoint - currentInventory));

    /** @type {'No data' | 'No recent sales' | 'Out of stock' | 'Urgent' | 'Warning' | 'Safe'} */
    let status;
    if (!sku) {
      status = "No data";
    } else if (dailySales === 0) {
      status = "No recent sales";
    } else if (currentInventory === 0) {
      status = "Out of stock";
    } else if (daysLeft < lead_time_days) {
      status = "Urgent";
    } else if (daysLeft < lead_time_days * (1 + buffer_pct)) {
      status = "Warning";
    } else {
      status = "Safe";
    }

    const noVelocity = status === "No data" || status === "No recent sales";

    items.push({
      product_title: v.productTitle,
      variant_id: v.variantId,
      sku,
      current_inventory: currentInventory,
      last_30_days_sales: last30DaysSales,
      daily_sales: dailySales,
      days_left: Number.isFinite(daysLeft) ? daysLeft : null,
      reorder_point: reorderPoint,
      reorder_qty: noVelocity ? 0 : reorderQty,
      status,
    });
  }

  items.sort((a, b) => {
    const rs = statusRank[a.status] - statusRank[b.status];
    if (rs !== 0) return rs;
    const aInf = !Number.isFinite(a.days_left);
    const bInf = !Number.isFinite(b.days_left);
    if (aInf && bInf) return 0;
    if (aInf) return 1;
    if (bInf) return -1;
    return a.days_left - b.days_left;
  });

  return items;
}
