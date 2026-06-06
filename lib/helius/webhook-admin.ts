/**
 * HELIUS WEBHOOK ADMIN — thin client over the Helius webhook REST API.
 *
 * Lets us register and keep in sync a single "enhanced" webhook that pushes
 * every SWAP for our subscribed address set to our receiver. Used by the
 * sync-webhook cron to self-register on first run and update the address list
 * on every run thereafter.
 *
 * All calls throw with a clear, prefixed message on a non-2xx so the caller can
 * surface the failure in JSON instead of silently no-op'ing.
 *
 *   Docs: https://docs.helius.dev/webhooks-and-websockets/api-reference
 */

import axios from 'axios';

/** Helius caps addresses per webhook at ~100k. Truncate defensively below that. */
export const MAX_ADDRESSES = 95_000;

export interface WebhookConfig {
  webhookURL: string;
  accountAddresses: string[];
  /** Sent as the `authHeader` Helius will echo back when calling our receiver. */
  authHeader: string;
}

export interface HeliusWebhook {
  webhookID: string;
  webhookURL?: string;
  accountAddresses?: string[];
  transactionTypes?: string[];
  webhookType?: string;
  [key: string]: unknown;
}

function apiKey(): string {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error('HELIUS_API_KEY env missing');
  return key;
}

function baseUrl(): string {
  return `https://api.helius.xyz/v0/webhooks?api-key=${apiKey()}`;
}

function webhookUrl(id: string): string {
  return `https://api.helius.xyz/v0/webhooks/${id}?api-key=${apiKey()}`;
}

/** Shape the request body Helius expects for an enhanced SWAP webhook. */
function buildBody(cfg: WebhookConfig) {
  return {
    webhookURL: cfg.webhookURL,
    transactionTypes: ['SWAP'],
    accountAddresses: cfg.accountAddresses,
    webhookType: 'enhanced',
    authHeader: cfg.authHeader,
  };
}

/** Error carrying the originating HTTP status so callers can branch (e.g. 404). */
export class HeliusWebhookError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'HeliusWebhookError';
    this.status = status;
  }
}

/** Wrap an axios error into a clear, prefixed Error for the caller to report. */
function wrap(action: string, error: unknown): HeliusWebhookError {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const body =
      typeof error.response?.data === 'string'
        ? error.response.data
        : JSON.stringify(error.response?.data ?? {});
    return new HeliusWebhookError(
      `Helius ${action} failed (HTTP ${status ?? '?'}): ${body || error.message}`,
      status
    );
  }
  return new HeliusWebhookError(`Helius ${action} failed: ${(error as Error).message}`);
}

/** List all webhooks registered under this API key. */
export async function listWebhooks(): Promise<HeliusWebhook[]> {
  try {
    const res = await axios.get(baseUrl(), { timeout: 15_000 });
    return Array.isArray(res.data) ? (res.data as HeliusWebhook[]) : [];
  } catch (error) {
    throw wrap('list', error);
  }
}

/** Create a new enhanced SWAP webhook. Returns the created webhook (with webhookID). */
export async function createWebhook(cfg: WebhookConfig): Promise<HeliusWebhook> {
  try {
    const res = await axios.post(baseUrl(), buildBody(cfg), { timeout: 30_000 });
    return res.data as HeliusWebhook;
  } catch (error) {
    throw wrap('create', error);
  }
}

/** Replace an existing webhook's config (URL + address list + authHeader). */
export async function editWebhook(id: string, cfg: WebhookConfig): Promise<HeliusWebhook> {
  try {
    const res = await axios.put(webhookUrl(id), buildBody(cfg), { timeout: 30_000 });
    return res.data as HeliusWebhook;
  } catch (error) {
    throw wrap('edit', error);
  }
}

/** Delete a webhook by id. Idempotent from the caller's view: a 404 is fine. */
export async function deleteWebhook(id: string): Promise<void> {
  try {
    await axios.delete(webhookUrl(id), { timeout: 30_000 });
  } catch (error) {
    throw wrap('delete', error);
  }
}

/** True if the error is a 404 (webhook id no longer exists → recreate). */
export function isNotFound(error: unknown): boolean {
  return error instanceof HeliusWebhookError && error.status === 404;
}
