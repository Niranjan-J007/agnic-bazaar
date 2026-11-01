import type { Server } from "node:http";
import { BlobNotFoundError, BlobPreconditionFailedError, get, put } from "@vercel/blob";
import type { MarketService } from "./service.ts";

const PATHNAME= "market/service-state.json";

export class BlobConflict extends Error {
    constructor() {
        super("Blob conflict");
        this.name = "BlobConflict";
    }
}

export type StoredState = {
    body: unknown | null;
    raw: string | null;
    etag?: string ;
}

export type StateStore = {
    read(): Promise<StoredState>;
    write(raw: string, etag?: string): Promise<void>;
}

type Snapshot = Parameters<MarketService["restore"]>[0];

export function blobConfigured(): boolean {
    return Boolean(process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN);
}

export function vercelBlobStore(): StateStore {
    return {
        read: async () => {
            try {
                const result = await get(PATHNAME, { access: "public", useCache: false });
                if(!result || result.statusCode !== 200 || !result.stream) {
                    return { body: null, raw: null };
                }
                
                const raw = await readStream(result.stream);
                return { body: raw ? JSON.parse(raw) : null, raw, etag: result.blob.etag };
            } catch (error) {
                if (error instanceof BlobNotFoundError) {
                    return { body: null, raw: null };
                }
                throw error;
            }
        },
        write: async (raw, etag) => {
            try {
                await put(PATHNAME, raw, { 
                    access: "public", 
                    allowOverwrite: true,
                    contentType: "application/json",
                    ...(etag ? { ifMatch: etag } : {}),
                });            
             
            } catch (error) {
                if (error instanceof BlobPreconditionFailedError) {
                    throw new BlobConflict();
                }
                throw error;
            }
        }
    };
}

export async function loadBlobState(service: MarketService, store: StateStore): Promise<void> {
    const loaded = await store.read();
    service.restore( asSnapshot(loaded.body) );
}

export async function saveBlobState(service: MarketService, store: StateStore): Promise<void> {
    const loaded = await store.read();
    const next = JSON.stringify(service.snapshot());
    if (next === loaded.raw) {
        return;
    }
    try{
        await store.write(next, loaded.etag);
    } catch (error) {
        if (error instanceof BlobConflict) {
            console.warn("Blob conflict detected, skipping save");
            return;
        }
        throw error;
    }
}

export function createBlobScope(service: MarketService, store: StateStore) {
    let tail: Promise<unknown> = Promise.resolve();
    return function scope<T>(fn: () => Promise<T>): Promise<T> {
        const run = tail.then(() => runScope(service, store, fn));
        tail = run.then(() => undefined, () => undefined);
        return run;
    };
}

export function persistOnShutdown(server: Server, save: () => Promise<void>): void {
    let stopping = false;
    const stop = () => {
        if (stopping) return;
        stopping = true;
        console.log("Shutting down, persisting state...");
        server.close();
        server.closeAllConnections();
        void save().finally(() => process.exit(0));
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
}

async function runScope<T>(service: MarketService, store: StateStore, fn: () => Promise<T>): Promise<T> {
    for(let attempt = 0; attempt < 3; attempt++) {
        const loaded = await store.read();
        service.restore( asSnapshot(loaded.body) );
        const before = JSON.stringify(service.snapshot());
        const result = await fn();
        const after = JSON.stringify(service.snapshot());
        if (before === after) {
            return result;
        }
        try{
            await store.write(after, loaded.etag);
            return result;
        } catch (error) {
            if (error instanceof BlobConflict && attempt < 2) {
                console.warn("Blob conflict detected, retrying...");
                continue;
            }
            throw error;
        }
    }
    throw new BlobConflict();
}

function asSnapshot(body: unknown): Snapshot {
    if (body === null || body === undefined) {
        return null;
    }
    return body as Snapshot;
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
            chunks.push(value);
        }
    }
    return Buffer.concat(chunks).toString("utf8");
}