const ORDERS_IDS_QUERY = `#graphql
  query ReorderlyOrderIds($query: String!, $cursor: String) {
    orders(first: 50, query: $query, after: $cursor, sortKey: CREATED_AT, reverse: true) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
        }
      }
    }
  }
`;

const LINE_ITEMS_QUERY = `#graphql
  query ReorderlyOrderLineItems($id: ID!, $cursor: String) {
    order(id: $id) {
      lineItems(first: 250, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        edges {
          node {
            quantity
            variant {
              id
              sku
              product {
                isGiftCard
              }
            }
          }
        }
      }
    }
  }
`;

const CATALOG_PRODUCTS_QUERY = "status:active";

const PRODUCTS_QUERY = `#graphql
  query ReorderlyProducts($cursor: String, $query: String!) {
    products(first: 50, query: $query, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          title
          status
          isGiftCard
          variants(first: 100) {
            pageInfo {
              hasNextPage
              endCursor
            }
            edges {
              node {
                id
                sku
                inventoryQuantity
              }
            }
          }
        }
      }
    }
  }
`;

const PRODUCT_VARIANTS_PAGE = `#graphql
  query ReorderlyProductVariants($id: ID!, $cursor: String) {
    product(id: $id) {
      variants(first: 100, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        edges {
          node {
            id
            sku
            inventoryQuantity
          }
        }
      }
    }
  }
`;

type AdminWithGraphql = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

function ymdUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function fetchAllOrderLineItems(
  admin: AdminWithGraphql,
  orderId: string,
): Promise<Array<{ quantity: number; variantId: string }>> {
  const out: Array<{ quantity: number; variantId: string }> = [];
  let cursor: string | null = null;
  for (;;) {
    const r = await admin.graphql(LINE_ITEMS_QUERY, {
      variables: { id: orderId, cursor },
    });
    const j = (await r.json()) as {
      data?: {
        order?: {
          lineItems: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            edges: Array<{
              node: {
                quantity: number;
                variant: {
                  id: string;
                  product?: { isGiftCard: boolean } | null;
                } | null;
              };
            }>;
          };
        } | null;
      };
    };
    const conn = j.data?.order?.lineItems;
    if (!conn) break;
    for (const e of conn.edges) {
      const v = e.node.variant;
      const vid = v?.id;
      if (!vid) continue;
      if (v.product?.isGiftCard) continue;
      out.push({ quantity: e.node.quantity, variantId: vid });
    }
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return out;
}

export async function fetchReorderSourceData(admin: AdminWithGraphql): Promise<{
  ordersAggregated: Array<{ variantId: string; quantity: number }>;
  productVariants: Array<{
    productTitle: string;
    variantId: string;
    sku: string | null;
    currentInventory: number;
  }>;
  variantCount: number;
  ordersInLast30Days: number;
  variantsWithSales: number;
}> {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - 30);
  const ordersQuery = `created_at:>=${ymdUTC(start)}`;

  const variantSales = new Map<string, number>();
  let ordersInLast30Days = 0;

  let orderCursor: string | null = null;
  for (;;) {
    const res = await admin.graphql(ORDERS_IDS_QUERY, {
      variables: { query: ordersQuery, cursor: orderCursor },
    });
    const body = (await res.json()) as {
      errors?: Array<{ message: string }>;
      data?: {
        orders?: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          edges: Array<{ node: { id: string } }>;
        };
      };
    };

    if (body.errors?.length) {
      console.error(
        "Reorderly orders query:",
        body.errors.map((e) => e.message).join("; "),
      );
    }

    const conn = body.data?.orders;
    if (!conn) break;

    for (const edge of conn.edges) {
      ordersInLast30Days += 1;
      const lines = await fetchAllOrderLineItems(admin, edge.node.id);
      for (const row of lines) {
        variantSales.set(
          row.variantId,
          (variantSales.get(row.variantId) ?? 0) + row.quantity,
        );
      }
    }

    if (!conn.pageInfo.hasNextPage) break;
    orderCursor = conn.pageInfo.endCursor;
  }

  const ordersAggregated = [...variantSales.entries()].map(([variantId, quantity]) => ({
    variantId,
    quantity,
  }));

  const variantRows: Array<{
    productTitle: string;
    variantId: string;
    sku: string | null;
    currentInventory: number;
    isGiftCard: boolean;
    productStatus: string;
  }> = [];

  let productCursor: string | null = null;
  console.log(
    "[Reorderly] Starting product fetch with query:",
    CATALOG_PRODUCTS_QUERY,
  );
  for (;;) {
    const pres = await admin.graphql(PRODUCTS_QUERY, {
      variables: { cursor: productCursor, query: CATALOG_PRODUCTS_QUERY },
    });
    const pbody = (await pres.json()) as {
      data?: {
        products?: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          edges: Array<{
            node: {
              id: string;
              title: string;
              status: string;
              isGiftCard: boolean;
              variants: {
                pageInfo: { hasNextPage: boolean; endCursor: string | null };
                edges: Array<{
                  node: {
                    id: string;
                    sku: string | null;
                    inventoryQuantity: number | null;
                  };
                }>;
              };
            };
          }>;
        };
      };
    };

    const pconn = pbody.data?.products;
    if (!pconn) {
      console.error(
        "[Reorderly] Products query returned no data. Raw response:",
        JSON.stringify(pbody).slice(0, 500),
      );
      break;
    }
    console.log(
      "[Reorderly] Products page fetched:",
      pconn.edges.length,
      "products",
    );

    for (const pe of pconn.edges) {
      const p = pe.node;

      const collectVariantPage = async (
        edges: typeof p.variants.edges,
        hasNext: boolean,
        endCursor: string | null,
      ) => {
        for (const ve of edges) {
          const n = ve.node;
          variantRows.push({
            productTitle: p.title,
            variantId: n.id,
            sku: n.sku,
            currentInventory: n.inventoryQuantity ?? 0,
            isGiftCard: p.isGiftCard,
            productStatus: p.status,
          });
        }
        if (!hasNext) return;
        let vCur: string | null = endCursor;
        while (vCur) {
          const vr = await admin.graphql(PRODUCT_VARIANTS_PAGE, {
            variables: { id: p.id, cursor: vCur },
          });
          const vj = (await vr.json()) as {
            data?: {
              product?: {
                variants: {
                  pageInfo: { hasNextPage: boolean; endCursor: string | null };
                  edges: Array<{
                    node: {
                      id: string;
                      sku: string | null;
                      inventoryQuantity: number | null;
                    };
                  }>;
                };
              } | null;
            };
          };
          const vc = vj.data?.product?.variants;
          if (!vc) break;
          for (const ve of vc.edges) {
            const n = ve.node;
            variantRows.push({
              productTitle: p.title,
              variantId: n.id,
              sku: n.sku,
              currentInventory: n.inventoryQuantity ?? 0,
              isGiftCard: p.isGiftCard,
              productStatus: p.status,
            });
          }
          if (!vc.pageInfo.hasNextPage) break;
          vCur = vc.pageInfo.endCursor;
        }
      };

      await collectVariantPage(
        p.variants.edges,
        p.variants.pageInfo.hasNextPage,
        p.variants.pageInfo.endCursor,
      );
    }

    if (!pconn.pageInfo.hasNextPage) break;
    productCursor = pconn.pageInfo.endCursor;
  }

  const productVariants = variantRows
    .filter((v) => !v.isGiftCard && v.productStatus === "ACTIVE")
    .map(({ productTitle, variantId, sku, currentInventory }) => ({
      productTitle,
      variantId,
      sku,
      currentInventory,
    }));
  const variantCount = productVariants.length;

  const variantsWithSales = variantSales.size;

  console.log(
    "[Reorderly] Final counts — variants:",
    productVariants.length,
    "orders:",
    ordersInLast30Days,
  );

  return {
    ordersAggregated,
    productVariants,
    variantCount,
    ordersInLast30Days,
    variantsWithSales,
  };
}
