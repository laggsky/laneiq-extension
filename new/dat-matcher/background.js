// Open the welcome page on first install (not on updates).
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
  }
});

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

  if (msg.type === 'openPanel') {
    chrome.windows.create({
      url:    chrome.runtime.getURL('panel.html'),
      type:   'popup',
      left:   msg.left   ?? 100,
      top:    msg.top    ?? 100,
      width:  msg.width  ?? 380,
      height: 640,
    });
    return false;
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
    const url = 'https://maps.googleapis.com/maps/api/directions/json' +
      `?origin=${encodeURIComponent(origin)}` +
      `&destination=${encodeURIComponent(dest)}` +
      `&key=${encodeURIComponent(apiKey)}`;

    fetch(url)
      .then(r => r.json())
      .then(data => {
        const route = data.routes?.[0];
        if (data.status === 'OK' && route) {
          const leg = route.legs[0];
          sendResponse({
            miles:    Math.round(leg.distance.value * 0.000621371),
            duration: leg.duration.text,
            polyline: route.overview_polyline.points,
          });
        } else {
          sendResponse({ error: data.status || 'API error' });
        }
      })
      .catch(e => sendResponse({ error: e.message }));

    return true;
  }
});
