const CACHE_NAME = 'maestro-auditor-v14';
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

function extractQuickNotificationSummary(rawText, jobType) {
  try {
    let s = String(rawText || '').trim();
    const fm = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fm) s = fm[1].trim();
    const obj = JSON.parse(s);
    if (obj && typeof obj === 'object') {
      if (jobType === 'script') {
        const mode = obj.suno_fix?.mode || 'Suno Script';
        const ai = obj.suno_fix?.audio_influence !== undefined ? `Audio ${obj.suno_fix.audio_influence}%` : '';
        return `🛠️ ${mode} तयार! ${ai} • कॉपी करण्यासाठी टच करा.`.trim();
      }
      const sc = obj.total_score !== undefined ? `${obj.total_score}/100 गुण` : '';
      const vd = obj.verdict ? `• ${obj.verdict}` : '';
      const ai = obj.ai_suspicion_pct !== undefined ? `• AI संशय: ${obj.ai_suspicion_pct}%` : '';
      return `${sc} ${vd} ${ai}`.trim();
    }
  } catch (_) {}
  return jobType === 'script'
    ? 'तुमची तयार Suno स्क्रिप्ट व स्लाइडर्स तयार आहेत! पाहण्यासाठी टच करा.'
    : 'तुमच्या गाण्याचा आंतरराष्ट्रीय ज्युरी निकाल तयार आहे! पाहण्यासाठी टच करा.';
}

async function deleteUploadedQuietly(fileName, apiKey) {
  if (!fileName || !apiKey) return;
  try {
    await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${encodeURIComponent(apiKey)}`, {
      method: 'DELETE'
    });
  } catch (_) {}
}

async function fetchWithTimeout(url, options, timeoutMs = 110000) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error('सर्व्हर प्रतिसादास खूप वेळ लागला (Timeout). कृपया "⚡ झटपट मोड (Fast)" वापरून पुन्हा प्रयत्न करा.');
    }
    throw err;
  } finally {
    clearTimeout(tid);
  }
}

async function runBackgroundAuditJob(msg) {
  const { jobId, jobType, apiKey, model, fallbackModels, payload, songTitle, isYT, uploadedName } = msg;
  const kind = jobType === 'jury' ? 'jury' : 'script';
  const dbKey = `latest_${kind}`;
  const startedAt = Date.now();
  const labelAction = kind === 'jury' ? 'आंतरराष्ट्रीय ज्युरी तपासत आहेत' : 'God Volume Suno स्क्रिप्ट तयार होत आहे';

  await saveJobRecord({
    id: dbKey,
    jobId,
    jobType: kind,
    status: 'running',
    songTitle: songTitle || 'Song',
    model,
    startedAt,
    updatedAt: startedAt
  });

  const hbTimer = setInterval(() => {
    const now = Date.now();
    saveJobRecord({
      id: dbKey,
      jobId,
      jobType: kind,
      status: 'running',
      songTitle: songTitle || 'Song',
      model,
      startedAt,
      updatedAt: now
    });
    broadcastToClients({
      type: 'BG_AUDIT_HEARTBEAT',
      jobId,
      jobType: kind,
      elapsedSec: Math.floor((now - startedAt) / 1000)
    });
  }, 4500);

  await broadcastToClients({
    type: 'BG_AUDIT_PROGRESS',
    jobId,
    jobType: kind,
    pct: 64,
    text: `2/3 ${model} — ${labelAction}...`
  });

  try {
    let activeModel = model;
    const callModel = async (mdl, bodyObj) => {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(mdl)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyObj)
      }, 115000);
      const json = await res.json().catch(() => ({}));
      return { res, json };
    };

    let { res: genRes, json: genJson } = await callModel(activeModel, payload);

    // Strip thinkingConfig if model doesn't support it
    if (!genRes.ok && genRes.status === 400 && payload?.generationConfig?.thinkingConfig && /thinking/i.test(genJson?.error?.message || '')) {
      delete payload.generationConfig.thinkingConfig;
      ({ res: genRes, json: genJson } = await callModel(activeModel, payload));
    }

    // Smart automatic fallback if selected model is retired / 404
    if (!genRes.ok && (genRes.status === 404 || /no longer available|not found/i.test(genJson?.error?.message || ''))) {
      const list = Array.isArray(fallbackModels) ? fallbackModels : ['gemini-2.5-flash', 'gemini-3-flash-preview', 'gemini-3.1-pro-preview'];
      for (const fb of list) {
        if (fb === activeModel) continue;
        await broadcastToClients({
          type: 'BG_AUDIT_PROGRESS',
          jobId,
          jobType: kind,
          pct: 72,
          text: `2/3 आपोआप ${fb} वर स्विच करून काम सुरू आहे...`
        });
        if (!/2\.5-flash/i.test(fb) && payload?.generationConfig?.thinkingConfig) {
          delete payload.generationConfig.thinkingConfig;
        }
        ({ res: genRes, json: genJson } = await callModel(fb, payload));
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
      ({ res: genRes, json: genJson } = await callModel(activeModel, payload));
    }

    if (!genRes.ok) {
      const rawMsg = genJson?.error?.message || `HTTP ${genRes.status}`;
      let errText = rawMsg;
      if (genRes.status === 429) {
        errText = `API कोटा / वेग मर्यादा (429): ${rawMsg}. उपाय: "⚡ झटपट मोड (Fast)" निवडा किंवा "Copy Prompt for Gemini Chat" वापरा!`;
      } else if (isYT && (genRes.status === 400 || genRes.status === 403 || /youtube|video|private|unavailable|duration/i.test(rawMsg))) {
        errText = `YouTube व्हिडिओ वाचता आला नाही (${genRes.status}): ${rawMsg}. खात्री करा की व्हिडिओ Public आहे व खूप लांब नाही.`;
      } else if (genRes.status === 400 || genRes.status === 403) {
        errText = `API Key किंवा मॉडेल त्रुटी (${genRes.status}): ${rawMsg}`;
      }
      throw new Error(errText);
    }

    const cand = genJson?.candidates?.[0];
    const finishReason = cand?.finishReason || '';
    const parts = cand?.content?.parts || [];
    const reportText = parts.map((p) => p.text || '').join('\n').trim();
    if (!reportText) {
      const blockReason = genJson?.promptFeedback?.blockReason || finishReason || 'EMPTY';
      throw new Error(`Gemini कडून निकाल तयार झाला नाही (कारण: ${blockReason}). कृपया "⚡ झटपट मोड" मध्ये पुन्हा प्रयत्न करा.`);
    }

    const finishedAt = Date.now();
    await saveJobRecord({
      id: dbKey,
      jobId,
      jobType: kind,
      status: 'done',
      songTitle: songTitle || 'Song',
      activeModel,
      reportText,
      startedAt,
      finishedAt,
      updatedAt: finishedAt
    });

    await broadcastToClients({
      type: 'BG_AUDIT_DONE',
      jobId,
      jobType: kind,
      activeModel,
      songTitle,
      reportText,
      elapsedSec: Math.round((finishedAt - startedAt) / 1000)
    });

    const summaryLine = extractQuickNotificationSummary(reportText, kind);
    await notifyIfBackground(
      kind === 'script' ? '🛠️ Suno स्क्रिप्ट तयार!' : '🏆 आंतरराष्ट्रीय ज्युरी निकाल तयार!',
      `${songTitle ? songTitle + ' — ' : ''}${summaryLine}`,
      jobId
    );
  } catch (err) {
    const errMsg = err?.message || 'अज्ञात त्रुटी';
    const now = Date.now();
    await saveJobRecord({
      id: dbKey,
      jobId,
      jobType: kind,
      status: 'error',
      songTitle: songTitle || 'Song',
      error: errMsg,
      startedAt,
      finishedAt: now,
      updatedAt: now
    });

    await broadcastToClients({
      type: 'BG_AUDIT_ERROR',
      jobId,
      jobType: kind,
      error: errMsg
    });

    await notifyIfBackground(
      `⚠️ Maestro Auditor थांबले`,
      errMsg.slice(0, 120),
      jobId
    );
  } finally {
    clearInterval(hbTimer);
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
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

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
