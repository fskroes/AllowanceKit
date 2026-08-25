import http from "node:http";
import { paymentGate } from "./seller.ts";
import type { Facilitator } from "./chain.ts";
import { usd, fmtUsdExact } from "./money.ts";

export interface DemoServer {
  port: number;
  name: string;
  priceMicro: bigint;
  close(): Promise<void>;
}

function listen(port: number, handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

async function startPaidApi(
  port: number,
  name: string,
  priceUsdValue: number,
  description: string,
  payTo: string,
  facilitator: Facilitator,
  payloadFor: (url: string) => unknown,
): Promise<DemoServer> {
  const priceMicro = usd(priceUsdValue);
  const server = await listen(
    port,
    paymentGate({ priceMicro, description, payTo, facilitator }, async (_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(await Promise.resolve(payloadFor(_req.url ?? "/"))));
    }),
  );
  return {
    port,
    name,
    priceMicro,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

export interface PaidApiCatalog {
  servers: DemoServer[];
  weatherUrl(city: string): string;
  bulkDataUrl(n: number): string;
  premiumResearchUrl(topic: string): string;
  analystReportUrl(id: string): string;
  enterpriseFeedUrl(key: string): string;
}

export async function startSellerApis(facilitator: Facilitator, basePort = 4021): Promise<PaidApiCatalog> {
  const weather = await startPaidApi(basePort, "weather-api", 0.001, "Live weather lookup per city", "0xseller0000000000000000000000000000weath", facilitator, (url) => ({
    city: decodeURIComponent((url.split("city=")[1] ?? "unknown").split("&")[0]),
    tempC: Math.round((Math.random() * 30 - 5) * 10) / 10,
    conditions: ["sunny", "cloudy", "rainy"][Math.floor(Math.random() * 3)],
  }));

  const bulk = await startPaidApi(basePort + 1, "bulk-data-api", 0.01, "Bulk records fetch (per 1k rows)", "0xseller0000000000000000000000000000bulk0", facilitator, () => ({
    rows: Array.from({ length: 3 }, (_, i) => ({ id: i, value: Math.random().toFixed(4) })),
  }));

  const premium = await startPaidApi(basePort + 2, "premium-research-api", 0.25, "Deep-dive research report section", "0xseller00000000000000000000000000prem0", facilitator, (url) => ({
    topic: decodeURIComponent((url.split("topic=")[1] ?? "general").split("&")[0]),
    findings: [
      "agentic commerce volume grew 40x YoY",
      "average machine payment size $0.32",
      "buyer-side controls remain the top unmet need",
    ],
  }));

  const analyst = await startPaidApi(basePort + 3, "analyst-report-api", 0.45, "Analyst market report (PDF)", "0xseller00000000000000000000000000anal0", facilitator, () => ({
    report: "[28-page PDF omitted in demo]",
  }));

  const enterprise = await startPaidApi(basePort + 4, "enterprise-feed-api", 5.0, "Enterprise real-time feed license", "0xseller00000000000000000000000000ente0", facilitator, () => ({
    feed: "[licensed stream omitted in demo]",
  }));

  return {
    servers: [weather, bulk, premium, analyst, enterprise],
    weatherUrl: (city) => `http://localhost:${basePort}/weather?city=${encodeURIComponent(city)}`,
    bulkDataUrl: (n) => `http://localhost:${basePort + 1}/rows?count=${n}`,
    premiumResearchUrl: (topic) => `http://localhost:${basePort + 2}/research?topic=${encodeURIComponent(topic)}`,
    analystReportUrl: (id) => `http://localhost:${basePort + 3}/report?id=${encodeURIComponent(id)}`,
    enterpriseFeedUrl: (key) => `http://localhost:${basePort + 4}/feed?key=${encodeURIComponent(key)}`,
  };
}

export function describeServers(catalog: PaidApiCatalog): string {
  return catalog.servers.map((s) => `  :${s.port}  ${s.name.padEnd(22)} ${fmtUsdExact(s.priceMicro)}/call`).join("\n");
}
