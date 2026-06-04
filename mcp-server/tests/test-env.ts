import type { AuthStore, Env } from "../src/auth.js";

class MemoryKv implements AuthStore {
  private readonly entries = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.entries.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.entries.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }
}

export function createTestEnv(overrides: Partial<Env> = {}): Env {
  return {
    DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    GITHUB_CLIENT_ID: "github-client-id",
    GITHUB_CLIENT_SECRET: "github-client-secret",
    GITHUB_ORG: "openwhispr",
    JWT_SECRET: "test-secret",
    SERVER_URL: "http://localhost:8787",
    AUTH_KV: new MemoryKv(),
    ...overrides,
  };
}
