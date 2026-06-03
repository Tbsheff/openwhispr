import { Pool } from "@neondatabase/serverless";

export type Row = Record<string, unknown>;
export type DbParam = string | number | boolean | string[] | null;

export interface QueryResult<T extends Row = Row> {
  rows: T[];
  rowCount: number;
}

export interface Db {
  query<T extends Row = Row>(text: string, params?: readonly DbParam[]): Promise<QueryResult<T>>;
  getOne<T extends Row = Row>(text: string, params?: readonly DbParam[]): Promise<T | null>;
  getMany<T extends Row = Row>(text: string, params?: readonly DbParam[]): Promise<T[]>;
  close?(): Promise<void>;
}

/**
 * Create a query interface bound to the given Neon connection string.
 * Uses Pool for parameterized queries (not tagged templates).
 */
export function createDb(databaseUrl: string): Db {
  const pool = new Pool({ connectionString: databaseUrl });

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
