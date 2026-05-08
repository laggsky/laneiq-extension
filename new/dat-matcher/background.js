chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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
