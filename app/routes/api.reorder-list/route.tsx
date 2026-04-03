import type { LoaderFunctionArgs } from "react-router";
import prisma from "../../db.server";
import { fetchReorderSourceData } from "../../lib/reorderData.server";
import {
  REORDERLY_MONTHLY_PLAN,
  authenticate,
} from "../../shopify.server";
import {
  getReorderCache,
  reorderCacheKey,
  setReorderCache,
} from "../../../web/lib/reorderCache.js";
import { computeReorderItems } from "../../../web/routes/api.js";

const ALLOWED_LEAD = new Set([7, 14, 30]);
const ALLOWED_BUFFER = new Set([0.1, 0.2, 0.3]);

async function billingBlocked(
  variantCount: number,
  billing: Awaited<ReturnType<typeof authenticate.admin>>["billing"],
): Promise<boolean> {
  if (variantCount <= 25) return false;
  const { hasActivePayment } = await billing.check({
    // shopifyApp billing keys are widened in typings; runtime plan id is REORDERLY_MONTHLY_PLAN.
    plans: [REORDERLY_MONTHLY_PLAN] as never,
    isTest: process.env.SHOPIFY_BILLING_TEST === "true",
  });
  return !hasActivePayment;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session, billing } = await authenticate.admin(request);
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
  };

  if (cached) {
    const blocked = await billingBlocked(cached.variantCount, billing);
    return Response.json({
      items: blocked ? [] : cached.items,
      variantCount: cached.variantCount,
      billingBlocked: blocked,
      leadTimeDays,
      bufferPct,
    });
  }

  try {
    const { ordersAggregated, productVariants, variantCount } =
      await fetchReorderSourceData(admin);

    const blocked = await billingBlocked(variantCount, billing);
    if (blocked) {
      return Response.json({
        items: [],
        variantCount,
        billingBlocked: true,
        leadTimeDays,
        bufferPct,
      });
    }

    const items = computeReorderItems(
      ordersAggregated,
      productVariants,
      leadTimeDays,
      bufferPct,
    );
    setReorderCache(cacheKey, { items, variantCount });

    return Response.json({
      items,
      variantCount,
      billingBlocked: false,
      leadTimeDays,
      bufferPct,
    });
  } catch (e) {
    console.error("reorder-list", e);
    return Response.json(
      { error: true, message: "Unable to load inventory data" },
      { status: 500 },
    );
  }
};
