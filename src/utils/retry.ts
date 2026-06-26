import { RETRY_CONFIG } from "../config/constants";

export interface RetryOptions {
  maxRetries?: number;
  initialDelay?: number;
  maxDelay?: number;
  backoffMultiplier?: number;
  shouldRetry?: (error: unknown) => boolean;
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    maxRetries = RETRY_CONFIG.MAX_RETRIES,
    initialDelay = RETRY_CONFIG.INITIAL_DELAY,
    maxDelay = RETRY_CONFIG.MAX_DELAY,
    backoffMultiplier = RETRY_CONFIG.BACKOFF_MULTIPLIER,
    shouldRetry = () => true,
  } = options;

  let lastError: unknown;
  let delay = initialDelay;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === maxRetries || !shouldRetry(error)) {
        throw error;
      }

      // Wait before retrying with exponential backoff
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * backoffMultiplier, maxDelay);
    }
  }

  throw lastError;
}

// Specific retry strategy for API calls
export function createApiRetryStrategy() {
  return {
    shouldRetry: (error: unknown) => {
      if (typeof error !== "object" || error === null) return true; // Network error
      const err = error as Record<string, unknown>;
      if (!err["response"]) return true; // Network error
      const response = err["response"] as Record<string, unknown>;
      const status =
        typeof response["status"] === "number"
          ? response["status"]
          : typeof err["status"] === "number"
            ? err["status"]
            : undefined;
      return status !== undefined && status >= 500 && status < 600;
    },
  };
}

// Specific retry strategy for file operations
export function createFileRetryStrategy() {
  return {
    shouldRetry: (error: unknown) => {
      const retriableErrors = ["EBUSY", "ENOENT", "EPERM", "EAGAIN"];
      if (typeof error === "object" && error !== null && "code" in error) {
        return retriableErrors.includes((error as { code: string }).code);
      }
      return false;
    },
    maxRetries: 2,
    initialDelay: 500,
  };
}
