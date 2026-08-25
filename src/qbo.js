// qbo.js
// QuickBooks Online integration — OAuth 2.0 + invoice payment link retrieval.
//
// SETUP (one-time):
//   1. Go to developer.intuit.com → Create an app → OAuth 2.0
//   2. Set redirect URI to: https://your-render-url.onrender.com/qbo/callback
//   3. Add to Render env vars: QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_REDIRECT_URI
//   4. Visit /qbo/auth in a browser while logged in as Alyssa to authorize
//   5. After redirect, QBO_REFRESH_TOKEN and QBO_REALM_ID are printed to Render logs
//   6. Add those two values to Render env vars — done, no re-auth needed for 101 days

import OAuthClient from 'intuit-oauth';

const QBO_BASE = process.env.QBO_SANDBOX === 'true'
  ? 'https://sandbox-quickbooks.api.intuit.com'
  : 'https://quickbooks.api.intuit.com';

const MINOR_VERSION = 65;

function makeOAuthClient() {
  return new OAuthClient({
    clientId:     process.env.QBO_CLIENT_ID,
    clientSecret: process.env.QBO_CLIENT_SECRET,
    environment:  process.env.QBO_SANDBOX === 'true' ? 'sandbox' : 'production',
    redirectUri:  process.env.QBO_REDIRECT_URI,
  });
}

// Returns a fresh access token, silently refreshing if needed.
// Stores the rotated refresh token back into the process env (lasts for the
// lifetime of the Render instance; re-auth only needed after 101 days of no use).
let cachedToken = null;
let tokenExpiresAt = 0;

export async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 60_000) return cachedToken;

  const refreshToken = process.env.QBO_REFRESH_TOKEN;
  if (!refreshToken) throw new Error('QBO_REFRESH_TOKEN not set — visit /qbo/auth to authorize.');

  const client = makeOAuthClient();
  client.setToken({ refresh_token: refreshToken });

  const response = await client.refreshUsingToken(refreshToken);
  const tokens = response.getJson();

  cachedToken = tokens.access_token;
  tokenExpiresAt = now + tokens.expires_in * 1000;

  // Rotate the refresh token in memory (Render keeps env in process scope per instance)
  process.env.QBO_REFRESH_TOKEN = tokens.refresh_token;
  console.log('[qbo] Access token refreshed.');

  return cachedToken;
}

// Find a QBO customer by their email address.
// Returns the customer object or null if not found.
export async function findCustomerByEmail(email) {
  const realmId = process.env.QBO_REALM_ID;
  const token   = await getAccessToken();

  const query = `SELECT * FROM Customer WHERE PrimaryEmailAddr = '${email.replace(/'/g, "\\'")}'`;
  const url   = `${QBO_BASE}/v3/company/${realmId}/query?query=${encodeURIComponent(query)}&minorversion=${MINOR_VERSION}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });

  if (!res.ok) throw new Error(`QBO customer query failed: ${res.status}`);
  const data = await res.json();
  const customers = data.QueryResponse?.Customer || [];
  return customers[0] || null;
}

// Find the most recent unpaid invoice for a customer (by customer Id).
// Returns the invoice object or null.
export async function findOpenInvoiceForCustomer(customerId) {
  const realmId = process.env.QBO_REALM_ID;
  const token   = await getAccessToken();

  const query = `SELECT * FROM Invoice WHERE CustomerRef = '${customerId}' AND Balance > '0' ORDERBY TxnDate DESC MAXRESULTS 1`;
  const url   = `${QBO_BASE}/v3/company/${realmId}/query?query=${encodeURIComponent(query)}&minorversion=${MINOR_VERSION}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });

  if (!res.ok) throw new Error(`QBO invoice query failed: ${res.status}`);
  const data = await res.json();
  const invoices = data.QueryResponse?.Invoice || [];
  return invoices[0] || null;
}

// Fetch the customer-facing payment portal link for an invoice.
// Requires QuickBooks Payments to be enabled on the QBO account.
export async function getInvoicePaymentLink(invoiceId) {
  const realmId = process.env.QBO_REALM_ID;
  const token   = await getAccessToken();

  const url = `${QBO_BASE}/v3/company/${realmId}/invoice/${invoiceId}?include=invoiceLink&minorversion=${MINOR_VERSION}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });

  if (!res.ok) throw new Error(`QBO invoice fetch failed: ${res.status}`);
  const data = await res.json();
  return data.Invoice?.invoiceLink || null;
}

// Build the OAuth authorization URL — visit this once in the browser.
export function getAuthUrl() {
  const client = makeOAuthClient();
  return client.authorizeUri({
    scope: [OAuthClient.scopes.Accounting, OAuthClient.scopes.Payment],
    state: 'evergreen-qbo-setup',
  });
}

// Exchange the authorization code for tokens (called from the redirect handler).
export async function exchangeCodeForTokens(url) {
  const client = makeOAuthClient();
  const response = await client.createToken(url);
  const tokens = response.getJson();
  return {
    accessToken:  tokens.access_token,
    refreshToken: tokens.refresh_token,
    realmId:      client.getToken().realmId,
  };
}
