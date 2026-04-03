import type { ActionFunctionArgs } from "react-router";
import prisma from "../../db.server";
import { authenticate } from "../../shopify.server";

const ALLOWED_LEAD = new Set([7, 14, 30]);
const ALLOWED_BUFFER = new Set([0.1, 0.2, 0.3]);

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  let body: { leadTimeDays?: number; bufferPct?: number };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const leadTimeDays = Number(body.leadTimeDays);
  const bufferPct = Number(body.bufferPct);

  if (!ALLOWED_LEAD.has(leadTimeDays)) {
    return Response.json({ error: "invalid_lead_time" }, { status: 400 });
  }
  if (!ALLOWED_BUFFER.has(bufferPct)) {
    return Response.json({ error: "invalid_buffer" }, { status: 400 });
  }

  await prisma.shopSettings.upsert({
    where: { shop },
    create: { shop, leadTimeDays, bufferPct },
    update: { leadTimeDays, bufferPct },
  });

  return Response.json({ ok: true, leadTimeDays, bufferPct });
};
