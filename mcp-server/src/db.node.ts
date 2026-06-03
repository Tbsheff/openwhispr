import pg from "pg";
import type { Db, DbParam, QueryResult, Row } from "./db.js";

export function createNodeDb(databaseUrl: string): Db {
  const pool = new pg.Pool({ connectionString: databaseUrl });

  return {
    async query<T extends Row = Row>(text: string, params?: readonly DbParam[]): Promise<QueryResult<T>> {
      const result = await pool.query(text, params ? [...params] : undefined);
      return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
    },

    async getOne<T extends Row = Row>(text: string, params?: readonly DbParam[]): Promise<T | null> {
      const result = await pool.query(text, params ? [...params] : undefined);
      return (result.rows[0] as T) ?? null;
    },

    async getMany<T extends Row = Row>(text: string, params?: readonly DbParam[]): Promise<T[]> {
      const result = await pool.query(text, params ? [...params] : undefined);
      return result.rows as T[];
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}
