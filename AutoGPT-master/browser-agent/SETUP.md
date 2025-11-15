# Browser Agent — Setup Guide

This file lists the exact tools, packages, and commands to get the `browser-agent` running on Windows (PowerShell). Follow the steps in order.

## Prerequisites
- Windows 10+ with PowerShell (the repo owner uses PowerShell v5.1).
- Node.js 18+ (LTS recommended). Download from https://nodejs.org/ or use nvm-windows.
- Git (optional, to clone repository).
- Ollama (self-hosted LLM runtime) — optional but required for the default agent configuration. See the "Ollama" section below.

## Packages used in the project
- playwright (Node library to control browsers)
- node-fetch@2 (lightweight fetch implementation)

These are declared in `browser-agent/package.json`. The exact versions added here were:
- playwright ^1.40.0
- node-fetch ^2.6.7

## Step-by-step commands (PowerShell)
1. Open PowerShell and navigate to the `browser-agent` directory:

```powershell
cd "e:\Work\Browser Agent\Agent\AutoGPT-master\browser-agent"
```

2. Install node modules (this will install Playwright and node-fetch):

```powershell
npm install
```

3. Install Playwright browser binaries (Playwright may prompt or automatically install browsers on first use). To force install browsers:

```powershell
npx playwright install
```

4. Run with local Ollama (default endpoint is http://localhost:11434). If Ollama is running locally and the desired model is available, simply:

```powershell
node browse-agent.js "https://example.com" "Extract the main heading and take a screenshot"
```

5. If Ollama is running on a different host or you need to specify a model name, set environment variables:

```powershell
$env:OLLAMA_URL = 'http://localhost:11434'
$env:OLLAMA_MODEL = 'llama2'
node browse-agent.js "https://example.com" "Extract the main heading and take a screenshot"
```

## Optional: Install Ollama (official docs)
- Ollama provides simple installers for macOS/Windows; follow official instructions at https://ollama.ai/docs.
- Once installed, pull or run a model. Example (if you have Ollama CLI):

```powershell
# Example: pull a model using Ollama CLI (adjust for available models)
ollama pull llama2
# Start Ollama daemon (if not already running)
ollama serve
```

After starting Ollama, verify the API is accessible:

```powershell
Invoke-RestMethod -Uri 'http://localhost:11434/api/models'
```

Expected response: JSON listing available models.

## Troubleshooting & verification
- If the agent fails to parse LLM output, check `browse-agent.js` console output; it prints the raw LLM output when JSON parsing fails.
- If Playwright cannot launch browsers, run `npx playwright install` again and verify network access.
- If Ollama returns errors, inspect the daemon logs and ensure the model name matches `OLLAMA_MODEL`.

## Security notes
- Do not expose Ollama's HTTP port on a public network without proper authentication and firewalling.
- Review any LLM-generated selectors/actions before running against sensitive sites.

## Summary of commands
```powershell
cd "e:\Work\Browser Agent\Agent\AutoGPT-master\browser-agent"
npm install
npx playwright install
# optional: set Ollama vars
$env:OLLAMA_URL = 'http://localhost:11434'
$env:OLLAMA_MODEL = 'llama2'
node browse-agent.js "https://example.com" "Extract the main heading and take a screenshot"
```
