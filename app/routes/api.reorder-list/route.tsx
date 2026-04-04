import type { LoaderFunctionArgs } from "react-router";
import prisma from "../../db.server";
import { fetchReorderSourceData } from "../../lib/reorderData.server";
import {
  REORDERLY_MONTHLY_PLAN,
  authenticate,
} from "../../shopify.server";
import { REORDERLY_FREE_VARIANT_LIMIT } from "../../lib/reorderly.constants";
import {
  getReorderCache,
  reorderCacheKey,
  setReorderCache,
} from "../../../web/lib/reorderCache.js";
import {
  computeReorderItems,
  reorderItemsJsonSafe,
} from "../../../web/routes/api.js";

const ALLOWED_LEAD = new Set([7, 14, 30]);
const ALLOWED_BUFFER = new Set([0.1, 0.2, 0.3]);

function shopAdminNav(shop: string) {
  return {
    adminProductsUrl: `https://${shop}/admin/products`,
    adminInventoryUrl: `https://${shop}/admin/products/inventory`,
  };
}

async function billingBlocked(
  variantCount: number,
  billing: Awaited<ReturnType<typeof authenticate.admin>>["billing"],
): Promise<boolean> {
  if (variantCount <= REORDERLY_FREE_VARIANT_LIMIT) return false;
  const { hasActivePayment } = await billing.check({
    // shopifyApp billing keys are widened in typings; runtime plan id is REORDERLY_MONTHLY_PLAN.
    plans: [REORDERLY_MONTHLY_PLAN] as never,
    isTest: process.env.SHOPIFY_BILLING_TEST === "true",
  });
  return !hasActivePayment;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session, billing } = await authenticate.admin(request);
  console.log("[Reorderly] /api/reorder-list called for shop:", session.shop);
  const shop = session.shop;

  const url = new URL(request.url);
  const urlLead = parseInt(url.searchParams.get("lead_time_days") ?? "", 10);
  const urlBuffer = parseFloat(url.searchParams.get("buffer_pct") ?? "");

  const stored = await prisma.shopSettings.findUnique({ where: { shop } });
  const defaultLead = stored?.leadTimeDays ?? 14;
  const defaultBuffer = stored?.bufferPct ?? 0.2;

  const leadTimeDays = ALLOWED_LEAD.has(urlLead) ? urlLead : defaultLead;
  const bufferPct = ALLOWED_BUFFER.has(urlBuffer) ? urlBuffer : defaultBuffer;

  const cacheKey = reorderCacheKey(shop, leadTimeDays, bufferPct);
  const cached = getReorderCache(cacheKey) as null | {
    items: ReturnType<typeof computeReorderItems>;
    variantCount: number;
    dataQuality: {
      ordersInLast30Days: number;
      variantsWithSales: number;
    };
  };

  const nav = shopAdminNav(shop);

  if (cached) {
    const blocked = await billingBlocked(cached.variantCount, billing);
    return Response.json({
      ...nav,
      items: reorderItemsJsonSafe(blocked ? [] : cached.items),
      variantCount: cached.variantCount,
      billingBlocked: blocked,
      leadTimeDays,
      bufferPct,
      dataQuality: cached.dataQuality ?? {
        ordersInLast30Days: 0,
        variantsWithSales: 0,
      },
    });
  }

  try {
    const {
      ordersAggregated,
      productVariants,
      variantCount,
      ordersInLast30Days,
      variantsWithSales,
    } = await fetchReorderSourceData(admin);

    console.log(
      "[Reorderly] Source data — variantCount:",
      variantCount,
      "ordersInLast30Days:",
      ordersInLast30Days,
    );

    const dataQuality = { ordersInLast30Days, variantsWithSales };

    const blocked = await billingBlocked(variantCount, billing);
    if (blocked) {
      return Response.json({
        ...nav,
        items: [],
        variantCount,
        billingBlocked: true,
        leadTimeDays,
        bufferPct,
        dataQuality,
      });
    }

    const items = computeReorderItems(
      ordersAggregated,
      productVariants,
      leadTimeDays,
      bufferPct,
    );
    setReorderCache(cacheKey, { items, variantCount, dataQuality });

    return Response.json({
      ...nav,
      items: reorderItemsJsonSafe(items),
      variantCount,
      billingBlocked: false,
      leadTimeDays,
      bufferPct,
      dataQuality,
    });
  } catch (e) {
    console.error("reorder-list", e);
    return Response.json(
      { error: true, message: "Unable to load inventory data" },
      { status: 500 },
    );
  }
};
