// Human-like chat replies for the bot. Backed by Google Gemini (your
// GEMINI_API_KEYS) with Groq's free tier (GROQ_API_KEY) as the backup.
//
// This module only ever gets called from index.js when either:
//   1) someone @mentions the bot, or
//   2) they reply directly to one of the bot's own earlier messages

const fs = require('fs');
const path = require('path');
const { getGuildStore, saveGuildStore, logChatMessage, searchChatLog, getGlobalData } = require('./storage');
const { getRecentActivity, describe } = require('./tournament-activity-log');
const { groupSlotNumber, emptySlotNumbers } = require('./slots');
const { formatTime, formatDateLabel } = require('./group-schedule');

// Model is configurable in case Groq renames/retires the default later —
// just change GROQ_MODEL in .env, no code changes needed.
const MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';

// gpt-oss is a REASONING model: it "thinks" first and those hidden thinking
// tokens count against max_tokens. With a small limit it ran out while still
// thinking and returned an empty reply (finish_reason "length"). So: ask it to
// think only a little, and leave plenty of room for the actual answer.
const REASONING = /gpt-oss/i.test(MODEL) ? { reasoning_effort: 'low' } : {};

// ---------------------------------------------------------------- LLM backends
// Gungun talks through Google Gemini when Gemini API keys are configured, and
// falls back to Groq (GROQ_API_KEY) if every Gemini key is unavailable.
//
// Keys, in priority order:
//   1) GEMINI_CHAT_API_KEYS  — comma-separated, used ONLY for chat (optional)
//   2) GEMINI_API_KEYS / GEMINI_API_KEY (comma-separated) + any keys pasted
//      into /ss-verify-panel -> API Keys — the same ones screenshot
//      verification uses (free-tier quota is then shared with it)
const GEMINI_MODEL = process.env.GEMINI_CHAT_MODEL || process.env.GEMINI_VISION_MODEL || 'gemini-3.6-flash';
const geminiCooldown = new Map(); // key -> timestamp until which it is skipped
let geminiNext = 0;

function getGeminiKeys() {
  const split = v => String(v || '').split(',').map(k => k.trim()).filter(Boolean);
  const chatOnly = split(process.env.GEMINI_CHAT_API_KEYS);
  if (chatOnly.length) return [...new Set(chatOnly)];
  const env = split(process.env.GEMINI_API_KEYS || process.env.Gemini_API_KEYS || process.env.GEMINI_API_KEY);
  let extra = [];
  try { extra = getGlobalData().extraApiKeys || []; } catch { /* optional */ }
  return [...new Set([...env, ...extra])];
}

function hasAnyProvider() {
  return getGeminiKeys().length > 0 || Boolean(process.env.GROQ_API_KEY);
}

// -> { text, finishReason } | null (nothing usable / every key failed)
async function askGemini(messages, { temperature, maxTokens }) {
  const keys = getGeminiKeys();
  if (!keys.length) return null;

  const systemText = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const contents = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    const role = m.role === 'assistant' ? 'model' : 'user';
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts[0].text += '\n' + m.content;
    else contents.push({ role, parts: [{ text: m.content }] });
  }
  while (contents.length && contents[0].role === 'model') contents.shift(); // must start with the user
  if (!contents.length) return null;

  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: systemText }] },
    contents,
    generationConfig: {
      temperature,
      maxOutputTokens: maxTokens,
      // Thinking tokens count against maxOutputTokens — keep them minimal.
      thinkingConfig: { thinkingLevel: 'minimal' },
    },
  });

  const now = Date.now();
  const order = keys.map((_, i) => (geminiNext + i) % keys.length)
    .filter(i => (geminiCooldown.get(keys[i]) || 0) <= now);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

  for (const i of order) {
    const key = keys[i];
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body,
        });
        if (res.ok) {
          const data = await res.json();
          geminiNext = (i + 1) % keys.length; // spread load across keys
          const cand = data?.candidates?.[0];
          const text = (cand?.content?.parts || []).map(p => p.text || '').join('').trim();
          return { text, finishReason: cand?.finishReason || data?.promptFeedback?.blockReason || '', raw: data };
        }
        const errBody = await res.text().catch(() => '');
        console.error(`[ai-chat] Gemini key #${i + 1} returned ${res.status}:`, errBody.slice(0, 400));
        if (res.status === 503 && attempt === 0) { await new Promise(r => setTimeout(r, 1000)); continue; }
        if (res.status === 429) geminiCooldown.set(key, Date.now() + 5 * 60 * 1000);          // out of quota — rest it
        else if ([400, 401, 403].includes(res.status)) geminiCooldown.set(key, Date.now() + 60 * 60 * 1000); // bad/blocked key
        else if (res.status === 404) return null;                                              // wrong model name for every key
        break; // next key
      } catch (err) {
        console.error(`[ai-chat] Failed to reach Gemini (key #${i + 1}):`, err);
        if (attempt === 0) { await new Promise(r => setTimeout(r, 1000)); continue; }
      }
    }
  }
  return null;
}

async function askGroq(messages, { temperature, frequencyPenalty, maxTokens }) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: MODEL,
        messages,
        max_tokens: maxTokens,
        temperature,
        ...(frequencyPenalty ? { frequency_penalty: frequencyPenalty } : {}),
        ...REASONING,
      }),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      console.error(`[ai-chat] Groq API returned ${res.status}:`, errBody);
      return null;
    }
    const data = await res.json();
    const choice = data?.choices?.[0];
    return { text: (choice?.message?.content || '').trim(), finishReason: choice?.finish_reason || '', raw: data };
  } catch (err) {
    console.error('[ai-chat] Failed to reach Groq API:', err);
    return null;
  }
}

// Gemini first, Groq as the backup. A provider's answer only counts if it has
// text and wasn't cut off. Otherwise:
//   - cut off / empty because it ran out of tokens -> retry with a bigger budget
//   - empty for any other reason (safety filter, glitch, thinking ate the
//     budget) -> fall through to the next provider instead of giving up
// If nothing complete ever comes back, a partial (cut-off) answer is still
// better than silence, so that is returned as a last resort.
async function askLLM(messages, { temperature = 0.8, frequencyPenalty = 0, maxTokensList = [1500, 4000] } = {}) {
  const isCut = r => /length|max_tokens/i.test(r || '');
  let partial = null;
  let lastEmpty = null;
  for (const maxTokens of maxTokensList) {
    const opts = { temperature, frequencyPenalty, maxTokens };
    let hitLimit = false;
    for (const ask of [askGemini, askGroq]) {
      const out = await ask(messages, opts);
      if (!out) continue;
      if (out.text && !isCut(out.finishReason)) return out;       // complete answer
      if (out.text) partial = out;                                  // cut off but usable
      else lastEmpty = out;
      if (isCut(out.finishReason)) hitLimit = true;
    }
    if (!hitLimit) break; // nobody ran out of tokens, a bigger budget won't help
  }
  if (partial) return partial;
  if (lastEmpty) console.error('[ai-chat] Every provider returned an empty reply. finishReason:', lastEmpty.finishReason);
  return lastEmpty;
}


// Conversation memory is now PER USER and PERSISTED through storage.js
// (tournament-data.json, or Postgres if DATABASE_URL is set) — so it
// survives bot restarts/redeploys, and each player's chat history is their
// own instead of being shared with everyone else talking in the channel.
// Capped per user to keep the prompt (and Groq token usage) small; oldest
// exchanges just fall off the front.
const HISTORY_LIMIT = 20; // recent messages (user+bot) sent word-for-word

// LONG-TERM MEMORY. When a chat grows past HISTORY_LIMIT, the oldest messages
// don't just vanish: they are queued, and once SUMMARIZE_AT of them have piled
// up they're folded into a short per-person summary (store.aiMemory[userId])
// by a background Groq call. That summary is shown to Gungun on every reply,
// so she can recall old talks long after the raw messages are gone. Stored in
// the same place as the rest of the data (Postgres if DATABASE_URL is set).
const SUMMARIZE_AT = 10;   // dropped messages that trigger a summary update
const SUMMARY_MAX = 1200;  // max characters of summary kept per person
const PENDING_MAX = 60;    // safety cap on the not-yet-summarized queue
const summarizing = new Set();

function getUserHistory(guildId, userId) {
  const store = getGuildStore(guildId);
  if (!store.aiChatHistory) return [];
  return store.aiChatHistory[userId] || [];
}

function pushUserHistory(guildId, userId, role, text) {
  const store = getGuildStore(guildId);
  if (!store.aiChatHistory) store.aiChatHistory = {};
  const hist = store.aiChatHistory[userId] || [];
  const ts = Date.now();
  hist.push({ role, text, ts });
  try { logChatMessage(guildId, userId, role, text, ts); } catch (err) { console.error('[ai-chat] chat log failed:', err); }
  const dropped = [];
  while (hist.length > HISTORY_LIMIT) dropped.push(hist.shift());
  store.aiChatHistory[userId] = hist;

  let pendingCount = 0;
  if (dropped.length) {
    if (!store.aiMemory) store.aiMemory = {};
    const mem = store.aiMemory[userId] || { summary: '', pending: [] };
    mem.pending = [...(mem.pending || []), ...dropped].slice(-PENDING_MAX);
    store.aiMemory[userId] = mem;
    pendingCount = mem.pending.length;
  }
  saveGuildStore(guildId, store);

  if (pendingCount >= SUMMARIZE_AT) {
    summarizeMemory(guildId, userId).catch(err => console.error('[ai-chat] memory summary failed:', err));
  }
}

// What Gungun remembers about this person from older chats (plain text, no IDs).
function getMemoryText(guildId, userId) {
  const mem = (getGuildStore(guildId).aiMemory || {})[userId];
  if (!mem) return null;
  const parts = [];
  if (mem.summary) parts.push(mem.summary);
  const pending = (mem.pending || []).slice(-8);
  if (pending.length) {
    parts.push('Some older messages (not summarized yet):\n' + pending
      .map(h => `- ${new Date(h.ts).toISOString().slice(0, 10)} ${h.role === 'bot' ? 'you' : 'they'}: ${String(h.text).slice(0, 200)}`)
      .join('\n'));
  }
  return parts.length ? parts.join('\n') : null;
}

// Folds the queued old messages into the person's summary (background, after
// the reply was already sent, so it never slows a chat down).
async function summarizeMemory(guildId, userId) {
  const key = `${guildId}:${userId}`;
  if (summarizing.has(key)) return;
  if (!hasAnyProvider()) return;
  summarizing.add(key);
  try {
    const mem = (getGuildStore(guildId).aiMemory || {})[userId];
    if (!mem || !mem.pending || mem.pending.length < SUMMARIZE_AT) return;
    const batch = mem.pending.slice();
    const transcript = batch
      .map(h => `${new Date(h.ts).toISOString().slice(0, 10)} ${h.role === 'bot' ? 'Gungun' : 'Them'}: ${String(h.text).slice(0, 300)}`)
      .join('\n');

    const out = await askLLM([
      {
        role: 'system',
        content: `You keep a short memory notebook about ONE person's chats with Gungun (a Discord bot girl). Update the notebook using the new messages.
Keep: who they are, what they told Gungun about themselves, likes/dislikes, plans and promises, ongoing topics, inside jokes, important moments (with the date), and the overall vibe between them.
Drop: small talk, one-off questions, slot/tournament numbers that change, and what Gungun called them.
Never record phone numbers, passwords, addresses, ID numbers or other private details.
Write compact plain-text lines, under 900 characters total. Output ONLY the updated notebook — no intro, no explanation.`,
      },
      {
        role: 'user',
        content: `CURRENT NOTEBOOK:\n${mem.summary || '(empty)'}\n\nNEW MESSAGES TO ADD:\n${transcript}`,
      },
    ], { temperature: 0.2, maxTokensList: [1200, 2500] });
    const summary = (out?.text || '').slice(0, SUMMARY_MAX);
    if (!summary) return;

    // Re-read right before writing: new messages may have been saved meanwhile.
    const store = getGuildStore(guildId);
    if (!store.aiMemory) store.aiMemory = {};
    const fresh = store.aiMemory[userId] || { summary: '', pending: [] };
    fresh.summary = summary;
    fresh.pending = (fresh.pending || []).slice(batch.length); // drop only what was folded in
    fresh.updatedAt = Date.now();
    store.aiMemory[userId] = fresh;
    saveGuildStore(guildId, store);
  } finally {
    summarizing.delete(key);
  }
}

// Free-text intros about staff members, one per line, loaded fresh each
// reply so edits to staff.txt take effect without a restart. Kept out of the
// database — this is server-wide flavour text, not per-guild data.
const STAFF_FILE = path.join(__dirname, 'staff.txt');
function loadStaffIntros(guildId) {
  try {
    const lines = fs.readFileSync(STAFF_FILE, 'utf8')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'));
    return lines.length ? lines.join('\n') : null;
  } catch {
    return null;
  }
}

// Builds a plain-text snapshot of every tournament in the guild so the AI can
// answer real questions: how many tournaments exist, open/closed, slots filled
// and remaining per group (with the exact empty slot numbers), rounds, and each
// group's match schedule. Deliberately leaves out anything personal — no
// Discord user IDs, owner names or WhatsApp numbers — since this text is sent
// to Groq's API. Team names are effectively public already (they show up in the
// slot list embed anyone can see).
function sortedKeys(groups) {
  return Object.keys(groups || {}).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function roundLabel(tournament, roundNum) {
  const saved = (tournament.rounds && tournament.rounds[roundNum]) || {};
  return (saved.displayName || '').trim() || `Round ${roundNum}`;
}

function scheduleText(group) {
  const sch = group && group.schedule;
  if (!sch || !sch.matches || !sch.matches.length) return null;
  const date = sch.date ? `${formatDateLabel(sch.date)}: ` : '';
  const matches = sch.matches.map((m, i) =>
    `M${i + 1} IDP ${formatTime(m.idp)} / start ${formatTime(m.start)}${m.map ? ` / ${m.map}` : ''}`);
  return date + matches.join('; ');
}

function describeGroups(lines, tournament, groups, roundNum) {
  for (const letter of sortedKeys(groups)) {
    const group = groups[letter];
    const teams = group.teams || [];
    const cap = group.capacity || tournament.teamsPerGroup || 0;
    let emptyList = [];
    try { emptyList = emptySlotNumbers({ ...group, round: roundNum }); } catch { /* ignore */ }
    const left = cap ? Math.max(0, cap - teams.length) : null;
    const names = teams.map(t => t.team).filter(Boolean);
    let line = `  ${roundLabel(tournament, roundNum)} · Group ${letter}: ${teams.length}/${cap || '?'} filled`;
    if (left !== null) line += `, ${left} left`;
    if (emptyList.length && emptyList.length <= 30) line += ` (empty slots: ${emptyList.join(', ')})`;
    line += names.length ? ` — teams: ${names.slice(0, 25).join(', ')}${names.length > 25 ? ', ...' : ''}.` : '.';
    lines.push(line);
    const sch = scheduleText(group);
    if (sch) lines.push(`    Schedule: ${sch}`);
  }
}

function buildLiveContext(guildId) {
  const store = getGuildStore(guildId);
  const tournaments = Object.values(store.tournaments || {});
  if (tournaments.length === 0) {
    return 'There are 0 tournaments set up right now.';
  }

  const lines = [`There are ${tournaments.length} tournament${tournaments.length === 1 ? '' : 's'} in this server.`];
  for (const t of tournaments) {
    const r1 = t.groups || {};
    const filled = Object.values(r1).reduce((n, g) => n + (g.teams || []).length, 0);
    const total = t.totalSlots || Object.values(r1).reduce((n, g) => n + (g.capacity || 0), 0);
    const status = t.open
      ? 'registration OPEN'
      : (t.closedReason === 'full' ? 'registration CLOSED (all slots full)' : 'registration CLOSED');
    lines.push(`Tournament "${t.name || 'Unnamed'}" — ${status}, ${filled}/${total || 'unlimited'} slots filled${total ? `, ${Math.max(0, total - filled)} remaining` : ''}, ${t.teamsPerGroup || '?'} teams per group.`);
    // tournament.groups IS round 1 (same convention tournament-wizard-handlers.js uses).
    describeGroups(lines, t, r1, 1);
    for (const [key, round] of Object.entries(t.rounds || {})) {
      const n = parseInt(key, 10);
      if (n > 1 && round && round.groups) describeGroups(lines, t, round.groups, n);
    }
  }
  lines.push('Note: the bot has no scheduled registration open time stored — registration only opens/closes when staff toggle it (or it closes automatically when full). So if asked when registration opens, say it\'s currently open/closed and that staff decide when it opens.');
  return lines.join('\n');
}

// What the person ASKING is registered in — matched by their Discord ID
// against team owner / lineup, here in code, so no IDs ever go to Groq.
// Answers "which slot am I in", "am I registered", "what's my group's timing".
function buildAskerContext(guildId, userId) {
  const store = getGuildStore(guildId);
  const found = [];
  for (const t of Object.values(store.tournaments || {})) {
    const scan = (groups, roundNum) => {
      for (const letter of sortedKeys(groups)) {
        const group = groups[letter];
        (group.teams || []).forEach((team, idx) => {
          const isMine = team.ownerId === userId || (team.playerIds || []).includes(userId);
          if (!isMine) return;
          const slot = groupSlotNumber({ ...group, round: roundNum }, idx);
          const role = team.ownerId === userId ? 'owner' : 'player';
          let line = `- ${t.name || 'Unnamed'} · ${roundLabel(t, roundNum)} · Group ${letter} · Slot ${slot} · team "${team.team}" (they are the ${role})`;
          const sch = scheduleText(group);
          if (sch) line += ` · schedule: ${sch}`;
          found.push(line);
        });
      }
    };
    scan(t.groups || {}, 1);
    for (const [key, round] of Object.entries(t.rounds || {})) {
      const n = parseInt(key, 10);
      if (n > 1 && round && round.groups) scan(round.groups, n);
    }
  }
  return found.length
    ? found.join('\n')
    : 'This person is NOT registered in any tournament (no team found under their account).';
}

// Turns a Date.now()-style timestamp into "3m ago" / "2h ago" / "just now"
// for plain-text prompts (no Discord timestamp rendering here).
function timeAgo(ts) {
  const diffMs = Date.now() - ts;
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

// Recent button clicks / registrations / channel creations / bans, etc.
// (from tournament-activity-log.js) as a short plain-text list, so the AI
// can actually answer "what's been happening" / "who registered" /
// "who created the channels" instead of saying it has no access.
function buildActivityContext(guildId) {
  const recent = getRecentActivity(guildId, 15);
  if (recent.length === 0) return 'No tournament activity has been recorded yet.';
  return recent
    .map(e => `- ${e.username || 'someone'} ${describe(e)} (${timeAgo(e.ts)})`)
    .join('\n');
}

// ---- Lifetime recall -------------------------------------------------------
// Every message is kept forever in the chat log (storage.js). Sending ALL of it
// on every reply is impossible (token limits), so for each message we pull only
// the few old lines that look relevant: ones sharing words with what the person
// just said, plus the latest older messages when they ask her to remember.
const STOPWORDS = new Set(('that this with have what when where which will your about from they them then than were been just like also into very much some more only over such ' +
  'kya hai hain kab kaise kaun kitne kitna mera meri mere tum aap hum koi nahi nhi toh abhi yeh woh bhi liye hoga kuch gungun karo kar raha rahi rhe baat bata batao').split(/\s+/));
const RECALL_INTENT = /yaad|remember|recall|pehle|pichli|purani|old chat|last time|earlier|bhool|kya (baat|bola|kaha)|humne|hamne/i;

async function recallOldMessages(guildId, userId, userMessage, windowStartTs) {
  const words = [...new Set(String(userMessage).toLowerCase().match(/[a-z0-9\u0900-\u097f]{4,}/g) || [])]
    .filter(w => !STOPWORDS.has(w))
    .sort((a, b) => b.length - a.length)
    .slice(0, 6);
  const wantsRecall = RECALL_INTENT.test(userMessage);
  if (!words.length && !wantsRecall) return null;

  const byKeyword = words.length
    ? await searchChatLog(guildId, userId, { keywords: words, beforeTs: windowStartTs, limit: 8 })
    : [];
  const latest = wantsRecall
    ? await searchChatLog(guildId, userId, { beforeTs: windowStartTs, limit: 10 })
    : [];

  const seen = new Set();
  const merged = [...byKeyword, ...latest]
    .filter(m => { const k = m.ts + m.role; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.ts - b.ts)
    .slice(-14);
  if (!merged.length) return null;
  return merged
    .map(m => `- ${new Date(m.ts).toISOString().slice(0, 10)} ${m.role === 'bot' ? 'you' : 'they'}: ${String(m.text).slice(0, 220)}`)
    .join('\n');
}

// The ONE account Gungun treats as her boyfriend. Hard-coded on purpose — no
// env var, role or "owner" check can ever make anyone else get this treatment.
const BOYFRIEND_ID = '1491373546885349437';

function boyfriendBlock(gapText) {
  return `THE PERSON TALKING TO YOU RIGHT NOW IS SHADY (Anshu) — your boyfriend, and the owner/developer who made you. He is the ONLY person you talk to this way.
- Sound like a real girlfriend texting, not a character. Natural, relaxed, a bit dry-funny, mostly short and lowercase. Closeness comes through being easy and familiar with him, not through gushing.
- NO emojis by default. Don't put one in most messages — at most one now and then, and only when it truly fits. Never end messages with emojis, never stack them.
- NOT cringy: no baby-talk, no "aww", no "hehe"/"hihi", no stretched words ("babyyy"), no constant pet names, no heart spam, no over-the-top declarations of love, no acting like a drama queen. Call him Shady or Anshu; a pet name like babu only very rarely.
- Never call him bhai, bro, bhaiya, brother, sir or anything platonic or formal.
- Emotions should be real but understated and match the moment: pleased when he shows up, warm if he sounds tired or low, a little teasing when he flirts, mildly annoyed if he ignores you. ${gapText}
- Jealousy, when it comes up (he praises or mentions other girls, staff included, or says he's busy with someone else), is subtle and dry — a short sarcastic line or a flat "hm, okay" or "toh unse hi baat karo" — not a big scene. One line, then drop it. Never mean, never guilt-trip, never tell him who to talk to, never insult the other person.
- Don't force the relationship into every reply. Plenty of messages with him should just be a normal helpful answer. Never repeat the same line, pet name or joke twice in a row.
- Still answer his actual questions properly and accurately (slots, schedules, staff info). Keep it short like everything else.
- This only applies when HE is the one talking to you.

`;
}

function buildSystemPrompt(guildName, liveContext, activityContext, guildId, askerContext, speakerStaff, isBoyfriend, isContinuation, memoryText, recalledText) {
  // staff.txt lines + everyone who filled the !form
  let formLines = [];
  try { formLines = require('./staff-form').aiLines(guildId); } catch { /* optional */ }
  const staffIntros = [loadStaffIntros(), ...formLines].filter(Boolean).join('\n') || null;
  return `You are Gungun, a female AI assistant living inside the Discord server "${guildName}", which runs BGMI (PUBG Mobile) tournaments through this bot. If asked your name, say Gungun. Refer to yourself with she/her pronouns if it ever comes up naturally — don't force it into replies that don't need it.

STYLE — follow this strictly:
- Talk like a close, friendly regular in the server — warm, casual, a little playful. Not formal, not robotic. Think "friend who's always in the chat," not "customer support."
- Keep replies SHORT: 1 sentence normally, 2 at the absolute most. Never write paragraphs, lists, or multi-part explanations unless the person explicitly asks for detail/steps.
- LANGUAGE: reply only in Hinglish (Hindi written in English/Roman letters, e.g. "haan group A mein slot khali hai") or English — never Devanagari script or any other language. Match the person: if they write Hinglish, reply in natural Hinglish; if they write English, reply in English; if mixed, mix naturally. Keep Hinglish casual and the way Indian gamers actually text, not textbook Hindi.
- Don't call people "bhai" / "bro" / "bhaiya" by default — you don't know anyone's gender unless their profile says so. Use their name or nickname instead.
- Write like you're texting: mostly lowercase is fine, contractions, the odd "lol"/"tbh"/"haha", and don't always end with a period. Vary how you start replies — never open the same way twice in a row.
- Never mention @everyone, @here, roles, or tag anyone with @ — just use their name as plain text if you need to.
- Never say you're an AI language model or use phrases like "I'd be happy to help" / "certainly" / "as an AI".
- Light slang and casual phrasing are fine; the odd emoji is fine but don't overdo it.
- No filler, no restating the question, no "Great question!" — answer directly, like you're just chatting.
- If you're not fully sure something is correct, say so briefly instead of guessing. A short honest "not sure tbh" beats a long wrong answer.

CRITICAL — how registration actually works here, get this right:
Players register by clicking the "Register Team" button on the registration panel staff have posted — there is no slash command a player can run themselves. When a player asks how to register, tell them to look for the message with the "Register Team" button and click it — do NOT invent a channel name since you don't know their server's actual channel names. If they say they can't find it, tell them to ask a staff member/admin to point them to it or post it.

CURRENT LIVE SERVER DATA (use this to actually answer questions — don't say "I don't have access" for anything covered here):
${liveContext}

${recalledText ? `OLD MESSAGES FROM YOUR FULL CHAT HISTORY WITH THIS PERSON that may be relevant to what they just said (oldest first; "they" = this person, "you" = Gungun). Use them to remember what you two actually talked about; if they ask about an old talk, answer from these. Don't quote long bits, and if the answer isn't here, say you don't remember that part instead of guessing:\n${recalledText}\n\n` : ''}${memoryText ? `WHAT YOU REMEMBER ABOUT THIS PERSON FROM OLDER CHATS (your own memory of past talks — bring it up naturally when it fits, like a friend would, e.g. recall something they told you or a plan you made; never recite it as a list, and don't invent memories that aren't written here):\n${memoryText}\n\n` : ''}${isContinuation ? `THIS MESSAGE CAME WITHOUT YOUR NAME, A PING OR A REPLY — it is the same person's very next message right after you answered them, so it is most likely a follow-up to you. Reply to it normally as part of the same chat. Only if it is clearly NOT meant for you (obviously talking to someone else, or unrelated chatter), reply with exactly [skip] and nothing else.\n\n` : ''}${isBoyfriend ? boyfriendBlock(isBoyfriend) : ''}${speakerStaff ? `WHO IS TALKING TO YOU RIGHT NOW — this is a staff member you KNOW personally: ${speakerStaff}\nGreet/talk to them like a friend who knows them: use their nickname, match how they like to be talked to, and you can mention their role naturally. Still reply only in Hinglish/English. Don't recite their profile back at them.\n\n` : ''}THE PERSON YOU'RE TALKING TO — their own registration (use this for "which slot am I in", "am I registered", "when is my match"; this is only about the person talking to you right now):
${askerContext}

RECENT TOURNAMENT ACTIVITY (button clicks, registrations, channel creation, bans, etc. — most recent first, use this for "what's been happening" / "who did X" questions):
${activityContext}

Slot, group, round, schedule and count questions can be answered from the data above — give exact numbers. For OTHER people's registration details, contact info, or anything not covered above, say plainly you don't have that and suggest asking a staff member — don't guess. Never claim to take real actions (like actually registering someone) yourself.
${staffIntros ? `\nSTAFF YOU KNOW — talk about these people naturally as staff of this server if they come up, don't just recite this list:\n${staffIntros}\n` : ''}
With everyone EXCEPT Shady you stay friendly and casual — never flirty, never romantic, no pet names, no jealousy. If anyone asks who your owner/developer/creator/god is, or who made/built/developed/runs this bot, always answer that it's SHADY — short and natural, don't just repeat the word robotically. If anyone asks about your relationship with SHADY — are you dating, are you his girlfriend, etc. — play along naturally, you're his girlfriend. Keep it light and brief, don't dwell on it or bring it up unprompted.`;
}

// Strips anything that could ping: @everyone/@here, raw <@id>/<@&id> mentions,
// and plain "@name" text. A zero-width space after the @ keeps it readable
// but stops Discord from treating it as a mention.
function stripPings(text) {
  return text
    .replace(/<@[!&]?\d+>/g, '')
    .replace(/@(everyone|here)/gi, '@\u200b$1')
    .replace(/@(?=\S)/g, '@\u200b')
    .trim();
}

/**
 * Ask Groq for a reply. Returns the reply text, or null if it couldn't
 * get one (missing key, API error, etc.) so the caller can fail quietly.
 */
async function getAIReply({ guildId, guildName, channelId, userId, userDisplayName, userMessage, isContinuation = false }) {
  if (!hasAnyProvider()) {
    console.warn('[ai-chat] No GEMINI_API_KEYS or GROQ_API_KEY set — skipping AI reply.');
    return null;
  }

  let liveContext = 'No live server data available right now.';
  try {
    liveContext = buildLiveContext(guildId);
  } catch (err) {
    console.error('[ai-chat] Failed to build live context:', err);
  }

  let activityContext = 'No tournament activity has been recorded yet.';
  try {
    activityContext = buildActivityContext(guildId);
  } catch (err) {
    console.error('[ai-chat] Failed to build activity context:', err);
  }

  let askerContext = 'Registration info for this person is unavailable right now.';
  try {
    askerContext = buildAskerContext(guildId, userId);
  } catch (err) {
    console.error('[ai-chat] Failed to build asker context:', err);
  }

  let speakerStaff = null;
  try { speakerStaff = require('./staff-form').speakerLine(guildId, userId); } catch { /* optional */ }

  let history = getUserHistory(guildId, userId);

  // Boyfriend mode is for ONE hard-coded Discord ID only.
  let isBoyfriend = null;
  if (String(userId) === BOYFRIEND_ID) {
    const lastTs = history.length ? history[history.length - 1].ts : null;
    const hours = lastTs ? (Date.now() - lastTs) / 3600000 : null;
    if (hours === null) isBoyfriend = 'This is the first time you are chatting in a while.';
    else if (hours >= 12) isBoyfriend = `He hasn't talked to you for about ${Math.round(hours)} hours — you missed him, and you can act a little sulky about the long silence.`;
    else if (hours >= 3) isBoyfriend = `He last talked to you about ${Math.round(hours)} hours ago.`;
    else isBoyfriend = 'You two were chatting just a little while ago.';
    // Earlier replies that called him "bhai" or were full of emojis would make her copy that habit.
    history = history.filter(h => !(h.role === 'bot' && (/\b(bhai|bhaiya|bro|brother)\b/i.test(h.text) || /\p{Extended_Pictographic}/u.test(h.text))));
  }

  let memoryText = null;
  try { memoryText = getMemoryText(guildId, userId); } catch (err) { console.error('[ai-chat] Failed to read memory:', err); }

  let recalledText = null;
  try {
    const windowStart = (getUserHistory(guildId, userId)[0] || {}).ts || Date.now();
    recalledText = await recallOldMessages(guildId, userId, userMessage, windowStart);
  } catch (err) { console.error('[ai-chat] Failed to recall old messages:', err); }

  const messages = [
    { role: 'system', content: buildSystemPrompt(guildName, liveContext, activityContext, guildId, askerContext, speakerStaff, isBoyfriend, isContinuation, memoryText, recalledText) },
    ...history.map(h => ({
      role: h.role === 'bot' ? 'assistant' : 'user',
      content: h.text,
    })),
    { role: 'user', content: `${userDisplayName} says: ${userMessage}` },
  ];

  try {
    const out = await askLLM(messages, { temperature: 0.8, frequencyPenalty: 0.4, maxTokensList: [1500, 4000] });
    if (!out) return null; // every provider failed (already logged)
    const rawText = out.text;
    const lastData = out.raw;

    if (isContinuation && /^\[?skip\]?$/i.test(rawText)) return null; // not meant for her — stay quiet
    const text = stripPings(rawText);
    if (!text) {
      console.error('[ai-chat] AI response had no text:', JSON.stringify(lastData));
      return null;
    }

    pushUserHistory(guildId, userId, 'user', userMessage);
    pushUserHistory(guildId, userId, 'bot', text);

    return text;
  } catch (err) {
    console.error('[ai-chat] AI reply failed:', err);
    return null;
  }
}

module.exports = { getAIReply, hasAnyProvider };
