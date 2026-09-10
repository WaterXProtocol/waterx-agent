/**
 * Envelope-aware HTTP client for the WaterX backend.
 *
 * Every route is wrapped by the backend's global `ResponseInterceptor` into
 * `{ success: true, data }` or, on failure, `{ success: false, error: { code,
 * message }, details }` (libs/shared). This module is the only place that
 * knows that shape; callers get `data` or a `WaterXApiError`.
 *
 * Retries are deliberately restricted to **GET**. A POST here builds a
 * transaction rather than executing one, so a retry is cheap in principle —
 * but a sponsored build reserves an Enoki digest, and re-issuing it on a
 * timeout we cannot distinguish from a slow success leaves a second reservation
 * dangling. Reads are idempotent and get the backoff; writes fail fast and let
 * the caller decide.
 */
import { WaterXApiError } from "../errors.ts";

type QueryValue = string | number | boolean | undefined;

interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: { code: number; message: string };
  details?: unknown;
}

export interface HttpClientOptions {
  baseUrl: string;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Attempts for a GET, including the first. */
  maxGetAttempts?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_GET_ATTEMPTS = 3;

export class HttpClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxGetAttempts: number;

  constructor(options: HttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxGetAttempts = options.maxGetAttempts ?? DEFAULT_MAX_GET_ATTEMPTS;
  }

  get<T>(path: string, query?: Record<string, QueryValue>): Promise<T> {
    return this.withRetry(() => this.send<T>("GET", path, { query }));
  }

  post<T>(path: string, body: unknown, query?: Record<string, QueryValue>): Promise<T> {
    return this.send<T>("POST", path, { body, query });
  }

  patch<T>(path: string, body: unknown): Promise<T> {
    return this.send<T>("PATCH", path, { body });
  }

  /** DELETE carries a body on the tx routes (`DELETE /order/:ticker/:id`). */
  delete<T>(path: string, body?: unknown): Promise<T> {
    return this.send<T>("DELETE", path, { body });
  }

  private async withRetry<T>(attempt: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let i = 0; i < this.maxGetAttempts; i++) {
      try {
        return await attempt();
      } catch (error) {
        lastError = error;
        const isLast = i === this.maxGetAttempts - 1;
        // A 4xx will not become a 2xx by asking again.
        const permanent = error instanceof WaterXApiError && !error.retryable;
        if (isLast || permanent) throw error;
        await sleep(Math.min(1000 * 2 ** i, 8000));
      }
    }
    throw lastError;
  }

  private async send<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    options: { body?: unknown; query?: Record<string, QueryValue> },
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const hasBody = options.body !== undefined;
    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method,
        headers: {
          Accept: "application/json",
          ...(hasBody ? { "Content-Type": "application/json" } : {}),
        },
        ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      // A transport failure has no status; give it 0 so `retryable` treats it
      // as transient rather than as a permanent 4xx.
      throw new WaterXApiError(0, `${method} ${path} failed: ${describe(cause)}`, 0);
    }

    const envelope = await readEnvelope<T>(response);

    if (!response.ok || envelope?.success !== true) {
      throw new WaterXApiError(
        envelope?.error?.code ?? response.status,
        envelope?.error?.message ?? `${method} ${path} → HTTP ${String(response.status)}`,
        response.status,
        envelope?.details,
      );
    }

    // `data` is legitimately absent for a void route; `undefined as T` is the
    // honest representation, and a typed caller never asks for a value there.
    return envelope.data as T;
  }
}

async function readEnvelope<T>(response: Response): Promise<Envelope<T> | undefined> {
  try {
    return (await response.json()) as Envelope<T>;
  } catch {
    // Non-JSON body (proxy error page, empty 204). The caller turns this into
    // an error using the status alone.
    return undefined;
  }
}

const describe = (cause: unknown): string =>
  cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
