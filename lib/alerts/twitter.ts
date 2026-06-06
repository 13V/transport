/**
 * X / TWITTER POSTER
 *
 * Posts a single tweet to the X API v2 endpoint `POST /2/tweets`, authenticated
 * with OAuth 1.0a user-context. The OAuth signature is computed in-process with
 * Node's built-in `crypto` (HMAC-SHA1) — no external Twitter SDK / dependency.
 *
 * Env vars (ALL FOUR required; if ANY is missing this module is a silent no-op):
 *   - TWITTER_API_KEY        OAuth 1.0a consumer key (a.k.a. API key)
 *   - TWITTER_API_SECRET     OAuth 1.0a consumer secret (a.k.a. API secret)
 *   - TWITTER_ACCESS_TOKEN   user-context access token for the posting account
 *   - TWITTER_ACCESS_SECRET  user-context access token secret
 *
 * Fully resilient: postTweet never throws. It returns false on any missing
 * credential, network error, or non-2xx response, and true only on a confirmed
 * 2xx from X — so a flaky tweet can never take down the cron that triggered it.
 */

import crypto from 'crypto';

const TWEET_URL = 'https://api.twitter.com/2/tweets';

interface TwitterCreds {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessSecret: string;
}

/** Read the four creds from env; null if any is missing/empty. */
function readCreds(): TwitterCreds | null {
  const apiKey = process.env.TWITTER_API_KEY;
  const apiSecret = process.env.TWITTER_API_SECRET;
  const accessToken = process.env.TWITTER_ACCESS_TOKEN;
  const accessSecret = process.env.TWITTER_ACCESS_SECRET;
  if (!apiKey || !apiSecret || !accessToken || !accessSecret) return null;
  return { apiKey, apiSecret, accessToken, accessSecret };
}

/** RFC 3986 percent-encoding (stricter than encodeURIComponent). */
function pctEncode(str: string): string {
  return encodeURIComponent(str).replace(
    /[!*'()]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

/**
 * Build the OAuth 1.0a `Authorization` header for a request. The JSON body of a
 * v2 tweet is NOT part of the OAuth signature base string (only the OAuth
 * params, since there are no query/form params), which is correct for
 * application/json POSTs to /2/tweets.
 */
function buildAuthHeader(creds: TwitterCreds, method: string, url: string): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: creds.apiKey,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: creds.accessToken,
    oauth_version: '1.0',
  };

  // Signature base string: METHOD&encodedURL&encodedSortedParams
  const paramString = Object.keys(oauthParams)
    .sort()
    .map((k) => `${pctEncode(k)}=${pctEncode(oauthParams[k])}`)
    .join('&');

  const baseString = [
    method.toUpperCase(),
    pctEncode(url),
    pctEncode(paramString),
  ].join('&');

  const signingKey = `${pctEncode(creds.apiSecret)}&${pctEncode(creds.accessSecret)}`;
  const signature = crypto
    .createHmac('sha1', signingKey)
    .update(baseString)
    .digest('base64');

  const headerParams: Record<string, string> = {
    ...oauthParams,
    oauth_signature: signature,
  };

  return (
    'OAuth ' +
    Object.keys(headerParams)
      .sort()
      .map((k) => `${pctEncode(k)}="${pctEncode(headerParams[k])}"`)
      .join(', ')
  );
}

/**
 * Post `text` as a tweet. Returns true only on a confirmed 2xx from X; false on
 * any missing credential, network failure, or non-2xx response. Never throws.
 */
export async function postTweet(text: string): Promise<boolean> {
  const creds = readCreds();
  if (!creds) return false; // not configured — silent no-op
  if (!text || !text.trim()) return false;

  try {
    const authHeader = buildAuthHeader(creds, 'POST', TWEET_URL);
    const res = await fetch(TWEET_URL, {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      let detail = '';
      try {
        detail = await res.text();
      } catch {
        /* ignore */
      }
      console.error(
        `[TWITTER] tweet failed ${res.status} ${res.statusText} ${detail.slice(0, 300)}`
      );
      return false;
    }
    return true;
  } catch (error) {
    console.error('[TWITTER] tweet send failed:', (error as Error).message);
    return false;
  }
}
