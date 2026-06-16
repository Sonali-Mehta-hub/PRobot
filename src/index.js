'use strict';

const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const {Octokit} = require('@octokit/rest');
const {MongoClient} = require('mongodb');
require('dotenv').config();

const {
  GITHUB_WEBHOOK_SECRET,
  GITHUB_TOKEN,
  GROQ_API_KEY,
  GROQ_MODEL = 'llama-3.3-70b-versatile',
  MONGODB_URI,
  PORT = 3000,
} = process.env;

if (!GITHUB_WEBHOOK_SECRET || !GITHUB_TOKEN || !GROQ_API_KEY) {
  console.error('Missing required environment variables. Please set GITHUB_WEBHOOK_SECRET, GITHUB_TOKEN, and GROQ_API_KEY.');
  process.exit(1);
}

const app = express();
const octokit = new Octokit({auth: GITHUB_TOKEN});
let mongoClient;
let reviewCollection;

async function initMongo() {
  if (!MONGODB_URI) {
    return;
  }
  try {
    mongoClient = new MongoClient(MONGODB_URI);
    await mongoClient.connect();
    const db = mongoClient.db();
    reviewCollection = db.collection('pr_reviews');
    console.log('Connected to MongoDB for review logging.');
  } catch (error) {
    console.warn('Could not connect to MongoDB:', error.message);
  }
}

function verifyGitHubSignature(body, signatureHeader) {
  if (!signatureHeader) {
    return false;
  }
  const signature = signatureHeader.replace('sha256=', '');
  const computedHash = crypto
    .createHmac('sha256', GITHUB_WEBHOOK_SECRET)
    .update(body)
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(computedHash));
}

function buildPrompt(fileDiffs) {
  const diffText = fileDiffs
    .map((file) => `### File: ${file.path}\n${file.patch}`)
    .join('\n\n');
  return `You are an expert code reviewer. Review the following pull request changes for bugs, improvements, best practices, and security issues. Return a concise review organized by file.\n\n${diffText}`;
}

async function requestAIReview(fileDiffs) {
  const prompt = buildPrompt(fileDiffs);

  try {
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: GROQ_MODEL,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.2,
        max_tokens: 1024,
      },
      {
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const text = response.data?.choices?.[0]?.message?.content;

    if (!text) {
      throw new Error('Unable to parse Groq response');
    }

    return text;
  } catch (error) {
    console.error('Groq API Error:', error.response?.data || error.message);
    throw error;
  }
}

async function getPullRequestFileDiffs(owner, repo, pull_number) {
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number,
    per_page: 100,
  });
  return files
    .filter((file) => file.patch)
    .map((file) => ({
      path: file.filename,
      patch: file.patch,
    }));
}

function getFirstCommentPosition(patch) {
  const lines = patch.split('\n');
  let position = 0;
  for (const line of lines) {
    if (line.startsWith('@@') || line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('new file mode') || line.startsWith('deleted file mode')) {
      continue;
    }
    position += 1;
    if (line.startsWith('+') && !line.startsWith('+++ ')) {
      return position;
    }
    if (line.startsWith(' ')) {
      return position;
    }
  }
  return position || 1;
}

function buildReviewComments(fileDiffs) {
  return fileDiffs.map((file) => ({
    path: file.path,
    position: getFirstCommentPosition(file.patch),
    body: `AI code review comment for ${file.path}. Review summary is included in the pull request review body.`,
  }));
}

async function postReview(owner, repo, pull_number, reviewText, fileDiffs) {
  const comments = buildReviewComments(fileDiffs);
  try {
    const response = await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number,
      event: 'COMMENT',
      body: reviewText,
      comments,
    });
    return response.data;
  } catch (error) {
    console.error('Failed to create PR review:', error.message);
    throw error;
  }
}

async function logReview(owner, repo, pull_number, reviewText, fileDiffs) {
  if (!reviewCollection) {
    return;
  }
  try {
    await reviewCollection.insertOne({
      createdAt: new Date(),
      repository: `${owner}/${repo}`,
      pull_number,
      fileCount: fileDiffs.length,
      reviewText,
      fileDiffs: fileDiffs.map((file) => ({path: file.path, patchLength: file.patch.length})),
    });
  } catch (error) {
    console.warn('Failed to log PR review to MongoDB:', error.message);
  }
}

app.post('/webhook', express.raw({type: 'application/json'}), async (req, res) => {
  console.log('🔔 Webhook received');
  const signature = req.headers['x-hub-signature-256'] || req.headers['x-hub-signature'];
  const payload = req.body;

  if (!verifyGitHubSignature(payload, signature)) {
    console.error('❌ Invalid signature');
    return res.status(401).json({error: 'Invalid signature'});
  }

  let event;
  try {
    event = JSON.parse(payload.toString('utf8'));
  } catch (error) {
    console.error('❌ Invalid JSON:', error.message);
    return res.status(400).json({error: 'Invalid JSON payload'});
  }

  const githubEvent = req.headers['x-github-event'];
  if (githubEvent !== 'pull_request') {
    console.log(`⏭️ Event ignored (not pull_request): ${githubEvent}`);
    return res.status(200).json({message: 'Event ignored'});
  }

  const action = event.action;
  if (!['opened', 'synchronize', 'reopened'].includes(action)){
    console.log(`⏭️ Action ignored: ${action}`);
    return res.status(200).json({message: `Pull request action '${action}' ignored`});
  }

  const pullRequest = event.pull_request;
  const owner = event.repository?.owner?.login;
  const repo = event.repository?.name;
  const pull_number = pullRequest?.number;

  console.log(`📋 Processing PR: ${owner}/${repo}#${pull_number} (${action})`);

  if (!owner || !repo || !pull_number) {
    console.error('❌ Missing repository info');
    return res.status(400).json({error: 'Missing repository or pull request information'});
  }

  try {
    console.log('📂 Fetching file diffs...');
    const fileDiffs = await getPullRequestFileDiffs(owner, repo, pull_number);
    
    if (!fileDiffs.length) {
      console.log('⚠️ No files changed in this PR');
      return res.status(200).json({message: 'No diff data available for this PR'});
    }
    
    console.log(`✅ Found ${fileDiffs.length} files with changes`);
    console.log('🤖 Requesting AI review from Groq...');
    const aiReview = await requestAIReview(fileDiffs);
    
    console.log('✅ AI review received');
    console.log('📝 Posting review to GitHub...');
    const reviewData = await postReview(owner, repo, pull_number, aiReview, fileDiffs);
    
    console.log('✅ Review posted successfully');
    await logReview(owner, repo, pull_number, aiReview, fileDiffs);
    return res.status(200).json({message: 'Review posted', review: reviewData});
  } catch (error) {
    console.error('❌ Webhook processing failed:', error.message);
    console.error('Stack:', error.stack);
    return res.status(500).json({error: 'Server error processing webhook', details: error.message});
  }
});

app.get('/health', (req, res) => {
  res.json({status: 'ok'});
});

initMongo()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`GitHub PR review bot listening on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error('Startup failed:', error);
    process.exit(1);
  });