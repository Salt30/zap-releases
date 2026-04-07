require('dotenv').config();
const { Client, GatewayIntentBits, Partials, EmbedBuilder, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const OpenAI = require('openai');
const KNOWLEDGE = require('./knowledge');
const fs = require('fs');
const path = require('path');

// ── Config ──
const DISCORD_TOKEN    = process.env.DISCORD_TOKEN;
const OPENAI_API_KEY   = process.env.OPENAI_API_KEY;
const OWNER_ID         = process.env.OWNER_ID;
const FEATURE_CHANNEL  = process.env.FEATURE_REQUESTS_CHANNEL;
const UPDATES_CHANNEL  = process.env.UPDATES_CHANNEL;
const GITHUB_PAT       = process.env.GITHUB_PAT;
const GITHUB_REPO      = 'Salt30/Zap';  // owner/repo
const PUBLIC_REPO      = 'Salt30/zap-releases'; // public releases
const ANNOUNCEMENTS_CHANNEL = process.env.UPDATES_CHANNEL; // #announcements channel ID

// ══════════════════════════════════════════════════════════════
//  ERROR HANDLING SYSTEM — categorized logging + owner alerts
// ══════════════════════════════════════════════════════════════
const ERROR_LOG_FILE = path.join(__dirname, 'errors.json');
const MAX_ERROR_LOG = 500; // Keep last 500 errors

const ErrorType = {
  OPENAI:     'OPENAI',      // OpenAI API failures
  DISCORD:    'DISCORD',     // Discord API failures
  GITHUB:     'GITHUB',      // GitHub API failures
  STRIPE:     'STRIPE',      // Stripe-related errors
  SECURITY:   'SECURITY',    // Security violations
  FILE_IO:    'FILE_IO',     // File read/write failures
  RATE_LIMIT: 'RATE_LIMIT',  // Rate limit hits
  STARTUP:    'STARTUP',     // Bot startup failures
  UNKNOWN:    'UNKNOWN',     // Uncategorized errors
};

const errorTracker = {
  counts: new Map(),       // ErrorType -> count in last hour
  lastReset: Date.now(),
  ownerAlerted: new Set(), // Prevent spam — track which errors we've already DM'd about

  log(type, message, details = {}) {
    const timestamp = new Date().toISOString();
    const entry = { type, message, details: String(details.stack || details.message || JSON.stringify(details)).slice(0, 500), timestamp };

    // Console log with category
    console.error(`[ERROR:${type}] ${message}`, details.message || '');

    // Persist to errors.json
    try {
      let errors = [];
      try { errors = JSON.parse(fs.readFileSync(ERROR_LOG_FILE, 'utf-8')); } catch (_) {}
      errors.push(entry);
      if (errors.length > MAX_ERROR_LOG) errors = errors.slice(-MAX_ERROR_LOG);
      fs.writeFileSync(ERROR_LOG_FILE, JSON.stringify(errors, null, 2));
    } catch (_) { /* Don't let error logging create more errors */ }

    // Track counts for alerting
    const now = Date.now();
    if (now - this.lastReset > 3600000) {
      this.counts.clear();
      this.ownerAlerted.clear();
      this.lastReset = now;
    }
    this.counts.set(type, (this.counts.get(type) || 0) + 1);

    return entry;
  },

  // Alert owner via DM for critical/repeated errors
  async alertOwner(type, message, client) {
    if (!OWNER_ID || !client?.isReady()) return;
    const alertKey = `${type}:${message.slice(0, 50)}`;
    if (this.ownerAlerted.has(alertKey)) return; // Already alerted for this
    this.ownerAlerted.add(alertKey);

    const count = this.counts.get(type) || 1;
    const severity = count >= 10 ? '🔴 CRITICAL' : count >= 3 ? '🟡 WARNING' : '🔵 INFO';

    try {
      const owner = await client.users.fetch(OWNER_ID);
      await owner.send(
        `${severity} **Bot Error — ${type}**\n` +
        `${message.slice(0, 300)}\n` +
        `_Occurred ${count}x in the last hour_\n` +
        `\`Check ~/Desktop/ZapBot/errors.json for full details\``
      );
    } catch (_) { /* Can't DM owner — they'll see the log */ }
  },

  // Get error summary for owner commands
  getSummary() {
    const summary = [];
    for (const [type, count] of this.counts) {
      summary.push(`${type}: ${count} errors`);
    }
    return summary.length ? summary.join('\n') : 'No errors in the last hour.';
  }
};

// ── Specific error handlers with user-friendly messages ──
function handleOpenAIError(err, context = '') {
  const entry = errorTracker.log(ErrorType.OPENAI, `OpenAI API error${context ? ' in ' + context : ''}`, err);

  if (err.status === 401 || err.code === 'invalid_api_key') {
    errorTracker.alertOwner(ErrorType.OPENAI, 'OpenAI API key is INVALID. Bot cannot respond to users. Rotate the key immediately.', client);
    return "I'm temporarily unable to process requests. The team has been notified and is fixing this now.";
  }
  if (err.status === 429 || err.code === 'rate_limit_exceeded') {
    errorTracker.alertOwner(ErrorType.OPENAI, 'OpenAI rate limit exceeded. Users are getting errors.', client);
    return "I'm getting a lot of requests right now. Please try again in a minute or two!";
  }
  if (err.status === 500 || err.status === 503) {
    return "OpenAI's servers are having issues right now. Try again in a few minutes — this usually resolves quickly.";
  }
  if (err.code === 'insufficient_quota') {
    errorTracker.alertOwner(ErrorType.OPENAI, 'OpenAI quota exceeded! Bot is DOWN. Add credits or raise the limit.', client);
    return "I'm temporarily offline due to a billing issue. The team has been notified.";
  }
  if (err.message?.includes('timeout') || err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET') {
    return "My connection timed out. Give me a sec and try again!";
  }

  // Generic fallback
  errorTracker.alertOwner(ErrorType.OPENAI, `Unexpected OpenAI error: ${err.message}`, client);
  return "I'm having trouble connecting right now. A team member will follow up shortly.";
}

function handleDiscordError(err, context = '') {
  errorTracker.log(ErrorType.DISCORD, `Discord error${context ? ' in ' + context : ''}`, err);

  if (err.code === 50001) return 'missing_access';      // Missing Access
  if (err.code === 50013) return 'missing_permissions';  // Missing Permissions
  if (err.code === 50007) return 'cannot_dm';            // Cannot DM user
  if (err.code === 10003) return 'unknown_channel';      // Unknown Channel
  if (err.code === 10008) return 'unknown_message';      // Unknown Message
  if (err.code === 40005) return 'too_large';            // Request entity too large
  return 'discord_error';
}

function handleGitHubError(err, context = '') {
  errorTracker.log(ErrorType.GITHUB, `GitHub API error${context ? ' in ' + context : ''}`, err);

  if (err.message?.includes('401') || err.message?.includes('Bad credentials')) {
    errorTracker.alertOwner(ErrorType.GITHUB, 'GitHub PAT is invalid! Auto-updates and PR creation are broken.', client);
  }
  if (err.message?.includes('403') && err.message?.includes('rate limit')) {
    errorTracker.alertOwner(ErrorType.GITHUB, 'GitHub API rate limit exceeded.', client);
  }
}

// ── Global uncaught error handlers ──
process.on('uncaughtException', (err) => {
  errorTracker.log(ErrorType.UNKNOWN, 'Uncaught exception — bot may be unstable', err);
  errorTracker.alertOwner(ErrorType.UNKNOWN, `Uncaught exception: ${err.message}. Bot may need a restart.`, client);
  // Don't exit — let the bot try to keep running
  console.error('[FATAL] Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  errorTracker.log(ErrorType.UNKNOWN, 'Unhandled promise rejection', err);
  // Don't exit — log and continue
  console.error('[FATAL] Unhandled rejection:', reason);
});

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ══════════════════════════════════════════════════════════════
//  RATE LIMITING — prevent abuse and runaway API costs
// ══════════════════════════════════════════════════════════════
const rateLimiter = {
  userCounts: new Map(),   // userId -> { count, resetTime }
  globalCount: 0,
  globalReset: Date.now() + 3600000,
  MAX_PER_USER_PER_HOUR: 30,   // Max AI requests per user per hour
  MAX_GLOBAL_PER_HOUR: 500,     // Max total AI requests per hour
  COST_ALERT_THRESHOLD: 200,    // DM owner if estimated cost exceeds this

  check(userId) {
    const now = Date.now();

    // Reset global counter hourly
    if (now > this.globalReset) {
      this.globalCount = 0;
      this.globalReset = now + 3600000;
    }

    // Check global limit
    if (this.globalCount >= this.MAX_GLOBAL_PER_HOUR) {
      console.warn(`[RATE LIMIT] Global limit hit: ${this.globalCount}/${this.MAX_GLOBAL_PER_HOUR}`);
      return false;
    }

    // Check per-user limit
    let user = this.userCounts.get(userId);
    if (!user || now > user.resetTime) {
      user = { count: 0, resetTime: now + 3600000 };
      this.userCounts.set(userId, user);
    }
    if (user.count >= this.MAX_PER_USER_PER_HOUR) {
      console.warn(`[RATE LIMIT] User ${userId} hit limit: ${user.count}/${this.MAX_PER_USER_PER_HOUR}`);
      return false;
    }

    user.count++;
    this.globalCount++;
    return true;
  },

  // Clean up old entries every 30 min
  cleanup() {
    const now = Date.now();
    for (const [id, data] of this.userCounts) {
      if (now > data.resetTime) this.userCounts.delete(id);
    }
  }
};
setInterval(() => rateLimiter.cleanup(), 30 * 60 * 1000);

// ══════════════════════════════════════════════════════════════
//  STARTUP SECURITY CHECKS — validate environment
// ══════════════════════════════════════════════════════════════
function validateEnvironment() {
  const required = ['DISCORD_TOKEN', 'OPENAI_API_KEY', 'OWNER_ID'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`[SECURITY] Missing required env vars: ${missing.join(', ')}`);
    console.error('[SECURITY] Bot will not start without these. Check .env file.');
    process.exit(1);
  }

  // Warn if running with old/known-compromised keys
  const compromisedPatterns = ['GOAmuM', 'sk-proj-3iRR', 'ghp_skJC', 'CO5z3R9xy', 'Vc0BvMN'];
  for (const pat of compromisedPatterns) {
    for (const [key, val] of Object.entries(process.env)) {
      if (val && val.includes(pat)) {
        console.error(`[SECURITY] ⚠️  ${key} appears to contain a COMPROMISED key! Rotate immediately.`);
      }
    }
  }

  console.log('[SECURITY] Environment validated — all keys present');
}
validateEnvironment();

// ── GitHub API helper ──
async function githubAPI(endpoint, method = 'GET', body = null) {
  const url = endpoint.startsWith('http') ? endpoint : `https://api.github.com/repos/${GITHUB_REPO}${endpoint}`;
  const opts = {
    method,
    headers: {
      'Authorization': `token ${GITHUB_PAT}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'ZapBot',
    },
  };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(url, opts);
  } catch (err) {
    handleGitHubError(err, `fetch ${method} ${endpoint}`);
    throw new Error(`GitHub API network error (${method} ${endpoint}): ${err.message}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => 'no body');
    const error = new Error(`GitHub API ${method} ${endpoint}: ${res.status} ${text.slice(0, 200)}`);
    handleGitHubError(error, `${method} ${endpoint}`);
    throw error;
  }
  return res.json();
}

// ══════════════════════════════════════════════════════════════
//  OUTPUT SAFETY FILTER — hard-coded leak prevention
//  Catches sensitive info BEFORE it's sent to Discord
// ══════════════════════════════════════════════════════════════

const BLOCKED_PATTERNS = [
  // API keys & tokens
  /sk-proj-[A-Za-z0-9_-]{20,}/gi,           // OpenAI keys
  /sk_live_[A-Za-z0-9]{20,}/gi,             // Stripe live keys
  /sk_test_[A-Za-z0-9]{20,}/gi,             // Stripe test keys
  /ghp_[A-Za-z0-9]{20,}/gi,                 // GitHub PATs
  /pplx-[A-Za-z0-9]{20,}/gi,               // Perplexity keys
  /price_[A-Za-z0-9]{10,}/gi,              // Stripe price IDs
  /prod_[A-Za-z0-9]{10,}/gi,               // Stripe product IDs
  /MTQ[A-Za-z0-9._-]{40,}/gi,              // Discord bot tokens
  /[A-Za-z0-9]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/g, // Discord tokens general

  // Internal code patterns — function/variable names from source
  /selfDestructExecute/gi,
  /selfDestructTrigger/gi,
  /selfDestructArmed/gi,
  /stopWatchdog/gi,
  /removePersistence/gi,
  /lockdownKeepAlive/gi,
  /startWatchdog/gi,
  /overlayWin/gi,
  /settingsWin/gi,
  /AXVisualSupportAgent/gi,
  /SecurityHealthService/gi,
  /electron-store/gi,
  /desktopCapturer/gi,
  /setIgnoreMouseEvents/gi,
  /BrowserWindow/gi,
  /globalShortcut/gi,

  // File paths & internal structure
  /main\.js/gi,
  /preload\.js/gi,
  /overlay\.html/gi,
  /settings\.html/gi,
  /src\/main/gi,
  /src\/overlay/gi,
  /src\/preload/gi,
  /src\/settings/gi,
  /svc\.vbs/gi,
  /ZapPersistence/gi,

  // Repo & infrastructure
  /Salt30\/Zap/gi,                          // GitHub repo path (beyond download URL)
  /github\.com\/Salt30/gi,                  // GitHub org (allow releases URL though)
  /ZAP-ADMIN-MASTER/gi,
  /ZAP-OWNER-ARHAAN/gi,
  /arhaand30@gmail\.com/g,                  // Owner email (only share for cancellation)

  // Technical implementation details
  /z-order\s*(level\s*)?99/gi,
  /screensaver\s*level/gi,
  /wscript\.exe/gi,
  /schtasks\s*\/create/gi,
  /launchd/gi,
  /LaunchAgent/gi,
  /SIGTERM/gi,
  /SIGHUP/gi,
  /Win32_Process/gi,
  /cimv2/gi,
  /ping\s*-n\s*\d+\s*127\.0\.0\.1/gi,
  /taskkill\s*\/f/gi,
];

// Whitelisted phrases that contain blocked words but are safe
const WHITELIST = [
  'https://github.com/Salt30/Zap/releases', // Download URL is fine
  'email arhaand30@gmail.com',              // Cancellation instruction is fine
];

function sanitizeOutput(text) {
  if (!text) return text;
  let sanitized = text;
  let leaked = false;

  for (const pattern of BLOCKED_PATTERNS) {
    // Reset regex lastIndex
    pattern.lastIndex = 0;
    if (pattern.test(sanitized)) {
      // Check whitelist before blocking
      const isWhitelisted = WHITELIST.some(safe => sanitized.includes(safe) &&
        sanitized.match(pattern)?.[0] && safe.includes(sanitized.match(pattern)[0]));
      if (!isWhitelisted) {
        pattern.lastIndex = 0;
        sanitized = sanitized.replace(pattern, '[redacted]');
        leaked = true;
      }
    }
  }

  if (leaked) {
    console.warn('[SECURITY] Blocked sensitive info from being sent to Discord');
  }

  return sanitized;
}

// Wrapper for safe message sending
async function safeSend(target, content, options = {}) {
  if (typeof content === 'string') {
    content = sanitizeOutput(content);
  }
  if (options.embeds) {
    options.embeds = options.embeds.map(embed => {
      if (embed.data?.description) embed.data.description = sanitizeOutput(embed.data.description);
      return embed;
    });
  }
  return target.send ? target.send({ content, ...options }) : target.reply({ content, ...options });
}

async function safeReply(message, content) {
  return message.reply(sanitizeOutput(content));
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Message, Partials.Channel],
});

// ── Data Files ──
const RECS_FILE = path.join(__dirname, 'recommendations.json');
const BUGS_FILE = path.join(__dirname, 'bugs.json');

function loadJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    if (err.code !== 'ENOENT') { // Don't log "file not found" — that's expected on first run
      errorTracker.log(ErrorType.FILE_IO, `Failed to read ${path.basename(file)}`, err);
    }
    return [];
  }
}
function saveJSON(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (err) {
    errorTracker.log(ErrorType.FILE_IO, `Failed to write ${path.basename(file)}`, err);
    errorTracker.alertOwner(ErrorType.FILE_IO, `Cannot save ${path.basename(file)} — data may be lost. Check disk space/permissions.`, client);
  }
}

// ── Conversation history per channel (last 20 messages for context) ──
const conversationCache = new Map();
function getHistory(channelId) {
  if (!conversationCache.has(channelId)) conversationCache.set(channelId, []);
  return conversationCache.get(channelId);
}
function addToHistory(channelId, role, content) {
  const h = getHistory(channelId);
  h.push({ role, content });
  if (h.length > 20) h.splice(0, h.length - 20);
}

// ══════════════════════════════════════════════════════════════
//  THINKING ENGINE — reason before responding
// ══════════════════════════════════════════════════════════════

async function think(userMessage, context = '') {
  const thinkPrompt = `You are ZapBot's internal reasoning engine. Your job is to THINK before responding.

Given this user message and context, produce a brief internal analysis:
1. What is the user actually asking/needing?
2. Is this a support issue, feature request, bug report, or general chat?
3. If it's a bug: could this be a user-side issue (wrong settings, outdated version, their computer) or a real Zap bug?
4. What's the best way to help them?
5. What information from the knowledge base is most relevant?

Be concise — this is internal reasoning, not the final response.

Context: ${context}`;

  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: thinkPrompt },
        { role: 'user', content: userMessage },
      ],
      max_tokens: 300,
      temperature: 0.3,
    });
    return res.choices[0]?.message?.content || '';
  } catch (err) {
    errorTracker.log(ErrorType.OPENAI, 'Think engine failed', err);
    return ''; // Non-critical — bot can still respond without thinking
  }
}

// ══════════════════════════════════════════════════════════════
//  INPUT SANITIZATION — prevent prompt injection & abuse
// ══════════════════════════════════════════════════════════════
const MAX_INPUT_LENGTH = 2000; // Discord max is 2000 anyway

function sanitizeInput(text) {
  if (!text) return '';
  // Truncate overly long messages
  let clean = text.slice(0, MAX_INPUT_LENGTH);
  // Strip common prompt injection patterns
  const injectionPatterns = [
    /ignore (?:all )?(?:previous |above |prior )?instructions/gi,
    /you are now/gi,
    /new system prompt/gi,
    /\[SYSTEM\]/gi,
    /\[ADMIN\]/gi,
    /reveal (?:your )?(?:system )?prompt/gi,
    /what (?:is|are) your (?:system )?(?:prompt|instructions)/gi,
    /pretend you(?:'re| are)/gi,
    /act as (?:if you(?:'re| are)|a)/gi,
    /disregard (?:all )?(?:previous )?/gi,
  ];
  for (const pat of injectionPatterns) {
    if (pat.test(clean)) {
      console.warn(`[SECURITY] Prompt injection attempt detected: "${clean.slice(0, 100)}"`);
      // Don't block — just log. The AI system prompt is hardened enough.
    }
  }
  return clean;
}

// ══════════════════════════════════════════════════════════════
//  SMART AI RESPONSE — uses thinking + knowledge
// ══════════════════════════════════════════════════════════════

async function getAIResponse(userMessage, channelId, context = '', userId = null) {
  // ── Sanitize input ──
  userMessage = sanitizeInput(userMessage);

  // ── Rate limit check ──
  if (userId && !rateLimiter.check(userId)) {
    return "⚡ You're sending messages a bit too fast! Please wait a few minutes and try again. (Limit: 30 requests/hour)";
  }
  if (!userId && !rateLimiter.check('anonymous')) {
    return "⚡ The bot is experiencing high traffic right now. Please try again in a few minutes.";
  }

  const history = getHistory(channelId);

  // Think first
  const thinking = await think(userMessage, context);

  const systemPrompt = KNOWLEDGE + `\n\nADDITIONAL CONTEXT:\n${context}` +
    (thinking ? `\n\nYOUR INTERNAL ANALYSIS (use this to craft a better response, but don't share your reasoning process with the user):\n${thinking}` : '');

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-10),
    { role: 'user', content: userMessage },
  ];

  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      max_tokens: 1000,
      temperature: 0.7,
    });
    const reply = res.choices[0]?.message?.content || "Sorry, I couldn't process that. Let me flag this to the team.";
    addToHistory(channelId, 'user', userMessage);
    addToHistory(channelId, 'assistant', reply);
    return reply;
  } catch (err) {
    return handleOpenAIError(err, 'getAIResponse');
  }
}

// ══════════════════════════════════════════════════════════════
//  MESSAGE CLASSIFICATION — smarter multi-label
// ══════════════════════════════════════════════════════════════

async function classifyMessage(text) {
  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: `Classify this Discord message about Zap (an exam helper app). Reply with ONLY one word:
- "bug" if the user is reporting something broken, not working, crashing, or behaving unexpectedly
- "feature" if the user is suggesting a new feature, improvement, or change
- "support" if the user needs help using Zap, has a question, or needs troubleshooting
- "chat" if it's general conversation, greeting, or off-topic` },
        { role: 'user', content: text },
      ],
      max_tokens: 10,
      temperature: 0,
    });
    return (res.choices[0]?.message?.content || 'chat').trim().toLowerCase();
  } catch (err) {
    errorTracker.log(ErrorType.OPENAI, 'Message classification failed', err);
    return 'chat'; // Fallback to chat — still respond to user
  }
}

// ══════════════════════════════════════════════════════════════
//  BUG TRIAGE — smart escalation logic
// ══════════════════════════════════════════════════════════════

// Bug tracker: { description, reporters: [{userId, username, timestamp}], status, escalated }
function findSimilarBug(description) {
  const bugs = loadJSON(BUGS_FILE);
  // Simple keyword matching — check if >40% of words overlap with an existing bug
  const words = description.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  for (const bug of bugs) {
    const bugWords = bug.description.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const overlap = words.filter(w => bugWords.includes(w)).length;
    const similarity = overlap / Math.max(words.length, 1);
    if (similarity > 0.4) return bug;
  }
  return null;
}

async function handleBugReport(message, text) {
  try {
  const bugs = loadJSON(BUGS_FILE);
  const description = text || message.content;

  // Think about whether this is really a bug or user error
  const analysis = await think(description, `This is reported as a bug. Common user-side causes: wrong version, stealth mode not enabled, wrong settings, bad internet, incorrect hotkeys. Think critically about whether this is a real Zap bug or something the user can fix on their end.`);

  // Check for similar existing bugs
  const existingBug = findSimilarBug(description);

  if (existingBug) {
    // Someone else reported this too — add reporter
    const alreadyReported = existingBug.reporters.some(r => r.userId === message.author.id);
    if (!alreadyReported) {
      existingBug.reporters.push({
        userId: message.author.id,
        username: message.author.username,
        timestamp: new Date().toISOString(),
      });
      saveJSON(BUGS_FILE, bugs);
    }

    const reporterCount = existingBug.reporters.length;

    // Multiple people reporting same issue — escalate to owner
    if (reporterCount >= 2 && !existingBug.escalated) {
      existingBug.escalated = true;
      existingBug.status = 'escalated';
      saveJSON(BUGS_FILE, bugs);

      // DM owner with escalation
      if (OWNER_ID) {
        try {
          const owner = await client.users.fetch(OWNER_ID);
          const reporterList = existingBug.reporters.map(r => `@${r.username}`).join(', ');
          await owner.send(
            `🚨 **Bug Escalation — ${reporterCount} users affected**\n\n` +
            `**Bug:** ${existingBug.description.slice(0, 500)}\n` +
            `**Reporters:** ${reporterList}\n` +
            `**First reported:** ${existingBug.reporters[0].timestamp}\n\n` +
            `Multiple users are experiencing this — likely a real bug, not user error. Consider pushing a fix.`
          );
        } catch (err) { console.error('[OWNER DM]', err.message); }
      }

      // Respond to user
      const context = `This bug has been reported by ${reporterCount} users now. It's been escalated to the dev team as a likely real bug. Acknowledge the issue, let them know others are affected too and the team is on it. Also provide any troubleshooting that might help in the meantime.`;
      await message.channel.sendTyping();
      const reply = await getAIResponse(description, message.channel.id, context, message.author.id);
      await safeReply(message, reply);
      return;
    }

    // Same person or only 1 reporter — troubleshoot first
    const context = `This bug was reported before but only by ${reporterCount} user(s). It might be a user-side issue. Your internal analysis: ${analysis}\n\nTroubleshoot first — ask about their version, OS, settings, whether stealth mode is on, etc. Don't assume it's a Zap bug yet.`;
    await message.channel.sendTyping();
    const reply = await getAIResponse(description, message.channel.id, context, message.author.id);
    await safeReply(message, reply);
    return;
  }

  // New bug — log it and troubleshoot first (don't escalate yet)
  const newBug = {
    id: Date.now(),
    description: description.slice(0, 1000),
    reporters: [{
      userId: message.author.id,
      username: message.author.username,
      timestamp: new Date().toISOString(),
    }],
    channel: message.channel.name || 'DM',
    status: 'investigating',
    escalated: false,
  };
  bugs.push(newBug);
  saveJSON(BUGS_FILE, bugs);

  console.log(`[BUG] New bug #${newBug.id} from @${message.author.username}: ${description.slice(0, 100)}`);

  // Respond with troubleshooting — assume user error first
  const context = `New bug report — first time seeing this issue. Your internal analysis: ${analysis}\n\nThis is the FIRST report of this issue, so it's likely a user-side problem. Troubleshoot thoroughly: ask about version (must be v3.23.2), OS, whether stealth mode is enabled, their settings, internet connection, etc. Be helpful but don't assume Zap is broken. If they confirm everything is correct, say you'll escalate to the team.`;
  await message.channel.sendTyping();
  const reply = await getAIResponse(description, message.channel.id, context, message.author.id);
  await safeReply(message, reply);

  // Notify owner (informational, not urgent)
  if (OWNER_ID) {
    try {
      const owner = await client.users.fetch(OWNER_ID);
      await owner.send(
        `🐛 **New bug report** from @${message.author.username} in #${message.channel.name || 'DM'}:\n` +
        `> ${description.slice(0, 500)}\n\n` +
        `_First report of this issue. Bot is troubleshooting — will escalate if more users report the same thing._`
      );
    } catch (_) {}
  }
  } catch (err) {
    errorTracker.log(ErrorType.DISCORD, 'Bug report handler failed', err);
    try { await message.reply("I ran into an issue processing your bug report. Don't worry — try again or a team member will help you shortly."); } catch (_) {}
  }
}

// ══════════════════════════════════════════════════════════════
//  RECOMMENDATIONS — with thinking + owner approval
// ══════════════════════════════════════════════════════════════

async function handleRecommendation(message, text) {
  try {
  const description = text || message.content;

  // Think about the recommendation
  const analysis = await think(description, `This is a feature request/recommendation. Think about: Is this feasible? Does Zap already have this feature? Is it a good idea? Would it conflict with existing features? Is it something many users would want?`);

  const rec = {
    id: Date.now(),
    user: message.author.username,
    userId: message.author.id,
    channel: message.channel.name || 'DM',
    text: description,
    analysis: analysis, // Store the AI's analysis
    timestamp: new Date().toISOString(),
    status: 'pending_review', // Needs owner approval
    ownerDecision: null, // 'approved', 'rejected', 'deferred'
  };

  const recs = loadJSON(RECS_FILE);
  recs.push(rec);
  saveJSON(RECS_FILE, recs);

  // DM the owner with approval buttons (no public posting — keep recommendations private)
  if (OWNER_ID) {
    try {
      const owner = await client.users.fetch(OWNER_ID);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`rec_approve_${rec.id}`)
          .setLabel('✅ Approve')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`rec_defer_${rec.id}`)
          .setLabel('🕐 Later')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`rec_reject_${rec.id}`)
          .setLabel('❌ Reject')
          .setStyle(ButtonStyle.Danger),
      );

      let dmContent = `📬 **New Feature Request** from @${rec.user}:\n> ${description.slice(0, 500)}\n`;
      if (analysis) {
        dmContent += `\n🤖 **ZapBot's take:**\n${analysis.slice(0, 500)}\n`;
      }
      dmContent += `\n**Your call — approve, defer, or reject?**`;

      await owner.send({ content: dmContent, components: [row] });
    } catch (err) { console.error('[OWNER DM]', err.message); }
  }

  // Respond to the user — thoughtful response based on analysis
  const responseContext = `The user suggested this feature: "${description}". Your analysis: ${analysis}\n\nRespond to the user: thank them for the idea, briefly share whether it aligns with Zap's direction (based on your analysis), and let them know it's been sent to the team for review. Don't promise it will be built — say the team will review it.`;
  await message.channel.sendTyping();
  const reply = await getAIResponse(description, message.channel.id, responseContext, message.author.id);
  await safeReply(message, reply);
  } catch (err) {
    errorTracker.log(ErrorType.DISCORD, 'Recommendation handler failed', err);
    try { await message.reply("Thanks for the suggestion! I had a small issue logging it, but the team will see it."); } catch (_) {}
  }
}

// ══════════════════════════════════════════════════════════════
//  AUTO-IMPLEMENTATION ENGINE
//  Uses GPT-4o to analyze codebase, write changes, create GitHub PR
// ══════════════════════════════════════════════════════════════

async function autoImplementFeature(rec, interaction) {
  const owner = await client.users.fetch(OWNER_ID);

  try {
    await owner.send(`⚙️ **Auto-implementing:** "${rec.text.slice(0, 200)}"\n\n_Reading codebase, planning changes..._`);

    // Step 1: Fetch the key source files from GitHub
    const filesToRead = ['src/main.js', 'src/overlay.html', 'src/preload.js', 'src/settings.html', 'package.json'];
    const fileContents = {};

    for (const filePath of filesToRead) {
      try {
        const data = await githubAPI(`/contents/${filePath}?ref=main`);
        fileContents[filePath] = Buffer.from(data.content, 'base64').toString('utf-8');
      } catch (err) {
        console.log(`[IMPL] Couldn't read ${filePath}: ${err.message}`);
      }
    }

    if (Object.keys(fileContents).length === 0) {
      await owner.send(`❌ **Implementation failed** — couldn't read any source files from GitHub. Check the PAT permissions.`);
      return;
    }

    // Step 2: Build a summary of the codebase (don't send full files — too big for context)
    const codeSummary = Object.entries(fileContents).map(([file, content]) => {
      // Send first 200 lines of each file to keep context manageable
      const lines = content.split('\n').slice(0, 200).join('\n');
      return `=== ${file} (first 200 lines) ===\n${lines}`;
    }).join('\n\n');

    // Step 3: Ask GPT-4o to plan the implementation
    const planResponse = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: `You are a senior Electron/Node.js developer working on Zap — a desktop overlay app built with Electron. You're implementing a feature request.

Your job is to:
1. Analyze the feature request
2. Look at the current codebase
3. Plan exactly which files need changes and what changes to make
4. Write the COMPLETE modified sections of code (not just diffs — full replacement blocks)

IMPORTANT RULES:
- Only modify existing files — don't create new files unless absolutely necessary
- Keep changes minimal and focused — don't refactor unrelated code
- Maintain the existing code style (no semicolons where there aren't any, etc.)
- Make sure the changes are complete and won't break existing functionality
- Return your response as a JSON object

Return ONLY a valid JSON object (no markdown, no code fences) with this structure:
{
  "summary": "Brief description of what you're changing",
  "changes": [
    {
      "file": "src/main.js",
      "description": "What's changing in this file",
      "search": "exact string to find in the file (must be unique, 3-10 lines of existing code)",
      "replace": "the replacement code"
    }
  ],
  "newFiles": [
    {
      "file": "path/to/new/file.js",
      "content": "full file content"
    }
  ]
}

If the feature is too vague, too complex, or would require major architectural changes, return:
{
  "summary": "explanation of why this can't be auto-implemented",
  "changes": [],
  "tooComplex": true
}` },
        { role: 'user', content: `FEATURE REQUEST: ${rec.text}\n\nAI ANALYSIS: ${rec.analysis || 'none'}\n\nCURRENT CODEBASE:\n${codeSummary}` },
      ],
      max_tokens: 4000,
      temperature: 0.3,
    });

    let plan;
    try {
      const raw = planResponse.choices[0]?.message?.content || '';
      // Strip markdown fences if present
      const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      plan = JSON.parse(cleaned);
    } catch (parseErr) {
      await owner.send(`❌ **Implementation failed** — AI couldn't generate a valid plan.\n\`\`\`\n${planResponse.choices[0]?.message?.content?.slice(0, 500)}\n\`\`\``);
      return;
    }

    if (plan.tooComplex) {
      await owner.send(`⚠️ **Too complex for auto-implementation:**\n${plan.summary}\n\nYou'll need to implement this one manually.`);
      return;
    }

    if (!plan.changes || plan.changes.length === 0) {
      await owner.send(`⚠️ **No changes generated.** The AI couldn't determine what to modify. Try rephrasing the feature request.`);
      return;
    }

    // Step 4: Send plan to owner for review before touching code
    let planMsg = `📋 **Implementation Plan for:** "${rec.text.slice(0, 100)}"\n\n`;
    planMsg += `**Summary:** ${plan.summary}\n\n`;
    planMsg += `**Files to modify:**\n`;
    for (const change of plan.changes) {
      planMsg += `• \`${change.file}\` — ${change.description}\n`;
    }
    if (plan.newFiles?.length) {
      planMsg += `\n**New files:**\n`;
      for (const nf of plan.newFiles) {
        planMsg += `• \`${nf.file}\`\n`;
      }
    }

    const implRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`impl_execute_${rec.id}`)
        .setLabel('🚀 Create PR')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`impl_cancel_${rec.id}`)
        .setLabel('❌ Cancel')
        .setStyle(ButtonStyle.Danger),
    );

    // Store the plan for later execution
    const plansFile = path.join(__dirname, 'plans.json');
    const plans = loadJSON(plansFile);
    plans.push({ recId: rec.id, plan, timestamp: new Date().toISOString() });
    saveJSON(plansFile, plans);

    await owner.send({ content: planMsg, components: [implRow] });

  } catch (err) {
    console.error('[AUTO-IMPL ERROR]', err);
    await owner.send(`❌ **Implementation error:** ${err.message?.slice(0, 300)}`);
  }
}

// Execute the plan — create branch, apply changes, open PR
async function executePlan(recId) {
  const plansFile = path.join(__dirname, 'plans.json');
  const plans = loadJSON(plansFile);
  const planEntry = plans.find(p => p.recId === parseInt(recId));
  if (!planEntry) throw new Error('Plan not found');

  const plan = planEntry.plan;
  const recs = loadJSON(RECS_FILE);
  const rec = recs.find(r => r.id === parseInt(recId));
  const branchName = `zapbot/feature-${recId}`;

  // 1. Get the latest commit SHA on main
  const mainRef = await githubAPI('/git/ref/heads/main');
  const baseSha = mainRef.object.sha;

  // 2. Create a new branch
  await githubAPI('/git/refs', 'POST', {
    ref: `refs/heads/${branchName}`,
    sha: baseSha,
  });

  // 3. Apply each file change
  for (const change of plan.changes) {
    // Get current file content
    let fileData;
    try {
      fileData = await githubAPI(`/contents/${change.file}?ref=${branchName}`);
    } catch (_) {
      console.error(`[IMPL] File not found: ${change.file}`);
      continue;
    }

    let content = Buffer.from(fileData.content, 'base64').toString('utf-8');

    // Apply the search/replace
    if (change.search && content.includes(change.search)) {
      content = content.replace(change.search, change.replace);
    } else if (change.search) {
      console.warn(`[IMPL] Search string not found in ${change.file}, skipping`);
      continue;
    }

    // Commit the change
    await githubAPI(`/contents/${change.file}`, 'PUT', {
      message: `feat: ${change.description} [ZapBot auto-impl]`,
      content: Buffer.from(content).toString('base64'),
      sha: fileData.sha,
      branch: branchName,
    });
  }

  // 4. Create any new files
  if (plan.newFiles) {
    for (const nf of plan.newFiles) {
      await githubAPI(`/contents/${nf.file}`, 'PUT', {
        message: `feat: add ${nf.file} [ZapBot auto-impl]`,
        content: Buffer.from(nf.content).toString('base64'),
        branch: branchName,
      });
    }
  }

  // 5. Create a draft PR
  const pr = await githubAPI('/pulls', 'POST', {
    title: `[ZapBot] ${plan.summary.slice(0, 60)}`,
    head: branchName,
    base: 'main',
    body: `## Auto-Implemented Feature\n\n**Requested by:** @${rec?.user || 'unknown'}\n**Request:** ${rec?.text?.slice(0, 300) || 'N/A'}\n\n**Changes:**\n${plan.changes.map(c => `- \`${c.file}\`: ${c.description}`).join('\n')}\n${plan.newFiles?.length ? `\n**New files:**\n${plan.newFiles.map(f => `- \`${f.file}\``).join('\n')}` : ''}\n\n---\n🤖 *Auto-implemented by ZapBot. Review carefully before merging.*`,
    draft: true,
  });

  return pr;
}

// ── Handle owner approval button clicks ──
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  if (interaction.user.id !== OWNER_ID) {
    await interaction.reply({ content: "Only the owner can approve/reject features.", ephemeral: true });
    return;
  }

  const parts = interaction.customId.split('_');
  const action = parts[0];
  const type = parts[1];
  const recId = parts.slice(2).join('_'); // handles IDs with underscores

  // Handle implementation execution/cancel buttons
  if (action === 'impl') {
    if (type === 'execute') {
      await interaction.update({ content: interaction.message.content + '\n\n🚀 **Creating PR...** This may take a minute.', components: [] });
      try {
        const pr = await executePlan(recId);
        const owner = await client.users.fetch(OWNER_ID);
        await owner.send(
          `✅ **PR Created!**\n\n` +
          `**${pr.title}**\n` +
          `${pr.html_url}\n\n` +
          `It's a draft PR — review the changes, then merge when you're happy. ` +
          `After merging, bump the version, build, and release as usual.`
        );

        // Update rec status
        const recs = loadJSON(RECS_FILE);
        const rec = recs.find(r => r.id === parseInt(recId));
        if (rec) {
          rec.status = 'pr_created';
          rec.prUrl = pr.html_url;
          saveJSON(RECS_FILE, recs);
        }
      } catch (err) {
        console.error('[IMPL EXECUTE]', err);
        const owner = await client.users.fetch(OWNER_ID);
        await owner.send(`❌ **PR creation failed:** ${err.message?.slice(0, 500)}\n\nYou may need to implement this one manually.`);
      }
      return;
    }

    if (type === 'cancel') {
      await interaction.update({ content: interaction.message.content + '\n\n❌ **Implementation cancelled.** Feature stays approved but won\'t be auto-implemented.', components: [] });
      return;
    }
  }

  if (action !== 'rec') return;

  const recs = loadJSON(RECS_FILE);
  const rec = recs.find(r => r.id === parseInt(recId));
  if (!rec) {
    await interaction.reply({ content: "Couldn't find that recommendation.", ephemeral: true });
    return;
  }

  if (type === 'approve') {
    rec.status = 'approved';
    rec.ownerDecision = 'approved';
    rec.decidedAt = new Date().toISOString();
    saveJSON(RECS_FILE, recs);

    await interaction.update({ content: interaction.message.content + '\n\n✅ **APPROVED** — Starting auto-implementation...', components: [] });

    // Notify the user who suggested it
    try {
      const user = await client.users.fetch(rec.userId);
      await user.send(`🎉 Great news! Your feature suggestion was **approved** by the Zap team:\n> ${rec.text.slice(0, 300)}\n\nWe're working on implementing it now!`);
    } catch (_) {}

    // Kick off auto-implementation
    autoImplementFeature(rec, interaction).catch(err => {
      console.error('[AUTO-IMPL]', err);
    });

  } else if (type === 'defer') {
    rec.status = 'deferred';
    rec.ownerDecision = 'deferred';
    rec.decidedAt = new Date().toISOString();
    saveJSON(RECS_FILE, recs);

    await interaction.update({ content: interaction.message.content + '\n\n🕐 **DEFERRED** — Will revisit later.', components: [] });

  } else if (type === 'reject') {
    rec.status = 'rejected';
    rec.ownerDecision = 'rejected';
    rec.decidedAt = new Date().toISOString();
    saveJSON(RECS_FILE, recs);

    await interaction.update({ content: interaction.message.content + '\n\n❌ **REJECTED** — Not pursuing this.', components: [] });
  }
});

// ══════════════════════════════════════════════════════════════
//  CHANNEL HANDLERS
// ══════════════════════════════════════════════════════════════

// ── Handle ticket channels (ticket-XXXX) ──
async function handleTicket(message) {
  try {
    const userMsg = message.content;
    const context = `This is support ticket channel: ${message.channel.name}. The user needs help with Zap. Be thorough, ask diagnostic questions if needed (version, OS, settings), and provide step-by-step solutions.`;

    await message.channel.sendTyping().catch(() => {}); // sendTyping can fail silently
    const reply = await getAIResponse(userMsg, message.channel.id, context, message.author.id);

    const safeReplyText = sanitizeOutput(reply);
    if (safeReplyText.length > 1900) {
      const parts = safeReplyText.match(/.{1,1900}/gs);
      for (const part of parts) await message.channel.send(part);
    } else {
      await message.channel.send(safeReplyText);
    }
  } catch (err) {
    const errType = handleDiscordError(err, 'handleTicket');
    if (errType === 'missing_permissions' || errType === 'missing_access') {
      errorTracker.alertOwner(ErrorType.DISCORD, `Bot can't respond in #${message.channel.name} — missing permissions. Check the channel settings.`, client);
    } else {
      try { await message.react('⚠️'); } catch (_) {} // Visual indicator something went wrong
    }
  }
}

// ── Handle @zapbot mentions ──
async function handleMention(message) {
  try {
    const cleanMsg = message.content.replace(/<@!?\d+>/g, '').trim();
    if (!cleanMsg) {
      await message.reply("Hey! Ask me anything about Zap — troubleshooting, features, pricing, you name it. 🚀");
      return;
    }

    await message.channel.sendTyping().catch(() => {});
    const type = await classifyMessage(cleanMsg);

    if (type === 'feature') {
      await handleRecommendation(message, cleanMsg);
      return;
    }

    if (type === 'bug') {
      await handleBugReport(message, cleanMsg);
      return;
    }

    const context = `User @${message.author.username} mentioned the bot in #${message.channel.name}. Type classified as: ${type}. Respond helpfully and concisely.`;
    const reply = await getAIResponse(cleanMsg, message.channel.id, context, message.author.id);

    const safeText = sanitizeOutput(reply);
    if (safeText.length > 1900) {
      const parts = safeText.match(/.{1,1900}/gs);
      for (const part of parts) await safeReply(message, part);
    } else {
      await safeReply(message, reply);
    }
  } catch (err) {
    handleDiscordError(err, 'handleMention');
    try { await message.reply("Sorry, something went wrong on my end. Try again in a moment!"); } catch (_) {}
  }
}

// ── Handle #recommendations — SILENT: no replies, just DM owner ──
async function handleRecommendationSilent(message) {
  const description = message.content;
  const analysis = await think(description, `This is a feature request/recommendation. Think about: Is this feasible? Does Zap already have this feature? Is it a good idea?`);

  const rec = {
    id: Date.now(),
    user: message.author.username,
    userId: message.author.id,
    channel: message.channel.name || 'DM',
    text: description,
    analysis: analysis,
    timestamp: new Date().toISOString(),
    status: 'pending_review',
    ownerDecision: null,
  };

  const recs = loadJSON(RECS_FILE);
  recs.push(rec);
  saveJSON(RECS_FILE, recs);

  console.log(`[REC] Silent pickup from @${rec.user}: ${description.slice(0, 100)}`);

  // DM the owner with approval buttons — NO channel reply
  if (OWNER_ID) {
    try {
      const owner = await client.users.fetch(OWNER_ID);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`rec_approve_${rec.id}`)
          .setLabel('✅ Approve')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`rec_defer_${rec.id}`)
          .setLabel('🕐 Later')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`rec_reject_${rec.id}`)
          .setLabel('❌ Reject')
          .setStyle(ButtonStyle.Danger),
      );

      let dmContent = `📬 **New Recommendation** from @${rec.user} in #recommendations:\n> ${description.slice(0, 500)}\n`;
      if (analysis) {
        dmContent += `\n🤖 **ZapBot's take:**\n${analysis.slice(0, 500)}\n`;
      }
      dmContent += `\n**Your call — approve, defer, or reject?**`;

      await owner.send({ content: dmContent, components: [row] });
    } catch (err) { console.error('[OWNER DM]', err.message); }
  }
  // Intentionally NO reply to the channel
}

// ── Handle #bug-reports channel ──
async function handleFeedbackChannel(message) {
  const type = await classifyMessage(message.content);

  if (type === 'feature') {
    await handleRecommendation(message, message.content);
  } else if (type === 'bug') {
    await handleBugReport(message, message.content);
  } else {
    // General question in feedback channel — answer with context
    const context = `This is the ${message.channel.name} channel. Respond helpfully.`;
    await message.channel.sendTyping();
    const reply = await getAIResponse(message.content, message.channel.id, context, message.author.id);
    await safeReply(message, reply);
  }
}

// ══════════════════════════════════════════════════════════════
//  MAIN MESSAGE HANDLER
// ══════════════════════════════════════════════════════════════

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  console.log(`[MSG] #${message.channel.name || 'DM'} @${message.author.username}: ${message.content.slice(0, 100)}`);

  try {
    const channelName = message.channel.name || '';
    const isMentioned = message.mentions.has(client.user);

    // ── #recommendations — silently read and DM owner only (NEVER reply in channel) ──
    if (channelName === 'recommendations') {
      await handleRecommendationSilent(message);
      return;
    }

    // ── DMs — always respond (this is direct support) ──
    if (message.channel.type === ChannelType.DM) {
      try {
        await message.channel.sendTyping().catch(() => {});
        const context = 'This is a private DM. The user wants help. Be extra helpful and thorough.';
        const reply = await getAIResponse(message.content, message.channel.id, context, message.author.id);
        await message.channel.send(sanitizeOutput(reply));
      } catch (err) {
        errorTracker.log(ErrorType.DISCORD, `DM handler error for @${message.author.username}`, err);
        try { await message.channel.send("Sorry, I'm having trouble right now. Try again in a moment or reach out in the Discord server for help!"); } catch (_) {}
      }
      return;
    }

    // ══════════════════════════════════════════════════════════════
    //  @MENTION GATE — Bot only responds when explicitly @mentioned
    //  This prevents spammy auto-replies to every message.
    //  Exception: DMs (above) and #recommendations (silent read).
    // ══════════════════════════════════════════════════════════════
    if (!isMentioned) return;

    // ── Ticket channels — respond to @mention in ticket ──
    if (channelName.startsWith('ticket-')) {
      await handleTicket(message);
      return;
    }

    // ── #bug-reports — smart routing (only when @mentioned) ──
    if (channelName === 'bug-reports') {
      await handleFeedbackChannel(message);
      return;
    }

    // ── @zapbot mentions anywhere else — general help ──
    await handleMention(message);

  } catch (err) {
    errorTracker.log(ErrorType.DISCORD, `Message handler error in #${message.channel?.name || 'DM'} from @${message.author?.username || 'unknown'}`, err);

    // Try to give the user a helpful response
    try {
      if (err.message?.includes('Missing Access') || err.message?.includes('Missing Permissions')) {
        errorTracker.alertOwner(ErrorType.DISCORD, `Bot missing permissions in #${message.channel?.name}. Cannot respond to users there.`, client);
      } else if (err.message?.includes('rate limit') || err.status === 429) {
        await message.reply("I'm getting a lot of messages right now — give me a sec and try again!").catch(() => {});
      } else {
        await message.react('⚠️').catch(() => {}); // Visual indicator without being spammy
      }
    } catch (_) { /* Can't even react — permissions issue, already logged */ }
  }
});

// ══════════════════════════════════════════════════════════════
//  AUTOMATED RELEASE ANNOUNCEMENTS
//  Polls Salt30/zap-releases for new versions, posts to #announcements
//  Matches the owner's announcement style with emoji headers
// ══════════════════════════════════════════════════════════════

const LAST_ANNOUNCED_FILE = path.join(__dirname, 'last_announced_version.txt');

function getLastAnnouncedVersion() {
  try { return fs.readFileSync(LAST_ANNOUNCED_FILE, 'utf-8').trim(); } catch (_) { return ''; }
}

function setLastAnnouncedVersion(version) {
  fs.writeFileSync(LAST_ANNOUNCED_FILE, version);
}

async function checkForNewRelease() {
  try {
    // Fetch latest release from public repo (no auth needed, but use PAT for rate limits)
    const res = await fetch(`https://api.github.com/repos/${PUBLIC_REPO}/releases/latest`, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'ZapBot',
        ...(GITHUB_PAT ? { 'Authorization': `token ${GITHUB_PAT}` } : {}),
      },
    });

    if (!res.ok) {
      console.log(`[RELEASE CHECK] GitHub API returned ${res.status}`);
      return;
    }

    const release = await res.json();
    if (release.draft || release.prerelease) return;

    const version = release.tag_name; // e.g. "v3.23.5"
    const lastAnnounced = getLastAnnouncedVersion();

    if (version === lastAnnounced) return; // Already announced
    if (!lastAnnounced) {
      // First run — don't announce old releases, just record current
      console.log(`[RELEASE] First run — recording current version ${version}`);
      setLastAnnouncedVersion(version);
      return;
    }

    console.log(`[RELEASE] New version detected: ${version} (last announced: ${lastAnnounced})`);

    // Get the release notes body
    const releaseNotes = release.body || '';

    // Generate announcement using AI in the owner's style
    const announcement = await generateAnnouncement(version, releaseNotes);
    if (!announcement) {
      console.error('[RELEASE] Failed to generate announcement');
      return;
    }

    // Post to #announcements
    const channel = client.channels.cache.get(ANNOUNCEMENTS_CHANNEL);
    if (!channel) {
      console.error(`[RELEASE] Announcements channel ${ANNOUNCEMENTS_CHANNEL} not found`);
      return;
    }

    // Run through safety filter
    const safeAnnouncement = sanitizeOutput(announcement);

    // Send the announcement
    await channel.send(safeAnnouncement);
    console.log(`[RELEASE] Posted announcement for ${version} to #announcements`);

    // Record that we announced this version
    setLastAnnouncedVersion(version);

    // DM owner to confirm
    if (OWNER_ID) {
      try {
        const owner = await client.users.fetch(OWNER_ID);
        await owner.send(`📢 **Auto-posted** release announcement for **${version}** to #announcements.`);
      } catch (_) {}
    }

    // Auto-update bot code from GitHub and restart
    await selfUpdateBot(version);

  } catch (err) {
    console.error('[RELEASE CHECK ERROR]', err.message);
  }
}

// ── Self-update: pull latest bot files from GitHub, then exit (launchd restarts us) ──
async function selfUpdateBot(version) {
  console.log(`[AUTO-UPDATE] Pulling latest bot code from GitHub...`);
  try {
    const botFiles = ['index.js', 'knowledge.js'];
    const botRepo = 'Salt30/Zap'; // bot code lives in the main repo under ZapBot/
    let updated = false;

    for (const file of botFiles) {
      try {
        const res = await fetch(`https://api.github.com/repos/${botRepo}/contents/ZapBot/${file}?ref=main`, {
          headers: {
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'ZapBot',
            ...(GITHUB_PAT ? { 'Authorization': `token ${GITHUB_PAT}` } : {}),
          },
        });
        if (!res.ok) {
          console.log(`[AUTO-UPDATE] Could not fetch ${file}: ${res.status}`);
          continue;
        }
        const data = await res.json();
        const content = Buffer.from(data.content, 'base64').toString('utf-8');
        const localPath = path.join(__dirname, file);

        // Compare with current file
        let currentContent = '';
        try { currentContent = fs.readFileSync(localPath, 'utf-8'); } catch (_) {}

        if (content !== currentContent) {
          fs.writeFileSync(localPath, content);
          console.log(`[AUTO-UPDATE] Updated ${file}`);
          updated = true;
        } else {
          console.log(`[AUTO-UPDATE] ${file} already up to date`);
        }
      } catch (err) {
        console.error(`[AUTO-UPDATE] Error updating ${file}:`, err.message);
      }
    }

    if (updated) {
      console.log(`[AUTO-UPDATE] Bot code updated for ${version}. Restarting in 3 seconds...`);

      // DM owner about the restart
      if (OWNER_ID) {
        try {
          const owner = await client.users.fetch(OWNER_ID);
          await owner.send(`🔄 **ZapBot auto-updating** — pulled latest code for ${version}. Restarting now...`);
        } catch (_) {}
      }

      // Give Discord messages time to send, then exit
      // launchd (KeepAlive=true) will auto-restart us with the new code
      setTimeout(() => {
        console.log('[AUTO-UPDATE] Exiting for restart...');
        client.destroy();
        process.exit(0);
      }, 3000);
    } else {
      console.log(`[AUTO-UPDATE] No code changes detected — skipping restart`);
    }
  } catch (err) {
    console.error('[AUTO-UPDATE ERROR]', err.message);
  }
}

async function generateAnnouncement(version, releaseNotes) {
  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: `You write Discord release announcements for Zap — a desktop study/exam helper app.

STYLE RULES (match exactly):
- Start with: ⚡ **Zap ${version} — [Short catchy subtitle]**
- Next line: A 1-2 sentence hook about the update
- Then blank line
- Then feature/fix bullets, each formatted as:
  [emoji] **Feature Name**
  Description on the next line. Keep it 1-2 sentences, user-facing language. No technical jargon.
- Use varied relevant emojis for each bullet (🔒, 🎯, 📸, 🖥️, ⚡, 🛡️, 🔧, 🚀, etc.)
- End with blank line then @here

CRITICAL SAFETY RULES — NEVER include any of these:
- No GitHub links, repo names, or URLs (EXCEPT "tryzap.net" or "Update in Settings")
- No API keys, tokens, or credentials
- No internal code details (function names, file names, variable names)
- No technical implementation details (how stealth works internally, process names, etc.)
- No mentions of kernel drivers, watchdog scripts, WMI, launchd, VBS, etc.
- No internal infrastructure (GitHub Actions, CI/CD, artifact storage, etc.)
- Keep everything user-facing and non-technical
- For updates about technical fixes, describe the USER-VISIBLE SYMPTOM that was fixed, not the technical cause

TONE: Confident, concise, slightly hype but not cringe. Like a founder shipping fast.

EXAMPLE FORMAT:
⚡ **Zap v3.21.5 — Bug Fixes + New Features**
Big update — squashed some major bugs and added features you asked for.

🔒 **Respondus LockDown Browser Fixes**
Overlay no longer disappears after a minute. Zap now auto-recovers if Respondus tries to minimize, hide, or steal focus.

📸 **Multi-Capture**
Hit the + button to grab multiple screenshots before sending to AI. Study across tabs, capture them all — Zap sends every image at once for a complete answer.

@here` },
        { role: 'user', content: `Generate a Discord announcement for Zap ${version}.\n\nRelease notes:\n${releaseNotes}\n\nWrite the announcement now. Only output the announcement text, nothing else.` },
      ],
      max_tokens: 1000,
      temperature: 0.7,
    });

    return res.choices[0]?.message?.content || null;
  } catch (err) {
    console.error('[ANNOUNCEMENT AI ERROR]', err.message);
    return null;
  }
}

let releaseCheckInterval = null;

// ── Bot ready ──
client.on('ready', () => {
  console.log(`✅ ZapBot online as ${client.user.tag}`);
  console.log(`   Thinking engine: enabled`);
  console.log(`   Bug triage: enabled (escalate on 2+ reports)`);
  console.log(`   Recommendations: owner approval required`);
  console.log(`   Security filter: ${BLOCKED_PATTERNS.length} patterns active`);
  console.log(`   PR mode: enabled`);
  client.user.setPresence({
    activities: [{ name: 'Zap Support | @me for help', type: 3 }],
    status: 'online',
  });

  // Start release announcement polling (check every 5 minutes)
  console.log(`   Release announcements: enabled (polling every 5min)`);
  checkForNewRelease(); // Check immediately on startup
  releaseCheckInterval = setInterval(checkForNewRelease, 5 * 60 * 1000);
});

// ── Discord connection error handling ──
client.on('error', (err) => {
  errorTracker.log(ErrorType.DISCORD, 'Discord client error', err);
  errorTracker.alertOwner(ErrorType.DISCORD, `Discord client error: ${err.message}. Bot may reconnect automatically.`, client);
});

client.on('warn', (warning) => {
  console.warn('[DISCORD WARN]', warning);
});

client.on('shardDisconnect', (event, shardId) => {
  errorTracker.log(ErrorType.DISCORD, `Shard ${shardId} disconnected (code: ${event.code})`, { message: event.reason || 'No reason' });
});

client.on('shardReconnecting', (shardId) => {
  console.log(`[DISCORD] Shard ${shardId} reconnecting...`);
});

client.on('shardResume', (shardId) => {
  console.log(`[DISCORD] Shard ${shardId} resumed — back online`);
});

// ── Graceful shutdown ──
process.on('SIGINT', () => {
  console.log('[SHUTDOWN] SIGINT received — shutting down gracefully');
  if (releaseCheckInterval) clearInterval(releaseCheckInterval);
  client.destroy();
  process.exit(0);
});
process.on('SIGTERM', () => {
  console.log('[SHUTDOWN] SIGTERM received — shutting down gracefully');
  if (releaseCheckInterval) clearInterval(releaseCheckInterval);
  client.destroy();
  process.exit(0);
});

// ── Login with error handling ──
client.login(DISCORD_TOKEN).catch((err) => {
  errorTracker.log(ErrorType.STARTUP, 'Failed to login to Discord', err);

  if (err.code === 'TokenInvalid' || err.message?.includes('TOKEN_INVALID')) {
    console.error('\n╔════════════════════════════════════════════════╗');
    console.error('║  DISCORD TOKEN IS INVALID                      ║');
    console.error('║                                                ║');
    console.error('║  Go to discord.com/developers/applications     ║');
    console.error('║  → Your app → Bot → Reset Token                ║');
    console.error('║  Then update .env with the new token           ║');
    console.error('╚════════════════════════════════════════════════╝\n');
  } else if (err.code === 'DisallowedIntents') {
    console.error('\n╔════════════════════════════════════════════════╗');
    console.error('║  MISSING DISCORD INTENTS                       ║');
    console.error('║                                                ║');
    console.error('║  Go to discord.com/developers/applications     ║');
    console.error('║  → Your app → Bot → Enable all intents         ║');
    console.error('╚════════════════════════════════════════════════╝\n');
  } else if (err.message?.includes('ENOTFOUND') || err.message?.includes('ECONNREFUSED')) {
    console.error('\n╔════════════════════════════════════════════════╗');
    console.error('║  NO INTERNET CONNECTION                        ║');
    console.error('║                                                ║');
    console.error('║  Check your internet and try again.            ║');
    console.error('║  Bot will auto-retry via launchd.              ║');
    console.error('╚════════════════════════════════════════════════╝\n');
  } else {
    console.error(`\n[STARTUP] Unknown login error: ${err.message}\n`);
  }

  process.exit(1);
});
