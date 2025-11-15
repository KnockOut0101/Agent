# Fixes and Next Steps — Browser Agent

This document records the fixes and improvements applied to the browser agent and planned next steps.

## Changes applied so far
1. Added `package.json` with dependencies:
   - `playwright` ^1.40.0
   - `node-fetch` ^2.6.7

2. Added `browse-agent.js` — initial Playwright + OpenAI design.

3. Added `browser-agent/README.md` — usage, design, and caveats.

4. Added `browser-agent/SETUP.md` — step-by-step install and run commands (PowerShell-friendly).

5. Updated `AGENTS.md` to reference the `browser-agent`.

6. Switched LLM integration from OpenAI to Ollama (self-hosted):
   - Replaced OpenAI API calls with Ollama `/api/generate` requests.
   - Added env vars `OLLAMA_URL` and `OLLAMA_MODEL` (defaults: `http://localhost:11434`, `gemma3:4b`).

7. Robust parsing for Ollama responses:
   - Replaced `res.json()` with `res.text()` and implemented `extractFirstJson` to find the first balanced JSON payload in the response.
   - Added logic to extract nested JSON from Ollama's metadata envelope and return the model text where possible.
   - Added retry logic for incomplete responses (e.g., code fences like "```").
   - Increased `max_tokens` and set `stream:false` by default to reduce truncation.

8. Troubleshooting guidance: when parsing fails the agent prints `LLM raw output:` to aid debugging.

## Observed issue
When navigating to `https://www.pokemon.com/us` Playwright returns:

```
page.goto: net::ERR_CONNECTION_RESET
```

This indicates the TCP connection was reset by the remote host or some intermediary.

## Possible causes
- Local network or ISP blocking the connection to pokemon.com.
- The remote server actively reset connections from automated clients or certain user-agents.
- Corporate firewall / antivirus intercepting or resetting connections.
- TLS interception by a proxy (man-in-the-middle) that Playwright's Chromium does not like.
- Playwright's default browser launch environment restricted from network access.

## Immediate debugging steps
1. Try opening the URL in your regular desktop browser on the same machine. If it works there, the issue is Playwright/Chromium-specific.
2. Try a curl or Invoke-RestMethod request from PowerShell to observe low-level TCP behavior:

```powershell
Invoke-WebRequest -Uri 'https://www.pokemon.com/us' -UseBasicParsing -TimeoutSec 30
```

3. Launch Playwright headful and manually navigate to the site to see if the browser shows an error (the agent already launches headful by default):

```powershell
# start the agent and watch the browser window
node browse-agent.js "https://www.pokemon.com/us" "Extract the main heading and take a screenshot"
```

4. Try launching the browser with different network settings (disable proxy) or pass a custom user agent. Example patch (temporary) to `browse-agent.js`:

```js
const browser = await chromium.launch({ headless: false, args: ['--no-sandbox'] });
const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36' });
```

5. If on a corporate network, try on a home network or VPN to see if a firewall/proxy is the cause.

6. Check Windows firewall or antivirus logs for blocked connections from Chromium.

## Potential fixes
- Use a stable user-agent in `newContext()` to mimic a real browser.
- Disable problematic command-line flags or add `--disable-features=IsolateOrigins,site-per-process` if the site blocks certain contexts.
- Set `ignoreHTTPSErrors:true` on `newContext()` if TLS interception is suspected (note: this weakens security).
- Use a proxy or VPN to route around ISP/firewall blocks.

## Planned next steps (near future)
- Add a `--dry-run` flag so parsing issues won't trigger navigation until the actions are validated.
- Add JSON schema validation (AJV) for the actions array and refuse to run invalid actions.
- Add better logging (save raw Ollama responses to `browser-agent/last_llm_raw.txt` for debugging).
- Add optional CLI flags to set `userAgent`, `ignoreHTTPSErrors`, and extra Chromium args.

## Applied network/browser launch fixes
- Added optional environment variables to tune Chromium launch and context:
   - `BROWSER_EXTRA_ARGS` - space-separated args to pass to Chromium (default: `--no-sandbox --disable-dev-shm-usage`).
   - `BROWSER_USER_AGENT` - string to use as the browser's user agent (defaults to a modern desktop UA).
   - `BROWSER_IGNORE_HTTPS` - set to `true` to pass `ignoreHTTPSErrors:true` to the context (useful when TLS is intercepted).

These were applied to `browse-agent.js` to reduce `ERR_CONNECTION_RESET` cases by mimicking a desktop browser and providing an escape hatch for TLS interception.

## Screenshot robustness
- Added `takeScreenshot(page, path, options)` helper that waits for `networkidle`, waits briefly for fonts/images, and retries screenshots (default 2 attempts, 60s timeout). This reduces `page.screenshot: Timeout 30000ms exceeded` errors on heavy pages.

## Additional debugging helpers
- The agent now writes the last raw LLM response to `browser-agent/last_llm_raw.txt` for inspection.
- Screenshot actions now log the save path and the agent records the absolute path in the `Results` output.

## Run watchdog and diagnostics
- Added a global run watchdog controlled by env var `RUN_TIMEOUT_SECONDS` (default 300s). If the run exceeds this time the agent will attempt to close the browser, write `diagnostics.txt` including a trace and the last LLM raw output, and exit with a non-zero code.
- On normal completion the agent writes `diagnostics.txt` with a trace and results.

Updates:
- The watchdog now sets an `abortRequested` flag first and writes diagnostics immediately; it will force-close the browser after a 30s grace period if the run doesn't stop on its own. This prevents abrupt mid-action closure.
- The agent now listens for `console` and `pageerror` events from the page and records them in the diagnostics trace.

Update:
- Screenshot execution has been temporarily disabled (screenshot actions are now skipped and logged) to avoid long hangs during runs. The previous implementation remains commented in the code for easy re-enabling.

## Post-run summarization
- After actions complete, the agent now sends any captured `eval` or `extract` text back to the LLM (using `askLLM`) and requests a single-paragraph summary. The summary is written to `summary.txt` and included in the final `Results.summary` field.

## Tolerant JSON parsing
- Added a sanitization step before JSON.parse to escape raw newlines/tabs inside JSON string literals returned by the LLM. This handles common malformed responses like unescaped newlines inside the `script` field.

## Files to review
- `browser-agent/browse-agent.js` — current main script
- `browser-agent/README.md` — usage
- `browser-agent/SETUP.md` — installation steps

---

If you'd like, I can now apply one or more of the potential fixes above (for example: set a desktop-like `userAgent` and `ignoreHTTPSErrors` in `newContext`, and add `--disable-dev-shm-usage` or `--no-sandbox` to the `chromium.launch` args). Tell me which fix you'd like me to implement and I'll patch the code and document it in this file.
