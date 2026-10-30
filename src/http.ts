import { readFileSync, existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MarketService } from "./service.ts";
import {
  BadRequest,
  NotFound,
  Refusal,
  Unauthorized,
  UpstreamError,
  type Outcome,
  type PublishInput,
} from "./types.ts";

export type HttpOptions = {
  operatorToken: string;
  oracleToken: string;
  webOrigin?: string;
  scope?: <T>(fn: () => Promise<T>) => Promise<T>;
};

export function createApp(service: MarketService, options: HttpOptions): Server {
  return createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") {
        writeCors(res, options.webOrigin);
        res.writeHead(204);
        res.end();
        return;
      }
      const run = () => route(service, options, req, res);
      if (options.scope) await options.scope(run);
      else await run();
    } catch (error) {
      if (error instanceof BadRequest || error instanceof Unauthorized || error instanceof NotFound || error instanceof Refusal || error instanceof UpstreamError) {
        send(res, error.status, error instanceof Refusal ? { status: "refused", reason: error.message } : { error: error.message }, options.webOrigin);
        return;
      }
      send(res, 500, { error: "internal error" }, options.webOrigin);
    }
  });
}

async function route(service: MarketService, options: HttpOptions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);
  const method = req.method ?? "GET";
  const token = bearer(req);

  if (method === "GET" && parts.length === 1 && parts[0] === "health") {
    send(res, 200, { ok: true }, options.webOrigin);
    return;
  }

  if (method === "POST" && parts.length === 2 && parts[0] === "webhooks" && parts[1] === "gobtcpay") {
    const raw = await readRaw(req);
    if (!service.verifyWebhook(raw, header(req, "x-gobtcpay-signature"))) throw new Unauthorized();
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new BadRequest("invalid json");
    }
    const externalId = externalIdOf(body);
    if (!externalId) throw new BadRequest("externalId is required");
    await service.settleExternal(externalId);
    send(res, 200, { ok: true }, options.webOrigin);
    return;
  }

  if (method === "POST" && parts.length === 2 && parts[0] === "operator" && parts[1] === "markets") {
    requireToken(token, options.operatorToken);
    const market = service.publish(await readPublish(req));
    send(res, 201, market, options.webOrigin);
    return;
  }

  if (method === "PATCH" && parts.length === 3 && parts[0] === "operator" && parts[1] === "markets") {
    requireToken(token, options.operatorToken);
    send(res, 200, service.updateDraft(decodeURIComponent(parts[2]), await readDraftPatch(req)), options.webOrigin);
    return;
  }

  if (method === "POST" && parts.length === 4 && parts[0] === "operator" && parts[1] === "markets" && parts[3] === "submit") {
    requireToken(token, options.operatorToken);
    send(res, 200, service.submit(decodeURIComponent(parts[2])), options.webOrigin);
    return;
  }

  if (method === "POST" && parts.length === 4 && parts[0] === "operator" && parts[1] === "markets" && parts[3] === "open") {
    requireToken(token, options.operatorToken);
    send(res, 200, service.open(decodeURIComponent(parts[2])), options.webOrigin);
    return;
  }

  if (method === "POST" && parts.length === 4 && parts[0] === "operator" && parts[1] === "markets" && parts[3] === "reject") {
    requireToken(token, options.operatorToken);
    send(res, 200, service.reject(decodeURIComponent(parts[2])), options.webOrigin);
    return;
  }

  if (method === "POST" && parts.length === 4 && parts[0] === "operator" && parts[1] === "markets" && parts[3] === "quote") {
    requireToken(token, options.operatorToken);
    const body = await readJson(req);
    send(res, 200, service.setQuote(decodeURIComponent(parts[2]), readQuotePrices(body)), options.webOrigin);
    return;
  }

  if (method === "POST" && parts.length === 4 && parts[0] === "operator" && parts[1] === "markets" && parts[3] === "pause") {
    requireToken(token, options.operatorToken);
    send(res, 200, service.pause(decodeURIComponent(parts[2])), options.webOrigin);
    return;
  }

  if (method === "POST" && parts.length === 4 && parts[0] === "operator" && parts[1] === "markets" && parts[3] === "unpause") {
    requireToken(token, options.operatorToken);
    send(res, 200, service.unpause(decodeURIComponent(parts[2])), options.webOrigin);
    return;
  }

  if (method === "GET" && parts.length === 2 && parts[0] === "operator" && parts[1] === "markets") {
    requireToken(token, options.operatorToken);
    send(res, 200, service.listOperatorMarkets(), options.webOrigin);
    return;
  }

  if (method === "GET" && parts.length === 2 && parts[0] === "operator" && parts[1] === "ledger") {
    requireToken(token, options.operatorToken);
    send(res, 200, service.ledger(), options.webOrigin);
    return;
  }

  if (method === "GET" && parts.length === 2 && parts[0] === "operator" && parts[1] === "payouts") {
    requireToken(token, options.operatorToken);
    const status = url.searchParams.get("status");
    send(res, 200, service.listPayouts(status === "owed" || status === "sent" || status === "confirmed" ? status : undefined), options.webOrigin);
    return;
  }

  if (method === "POST" && parts.length === 4 && parts[0] === "operator" && parts[1] === "payouts" && parts[3] === "sent") {
    requireToken(token, options.operatorToken);
    const body = await readJson(req);
    send(res, 200, await service.markPayoutSent(decodeURIComponent(parts[2]), stringField(body, "transactionId")), options.webOrigin);
    return;
  }

  if (method === "POST" && parts.length === 4 && parts[0] === "operator" && parts[1] === "markets" && parts[3] === "archive") {
    requireToken(token, options.operatorToken);
    send(res, 200, service.archive(decodeURIComponent(parts[2])), options.webOrigin);
    return;
  }

  if (method === "POST" && parts.length === 4 && parts[0] === "operator" && parts[1] === "markets" && parts[3] === "backing") {
    requireToken(token, options.operatorToken);
    const body = await readJson(req);
    const transactionId = stringField(body, "transactionId");
    send(res, 200, await service.postBacking(decodeURIComponent(parts[2]), transactionId), options.webOrigin);
    return;
  }

  if (method === "POST" && parts.length === 2 && parts[0] === "oracle" && parts[1] === "proposals") {
    requireToken(token, options.oracleToken);
    const body = await readJson(req);
    send(res, 200, service.propose({
      marketId: stringField(body, "marketId"),
      outcome: outcomeField(body),
      evidence: stringField(body, "evidence"),
    }), options.webOrigin);
    return;
  }

  if (method === "POST" && parts.length === 4 && parts[0] === "oracle" && parts[1] === "markets" && parts[3] === "finalize") {
    requireToken(token, options.oracleToken);
    send(res, 200, service.finalize(decodeURIComponent(parts[2])), options.webOrigin);
    return;
  }

  if (method === "POST" && parts.length === 2 && parts[0] === "agent" && parts[1] === "challenges") {
    if (!token) throw new Unauthorized();
    const body = await readJson(req);
    send(res, 200, await service.challenge(token, {
      marketId: stringField(body, "marketId"),
      reason: stringField(body, "reason"),
    }), options.webOrigin);
    return;
  }

  if (method === "GET" && (parts.length === 0 || (parts.length === 1 && parts[0] === "index.html"))) {
    sendFile(res, "index.html", "text/html; charset=utf-8");
    return;
  }

  if (method === "GET" && parts.length === 1 && parts[0] === "board.css") {
    sendFile(res, "board.css", "text/css; charset=utf-8");
    return;
  }

  if (method === "GET" && parts.length === 2 && parts[0] === "agent" && parts[1] === "markets") {
    send(res, 200, service.listMarkets(), options.webOrigin);
    return;
  }

  if (method === "GET" && parts.length === 4 && parts[0] === "agent" && parts[1] === "markets" && parts[3] === "quotes") {
    send(res, 200, service.listQuotes(decodeURIComponent(parts[2])), options.webOrigin);
    return;
  }

  if (method === "GET" && parts.length === 1 && parts[0] === "llms.txt") {
    sendLlms(req, res, options.webOrigin);
    return;
  }  

  if (method === "GET" && parts.length === 3 && parts[0] === "agent" && parts[1] === "markets") {
    send(res, 200, service.getMarket(decodeURIComponent(parts[2])), options.webOrigin);
    return;
  }

  if (method === "GET" && parts.length === 2 && parts[0] === "agent" && parts[1] === "events") {
    send(res, 200, service.listEvents(url.searchParams.get("marketId") ?? undefined), options.webOrigin);
    return;
  }

  if (method === "GET" && parts.length === 3 && parts[0] === "agent" && parts[1] === "me" && parts[2] === "orders") {
    if (!token) throw new Unauthorized();
    send(res, 200, await service.listMyOrders(token), options.webOrigin);
    return;
  }

  if (method === "GET" && parts.length === 3 && parts[0] === "agent" && parts[1] === "me" && parts[2] === "positions") {
    if (!token) throw new Unauthorized();
    send(res, 200, await service.listMyPositions(token), options.webOrigin);
    return;
  }

  if (method === "GET" && parts.length === 3 && parts[0] === "agent" && parts[1] === "resolution") {
    send(res, 200, service.getResolution(decodeURIComponent(parts[2])), options.webOrigin);
    return;
  }

  if (method === "POST" && parts.length === 2 && parts[0] === "agent" && parts[1] === "checkout") {
    if (!token) throw new Unauthorized();
    const body = await readJson(req);
    const result = await service.checkout({
      token,
      marketId: stringField(body, "marketId"),
      outcome: outcomeField(body),
      quantity: integerField(body, "quantity"),
      maxPriceBps: integerField(body, "maxPriceBps"),
      quoteId: header(req, "x-quote-id"),
      txId: header(req, "x-transaction-id"),
      paymentId: header(req, "x-payment-id"),
    });
    send(res, result.http, result.http === 402 ? result.payment : result.order, options.webOrigin);
    return;
  }

  if (method === "GET" && parts.length === 3 && parts[0] === "agent" && parts[1] === "orders") {
    if (!token) throw new Unauthorized();
    send(res, 200, await service.getOrder(token, decodeURIComponent(parts[2])), options.webOrigin);
    return;
  }

  if (method === "POST" && parts.length === 2 && parts[0] === "agent" && parts[1] === "redemptions") {
    if (!token) throw new Unauthorized();
    const body = await readJson(req);
    send(res, 200, await service.redeem(token, {
      marketId: stringField(body, "marketId"),
      outcome: optionalOutcome(body),
      quantity: optionalInteger(body, "quantity"),
      wallet: optionalString(body, "wallet"),
    }), options.webOrigin);
    return;
  }

  throw new NotFound("not found");
}

function requireToken(token: string | undefined, expected: string): void {
  if (!token || token !== expected) throw new Unauthorized();
}

function bearer(req: IncomingMessage): string | undefined {
  const value = req.headers.authorization;
  if (!value) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(value);
  return match?.[1];
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value.trim();
}

async function readPublish(req: IncomingMessage) {
  const body = await readJson(req);
  return {
    question: stringField(body, "question"),
    description: optionalString(body, "description") ?? "",
    category: optionalString(body, "category") ?? "",
    closeAt: stringField(body, "closeAt"),
    resolutionSource: stringField(body, "resolutionSource"),
    resolutionRules: stringField(body, "resolutionRules"),
    challengePeriod: integerField(body, "challengePeriod"),
    unitSats: integerField(body, "unitSats"),
    tags: readTags(body),
    ...readPrices(body),
    maxShares: integerField(body, "maxShares"),
  };
}

async function readRaw(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function externalIdOf(body: Record<string, unknown>): string | undefined {
  if (typeof body.externalId === "string") return body.externalId;
  for (const key of ["data", "payment"] as const) {
    const nested = body[key];
    if (nested && typeof nested === "object" && typeof (nested as { externalId?: unknown }).externalId === "string") {
      return (nested as { externalId: string }).externalId;
    }
  }
  return undefined;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new BadRequest("body too large");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new BadRequest("invalid json");
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof BadRequest) throw error;
    throw new BadRequest("invalid json");
  }
}

function stringField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== "string" || value.trim() === "") throw new BadRequest(`${name} is required`);
  return value;
}

function optionalString(body: Record<string, unknown>, name: string): string | undefined {
  if (body[name] === undefined) return undefined;
  return stringField(body, name);
}

function integerField(body: Record<string, unknown>, name: string): number {
  const value = body[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new BadRequest(`${name} must be an integer`);
  return value;
}

function optionalInteger(body: Record<string, unknown>, name: string): number | undefined {
  if (body[name] === undefined) return undefined;
  return integerField(body, name);
}

function outcomeField(body: Record<string, unknown>): Outcome {
  const value = body.outcome;
  if (typeof value !== "string" || value.trim() === "") throw new BadRequest("outcome is required");
  return value.trim();
}

function readPrices(body: Record<string, unknown>): { outcomes: ReturnType<typeof readOutcomeDrafts> } | { yesPriceBps: number; noPriceBps: number } {
  if (body.outcomes !== undefined) return { outcomes: readOutcomeDrafts(body) };
  return { yesPriceBps: integerField(body, "yesPriceBps"), noPriceBps: integerField(body, "noPriceBps") };
}

function readQuotePrices(body: Record<string, unknown>): { id: string; priceBps: number }[] {
  if (body.outcomes !== undefined) {
    return readOutcomeDrafts(body).map((outcome) => {
      if (!outcome.id) throw new BadRequest("outcome id is required");
      return { id: outcome.id, priceBps: outcome.priceBps };
    });
  }
  return [
    { id: "YES", priceBps: integerField(body, "yesPriceBps") },
    { id: "NO", priceBps: integerField(body, "noPriceBps") },
  ];
}

function readOutcomeDrafts(body: Record<string, unknown>) {
  if (!Array.isArray(body.outcomes)) throw new BadRequest("outcomes must be a list");
  return body.outcomes.map((row) => {
    if (!row || typeof row !== "object") throw new BadRequest("outcomes must be a list");
    const item = row as Record<string, unknown>;
    const draft: { id?: string; label: string; priceBps: number } = {
      label: stringField(item, "label"),
      priceBps: integerField(item, "priceBps"),
    };
    if (typeof item.id === "string" && item.id.trim() !== "") draft.id = item.id.trim();
    return draft;
  });
}

function readTags(body: Record<string, unknown>): string[] | undefined {
  if (body.tags === undefined) return undefined;
  if (!Array.isArray(body.tags)) throw new BadRequest("tags must be a list");
  return body.tags.map((tag) => {
    if (typeof tag !== "string") throw new BadRequest("tags must be text");
    return tag;
  });
}

function optionalOutcome(body: Record<string, unknown>): Outcome | undefined {
  if (body.outcome === undefined) return undefined;
  return outcomeField(body);
}

const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

function sendFile(res: ServerResponse, name: string, contentType: string): void {
  const payload = readFileSync(join(publicDir, name));
  res.writeHead(200, {
    "content-type": contentType,
    "content-length": payload.length,
    "cache-control": "no-cache",
  });
  res.end(payload);
}

function readDraftPatch(req: IncomingMessage): Promise<Partial<PublishInput>> {
  return readJson(req).then((body) => {
    const patch: Partial<PublishInput> = {};
    for (const key of ["question", "description", "category", "closeAt", "resolutionSource", "resolutionRules"] as const) {
      if (body[key] !== undefined) patch[key] = stringField(body, key);
    }
    for (const key of ["challengePeriod", "unitSats", "yesPriceBps", "noPriceBps", "maxShares"] as const) {
      if (body[key] !== undefined) patch[key] = integerField(body, key);
    }
    if (body.tags !== undefined) patch.tags = readTags(body);
    if (body.outcomes !== undefined) patch.outcomes = readOutcomeDrafts(body);
    return patch;
  });
}

function sendLlms(req: IncomingMessage, res: ServerResponse, origin?: string): void {
  const file = llmsFile();
  const raw = file ? readFileSync(file, "utf8") : "Catalog is unavailable.\n";
  const payload = Buffer.from(raw.replaceAll("{origin}", requestOrigin(req)), "utf8");
  writeCors(res, origin);
  res.writeHead(200, {
    "content-type": "text/plain, charset=utf-8",
    "content-length": payload.length,
    "cache-control": "no-cache",
  });
  res.send(payload);
}

function writeCors(res: ServerResponse, origin: string | undefined): void {
  if (!origin) return;
  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("access-control-allow-headers", "authorization, content-type, x-quote-id, x-transaction-id");
  res.setHeader("access-control-allow-methods", "GET, POST, PATCH, OPTIONS");
  res.setHeader("vary", "origin");
}

function send(res: ServerResponse, status: number, body: unknown, origin?: string): void {
  const payload = JSON.stringify(body);
  writeCors(res, origin);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}
