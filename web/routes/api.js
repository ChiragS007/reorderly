import { buildReorderList } from "../lib/reorderLogic.js";

export function serializeReorderRow(row) {
  return {
    product_title: row.product_title,
    variant_id: row.variant_id,
    sku: row.sku,
    current_inventory: row.current_inventory,
    daily_sales: row.daily_sales,
    days_left: Number.isFinite(row.days_left) ? row.days_left : null,
    reorder_qty: row.reorder_qty,
    urgency: row.urgency,
  };
}

export function computeReorderItems(
  ordersAggregated,
  productVariants,
  leadTimeDays,
  bufferPct,
) {
  const rows = buildReorderList(ordersAggregated, productVariants, {
    lead_time_days: leadTimeDays,
    buffer_pct: bufferPct,
  });
  return rows.map(serializeReorderRow);
}
