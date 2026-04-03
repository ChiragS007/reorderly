/**
 * Pure reorder calculations from aggregated sales and catalog snapshot.
 * @param {Array<{ variantId: string; quantity: number }>} ordersAggregated
 * @param {Array<{ productTitle: string; variantId: string; sku: string | null; currentInventory: number }>} productVariants
 * @param {{ lead_time_days: number; buffer_pct: number }} settings
 * @returns {Array<{
 *   product_title: string;
 *   variant_id: string;
 *   sku: string;
 *   current_inventory: number;
 *   daily_sales: number;
 *   days_left: number;
 *   reorder_qty: number;
 *   urgency: 'RED' | 'YELLOW' | 'GREEN';
 * }>}
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

  /** @type {ReturnType<typeof buildReorderList>} */
  const items = [];

  for (const v of productVariants) {
    const totalQtySold = soldMap.get(v.variantId) ?? 0;
    const dailySales = totalQtySold / 30;
    const currentInventory = Number.isFinite(v.currentInventory)
      ? v.currentInventory
      : 0;

    let daysLeft;
    let reorderQtyRaw;

    if (dailySales === 0) {
      daysLeft = Number.POSITIVE_INFINITY;
      reorderQtyRaw = 0;
    } else {
      daysLeft = currentInventory / dailySales;
      reorderQtyRaw = Math.max(
        0,
        dailySales * lead_time_days - currentInventory,
      );
    }

    const reorderQty = Math.ceil(reorderQtyRaw * (1 + buffer_pct));

    /** @type {'RED' | 'YELLOW' | 'GREEN'} */
    let urgency;
    if (dailySales === 0 || !Number.isFinite(daysLeft) || daysLeft >= 14) {
      urgency = "GREEN";
    } else if (daysLeft < 5) {
      urgency = "RED";
    } else {
      urgency = "YELLOW";
    }

    items.push({
      product_title: v.productTitle,
      variant_id: v.variantId,
      sku: v.sku ?? "",
      current_inventory: currentInventory,
      daily_sales: dailySales,
      days_left: daysLeft,
      reorder_qty: reorderQty,
      urgency,
    });
  }

  const needsAttention = (row) =>
    row.reorder_qty > 0 ||
    (Number.isFinite(row.days_left) && row.days_left < 14);

  const filtered = items.filter(needsAttention);

  filtered.sort((a, b) => {
    const aInf = !Number.isFinite(a.days_left);
    const bInf = !Number.isFinite(b.days_left);
    if (aInf && bInf) return 0;
    if (aInf) return 1;
    if (bInf) return -1;
    return a.days_left - b.days_left;
  });

  return filtered;
}
