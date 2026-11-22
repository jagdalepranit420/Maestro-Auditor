const CACHE_NAME = 'maestro-auditor-v10';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

const DB_NAME = 'MaestroAuditorDB';
const DB_STORE = 'jobs';

function openJobDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveJobRecord(record) {
  try {
    const db = await openJobDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (_) {}
}

async function broadcastToClients(msg) {
  try {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of list) {
      client.postMessage(msg);
    }
    return list;
  } catch (_) {
    return [];
  }
}

async function notifyIfBackground(title, body, jobId) {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const anyVisible = list.some((c) => c.visibilityState === 'visible' && c.focused);
    if (anyVisible) return;
    await self.registration.showNotification(title, {
      body,
      icon: './icon-192.png',
      badge: './icon-192.png',
      tag: 'maestro-audit-result',
      renotify: true,
      data: { jobId, url: './' }
    });
  } catch (_) {}
}

function extractQuickNotificationSummary(rawText) {
  try {
    let s = String(rawText || '').trim();
    const fm = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fm) s = fm[1].trim();
    const obj = JSON.parse(s);
    if (obj && typeof obj === 'object') {
      const sc = obj.total_score !== undefined ? `${obj.total_score}/100 गुण` : '';
      const vd = obj.verdict ? `• ${obj.verdict}` : '';
      const ai = obj.ai_suspicion_pct !== undefined ? `• AI संशय: ${obj.ai_suspicion_pct}%` : '';
      return `${sc} ${vd} ${ai}`.trim();
    }
  } catch (_) {}
  return 'तुमच्या गाण्याचा आंतरराष्ट्रीय ज्युरी निकाल तयार आहे! पाहण्यासाठी टच करा.';
}

async function deleteUploadedQuietly(fileName, apiKey) {
  if (!fileName || !apiKey) return;
  try {
    await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${encodeURIComponent(apiKey)}`, {
      method: 'DELETE'
    });
  } catch (_) {}
}

async function runBackgroundAuditJob(msg) {
  const { jobId, apiKey, model, fallbackModels, payload, songTitle, isYT, uploadedName } = msg;
  const startedAt = Date.now();

  await saveJobRecord({
    id: 'latest',
    jobId,
    status: 'running',
    songTitle: songTitle || 'Song',
    model,
    startedAt
  });

  await broadcastToClients({
    type: 'BG_AUDIT_PROGRESS',
    jobId,
    pct: 64,
    text: `2/3 ${model} ज्युरी बॅकग्राऊंडमध्ये गाणे ऐकत आहेत... (तुम्ही इतर अ‍ॅप्स वापरू शकता)`
  });

  try {
    let activeModel = model;
    const genUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(activeModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    let genRes = await fetch(genUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    let genJson = await genRes.json().catch(() => ({}));

    // Smart automatic fallback if selected model is retired / 404 / overloaded
    if (!genRes.ok && (genRes.status === 404 || /no longer available|not found/i.test(genJson?.error?.message || ''))) {
      const list = Array.isArray(fallbackModels) ? fallbackModels : ['gemini-2.5-flash', 'gemini-3-flash-preview', 'gemini-3.1-pro-preview'];
      for (const fb of list) {
        if (fb === activeModel) continue;
        await broadcastToClients({
          type: 'BG_AUDIT_PROGRESS',
          jobId,
          pct: 72,
          text: `2/3 आपोआप ${fb} वर स्विच करून बॅकग्राऊंड ऑडिट सुरू आहे...`
        });
        const fbUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(fb)}:generateContent?key=${encodeURIComponent(apiKey)}`;
        genRes = await fetch(fbUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        genJson = await genRes.json().catch(() => ({}));
        if (genRes.ok) {
          activeModel = fb;
          break;
        }
      }
    }

    // YouTube mimeType retry if needed
    if (!genRes.ok && isYT && genRes.status === 400 && /mime/i.test(genJson?.error?.message || '')) {
      if (payload?.contents?.[0]?.parts?.[0]?.fileData) {
        payload.contents[0].parts[0].fileData.mimeType = 'video/mp4';
      }
      const retryUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(activeModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      genRes = await fetch(retryUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      genJson = await genRes.json().catch(() => ({}));
    }

    if (!genRes.ok) {
      const rawMsg = genJson?.error?.message || `HTTP ${genRes.status}`;
      let errText = rawMsg;
      if (genRes.status === 429) {
        errText = `API कोटा / वेग मर्यादा (429): ${rawMsg}. उपाय: "⚡ झटपट मोड (Flash)" निवडा किंवा "Copy Forensic Report for Gemini Chat" वापरा!`;
      } else if (isYT && (genRes.status === 400 || genRes.status === 403 || /youtube|video|private|unavailable/i.test(rawMsg))) {
        errText = `YouTube व्हिडिओ वाचता आला नाही (${genRes.status}): ${rawMsg}. खात्री करा की व्हिडिओ Public आहे.`;
      } else if (genRes.status === 400 || genRes.status === 403) {
        errText = `API Key किंवा मॉडेल त्रुटी (${genRes.status}): ${rawMsg}`;
      }
      throw new Error(errText);
    }

    const parts = genJson?.candidates?.[0]?.content?.parts || [];
    const reportText = parts.map((p) => p.text || '').join('\n').trim();
    if (!reportText) {
      throw new Error('Gemini कडून रिकामा प्रतिसाद आला. कृपया पुन्हा प्रयत्न करा.');
    }

    const finishedAt = Date.now();
    await saveJobRecord({
      id: 'latest',
      jobId,
      status: 'done',
      songTitle: songTitle || 'Song',
      activeModel,
      reportText,
      startedAt,
      finishedAt
    });

    await broadcastToClients({
      type: 'BG_AUDIT_DONE',
      jobId,
      activeModel,
      songTitle,
      reportText,
      elapsedSec: Math.round((finishedAt - startedAt) / 1000)
    });

    const summaryLine = extractQuickNotificationSummary(reportText);
    await notifyIfBackground(
      `🏆 Maestro Auditor निकाल तयार!`,
      `${songTitle ? songTitle + ' — ' : ''}${summaryLine}`,
      jobId
    );
  } catch (err) {
    const errMsg = err?.message || 'अज्ञात त्रुटी';
    await saveJobRecord({
      id: 'latest',
      jobId,
      status: 'error',
      songTitle: songTitle || 'Song',
      error: errMsg,
      startedAt,
      finishedAt: Date.now()
    });

    await broadcastToClients({
      type: 'BG_AUDIT_ERROR',
      jobId,
      error: errMsg
    });

    await notifyIfBackground(
      `⚠️ Maestro Auditor ऑडिट थांबले`,
      errMsg.slice(0, 120),
      jobId
    );
  } finally {
    if (uploadedName) {
      await deleteUploadedQuietly(uploadedName, apiKey);
    }
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'START_BG_AUDIT') {
    event.waitUntil(runBackgroundAuditJob(data));
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./');
    })
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Never intercept POST/DELETE or external API calls (Gemini Files API / large WAV uploads)
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Network-first strategy so GitHub Pages updates appear immediately, with offline fallback
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match('./index.html')))
  );
});
