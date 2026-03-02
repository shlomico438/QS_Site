/**
 * Correct transcript segments using OpenAI GPT.
 * Reads JSON from stdin: { "segments": [{ "start", "end", "text", ... }], "targetLang": "he" }
 * Writes JSON to stdout: { "segments": [...], "meta": {...} }
 */

const DEBUG_ENABLED = String(process.env.GPT_DEBUG || '').toLowerCase() === 'true';
const DEBUG_FULL_PAYLOAD = String(process.env.GPT_DEBUG_FULL_PAYLOAD || '').toLowerCase() === 'true';
const MAX_PREVIEW_CHARS = Number(process.env.GPT_DEBUG_PREVIEW_CHARS || 1200);
const REQUEST_TIMEOUT_MS = Number(process.env.GPT_TIMEOUT_MS || 60000);

function nowMs() { return Date.now(); }
function debugLog(...args) { if (DEBUG_ENABLED) console.error('[gpt-debug]', ...args); }

function preview(str) {
  const s = String(str || '');
  if (DEBUG_FULL_PAYLOAD) return s;
  return s.length > MAX_PREVIEW_CHARS ? `${s.slice(0, MAX_PREVIEW_CHARS)}...[truncated]` : s;
}

function getApiKey() {
  const key = process.env.GPT_API_KEY || process.env.OPENAI_API_KEY;
  if (!key || !key.trim()) throw new Error('GPT_API_KEY must be set in the environment');
  return key.trim();
}

function getModel() {
  // Higher-quality default for transcript correction; override with GPT_MODEL if needed.
  return (process.env.GPT_MODEL || 'gpt-4.1').trim();
}

function sanitizeJsonText(raw) {
  const text = String(raw || '').trim();
  return text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
}

async function callOpenAIChat(apiKey, model, messages) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const body = {
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages
    };
    debugLog('request body preview:', preview(JSON.stringify(body)));
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`OpenAI API ${response.status}: ${preview(raw)}`);
    }
    debugLog('response chars:', raw.length);
    return JSON.parse(raw);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function processBatch(apiKey, model, items, targetLang) {
  const t0 = nowMs();
  if (!items || items.length === 0) return [];

  const batchInput = {
    results: items.map((seg, i) => ({
      id: i,
      text: String(seg.text || '').trim()
    }))
  };

  const systemPrompt = [
    'You are an expert transcript correction engine.',
    'Return ONLY valid JSON with this shape: {"results":[{"id":number,"text":string}]}.',
    'Do not add extra keys.',
    'Do not translate.',
    'Preserve original language and writing direction (RTL/LTR).',
    'Do not add explanations or comments.',
    'Fix obvious transcription errors only.'
  ].join(' ');

  const userPrompt = [
    `Target language hint: ${targetLang || 'he'}.`,
    'Fix the text values and return the exact same JSON structure with same ids.',
    JSON.stringify(batchInput)
  ].join('\n\n');

  debugLog(`batch start | size=${items.length}`);
  debugLog('batch input preview:', preview(userPrompt));

  try {
    const completion = await callOpenAIChat(apiKey, model, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]);
    const content = completion?.choices?.[0]?.message?.content || '';
    const clean = sanitizeJsonText(content);
    const parsed = JSON.parse(clean);
    if (!parsed || !Array.isArray(parsed.results)) {
      throw new Error("Missing 'results' array in GPT output");
    }
    debugLog(`batch end | elapsed_ms=${nowMs() - t0}`);
    return parsed.results;
  } catch (err) {
    console.error(`[gpt-error] Batch failed: ${err.message || err}`);
    return batchInput.results;
  }
}

async function processSegments(segments, targetLang = 'he') {
  const tAll = nowMs();
  const apiKey = getApiKey();
  const activeModel = getModel();
  const out = [];
  let okCount = 0;
  let emptyCount = 0;
  let errorCount = 0;
  let changedCount = 0;
  let firstError = '';

  const CHUNK_SIZE = Number(process.env.GPT_CHUNK_SIZE || 30);
  const MAX_PARALLEL_CHUNKS = Number(process.env.GPT_MAX_PARALLEL_CHUNKS || 5);

  debugLog(`process start | total=${segments.length} | chunk_size=${CHUNK_SIZE} | parallel_chunks=${MAX_PARALLEL_CHUNKS} | model=${activeModel}`);

  const chunks = [];
  for (let i = 0; i < segments.length; i += CHUNK_SIZE) {
    chunks.push({ start: i, items: segments.slice(i, i + CHUNK_SIZE) });
  }

  async function processChunk(chunk) {
    const tChunk = nowMs();
    const chunkOut = [];
    try {
      const correctedBatch = await processBatch(apiKey, activeModel, chunk.items, targetLang);
      for (let i = 0; i < chunk.items.length; i++) {
        const originalSeg = chunk.items[i];
        const correctedItem = Array.isArray(correctedBatch) ? correctedBatch.find((item) => item.id === i) : null;

        const copy = { ...originalSeg };
        const originalText = String(originalSeg.text || '');
        const newText = correctedItem ? String(correctedItem.text || '') : '';

        copy.translated_text = newText;
        copy.translation_status = newText ? 'ok' : 'empty';

        if (newText) {
          okCount += 1;
          if (newText.trim() !== originalText.trim()) changedCount += 1;
        } else {
          emptyCount += 1;
        }
        chunkOut.push(copy);
      }
      debugLog(`chunk ok | start=${chunk.start} | elapsed_ms=${nowMs() - tChunk}`);
    } catch (err) {
      errorCount += chunk.items.length;
      if (!firstError) firstError = err.message || String(err);
      for (const seg of chunk.items) {
        chunkOut.push({ ...seg, translated_text: '', translation_status: 'error' });
      }
    }
    return { start: chunk.start, items: chunkOut };
  }

  const chunkResults = [];
  let nextChunk = 0;
  async function worker() {
    while (nextChunk < chunks.length) {
      const idx = nextChunk++;
      const res = await processChunk(chunks[idx]);
      chunkResults.push(res);
    }
  }

  const workers = [];
  for (let i = 0; i < Math.max(1, MAX_PARALLEL_CHUNKS); i++) workers.push(worker());
  await Promise.all(workers);

  chunkResults.sort((a, b) => a.start - b.start).forEach((c) => out.push(...c.items));

  return {
    segments: out,
    meta: {
      total: segments.length,
      ok_count: okCount,
      empty_count: emptyCount,
      error_count: errorCount,
      changed_count: changedCount,
      first_error: firstError,
      model: activeModel,
      total_elapsed_ms: nowMs() - tAll
    }
  };
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function main() {
  const input = await readStdin();
  const data = JSON.parse(input || '{}');
  const segments = Array.isArray(data.segments) ? data.segments : [];
  const targetLang = data.targetLang || 'he';

  if (segments.length === 0) {
    process.stdout.write(JSON.stringify({ segments: [], meta: { total: 0 } }));
    process.exit(0);
    return;
  }

  const result = await processSegments(segments, targetLang);
  process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0));
}

main().catch((err) => {
  console.error('[gpt-error] fatal:', err && err.message ? err.message : err);
  process.exit(1);
});