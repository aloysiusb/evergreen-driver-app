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

/* Everything above this line reads. Everything below writes.
 *
 * Nothing here is on the critical path of approving a customer: the route
 * sheet is what a driver works from, and a QuickBooks outage must never be
 * the reason someone cannot be put on a route. The caller treats all of this
 * as best effort and records what happened either way. */

/** True when the four values an API call needs are all present. */
export function isConfigured() {
  return Boolean(
    process.env.QBO_CLIENT_ID &&
    process.env.QBO_CLIENT_SECRET &&
    process.env.QBO_REFRESH_TOKEN &&
    process.env.QBO_REALM_ID
  );
}

async function qboPost(path, body) {
  const realmId = process.env.QBO_REALM_ID;
  const token   = await getAccessToken();

  const res = await fetch(
    `${QBO_BASE}/v3/company/${realmId}/${path}?minorversion=${MINOR_VERSION}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    /* QBO puts the useful part in Fault.Error[0] — a bare status tells you
       nothing about which field it objected to. */
    const fault = data?.Fault?.Error?.[0];
    const detail = fault
      ? `${fault.Message}${fault.Detail ? ` — ${fault.Detail}` : ''} (code ${fault.code})`
      : `HTTP ${res.status}`;
    const err = new Error(`QBO ${path} failed: ${detail}`);
    err.qboCode = fault?.code;
    throw err;
  }
  return data;
}

async function qboQuery(query) {
  const realmId = process.env.QBO_REALM_ID;
  const token   = await getAccessToken();
  const res = await fetch(
    `${QBO_BASE}/v3/company/${realmId}/query?query=${encodeURIComponent(query)}&minorversion=${MINOR_VERSION}`,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
  );
  if (!res.ok) throw new Error(`QBO query failed: ${res.status}`);
  return (await res.json()).QueryResponse || {};
}

/* An invoice line needs something to sell. QBO_SERVICE_ITEM_ID names it
   explicitly; without that we take the first active service item on the
   account, which is what a small hauler will have anyway. Cached because it
   does not change between approvals. */
let cachedItemRef = null;
export async function serviceItemRef() {
  if (process.env.QBO_SERVICE_ITEM_ID) {
    return { value: process.env.QBO_SERVICE_ITEM_ID };
  }
  if (cachedItemRef) return cachedItemRef;
  const { Item = [] } = await qboQuery(
    "SELECT Id, Name FROM Item WHERE Type = 'Service' AND Active = true MAXRESULTS 1"
  );
  if (!Item.length) {
    throw new Error(
      'No active service item in QuickBooks. Create one, or set QBO_SERVICE_ITEM_ID.'
    );
  }
  cachedItemRef = { value: Item[0].Id, name: Item[0].Name };
  return cachedItemRef;
}

/** Look a customer up by display name. QBO requires these to be unique. */
async function findCustomerByName(displayName) {
  const escaped = displayName.replace(/'/g, "\\'");
  const { Customer = [] } = await qboQuery(
    `SELECT * FROM Customer WHERE DisplayName = '${escaped}' MAXRESULTS 1`
  );
  return Customer[0] || null;
}

/**
 * The customer for this request, created if they are new.
 *
 * Matching is by email first, then by display name, because QBO rejects a
 * duplicate DisplayName outright and a hauler's sheet often carries the same
 * household twice. Returns { customer, created }.
 */
export async function ensureCustomer({ name, email, phone, address, city }) {
  if (email) {
    const byEmail = await findCustomerByEmail(email);
    if (byEmail) return { customer: byEmail, created: false };
  }

  const displayName = String(name || '').trim();
  if (!displayName) throw new Error('A customer needs a name.');

  const existing = await findCustomerByName(displayName);
  if (existing) return { customer: existing, created: false };

  const body = { DisplayName: displayName };
  if (email)   body.PrimaryEmailAddr = { Address: email };
  if (phone)   body.PrimaryPhone     = { FreeFormNumber: phone };
  if (address) body.BillAddr = { Line1: address, ...(city ? { City: city } : {}) };

  try {
    const data = await qboPost('customer', body);
    return { customer: data.Customer, created: true };
  } catch (err) {
    /* 6240 is "duplicate name exists" — someone else created them between our
       lookup and our write, or the name collides with an inactive record.
       Re-read rather than failing the approval over a race. */
    if (err.qboCode === '6240') {
      const found = await findCustomerByName(displayName);
      if (found) return { customer: found, created: false };
    }
    throw err;
  }
}

/**
 * Raise a single-line invoice. `amount` is in dollars.
 * Returns the created Invoice object.
 */
export async function createInvoice({ customerId, amount, description, email }) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invoice amount must be a positive number, got "${amount}".`);
  }
  const itemRef = await serviceItemRef();

  const body = {
    CustomerRef: { value: String(customerId) },
    Line: [
      {
        Amount: value,
        DetailType: 'SalesItemLineDetail',
        ...(description ? { Description: description } : {}),
        SalesItemLineDetail: { ItemRef: itemRef, Qty: 1, UnitPrice: value },
      },
    ],
  };
  /* Lets Alyssa send it from QuickBooks without retyping the address, and is
     what QBO uses if she turns on automatic delivery. */
  if (email) {
    body.BillEmail = { Address: email };
    body.EmailStatus = 'NeedToSend';
  }

  const data = await qboPost('invoice', body);
  return data.Invoice;
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
