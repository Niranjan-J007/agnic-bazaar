import type { Pool, PoolClient } from "pg";
import type { MarketService } from "./service.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS service_state (
  id integer PRIMARY KEY,
  body jsonb NOT NULL
);
`;

export function createPersistingScope(pool: Pool, service: MarketService) {
  let ready: Promise<void> | undefined;
  const ensure = () => {
    ready ??= pool.query(SCHEMA).then(() => undefined);
    return ready;
  };

  return async function scope<T>(fn: () => Promise<T>): Promise<T> {
    await ensure();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query("SELECT body FROM service_state WHERE id = 1 FOR UPDATE");
      service.restore(existing.rows[0]?.body ?? null);
      const result = await fn();
      await save(client, service);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  };
}

async function save(client: PoolClient, service: MarketService): Promise<void> {
  await client.query(
    `INSERT INTO service_state (id, body) VALUES (1, $1::jsonb)
     ON CONFLICT (id) DO UPDATE SET body = EXCLUDED.body`,
    [JSON.stringify(service.snapshot())],
  );
}
