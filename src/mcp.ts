import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { MarketService } from "./service.ts";
import { BadRequest, NotFound, Refusal, Unauthorized, UpstreamError } from "./types.ts";

/**
 * MCP over the HTTP+SSE transport (protocol 2024-11-05), the same shape as
 * the O Biscotti connector at mcp.agnic.ai/sse.
 * GET /sse opens the stream. POST /messages?session_id= sends JSON-RPC.
 */

type Session = {
  res: ServerResponse;
  token?: string;
};

type RpcId = string | number | null;

type Rpc = {
  jsonrpc?: unknown;
  id?: RpcId;
  method?: unknown;
  params?: unknown;
};

const sessions = new Map<string, Session>();

const tools = [
  {
    name: "list_markets",
    description: "List markets an agent can read. Buy only while status is OPEN and paused is false.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_market",
    description: "Read one market, including outcome ids, labels, and priceBps.",
    inputSchema: {
      type: "object",
      properties: { marketId: { type: "string" } },
      required: ["marketId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_quotes",
    description: "Published outcome prices for one market. An issued quote keeps its price.",
    inputSchema: {
      type: "object",
      properties: { marketId: { type: "string" } },
      required: ["marketId"],
      additionalProperties: false,
    },
  },
  {
    name: "checkout",
    description:
      "Buy shares from the Agnic wallet on this connection. The first call returns HTTP 402 with amountSats, quoteId, paymentId, checkoutUrl, and qrString. Pay that GoBTC payment, then call again with the same marketId, outcome, quantity, and maxPriceBps plus quoteId and paymentId. HTTP 202 means the payment is seen. HTTP 200 means the order is filled. A transactionId pays the quoted address when the 402 has no paymentId.",
    inputSchema: {
      type: "object",
      properties: {
        marketId: { type: "string" },
        outcome: { type: "string", description: "Outcome id. YES or NO on a Yes/No market." },
        quantity: { type: "integer", minimum: 1 },
        maxPriceBps: { type: "integer", minimum: 0, maximum: 10000 },
        quoteId: { type: "string" },
        paymentId: { type: "string" },
        transactionId: { type: "string" },
      },
      required: ["marketId", "outcome", "quantity", "maxPriceBps"],
      additionalProperties: false,
    },
  },
  {
    name: "get_order",
    description: "Read one order for the connected wallet, including a pending payment.",
    inputSchema: {
      type: "object",
      properties: { quoteId: { type: "string" } },
      required: ["quoteId"],
      additionalProperties: false,
    },
  },
  {
    name: "my_orders",
    description: "Orders for the Agnic wallet on this connection.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "my_positions",
    description: "Share balances and payouts for the Agnic wallet on this connection.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_resolution",
    description: "Resolution status, proposal, and final outcome for one market.",
    inputSchema: {
      type: "object",
      properties: { marketId: { type: "string" } },
      required: ["marketId"],
      additionalProperties: false,
    },
  },
  {
    name: "redeem",
    description: "Redeem shares after the market is finalized. A winning share pays unitSats minus the fee.",
    inputSchema: {
      type: "object",
      properties: {
        marketId: { type: "string" },
        outcome: { type: "string" },
        quantity: { type: "integer", minimum: 1 },
      },
      required: ["marketId"],
      additionalProperties: false,
    },
  },
  {
    name: "challenge",
    description: "Dispute a proposed outcome while the challenge window is open.",
    inputSchema: {
      type: "object",
      properties: {
        marketId: { type: "string" },
        reason: { type: "string" },
      },
      required: ["marketId", "reason"],
      additionalProperties: false,
    },
  },
];

export function openMcpSse(req: IncomingMessage, res: ServerResponse, origin?: string): void {
  const id = randomUUID();
  sessions.set(id, { res, token: bearer(req) });
  writeCors(res, origin);
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  res.write(`event: endpoint\ndata: /messages?session_id=${id}\n\n`);
  const timer = setInterval(() => {
    res.write(": ping\n\n");
  }, 15_000);
  timer.unref();
  const close = () => {
    clearInterval(timer);
    if (sessions.get(id)?.res === res) sessions.delete(id);
  };
  req.on("close", close);
  res.on("close", close);
}

export async function postMcpMessage(
  service: MarketService,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  origin?: string,
): Promise<void> {
  const session = sessions.get(url.searchParams.get("session_id") ?? "");
  if (!session) throw new NotFound("session not found");
  const token = bearer(req) ?? session.token;
  const messages = await readRpc(req);
  for (const message of messages) {
    const response = await handleRpc(service, message, token);
    if (response) writeMessage(session.res, response);
  }
  writeCors(res, origin);
  res.writeHead(202);
  res.end();
}

async function handleRpc(service: MarketService, message: unknown, token: string | undefined): Promise<unknown> {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return rpcError(null, -32600, "invalid request");
  }
  const rpc = message as Rpc;
  const id = rpc.id ?? null;
  if (rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") return rpcError(id, -32600, "invalid request");
  if (rpc.id === undefined) return null;
  try {
    const result = await dispatch(service, rpc.method, rpc.params, token);
    return { jsonrpc: "2.0", id: rpc.id, result };
  } catch (error) {
    if (error instanceof BadRequest) return rpcError(rpc.id, -32602, error.message);
    if (error instanceof NotFound && error.message === "unknown method") return rpcError(rpc.id, -32601, error.message);
    if (error instanceof Unauthorized || error instanceof NotFound || error instanceof Refusal || error instanceof UpstreamError) {
      return rpcError(rpc.id, -32603, error.message);
    }
    throw error;
  }
}

async function dispatch(service: MarketService, method: string, params: unknown, token: string | undefined): Promise<unknown> {
  if (method === "initialize") {
    return {
      protocolVersion: "2024-11-05",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "bazaar", version: "1.0.0" },
      instructions:
        "List open markets, then buy one outcome with checkout. The first checkout returns a 402 payment. Pay amountSats from the Agnic wallet, then call checkout again with quoteId and paymentId. The connection needs Authorization: Bearer <agnic token>.",
    };
  }
  if (method === "ping") return {};
  if (method === "tools/list") return { tools };
  if (method === "tools/call") return callTool(service, params, token);
  throw new NotFound("unknown method");
}

async function callTool(service: MarketService, params: unknown, token: string | undefined): Promise<unknown> {
  const record = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
  const name = record.name;
  if (typeof name !== "string" || name === "") throw new BadRequest("tool name is required");
  const args = record.arguments && typeof record.arguments === "object" && !Array.isArray(record.arguments)
    ? (record.arguments as Record<string, unknown>)
    : {};
  try {
    const value = await runTool(service, name, args, token);
    return { content: [{ type: "text", text: JSON.stringify(value) }] };
  } catch (error) {
    if (error instanceof BadRequest && error.message === "unknown tool") throw error;
    if (
      error instanceof BadRequest ||
      error instanceof Unauthorized ||
      error instanceof NotFound ||
      error instanceof Refusal ||
      error instanceof UpstreamError
    ) {
      return { content: [{ type: "text", text: error.message }], isError: true };
    }
    throw error;
  }
}

async function runTool(service: MarketService, name: string, args: Record<string, unknown>, token: string | undefined): Promise<unknown> {
  if (name === "list_markets") return service.listMarkets();
  if (name === "get_market") return service.getMarket(requiredString(args, "marketId"));
  if (name === "list_quotes") return service.listQuotes(requiredString(args, "marketId"));
  if (name === "get_resolution") return service.getResolution(requiredString(args, "marketId"));
  if (name === "checkout") {
    const result = await service.checkout({
      token: requiredToken(token),
      marketId: requiredString(args, "marketId"),
      outcome: requiredString(args, "outcome"),
      quantity: requiredInt(args, "quantity"),
      maxPriceBps: requiredInt(args, "maxPriceBps"),
      quoteId: optionalString(args, "quoteId"),
      paymentId: optionalString(args, "paymentId"),
      txId: optionalString(args, "transactionId"),
    });
    return result.http === 402 ? { http: 402, ...result.payment } : { http: result.http, ...result.order };
  }
  if (name === "get_order") return service.getOrder(requiredToken(token), requiredString(args, "quoteId"));
  if (name === "my_orders") return service.listMyOrders(requiredToken(token));
  if (name === "my_positions") return service.listMyPositions(requiredToken(token));
  if (name === "redeem") {
    return service.redeem(requiredToken(token), {
      marketId: requiredString(args, "marketId"),
      outcome: optionalString(args, "outcome"),
      quantity: optionalInt(args, "quantity"),
    });
  }
  if (name === "challenge") {
    return service.challenge(requiredToken(token), {
      marketId: requiredString(args, "marketId"),
      reason: requiredString(args, "reason"),
    });
  }
  throw new BadRequest("unknown tool");
}

function requiredToken(token: string | undefined): string {
  if (!token) throw new Unauthorized();
  return token;
}

function requiredString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value.trim() === "") throw new BadRequest(`${name} is required`);
  return value;
}

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  if (args[name] === undefined) return undefined;
  return requiredString(args, name);
}

function requiredInt(args: Record<string, unknown>, name: string): number {
  const value = args[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new BadRequest(`${name} must be an integer`);
  return value;
}

function optionalInt(args: Record<string, unknown>, name: string): number | undefined {
  if (args[name] === undefined) return undefined;
  return requiredInt(args, name);
}

function rpcError(id: RpcId, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function writeMessage(res: ServerResponse, payload: unknown): void {
  res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
}

function bearer(req: IncomingMessage): string | undefined {
  const value = req.headers.authorization;
  if (!value) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(value);
  return match?.[1];
}

function writeCors(res: ServerResponse, origin: string | undefined): void {
  if (!origin) return;
  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("access-control-allow-headers", "authorization, content-type, x-quote-id, x-transaction-id");
  res.setHeader("access-control-allow-methods", "GET, POST, PATCH, OPTIONS");
  res.setHeader("vary", "origin");
}

async function readRpc(req: IncomingMessage): Promise<unknown[]> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new BadRequest("body too large");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new BadRequest("invalid json");
  }
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== "object") throw new BadRequest("invalid json");
  return [parsed];
}
