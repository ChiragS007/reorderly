import type { ReactElement } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData } from "react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  IndexTable,
  InlineGrid,
  InlineStack,
  Layout,
  List,
  Page,
  Select,
  SkeletonBodyText,
  SkeletonDisplayText,
  SkeletonPage,
  Text,
  Tooltip,
  useIndexResourceState,
} from "@shopify/polaris";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { REORDERLY_FREE_VARIANT_LIMIT } from "../lib/reorderly.constants";

/** IndexTable uses `position: fixed` for the duplicate header; that escapes nested scroll and overlays cards above. Pin it to normal flow inside `.reorderly-sku-table-scroll` only. */
const INDEX_TABLE_STICKY_FIX_CSS = `
.reorderly-sku-table-scroll .Polaris-IndexTable__StickyTable > div:nth-child(2) {
  position: static !important;
  top: auto !important;
  left: auto !important;
  width: 100% !important;
}
`;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return {
    isDev: process.env.NODE_ENV === "development",
  };
};

type RiskStatus =
  | "No data"
  | "No recent sales"
  | "Out of stock"
  | "Urgent"
  | "Warning"
  | "Safe";

type ReorderItem = {
  product_title: string;
  variant_id: string;
  sku: string;
  current_inventory: number;
  last_30_days_sales: number;
  daily_sales: number;
  days_left: number | null;
  reorder_point: number;
  reorder_qty: number;
  status: RiskStatus;
};

type ReorderListResponse = {
  items: ReorderItem[];
  variantCount: number;
  billingBlocked: boolean;
  leadTimeDays: number;
  bufferPct: number;
  adminProductsUrl?: string;
  adminInventoryUrl?: string;
  dataQuality?: {
    ordersInLast30Days: number;
    variantsWithSales: number;
  };
  error?: boolean;
  message?: string;
};

function rowTone(
  status: RiskStatus,
): "success" | "warning" | "critical" | undefined {
  if (status === "Out of stock" || status === "Urgent") return "critical";
  if (status === "Warning") return "warning";
  if (status === "Safe") return "success";
  return undefined;
}

function formatDays(days: number | null): string {
  if (days === null || !Number.isFinite(days)) return "—";
  if (days < 0.05) return "<0.1";
  return days < 100 ? days.toFixed(1) : "99+";
}

/** Line shown under the page subtitle (merchant's local time). */
function formatLastUpdatedLine(updatedAt: Date): string {
  const now = new Date();
  const isToday =
    updatedAt.getFullYear() === now.getFullYear() &&
    updatedAt.getMonth() === now.getMonth() &&
    updatedAt.getDate() === now.getDate();
  const timeStr = updatedAt.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  const dayPart = isToday
    ? "today"
    : updatedAt.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
  return `Last updated: ${dayPart} at ${timeStr} · refreshes on each visit`;
}

/**
 * Single informational state banner (priority order). Does not include the
 * urgent stockout hero — that renders separately when `metrics.riskyWithin5 > 0`.
 */
function getStateBanner(
  dq: ReorderListResponse["dataQuality"] | undefined,
  items: ReorderItem[],
  isDev: boolean,
): ReactElement | null {
  const noVelocityOnly =
    items.length > 0 &&
    items.every(
      (i) => i.status === "No data" || i.status === "No recent sales",
    );
  const riskyWithin5 = items.filter(
    (i) => i.days_left !== null && i.days_left < 5,
  ).length;
  const showRiskHero = riskyWithin5 > 0;
  const atRiskAction = items.filter(
    (i) =>
      i.status === "Out of stock" ||
      i.status === "Urgent" ||
      i.status === "Warning",
  ).length;
  const allSafe =
    items.length > 0 && items.every((i) => i.status === "Safe");
  const finiteDays = items
    .map((i) => i.days_left)
    .filter((d): d is number => d !== null && Number.isFinite(d));
  const earliest =
    finiteDays.length > 0 ? Math.min(...finiteDays) : null;

  if (dq && items.length > 0 && dq.ordersInLast30Days === 0) {
    return (
      <Banner tone="warning" title="No orders in the last 30 days">
        <BlockStack gap="200">
          <p>
            No orders found in the last 30 days. Reorderly calculates reorder
            quantities from your recent sales — once orders come in, your
            reorder list will appear here automatically.
          </p>
          {isDev ? (
            <p>
              Velocity comes from order line items tied to variants. On a dev
              store, create a test order with catalog products (variants with
              optional SKUs), then complete payment if your workflow requires it
              — you should then see non-zero{" "}
              <Text as="span" fontWeight="semibold">
                Avg daily
              </Text>{" "}
              for those lines.
            </p>
          ) : null}
        </BlockStack>
      </Banner>
    );
  }

  if (
    dq &&
    items.length > 0 &&
    dq.ordersInLast30Days > 0 &&
    dq.variantsWithSales === 0
  ) {
    return (
      <Banner
        tone="info"
        title="Orders found, but no variant quantities counted"
      >
        <p>
          Line items need a linked product variant for Reorderly to aggregate
          sales. Custom line items without variants are skipped.
        </p>
      </Banner>
    );
  }

  if (
    items.length > 0 &&
    noVelocityOnly &&
    dq &&
    dq.ordersInLast30Days > 0
  ) {
    return (
      <Banner tone="info" title="No sales data yet">
        <p>No reorder quantities until sales data is available.</p>
      </Banner>
    );
  }

  if (showRiskHero) {
    return null;
  }

  if (items.length === 0) {
    return (
      <Banner tone="info" title="No SKUs to analyze">
        <p>Add products with variants to see risk and reorder suggestions.</p>
      </Banner>
    );
  }

  if (noVelocityOnly) {
    return (
      <Banner tone="info" title="No sales data yet">
        <p>
          Reorderly needs at least one order in the last 30 days to calculate
          reorder quantities. Once your store has recent sales, this list will
          populate automatically.
        </p>
      </Banner>
    );
  }

  if (atRiskAction > 0) {
    return (
      <Banner tone="info" title="Review reorder-soon SKUs">
        <p>
          Nothing is inside a 5‑day stockout window, but some SKUs are still
          below their target. Order before runway shrinks further.
        </p>
      </Banner>
    );
  }

  if (allSafe) {
    return (
      <Banner tone="success" title="No reorders needed today">
        <p>
          You&apos;re fully stocked for the next 7 days at current velocity —
          all SKUs are at or above target after lead time and buffer.
          {earliest !== null ? (
            <>
              {" "}
              Shortest runway:{" "}
              <Text as="span" fontWeight="semibold">
                {formatDays(earliest)} days
              </Text>
              .
            </>
          ) : null}
        </p>
      </Banner>
    );
  }

  return (
    <Banner tone="info" title="Check mixed rows below">
      <p>
        Some SKUs have full forecasts; others need a SKU or sales history. Safe
        rows are trustworthy — treat no-velocity rows as unknown risk, not
        &quot;safe&quot;.
      </p>
    </Banner>
  );
}

function StatusBadge({ status }: { status: RiskStatus }) {
  switch (status) {
    case "No data":
      return <Badge tone="critical">No data</Badge>;
    case "No recent sales":
      return <Badge tone="read-only">No recent sales</Badge>;
    case "Out of stock":
      return <Badge tone="critical">Out of stock</Badge>;
    case "Urgent":
      return <Badge tone="critical">Urgent</Badge>;
    case "Warning":
      return <Badge tone="warning">Warning</Badge>;
    default:
      return <Badge tone="success">Safe</Badge>;
  }
}

function KpiCard({
  label,
  value,
  sublabel,
}: {
  label: string;
  value: string;
  sublabel?: string;
}) {
  return (
    <Card padding="400" background="bg-surface-secondary">
      <BlockStack gap="100">
        <Text variant="bodySm" tone="subdued" as="p">
          {label}
        </Text>
        <Text variant="headingXl" as="p">
          {value}
        </Text>
        {sublabel ? (
          <Text variant="bodySm" tone="subdued" as="p">
            {sublabel}
          </Text>
        ) : null}
      </BlockStack>
    </Card>
  );
}

function deriveDashboardMetrics(items: ReorderItem[]) {
  const finiteDays = items
    .map((i) => i.days_left)
    .filter((d): d is number => d !== null && Number.isFinite(d));
  const earliest =
    finiteDays.length > 0 ? Math.min(...finiteDays) : null;
  const riskyWithin5 = items.filter(
    (i) => i.days_left !== null && i.days_left < 5,
  ).length;
  const atRiskAction = items.filter(
    (i) =>
      i.status === "Out of stock" ||
      i.status === "Urgent" ||
      i.status === "Warning",
  ).length;
  const reorderNowCount = items.filter(
    (i) => i.status === "Out of stock" || i.status === "Urgent",
  ).length;
  const orderSoonCount = items.filter((i) => i.status === "Warning").length;
  const variantsWithVelocity = items.filter(
    (i) => i.status !== "No data" && i.status !== "No recent sales",
  ).length;

  return {
    earliest,
    riskyWithin5,
    atRiskAction,
    reorderNowCount,
    orderSoonCount,
    variantsWithVelocity,
  };
}

export default function InventoryRiskDashboard() {
  const { isDev } = useLoaderData<typeof loader>();
  const [leadTime, setLeadTime] = useState("14");
  const [bufferPct, setBufferPct] = useState("0.2");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [data, setData] = useState<ReorderListResponse | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [devHelperDismissed, setDevHelperDismissed] = useState(false);

  const fetchList = useCallback(async (lead: string, buffer: string) => {
    const params = new URLSearchParams({
      lead_time_days: lead,
      buffer_pct: buffer,
    });
    const res = await fetch(`/api/reorder-list?${params}`, {
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "include",
    });
    const json = (await res.json()) as ReorderListResponse & {
      error?: boolean;
    };
    if (!res.ok || json.error) {
      return { ok: false as const };
    }
    return { ok: true as const, data: json };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(false);
      const res = await fetch("/api/reorder-list", {
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
      });
      const json = (await res.json()) as ReorderListResponse & { error?: boolean };
      const result =
        !res.ok || json.error
          ? { ok: false as const }
          : { ok: true as const, data: json };
      if (cancelled) return;
      if (!result.ok) {
        setError(true);
        setData(null);
        setLastUpdatedAt(null);
      } else {
        setData(result.data);
        setLeadTime(String(result.data.leadTimeDays));
        setBufferPct(String(result.data.bufferPct));
        setLastUpdatedAt(new Date());
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const persistAndRefetch = async (nextLead: string, nextBuffer: string) => {
    setLoading(true);
    setError(false);
    try {
      await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          leadTimeDays: Number(nextLead),
          bufferPct: Number(nextBuffer),
        }),
      });
    } catch {
      /* non-blocking */
    }
    const result = await fetchList(nextLead, nextBuffer);
    if (!result.ok) {
      setError(true);
      setData(null);
      setLastUpdatedAt(null);
    } else {
      setData(result.data);
      setLeadTime(String(result.data.leadTimeDays));
      setBufferPct(String(result.data.bufferPct));
      setLastUpdatedAt(new Date());
    }
    setLoading(false);
  };

  const handleLeadChange = (value: string) => {
    setLeadTime(value);
    void persistAndRefetch(value, bufferPct);
  };

  const handleBufferChange = (value: string) => {
    setBufferPct(value);
    void persistAndRefetch(leadTime, value);
  };

  const items = data?.items ?? [];
  const leadDays = data?.leadTimeDays ?? (Number(leadTime) || 14);

  const metrics = useMemo(() => deriveDashboardMetrics(items), [items]);

  const { selectedResources, allResourcesSelected, handleSelectionChange } =
    useIndexResourceState(items, {
      resourceIDResolver: (r) => r.variant_id,
    });

  const exportCsv = () => {
    const selected = items.filter((i) =>
      selectedResources.includes(i.variant_id),
    );
    if (selected.length === 0) return;
    const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const header = "product name,sku,reorder_qty\n";
    const lines = selected.map(
      (r) =>
        `${esc(r.product_title)},${esc(r.sku ?? "")},${r.reorder_qty}`,
    );
    const blob = new Blob([header + lines.join("\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `inventory-risk-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading && !data) {
    return (
      <SkeletonPage primaryAction>
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <SkeletonDisplayText size="small" />
                <SkeletonBodyText lines={6} />
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </SkeletonPage>
    );
  }

  const billingBlocked = data?.billingBlocked === true;
  const exportDisabled =
    items.length === 0 ||
    billingBlocked ||
    error ||
    selectedResources.length === 0;

  const showRiskHero = metrics.riskyWithin5 > 0;
  const noVelocityOnly =
    items.length > 0 &&
    items.every(
      (i) => i.status === "No data" || i.status === "No recent sales",
    );
  const dq = data?.dataQuality;

  return (
    <Page
      fullWidth
      title="Today's reorder list"
      subtitle="What to restock, how much to order, and when"
      additionalMetadata={
        lastUpdatedAt ? formatLastUpdatedLine(lastUpdatedAt) : undefined
      }
      primaryAction={{
        content: "Export to supplier",
        onAction: exportCsv,
        disabled: exportDisabled,
      }}
    >
      <BlockStack gap="600">
        {error ? (
          <Banner tone="critical" title="Unable to load inventory data">
            <p>Check your connection and try again.</p>
          </Banner>
        ) : null}

        {billingBlocked ? (
          <Banner title="Upgrade to continue" tone="warning">
            <BlockStack gap="300">
              <p>
                Reorderly includes up to {REORDERLY_FREE_VARIANT_LIMIT} SKUs at
                no charge. This shop has {data?.variantCount ?? 0} variants —
                subscribe for $9/month to continue.
              </p>
              <Form method="post" action="/api/billing/request" target="_top">
                <Button submit variant="primary">
                  Upgrade to continue
                </Button>
              </Form>
            </BlockStack>
          </Banner>
        ) : null}

        {!error && !billingBlocked ? (
          <>
            <style dangerouslySetInnerHTML={{ __html: INDEX_TABLE_STICKY_FIX_CSS }} />
            <BlockStack gap="400">
              {getStateBanner(dq, items, isDev)}
              {showRiskHero ? (
                <Banner
                  tone="warning"
                  title={`${metrics.riskyWithin5} SKUs will stock out within 5 days`}
                >
                  <p>
                    {metrics.reorderNowCount > 0 ? (
                      <>
                        <Text as="span" fontWeight="semibold">
                          {metrics.reorderNowCount} SKU
                          {metrics.reorderNowCount === 1 ? "" : "s"}
                        </Text>{" "}
                        are out of stock or urgent (runway under your{" "}
                        {leadDays}-day lead time).{" "}
                      </>
                    ) : null}
                    Earliest stockout:{" "}
                    <Text as="span" fontWeight="semibold">
                      {formatDays(metrics.earliest)} days
                    </Text>
                    .
                  </p>
                </Banner>
              ) : null}
            </BlockStack>

            <InlineGrid columns={{ xs: 1, sm: 2, lg: 4 }} gap="400">
              <KpiCard
                label="Reorder now"
                value={String(metrics.reorderNowCount)}
                sublabel="Out of stock or urgent"
              />
              <KpiCard
                label="Order soon"
                value={String(metrics.orderSoonCount)}
                sublabel="Below target after lead and buffer"
              />
              <KpiCard
                label="Earliest stockout"
                value={
                  metrics.earliest !== null
                    ? `${formatDays(metrics.earliest)} days`
                    : "—"
                }
                sublabel="Fastest runway to zero"
              />
              <KpiCard
                label="Products monitored"
                value={String(items.length)}
                sublabel={
                  metrics.variantsWithVelocity > 0
                    ? `${metrics.variantsWithVelocity} with sales history`
                    : "Add orders to see reorder quantities"
                }
              />
            </InlineGrid>

            <Card padding="400">
              <BlockStack gap="300">
                <Text variant="headingSm" as="h2">
                  Reorder settings
                </Text>
                <Text variant="bodySm" tone="subdued" as="p">
                  These settings apply to every product we have sales data for.
                </Text>
                <Box maxWidth="480px">
                  <InlineStack gap="400" wrap blockAlign="end">
                    <Select
                      label="Supplier delivery time"
                      options={[
                        { label: "7 days", value: "7" },
                        { label: "14 days", value: "14" },
                        { label: "30 days", value: "30" },
                      ]}
                      value={leadTime}
                      onChange={handleLeadChange}
                      disabled={loading}
                    />
                    <Select
                      label="Safety stock"
                      options={[
                        { label: "10%", value: "0.1" },
                        { label: "20%", value: "0.2" },
                        { label: "30%", value: "0.3" },
                      ]}
                      value={bufferPct}
                      onChange={handleBufferChange}
                      disabled={loading}
                    />
                  </InlineStack>
                </Box>
              </BlockStack>
            </Card>

            {isDev &&
            !devHelperDismissed &&
            items.length > 0 &&
            noVelocityOnly ? (
              <Banner
                tone="info"
                title="Test this app with real data"
                onDismiss={() => setDevHelperDismissed(true)}
              >
                <BlockStack gap="300">
                  <Text as="p" variant="bodyMd">
                    To see reorder quantities, create test orders in your dev
                    store:
                  </Text>
                  <List type="number" gap="extraTight">
                    <List.Item>
                      Go to Shopify Admin → Orders → Create order
                    </List.Item>
                    <List.Item>
                      Add 3-5 products that have SKUs set
                    </List.Item>
                    <List.Item>Click Mark as paid</List.Item>
                    <List.Item>
                      Repeat 4-5 times with different quantities
                    </List.Item>
                    <List.Item>
                      Come back here and refresh — you&apos;ll see Days until
                      empty and Order qty calculated from those sales
                    </List.Item>
                  </List>
                </BlockStack>
              </Banner>
            ) : null}

            {items.length > 0 ? (
              <Card padding="0">
                <Box padding="400" paddingBlockEnd="200">
                  <BlockStack gap="300">
                    <BlockStack gap="100">
                      <Text variant="headingSm" as="h2">
                        SKU list
                      </Text>
                      <Text variant="bodySm" tone="subdued" as="p">
                        {noVelocityOnly
                          ? `Showing ${items.length} products · reorder quantities appear once sales come in`
                          : `Scrollable list — about five rows visible at once; scroll for the rest (${items.length} total).`}
                      </Text>
                    </BlockStack>
                  </BlockStack>
                </Box>
                <Box
                  background="bg-surface-secondary"
                  paddingInline="200"
                  paddingBlockEnd="200"
                >
                  <div
                    className="reorderly-sku-table-scroll"
                    style={{
                      maxHeight: "19.5rem",
                      overflowY: "auto",
                      overflowX: "auto",
                      position: "relative",
                      isolation: "isolate",
                      borderRadius: "var(--p-border-radius-200)",
                      boxShadow: "var(--p-shadow-inset-200)",
                    }}
                  >
                    <IndexTable
                      resourceName={{ singular: "SKU", plural: "SKUs" }}
                      itemCount={items.length}
                      selectedItemsCount={
                        allResourcesSelected ? "All" : selectedResources.length
                      }
                      onSelectionChange={handleSelectionChange}
                      headings={
                        noVelocityOnly
                          ? [
                              { title: "Product" },
                              { title: "Status" },
                              { title: "Stock", alignment: "end" },
                            ]
                          : [
                              { title: "Status" },
                              { title: "Product" },
                              { title: "Stock", alignment: "end" },
                              { title: "Avg daily", alignment: "end" },
                              { title: "Runway", alignment: "end" },
                              { title: "Order qty", alignment: "end" },
                            ]
                      }
                      loading={loading}
                    >
                      {items.map((row, index) => (
                        <IndexTable.Row
                          id={row.variant_id}
                          key={row.variant_id}
                          selected={selectedResources.includes(row.variant_id)}
                          position={index}
                          tone={rowTone(row.status)}
                        >
                          {noVelocityOnly ? (
                            <>
                              <IndexTable.Cell>
                                <BlockStack gap="050">
                                  <Text
                                    variant="bodyMd"
                                    fontWeight="semibold"
                                    as="span"
                                  >
                                    {row.product_title}
                                  </Text>
                                  <Text variant="bodySm" tone="subdued" as="span">
                                    {row.sku || "No SKU"}
                                  </Text>
                                </BlockStack>
                              </IndexTable.Cell>
                              <IndexTable.Cell>
                                {(row.sku ?? "").trim() ? (
                                  <Badge tone="attention">No orders yet</Badge>
                                ) : (
                                  <Badge>Missing product code</Badge>
                                )}
                              </IndexTable.Cell>
                              <IndexTable.Cell>
                                <div style={{ textAlign: "right" }}>
                                  <Text as="span" numeric>
                                    {row.current_inventory}
                                  </Text>
                                </div>
                              </IndexTable.Cell>
                            </>
                          ) : (
                            <>
                              <IndexTable.Cell>
                                <StatusBadge status={row.status} />
                              </IndexTable.Cell>
                              <IndexTable.Cell>
                                <BlockStack gap="050">
                                  <Text
                                    variant="bodyMd"
                                    fontWeight="semibold"
                                    as="span"
                                  >
                                    {row.product_title}
                                  </Text>
                                  <Text variant="bodySm" tone="subdued" as="span">
                                    {row.sku || "No SKU"}
                                  </Text>
                                </BlockStack>
                              </IndexTable.Cell>
                              <IndexTable.Cell>
                                <div style={{ textAlign: "right" }}>
                                  <Text as="span" numeric>
                                    {row.current_inventory}
                                  </Text>
                                </div>
                              </IndexTable.Cell>
                              <IndexTable.Cell>
                                <div style={{ textAlign: "right" }}>
                                  <Text as="span" numeric>
                                    {row.daily_sales.toFixed(2)}
                                  </Text>
                                </div>
                              </IndexTable.Cell>
                              <IndexTable.Cell>
                                <div style={{ textAlign: "right" }}>
                                  <Text as="span" numeric>
                                    {formatDays(row.days_left)}
                                  </Text>
                                </div>
                              </IndexTable.Cell>
                              <IndexTable.Cell>
                                <div style={{ textAlign: "right" }}>
                                  <Text
                                    as="span"
                                    numeric
                                    fontWeight={
                                      row.status === "Safe" ||
                                      row.status === "No data" ||
                                      row.status === "No recent sales"
                                        ? "regular"
                                        : "semibold"
                                    }
                                  >
                                    {row.reorder_qty}
                                  </Text>
                                </div>
                              </IndexTable.Cell>
                            </>
                          )}
                        </IndexTable.Row>
                      ))}
                    </IndexTable>
                  </div>
                </Box>
              </Card>
            ) : null}

            <Card padding="500">
              <BlockStack gap="400">
                <Text variant="headingSm" as="h2">
                  How this works
                </Text>
                <BlockStack gap="300">
                  <Text variant="bodyMd" as="p">
                    Reorderly checks your last 30 days of sales and calculates
                    how fast each product sells. It then tells you which
                    products to reorder and how many, based on how long your
                    supplier takes to deliver.
                  </Text>
                  <Text variant="bodyMd" as="p" tone="subdued">
                    <Text as="span" fontWeight="semibold">
                      Out of stock
                    </Text>
                    {" — "}you have zero units left and this product is still
                    selling. Order immediately.
                  </Text>
                  <Text variant="bodyMd" as="p" tone="subdued">
                    <Text as="span" fontWeight="semibold">
                      Urgent
                    </Text>
                    {" — "}stock will run out before your supplier can deliver.
                    Order today.
                  </Text>
                  <Text variant="bodyMd" as="p" tone="subdued">
                    <Text as="span" fontWeight="semibold">
                      Warning
                    </Text>
                    {" — "}stock is getting low. Order within the next few days.
                  </Text>
                  <Text variant="bodyMd" as="p" tone="subdued">
                    <Text as="span" fontWeight="semibold">
                      Safe
                    </Text>
                    {" — "}you have enough stock to cover your full supplier
                    delivery time plus your safety buffer.
                  </Text>
                  <Text variant="bodyMd" as="p" tone="subdued">
                    <Text as="span" fontWeight="semibold">
                      No orders yet
                    </Text>
                    {" — "}this product has not sold in 30 days. We cannot
                    calculate a reorder quantity but it is still shown so you can
                    see current stock.
                  </Text>
                  <Text variant="bodyMd" as="p" tone="subdued">
                    <Text as="span" fontWeight="semibold">
                      Missing product code
                    </Text>
                    {" — "}this product has no SKU set in Shopify. Go to
                    Products, find this item, and add a SKU to start tracking it.
                  </Text>
                </BlockStack>
                <InlineStack gap="300" wrap>
                  <Tooltip content="How many days from placing an order with your supplier to receiving the stock. Example: if your supplier takes 14 days to ship, set this to 14.">
                    <Button variant="tertiary" size="slim">
                      What is supplier delivery time?
                    </Button>
                  </Tooltip>
                  <Tooltip content="Extra stock as a safety cushion. At 20%, if you need 10 units to cover the delivery window, we suggest ordering 12 units instead.">
                    <Button variant="tertiary" size="slim">
                      What is safety stock?
                    </Button>
                  </Tooltip>
                </InlineStack>
              </BlockStack>
            </Card>

            {noVelocityOnly && items.length > 0 ? (
              <Card padding="500">
                <BlockStack gap="300">
                  <Text variant="headingSm" as="h2">
                    Quick actions
                  </Text>
                  <Text variant="bodySm" tone="subdued" as="p">
                    Things you can do right now to get the most from Reorderly.
                  </Text>
                  <BlockStack gap="200">
                    <Button variant="plain" url="shopify:admin/products">
                      Add product codes to untracked products
                    </Button>
                    <Button
                      variant="plain"
                      url="shopify:admin/products/inventory"
                    >
                      Review and update your current stock levels
                    </Button>
                  </BlockStack>
                </BlockStack>
              </Card>
            ) : null}
          </>
        ) : null}
      </BlockStack>
    </Page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
