import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form } from "react-router";
import { useCallback, useEffect, useState } from "react";
import {
  Banner,
  BlockStack,
  Button,
  IndexTable,
  InlineStack,
  Layout,
  LegacyCard,
  Page,
  Select,
  SkeletonBodyText,
  SkeletonDisplayText,
  SkeletonPage,
  Text,
  useIndexResourceState,
} from "@shopify/polaris";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

type Urgency = "RED" | "YELLOW" | "GREEN";

type ReorderItem = {
  product_title: string;
  variant_id: string;
  sku: string;
  current_inventory: number;
  daily_sales: number;
  days_left: number | null;
  reorder_qty: number;
  urgency: Urgency;
};

type ReorderListResponse = {
  items: ReorderItem[];
  variantCount: number;
  billingBlocked: boolean;
  leadTimeDays: number;
  bufferPct: number;
  error?: boolean;
  message?: string;
};

function rowTone(
  urgency: Urgency,
): "success" | "warning" | "critical" | undefined {
  if (urgency === "RED") return "critical";
  if (urgency === "YELLOW") return "warning";
  if (urgency === "GREEN") return "success";
  return undefined;
}

function formatDaysLeft(days: number | null): string {
  if (days === null || !Number.isFinite(days)) return "—";
  return days < 100 ? days.toFixed(1) : "999+";
}

export default function TodaysReorder() {
  const [leadTime, setLeadTime] = useState("14");
  const [bufferPct, setBufferPct] = useState("0.2");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [data, setData] = useState<ReorderListResponse | null>(null);

  const fetchList = useCallback(async (lead: string, buffer: string) => {
    const params = new URLSearchParams({
      lead_time_days: lead,
      buffer_pct: buffer,
    });
    const res = await fetch(`/api/reorder-list?${params}`, {
      credentials: "same-origin",
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
      const res = await fetch("/api/reorder-list", { credentials: "same-origin" });
      const json = (await res.json()) as ReorderListResponse & { error?: boolean };
      const result =
        !res.ok || json.error
          ? { ok: false as const }
          : { ok: true as const, data: json };
      if (cancelled) return;
      if (!result.ok) {
        setError(true);
        setData(null);
      } else {
        setData(result.data);
        setLeadTime(String(result.data.leadTimeDays));
        setBufferPct(String(result.data.bufferPct));
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
        credentials: "same-origin",
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
    } else {
      setData(result.data);
      setLeadTime(String(result.data.leadTimeDays));
      setBufferPct(String(result.data.bufferPct));
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
    a.download = `reorderly-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading && !data) {
    return (
      <SkeletonPage primaryAction>
        <Layout>
          <Layout.Section>
            <LegacyCard sectioned>
              <BlockStack gap="400">
                <SkeletonDisplayText size="small" />
                <SkeletonBodyText lines={6} />
              </BlockStack>
            </LegacyCard>
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

  return (
    <Page
      title="Today's Reorder"
      subtitle="Based on last 30 days sales"
      primaryAction={{
        content: "Export CSV",
        onAction: exportCsv,
        disabled: exportDisabled,
      }}
    >
      <BlockStack gap="400">
        {error ? (
          <Banner tone="critical">
            <Text as="p" variant="bodyMd">
              Unable to load inventory data
            </Text>
          </Banner>
        ) : null}

        {billingBlocked ? (
          <Banner title="Upgrade to continue" tone="warning">
            <BlockStack gap="300">
              <p>
                Reorderly includes up to 25 SKUs at no charge. This shop has{" "}
                {data?.variantCount ?? 0} variants — subscribe for $9/month to
                continue.
              </p>
              <Form method="post" action="/api/billing/request" target="_top">
                <Button submit variant="primary">
                  Upgrade to continue
                </Button>
              </Form>
            </BlockStack>
          </Banner>
        ) : null}

        <LegacyCard sectioned>
          <InlineStack gap="400" wrap>
            <Select
              label="Lead time (days)"
              options={[
                { label: "7 days", value: "7" },
                { label: "14 days", value: "14" },
                { label: "30 days", value: "30" },
              ]}
              value={leadTime}
              onChange={handleLeadChange}
              disabled={loading || billingBlocked}
            />
            <Select
              label="Buffer %"
              options={[
                { label: "10%", value: "0.1" },
                { label: "20%", value: "0.2" },
                { label: "30%", value: "0.3" },
              ]}
              value={bufferPct}
              onChange={handleBufferChange}
              disabled={loading || billingBlocked}
            />
          </InlineStack>
        </LegacyCard>

        {!error && !billingBlocked && items.length === 0 ? (
          <LegacyCard sectioned>
            <Text as="p" tone="subdued" variant="bodyLg">
              All products have sufficient stock
            </Text>
          </LegacyCard>
        ) : null}

        {!error && !billingBlocked && items.length > 0 ? (
          <LegacyCard>
            <LegacyCard.Section flush>
            <IndexTable
              resourceName={{ singular: "item", plural: "items" }}
              itemCount={items.length}
              selectedItemsCount={
                allResourcesSelected ? "All" : selectedResources.length
              }
              onSelectionChange={handleSelectionChange}
              headings={[
                { title: "Product name" },
                { title: "SKU" },
                { title: "Current stock", alignment: "end" },
                { title: "Daily sales", alignment: "end" },
                { title: "Days left", alignment: "end" },
                { title: "Reorder qty", alignment: "end" },
              ]}
              loading={loading}
            >
              {items.map((row, index) => (
                <IndexTable.Row
                  id={row.variant_id}
                  key={row.variant_id}
                  selected={selectedResources.includes(row.variant_id)}
                  position={index}
                  tone={rowTone(row.urgency)}
                >
                  <IndexTable.Cell>
                    <Text variant="bodyMd" fontWeight="semibold" as="span">
                      {row.product_title}
                    </Text>
                  </IndexTable.Cell>
                  <IndexTable.Cell>{row.sku || "—"}</IndexTable.Cell>
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
                        {formatDaysLeft(row.days_left)}
                      </Text>
                    </div>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <div style={{ textAlign: "right" }}>
                      <Text as="span" numeric>
                        {row.reorder_qty}
                      </Text>
                    </div>
                  </IndexTable.Cell>
                </IndexTable.Row>
              ))}
            </IndexTable>
            </LegacyCard.Section>
          </LegacyCard>
        ) : null}
      </BlockStack>
    </Page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
