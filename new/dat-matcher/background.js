const ROUTE_CACHE_VERSION = 1;  // bump to invalidate all cached routes

// Open the welcome page on first install (not on updates).
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
  }
});

// Opens route.html as a popup window and tracks its lifecycle. On close (the
// authoritative onRemoved event), emits a distinct 'routeClosed' token so content.js
// tears the inline modal down COMPLETELY — it does NOT re-show. (routePopped:false on
// its own no longer re-docks; only this explicit close kills everything.)
function createRouteWindow(msg) {
  chrome.windows.create({
    url:    chrome.runtime.getURL('route.html'),
    type:   'popup',
    left:   msg.left   ?? 120,
    top:    msg.top    ?? 120,
    width:  msg.width  ?? 1100,
    height: msg.height ?? 620,
  }, (win) => {
    if (!win) return;
    const routeWindowId = win.id;
    chrome.storage.local.set({ routeWindowId: win.id });
    const onRemoved = (closedId) => {
      if (closedId !== routeWindowId) return;
      chrome.windows.onRemoved.removeListener(onRemoved);
      chrome.storage.local.set({
        routePopped: false,
        routeWindowId: null,
        routeClosed: Date.now() + '-' + Math.random().toString(36).slice(2), // unique close token
      });
    };
    chrome.windows.onRemoved.addListener(onRemoved);
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Open a URL and scroll to a hash anchor after the page fully loads.
  // Doing this in the service worker avoids the popup-close race condition
  // that kills chrome.tabs.onUpdated listeners registered in popup.js.
  if (msg.type === 'openWithHash') {
    const { baseUrl, hash } = msg;
    chrome.tabs.create({ url: baseUrl }, (tab) => {
      const listener = (tabId, info) => {
        if (tabId === tab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          chrome.tabs.update(tabId, { url: baseUrl + hash });
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
    return false;
  }

  // Fallback for the Market tab's "Check Today's Market Trends" button when the
  // DAT page blocks window.open. Fixed URL (no arbitrary-URL param) — opens DAT's
  // live Trendlines page in a new tab. No data is fetched or stored here.
  if (msg.type === 'openTrends') {
    chrome.tabs.create({ url: 'https://www.dat.com/trendlines' });
    return false;
  }

  if (msg.type === 'openPanel') {
    chrome.windows.create({
      url:    chrome.runtime.getURL('panel.html'),
      type:   'popup',
      left:   msg.left   ?? 100,
      top:    msg.top    ?? 100,
      width:  msg.width  ?? 450,
      height: 640,
    }, (win) => {
      if (!win) return;
      const panelWindowId = win.id;
      chrome.storage.local.set({ panelWindowId: win.id });
      const onRemoved = (closedId) => {
        if (closedId !== panelWindowId) return;
        chrome.windows.onRemoved.removeListener(onRemoved);
        chrome.storage.local.set({ panelPopped: false, panelWindowId: null });
      };
      chrome.windows.onRemoved.addListener(onRemoved);
    });
    return false;
  }

  // Floating RPM/map route window. Mirrors openPanel/checkPanelWindow but tracks
  // its own routeWindowId/routePopped keys (no collision with the data panel) and
  // focuses an existing window instead of opening a duplicate.
  if (msg.type === 'openRoute') {
    chrome.storage.local.get(['routeWindowId'], (s) => {
      if (s.routeWindowId) {
        chrome.windows.update(s.routeWindowId, { focused: true }, (win) => {
          if (chrome.runtime.lastError || !win) createRouteWindow(msg);
        });
      } else {
        createRouteWindow(msg);
      }
    });
    return false;
  }

  if (msg.type === 'checkRouteWindow') {
    chrome.storage.local.get(['routeWindowId'], (s) => {
      if (!s.routeWindowId) { sendResponse({ exists: false }); return; }
      chrome.windows.get(s.routeWindowId, (win) => {
        if (chrome.runtime.lastError || !win) {
          chrome.storage.local.set({ routePopped: false, routeWindowId: null });
          sendResponse({ exists: false });
        } else {
          sendResponse({ exists: true });
        }
      });
    });
    return true;
  }

  if (msg.type === 'checkPanelWindow') {
    chrome.storage.local.get(['panelWindowId'], (s) => {
      if (!s.panelWindowId) { sendResponse({ exists: false }); return; }
      chrome.windows.get(s.panelWindowId, (win) => {
        if (chrome.runtime.lastError || !win) {
          chrome.storage.local.set({ panelPopped: false, panelWindowId: null });
          sendResponse({ exists: false });
        } else {
          sendResponse({ exists: true });
        }
      });
    });
    return true;
  }

  if (msg.type === 'sendGmail') {
    const { to, subject, body } = msg;
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      let responded = false;
      const safeRespond = (payload) => { if (!responded) { responded = true; sendResponse(payload); } };
      if (chrome.runtime.lastError || !token) {
        safeRespond({ ok: false, error: chrome.runtime.lastError?.message || 'no token' });
        return;
      }
      const raw =
        `To: ${to}\r\n` +
        `Subject: ${subject}\r\n` +
        `Content-Type: text/plain; charset="UTF-8"\r\n\r\n` +
        body;
      const bytes = new TextEncoder().encode(raw);
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      const encoded = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ raw: encoded }),
      })
        .then(r => r.ok ? safeRespond({ ok: true }) : r.text().then(t => safeRespond({ ok: false, error: t })))
        .catch(e => safeRespond({ ok: false, error: e.message }));
    });
    return true;
  }

  if (msg.type === 'gmailConnect') {
    chrome.identity.getAuthToken({ interactive: true }, async (token) => {
      if (chrome.runtime.lastError || !token) {
        sendResponse({ ok: false, error: chrome.runtime.lastError?.message || 'no token' });
        return;
      }
      try {
        const res  = await fetch(`https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=${token}`);
        const info = await res.json();
        sendResponse({ ok: true, email: info.email || 'Gmail Connected' });
      } catch (e) {
        sendResponse({ ok: true, email: 'Gmail Connected' });
      }
    });
    return true;
  }

  if (msg.type === 'gmailDisconnect') {
    chrome.identity.getAuthToken({ interactive: false }, (token) => {
      if (chrome.runtime.lastError || !token) {
        sendResponse({ ok: true });
        return;
      }
      chrome.identity.removeCachedAuthToken({ token }, () => {
        chrome.identity.clearAllCachedAuthTokens(() => {});
        fetch(`https://accounts.google.com/o/oauth2/revoke?token=${token}`)
          .catch(() => {})
          .finally(() => {
            chrome.storage.local.set({ panelPopped: false, panelWindowId: null });
            sendResponse({ ok: true });
          });
      });
    });
    return true;
  }

  // ── Microsoft Outlook OAuth (Graph API) ──────────────────────────────────
  // Mirrors the Gmail flow above but uses chrome.identity.launchWebAuthFlow +
  // PKCE since Microsoft is not a built-in getAuthToken provider. Tokens are
  // stored separately from Gmail under chrome.storage.local 'outlookToken'.
  if (msg.type === 'outlookConnect') {
    (async () => {
      try {
        const tokens = await outlookInteractiveAuth();
        await chrome.storage.local.set({ outlookToken: tokens });
        const email = await outlookFetchEmail(tokens.access_token);
        await chrome.storage.local.set({ outlookOAuthEmail: email });
        sendResponse({ ok: true, email });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || 'outlook auth failed' });
      }
    })();
    return true;
  }

  if (msg.type === 'outlookDisconnect') {
    chrome.storage.local.remove(['outlookToken', 'outlookOAuthEmail'], () => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === 'sendOutlook') {
    const { to, subject, body } = msg;
    (async () => {
      try {
        const token = await outlookValidToken();
        if (!token) { sendResponse({ ok: false, error: 'not connected' }); return; }
        const payload = {
          message: {
            subject: subject,
            body: { contentType: 'Text', content: body },
            toRecipients: [{ emailAddress: { address: to } }],
          },
          saveToSentItems: true,
        };
        const res = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });
        // Graph sendMail returns 202 Accepted with empty body on success.
        if (res.ok) sendResponse({ ok: true });
        else { const t = await res.text(); sendResponse({ ok: false, error: t }); }
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || 'send failed' });
      }
    })();
    return true;
  }

  if (msg.type === 'getDistance') {
    const { origin, dest, apiKey } = msg;
    const url = 'https://maps.googleapis.com/maps/api/distancematrix/json' +
      `?origins=${encodeURIComponent(origin)}` +
      `&destinations=${encodeURIComponent(dest)}` +
      `&key=${encodeURIComponent(apiKey)}`;

    fetch(url)
      .then(r => r.json())
      .then(data => {
        const elem = data.rows?.[0]?.elements?.[0];
        if (data.status === 'OK' && elem?.status === 'OK') {
          const miles    = Math.round(elem.distance.value * 0.000621371);
          const duration = elem.duration.text;
          sendResponse({ miles, duration });
        } else {
          sendResponse({ error: elem?.status || data.status || 'API error' });
        }
      })
      .catch(e => sendResponse({ error: e.message }));

    return true;
  }

  // Returns miles, duration, AND the encoded overview polyline for Static Maps rendering
  if (msg.type === 'getRoute') {
    const { origin, dest, apiKey } = msg;
    // Normalize for the cache key only; the API call uses original-case values.
    const cacheKey = `${String(origin).trim().toLowerCase()}|${String(dest).trim().toLowerCase()}`;

    (async () => {
      // (a/b) Cache hit → return immediately, no API call.
      try {
        const stored = (await chrome.storage.local.get('routeCache')).routeCache;
        if (stored && stored._v === ROUTE_CACHE_VERSION && stored[cacheKey]) {
          console.log('[LaneIQ] route cache HIT:', cacheKey);
          sendResponse(stored[cacheKey]);
          return;
        }
      } catch (e) { /* cache read failed — fall through to network */ }

      console.log('[LaneIQ] route cache MISS, fetching via proxy:', cacheKey);
      const url = 'https://laneiq-backend-production.up.railway.app/maps/directions'
        + `?origin=${encodeURIComponent(origin)}`
        + `&dest=${encodeURIComponent(dest)}`;
      try {
        const r = await fetch(url);
        const data = await r.json();
        if (!data.error && data.polyline) {
          const result = {
            miles:    data.miles,
            duration: data.duration,
            polyline: data.polyline,
          };
          try {
            const cur  = (await chrome.storage.local.get('routeCache')).routeCache;
            const base = (cur && cur._v === ROUTE_CACHE_VERSION) ? cur : { _v: ROUTE_CACHE_VERSION };
            base[cacheKey] = result;
            await chrome.storage.local.set({ routeCache: base });
            console.log('[LaneIQ] route cached:', cacheKey);
          } catch (e) { /* cache write failed — must not break the response */ }
          sendResponse(result);
        } else {
          sendResponse({ error: data.error || 'API error' });
        }
      } catch (e) {
        sendResponse({ error: e.message });
      }
    })();

    return true;  // async response
  }
});

// ── Outlook / Microsoft Graph OAuth helpers ─────────────────────────────────
const OUTLOOK_CLIENT_ID = '95cc75b1-d63a-4eb9-9eda-43c3f399c9e9';
const OUTLOOK_AUTH_URL   = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
const OUTLOOK_TOKEN_URL  = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const OUTLOOK_SCOPES     = 'Mail.Send offline_access openid profile email';
const OUTLOOK_REDIRECT   = chrome.identity.getRedirectURL();

// base64url encoding of an ArrayBuffer / Uint8Array
function b64url(bytes) {
  let binary = '';
  const arr = new Uint8Array(bytes);
  for (const byte of arr) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function pkcePair() {
  const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
  const code_verifier = b64url(verifierBytes);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code_verifier));
  const code_challenge = b64url(digest);
  return { code_verifier, code_challenge };
}

// Interactive auth: launch web auth flow, exchange code for tokens.
// Returns { access_token, refresh_token, expires_at }.
async function outlookInteractiveAuth() {
  const { code_verifier, code_challenge } = await pkcePair();
  const stateBytes = crypto.getRandomValues(new Uint8Array(16));
  const state = b64url(stateBytes);

  const authUrl = OUTLOOK_AUTH_URL +
    `?client_id=${encodeURIComponent(OUTLOOK_CLIENT_ID)}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(OUTLOOK_REDIRECT)}` +
    `&response_mode=query` +
    `&scope=${encodeURIComponent(OUTLOOK_SCOPES)}` +
    `&state=${encodeURIComponent(state)}` +
    `&code_challenge=${encodeURIComponent(code_challenge)}` +
    `&code_challenge_method=S256` +
    `&prompt=select_account`;

  const redirectResponse = await new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, (responseUrl) => {
      if (chrome.runtime.lastError || !responseUrl) {
        reject(new Error(chrome.runtime.lastError?.message || 'auth cancelled'));
      } else {
        resolve(responseUrl);
      }
    });
  });

  const returned = new URL(redirectResponse);
  const code         = returned.searchParams.get('code');
  const returnedState = returned.searchParams.get('state');
  const authError    = returned.searchParams.get('error');
  if (authError) throw new Error(returned.searchParams.get('error_description') || authError);
  if (!code) throw new Error('no authorization code returned');
  if (returnedState !== state) throw new Error('state mismatch');

  const tokens = await outlookExchangeCode(code, code_verifier);
  return tokens;
}

async function outlookExchangeCode(code, code_verifier) {
  const params = new URLSearchParams({
    client_id: OUTLOOK_CLIENT_ID,
    grant_type: 'authorization_code',
    code,
    redirect_uri: OUTLOOK_REDIRECT,
    code_verifier,
    scope: OUTLOOK_SCOPES,
  });
  const res = await fetch(OUTLOOK_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${await res.text()}`);
  const data = await res.json();
  return {
    access_token:  data.access_token,
    refresh_token: data.refresh_token,
    expires_at:    Date.now() + ((data.expires_in || 3600) * 1000),
  };
}

async function outlookRefresh(refresh_token) {
  const params = new URLSearchParams({
    client_id: OUTLOOK_CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token,
    redirect_uri: OUTLOOK_REDIRECT,
    scope: OUTLOOK_SCOPES,
  });
  const res = await fetch(OUTLOOK_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!res.ok) throw new Error(`refresh failed: ${await res.text()}`);
  const data = await res.json();
  return {
    access_token:  data.access_token,
    // MS may or may not return a new refresh token; keep old one if absent.
    refresh_token: data.refresh_token || refresh_token,
    expires_at:    Date.now() + ((data.expires_in || 3600) * 1000),
  };
}

// Returns a valid access token, refreshing + persisting if expired. Null if not connected.
async function outlookValidToken() {
  const { outlookToken } = await chrome.storage.local.get(['outlookToken']);
  if (!outlookToken || !outlookToken.access_token) return null;
  // 60s safety margin before expiry.
  if (outlookToken.expires_at && Date.now() < outlookToken.expires_at - 60000) {
    return outlookToken.access_token;
  }
  if (!outlookToken.refresh_token) return outlookToken.access_token;
  const refreshed = await outlookRefresh(outlookToken.refresh_token);
  await chrome.storage.local.set({ outlookToken: refreshed });
  return refreshed.access_token;
}

async function outlookFetchEmail(access_token) {
  try {
    const res = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { 'Authorization': `Bearer ${access_token}` },
    });
    if (!res.ok) return 'Outlook Connected';
    const info = await res.json();
    return info.mail || info.userPrincipalName || 'Outlook Connected';
  } catch (e) {
    return 'Outlook Connected';
  }
}
