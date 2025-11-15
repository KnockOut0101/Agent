# Browser Agent

This directory contains a simple Browser Agent that uses Playwright and an LLM to convert natural-language instructions into deterministic browser actions.

Files added
- `package.json` — Node package manifest for the agent.
- `browse-agent.js` — Main script. Launches Playwright, prompts an LLM (via Ollama) to return a JSON action list, and executes actions.

Why this design
- Separation of concerns: LLM handles high-level planning (turns instructions into an action list), Playwright performs deterministic actions. This limits unexpected LLM side-effects.
- JSON action list: easy to validate, parse, and extend (goto/click/fill/extract/eval/screenshot).

How to run (Windows PowerShell)

1. Install node dependencies from the `browser-agent` folder:

```powershell
cd "e:\Work\Browser Agent\Agent\AutoGPT-master\browser-agent"
npm install
```

2. Configure Ollama and run the agent. The script defaults to `http://localhost:11434` and model `llama2` but you can override via env vars `OLLAMA_URL` and `OLLAMA_MODEL`.

Example (assumes Ollama is running locally):

```powershell
node browse-agent.js "https://example.com" "Extract the main heading and take a screenshot"
```

If Ollama is running on a different host or model name, set env vars:

```powershell
$env:OLLAMA_URL = 'http://localhost:11434'
$env:OLLAMA_MODEL = 'mixtral-8x'  # example
node browse-agent.js "https://example.com" "Extract the main heading and take a screenshot"
```

What the agent does
1. Opens a Chromium browser (headful by default for visibility).
2. Navigates to the start URL.
3. Sends a system+user prompt to the configured Ollama instance asking for a JSON array of actions.
4. Parses the returned JSON and executes actions in order.
5. Prints any extracted results and closes the browser.

Security and caveats
- Do not run this against sensitive systems without reviewing and whitelisting LLM-produced selectors and actions.
- The LLM may occasionally return malformed JSON. Improve the prompt or add a JSON schema validator if needed.
- CAPTCHAs, MFA, and anti-bot protections are not handled.

Extending
- Add a JSON schema validator before executing actions.
- Add retries and better error handling for flaky pages.
- Add credential injection using environment variables for login flows.

Contact
- If you want this adapted to Python or integrated into the larger AutoGPT project here, tell me which path to patch and I'll add it.
