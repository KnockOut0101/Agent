import { chromium } from 'playwright';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';

// Ollama (self-hosted) configuration. Default assumes Ollama is running locally on port 11434.
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'gemma3:4b';


const args = process.argv.slice(2);
const startUrl = args[0];
const userInstructions = args.slice(1).join(' ') || 'Explore the page and summarize visible headings.';

if (!startUrl) {
  console.error('Usage: node browse-agent.js <startUrl> "<instructions>"');
  process.exit(1);
}

function buildPrompt(pageUrl, userInstructions) {
  return [
    { role: 'system', content:
`You are an assistant that outputs a JSON array of browser actions ONLY. Allowed action objects:
- { "type":"goto", "url": "<url>" }
- { "type":"waitForSelector", "selector":"<css>", "timeout":ms (optional) }
- { "type":"click", "selector":"<css>" }
- { "type":"fill", "selector":"<css>", "value":"<text>" }
- { "type":"eval", "script":"<js expression returning value>" }
- { "type":"screenshot", "path":"file.png" }
- { "type":"extract", "selector":"<css>", "name":"identifier" }
- { "type":"done" }

Return ONLY valid JSON. No extra text.`},
    { role: 'user', content: `Start page: ${pageUrl}\nTask: ${userInstructions}\nReturn an ordered list of actions (JSON array).` }
  ];
}

// Robust screenshot helper: waits for load and retries on transient failures
async function takeScreenshot(page, path, options = {}) {
  const timeout = options.timeout ?? 60000; // 60s
  const attempts = options.attempts ?? 2;
  for (let i = 0; i < attempts; i++) {
    try {
      await page.waitForLoadState('networkidle', { timeout });
      // small delay to allow fonts/images to settle
      await page.waitForTimeout(500);
      await page.screenshot({ path, fullPage: true, timeout });
      return;
    } catch (err) {
      if (i === attempts - 1) throw err;
      // retry after short backoff
      await page.waitForTimeout(500 * (i + 1));
    }
  }
}

async function askLLM(messages) {
  // Ollama expects a slightly different payload. We'll send the messages as a single string
  // and request streamed JSON-like output. Ollama's /api/generate returns { "model","parameters","content" }
  const prompt = messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');

  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
  prompt,
  max_tokens: 1024,
  temperature: 0.0,
  stream: false
    })
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Ollama API error: ${res.status} ${txt}`);
  }

  // Read raw text because some Ollama versions or configurations return extra data
  // (for example streamed chunks or metadata) which makes res.json() fail.
  const raw = await res.text();

  // Helper: find first balanced JSON object or array starting at the first '{' or '['.
  function extractFirstJson(text) {
    const startIdxObj = text.indexOf('{');
    const startIdxArr = text.indexOf('[');
    let start = -1;
    let startChar = null;
    if (startIdxArr !== -1 && (startIdxArr < startIdxObj || startIdxObj === -1)) {
      start = startIdxArr;
      startChar = '[';
    } else if (startIdxObj !== -1) {
      start = startIdxObj;
      startChar = '{';
    }
    if (start === -1) return null;

    let stack = [];
    let inString = false;
    let escape = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{' || ch === '[') {
        stack.push(ch);
      } else if (ch === '}' || ch === ']') {
        if (stack.length === 0) return null;
        const open = stack.pop();
        // basic check: matching types
        if ((open === '{' && ch !== '}') || (open === '[' && ch !== ']')) {
          return null; // mismatched
        }
        if (stack.length === 0) {
          return text.slice(start, i + 1);
        }
      }
    }
    return null; // no balanced JSON found
  }

  // Robust screenshot helper: waits for load and retries on transient failures
  // Try to extract a JSON payload from the raw response
  let extracted = extractFirstJson(raw);

  // If the top-level response is a metadata envelope, try to extract useful text from its `response` field.
  const tryExtractFromMeta = async (metaText) => {
    if (!metaText || typeof metaText !== 'string') return null;
    // Try to find JSON inside the meta response
    const nested = extractFirstJson(metaText);
    if (nested) return nested;
    // Otherwise return the raw meta text
    return metaText;
  };

  // Retry loop: if Ollama returned an envelope with an empty/only-fence `response` and done=false,
  // ask once more (up to 2 retries) with a stricter instruction to emit only the JSON array.
  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (extracted) {
      try {
        const parsedMeta = JSON.parse(extracted);
        const respText = (parsedMeta?.response ?? parsedMeta?.content ?? (parsedMeta?.outputs && parsedMeta.outputs.map(o=>o?.text||'').join('')) ) || '';
        // If the response contains nested JSON, return that immediately
        const nested = await tryExtractFromMeta(respText);
        if (nested && extractFirstJson(nested)) {
          // return the nested JSON string
          return extractFirstJson(nested);
        }

  const clean = String(respText).replace(/[`\s]/g, '');
  const onlyFences = /^(\s*`+\s*)+$/.test(String(respText));
  if ((clean.length === 0 || clean.length < 5 || onlyFences) && parsedMeta?.done === false && attempt < maxRetries) {
          // Retry with a strict prompt to only output JSON array
          const retryBody = JSON.stringify({
            model: OLLAMA_MODEL,
            prompt: prompt + "\n\nThe previous response was incomplete. Please output ONLY the JSON array of actions now, with no explanation or fencing.",
            max_tokens: 1024,
            temperature: 0.0,
            stream: false
          });
          const r2 = await fetch(`${OLLAMA_URL}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: retryBody });
          if (r2.ok) {
            const raw2 = await r2.text();
            extracted = extractFirstJson(raw2);
            if (!extracted) {
              // try to extract nested JSON inside the raw2
              const nested2 = extractFirstJson(raw2);
              if (nested2) extracted = nested2;
            }
            // continue loop to examine the new extracted
            continue;
          } else {
            // cannot retry, break to fall back
            break;
          }
        }
        // If respText is non-empty and not just fences, return it
        if (typeof respText === 'string' && respText.replace(/[`\s]/g, '').length > 0) {
          return respText;
        }
      } catch (e) {
        // ignore and fall through to try other parsing below
      }
    }
    break;
  }

  // If we have an extracted JSON envelope (or nested JSON), attempt to parse it to retrieve the model's text.
  if (extracted) {
    try {
      const parsed = JSON.parse(extracted);
      if (Array.isArray(parsed)) return JSON.stringify(parsed);
      if (parsed?.results && Array.isArray(parsed.results) && parsed.results[0]?.content) {
        return parsed.results[0].content.map(c => c?.text || '').join('');
      }
      if (parsed?.response) {
        // response may contain fences or partial content; try to extract nested JSON
        const nested = extractFirstJson(parsed.response);
        if (nested) return nested;
        return String(parsed.response);
      }
      if (parsed?.content) return parsed.content;
      if (parsed?.outputs && Array.isArray(parsed.outputs)) return parsed.outputs.map(o => o?.text || '').join('');
      return JSON.stringify(parsed);
    } catch (e) {
      // fall through to return raw
    }
  }

  // If extraction failed, return raw text for debugging
  return raw;
}

async function run() {
  let browser = await chromium.launch({ headless: false });
  const trace = [];
  let lastLLM = '';
  let timedOut = false;
  let abortRequested = false;
  const timeoutMs = Number(process.env.RUN_TIMEOUT_SECONDS || '300') * 1000;
  // watchdog: if the run exceeds timeoutMs, mark abortRequested and write diagnostics; do not immediately close browser
  const watchdog = setTimeout(() => {
    timedOut = true;
    abortRequested = true;
    trace.push('watchdog triggered');
    console.error('Global run timeout exceeded. abortRequested=true. Will attempt graceful shutdown; force-kill in 30s.');
    try {
      fs.writeFileSync('diagnostics.txt', JSON.stringify({ time: new Date().toISOString(), trace, last_llm_raw: lastLLM }, null, 2), { encoding: 'utf8' });
      console.error('Wrote diagnostics to', path.resolve('diagnostics.txt'));
    } catch (e) {
      console.error('Failed to write diagnostics:', e.message);
    }
    // Force kill after grace period
    setTimeout(async () => {
      console.error('Force-kill timeout reached. Closing browser and exiting.');
      try { if (browser) await browser.close(); } catch (e) { console.error('Force kill close error:', e.message); }
      process.exit(1);
    }, 30 * 1000);
  }, timeoutMs);
  // Allow tuning network/TLS behavior via env vars
  const extraArgs = (process.env.BROWSER_EXTRA_ARGS || '--no-sandbox --disable-dev-shm-usage').split(' ');
  const ignoreHTTPS = String(process.env.BROWSER_IGNORE_HTTPS || 'false').toLowerCase() === 'true';

  // Relaunch browser with extra args if provided
  if (extraArgs.length > 0) {
    await browser.close();
    const relaunchArgs = { headless: false, args: extraArgs };
    // keep default launch if extraArgs is empty
    const browser2 = await chromium.launch(relaunchArgs);
    // Use a desktop-like user agent to reduce blocking by servers
    const defaultUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36';
    const context = await browser2.newContext({ userAgent: process.env.BROWSER_USER_AGENT || defaultUA, ignoreHTTPSErrors: ignoreHTTPS });
    // replace references
    browser = browser2; // eslint-disable-line no-param-reassign
    globalThis._agent_context = context;
  }
  const context = globalThis._agent_context ?? await browser.newContext({ userAgent: process.env.BROWSER_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', ignoreHTTPSErrors: ignoreHTTPS });
  const page = await context.newPage();

  // capture console and page errors into trace for diagnostics
  page.on('console', msg => {
    try { trace.push({ console: msg.text() }); } catch(e) {}
  });
  page.on('pageerror', err => { try { trace.push({ pageerror: String(err.message || err) }); } catch(e){} });

  await page.goto(startUrl, { waitUntil: 'domcontentloaded' });

  const prompt = buildPrompt(startUrl, userInstructions);
  const llmText = await askLLM(prompt);
  try {
    lastLLM = String(llmText);
    fs.writeFileSync('last_llm_raw.txt', lastLLM, { encoding: 'utf8' });
    console.log('Wrote raw LLM output to', path.resolve('last_llm_raw.txt'));
  } catch (e) {
    console.warn('Failed to write last_llm_raw.txt:', e.message);
  }

  let actions;
  try {
    // Sanitize LLM output: escape unescaped control characters inside JSON string literals
    function sanitizeLLMJson(s) {
      if (!s || typeof s !== 'string') return s;
      // Quick heuristic: find JSON string literals and replace raw newlines/tabs with escaped versions
      // This is not a full JSON parser, but handles common bad outputs from LLMs.
      return s.replace(/("(?:[^"\\]|\\.)*")|(['"])([\s\S]*?)\2/g, (m, g1) => {
        if (!g1) return m;
        // strip the surrounding quotes
        const inner = g1.slice(1, -1);
        // escape literal CR, LF, and tab characters that are not already escaped
        const escaped = inner.replace(/\\/g, '\\\\').replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
        return '"' + escaped + '"';
      });
    }
    const sanitized = sanitizeLLMJson(llmText);
    actions = JSON.parse(sanitized);
    if (!Array.isArray(actions)) throw new Error('Expected JSON array');
  } catch (e) {
    console.error('Failed to parse LLM output as JSON:', e.message);
    console.error('LLM raw output:', llmText);
    await browser.close();
    return;
  }

  const results = {};
  for (const act of actions) {
    if (abortRequested) {
      console.error('Abort requested by watchdog — stopping action execution.');
      trace.push('abortRequested before action: ' + JSON.stringify(act));
      break;
    }
    try {
      switch (act.type) {
        case 'goto':
          await page.goto(act.url, { waitUntil: 'domcontentloaded' });
          break;
        case 'waitForSelector':
          await page.waitForSelector(act.selector, { timeout: act.timeout ?? 5000 });
          break;
        case 'click':
          await page.click(act.selector);
          break;
        case 'fill':
          await page.fill(act.selector, act.value);
          break;
        case 'eval':
          results['eval'] = await page.evaluate(act.script);
          break;
        case 'extract':
          results[act.name || act.selector] = await page.locator(act.selector).allTextContents();
          break;
        case 'screenshot':
          // Screenshot execution has been temporarily disabled to avoid long hangs during runs.
          // To re-enable, uncomment the block below and remove the skip log.
          console.log('Skipping screenshot action (disabled). Path requested:', act.path || 'screenshot.png');
          results['screenshot_skipped'] = act.path || 'screenshot.png';
          /*
          // previous implementation:
          try {
            const savePath = act.path || 'screenshot.png';
            console.log('Taking screenshot ->', savePath);
            if (act.selector) {
              try { await page.waitForSelector(act.selector, { timeout: 10000 }); } catch(e) { }
            }
            try {
              await takeScreenshot(page, savePath, { timeout: Number(process.env.SCREENSHOT_TIMEOUT || 60000) });
            } catch (err) {
              console.warn('Full-page screenshot failed, attempting viewport fallback:', err.message);
              try {
                await page.screenshot({ path: savePath, fullPage: false, timeout: 30000 });
              } catch (err2) {
                console.error('Viewport screenshot failed:', err2.message);
                throw err2;
              }
            }
            const abs = path.resolve(savePath);
            console.log('Screenshot saved to', abs);
            results['screenshot'] = abs;
          } catch (err) {
            console.error('Screenshot failed:', err.message);
            throw err;
          }
          */
          break;
        case 'done':
          console.log('Agent signaled done');
          break;
        default:
          console.warn('Unknown action', act);
      }
    } catch (err) {
      console.error('Action failed:', act, err.message);
    }
  }

  console.log('Results:', results);
  // If we have extracted text or eval output, ask the LLM to summarize it into a simple paragraph
  async function summarizeResults(resultsObj) {
    try {
      const pieces = [];
      if (resultsObj.eval) pieces.push(String(resultsObj.eval).slice(0, 20000));
      if (resultsObj.extract) pieces.push(JSON.stringify(resultsObj.extract).slice(0, 20000));
      const combined = pieces.join('\n\n');
      if (!combined) return null;
      const prompt = [
        { role: 'system', content: 'You are a concise summarizer. Produce a single short paragraph in plain English that generalizes the provided content for a non-technical audience.' },
        { role: 'user', content: `Content to summarize:\n\n${combined}\n\nProduce one short paragraph.` }
      ];
      const sumText = await askLLM(prompt);
      if (sumText) {
        fs.writeFileSync('summary.txt', String(sumText), { encoding: 'utf8' });
        console.log('Wrote summary to', path.resolve('summary.txt'));
        return String(sumText);
      }
      return null;
    } catch (e) {
      console.warn('Failed to summarize results:', e.message);
      return null;
    }
  }
  const summary = await summarizeResults(results);
  if (summary) results.summary = summary;
  try {
    await browser.close();
  } catch (e) {
    console.warn('Error closing browser:', e.message);
  }
  clearTimeout(watchdog);
  try {
    trace.push({ results });
    fs.writeFileSync('diagnostics.txt', JSON.stringify({ time: new Date().toISOString(), trace }, null, 2), { encoding: 'utf8' });
    console.log('Wrote diagnostics to', path.resolve('diagnostics.txt'));
  } catch (e) {
    console.warn('Failed to write diagnostics:', e.message);
  }
}

run().catch(err => { console.error(err); process.exit(1); });
