import type { ActionFunctionArgs } from "react-router";
import {
  REORDERLY_MONTHLY_PLAN,
  authenticate,
} from "../../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  const { billing } = await authenticate.admin(request);
  const appUrl = process.env.SHOPIFY_APP_URL || "";
  const returnUrl = `${appUrl.replace(/\/$/, "")}/app`;

  return billing.request({
    plan: REORDERLY_MONTHLY_PLAN as never,
    isTest: process.env.SHOPIFY_BILLING_TEST === "true",
    returnUrl,
  });
};
