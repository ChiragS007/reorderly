import { buildReorderList } from "../lib/reorderLogic.js";

export function serializeReorderRow(row) {
  return {
    product_title: row.product_title,
    variant_id: row.variant_id,
    sku: row.sku,
    current_inventory: row.current_inventory,
    last_30_days_sales: row.last_30_days_sales,
    daily_sales: row.daily_sales,
    days_left: Number.isFinite(row.days_left) ? row.days_left : null,
    reorder_point: row.reorder_point,
    reorder_qty: row.reorder_qty,
    status: row.status,
  };
}

/** JSON has no Infinity; enforce finite `days_left` or null on every API response. */
export function reorderItemsJsonSafe(items) {
  return items.map((item) => ({
    ...item,
    days_left: Number.isFinite(item.days_left) ? item.days_left : null,
  }));
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
  const safeItems = rows.map((item) => ({
    ...item,
    days_left: Number.isFinite(item.days_left) ? item.days_left : null,
  }));
  return safeItems.map(serializeReorderRow);
}
