# GitHub PR Review Bot

A Node.js + Express webhook server that listens for GitHub pull request events, sends the diff to Groq for AI review, and posts inline review comments back to the PR.

## Project Structure

- `src/index.js` — main Express server and webhook logic
- `package.json` — dependencies and scripts
- `.env.example` — environment variables required to run
- `.gitignore` — local ignores

## Environment Variables

Copy `.env.example` to `.env` and fill in the values:

- `GITHUB_WEBHOOK_SECRET` — webhook secret used to verify GitHub payloads
- `GITHUB_TOKEN` — GitHub token with repo access and pull request write permissions
- `GROQ_API_KEY` — Groq API key
- `GROQ_MODEL` — Groq model name (default: `llama-3.3-70b-versatile`)
- `MONGODB_URI` — optional MongoDB connection string for logging reviews
- `PORT` — server port (default: `3000`)

## Installation

```bash
npm install
```

## Run Locally

```bash
npm start
```

## Local Testing with ngrok

1. Start the server:

```bash
npm start
```

2. Start ngrok:

```bash
ngrok http 3000
```

3. Set the GitHub webhook payload URL to:

```
https://<your-ngrok-domain>.ngrok.io/webhook
```

4. Use the same `GITHUB_WEBHOOK_SECRET` value in GitHub webhook settings.

5. Enable `pull_request` events and send `opened` and `synchronize` events.

## GitHub Webhook Setup

1. Go to your repository settings > Webhooks.
2. Add a new webhook:
   - Payload URL: `https://<your-domain>/webhook`
   - Content type: `application/json`
   - Secret: same as `GITHUB_WEBHOOK_SECRET`
   - Events: `Pull requests`

## What the Bot Does

1. Listens for `pull_request` events with action `opened` or `synchronize`.
2. Verifies the webhook signature.
3. Fetches changed file diffs from the PR.
4. Sends the diff to Groq for AI review.
5. Posts an inline PR review comment using Octokit.

## Notes

- The bot uses `@octokit/rest` to fetch PR files and create reviews.
- If `MONGODB_URI` is set, the bot logs review metadata and AI output to MongoDB.
