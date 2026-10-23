'use strict';
/**
 * Built-in AI assistant — 100% local by default.
 *
 * Privacy contract: this module NEVER receives anybody's private conversation
 * automatically. Conversation summaries are produced only when a user clicks
 * "Summarize this chat" inside that conversation, and the summary is computed
 * extractively on this server from that conversation's recent messages.
 *
 * An optional OpenAI-compatible provider can be enabled with AI_API_KEY
 * (see .env.example). It is OFF by default, receives ONLY the dedicated
 * assistant conversation (never user-to-user chats), and is untested with a
 * live key in this build.
 */

const PHRASES = [
  ['hello', 'नमस्ते'], ['thank you', 'धन्यवाद'], ['good morning', 'सुप्रभात'],
  ['good night', 'शुभ रात्रि'], ['how are you?', 'आप कैसे हैं?'],
  ['i am fine', 'मैं ठीक हूँ'], ['please wait', 'कृपया प्रतीक्षा करें'],
  ['see you tomorrow', 'कल मिलते हैं'], ['congratulations', 'बधाई हो'],
  ['happy birthday', 'जन्मदिन मुबारक हो'], ['i need help', 'मुझे मदद चाहिए'],
  ['what is your name?', 'आपका नाम क्या है?'], ['welcome', 'आपका स्वागत है'],
  ['good luck', 'शुभकामनाएँ'], ['sorry', 'माफ़ कीजिए'],
  ['yes', 'हाँ'], ['no', 'नहीं'],
  ['i will call you later', 'मैं आपको बाद में कॉल करूँगा'],
  ['the meeting is at 5 pm', 'बैठक शाम 5 बजे है'],
  ['please send the file', 'कृपया फ़ाइल भेजें'],
];

function translatePhrase(text, direction) {
  const t = String(text || '').trim().toLowerCase();
  for (const [en, hi] of PHRASES) {
    if (direction === 'en-hi' && t === en) return { translation: hi, matched: true };
    if (direction === 'hi-en' && t === hi.toLowerCase()) return { translation: en, matched: true };
  }
  return {
    translation: null,
    matched: false,
    note: 'The built-in translator covers common Hindi⇄English phrases only. Full translation needs the optional AI provider (AI_API_KEY), which is off by default.',
  };
}

const TEMPLATES = {
  leave: 'Subject: Leave Application\n\nDear [Manager Name],\n\nI would like to apply for leave from [start date] to [end date] due to [reason]. I will hand over my pending work to [colleague] before I leave and will be reachable on [phone/email] for anything urgent.\n\nThank you for your understanding.\n\nRegards,\n[Your Name]',
  meeting: 'Hi [Name], I would like to schedule a meeting to discuss [topic]. Would [date] at [time] work for you? The meeting should take about [duration]. Please let me know if another time suits you better. Thanks!',
  thanks: 'Thank you so much for [what they did]. I really appreciate your help and time — it made a real difference. Please let me know if I can return the favour!',
  followup: 'Hi [Name], just following up on [topic] from [when]. Could you please share an update when you get a chance? Happy to discuss on a quick call if easier. Thanks!',
  introduction: 'Hi [Name], I am [Your Name], [your role]. I am reaching out because [reason]. I would love to [what you are asking for]. Looking forward to connecting!',
};

function summarizeMessages(messages, title) {
  if (!messages.length) return 'This conversation has no messages to summarize yet.';
  const bySender = new Map();
  for (const m of messages) bySender.set(m.senderName, (bySender.get(m.senderName) || 0) + 1);
  const speakers = [...bySender.entries()].sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `${name} (${n})`).join(', ');
  const questions = messages.filter(m => /\?\s*$/.test(m.body.trim())).slice(-3);
  const actions = messages.filter(m =>
    /\b(please|need to|will|todo|to-do|deadline|send|call|meeting|finish|submit|book|pay)\b/i.test(m.body)).slice(-4);
  const longest = [...messages].sort((a, b) => b.body.length - a.body.length).slice(0, 2);
  const lines = [
    `Summary of "${title || 'this conversation'}" — ${messages.length} recent messages.`,
    `Most active: ${speakers}.`,
  ];
  if (longest.length) {
    lines.push('Key points mentioned:');
    for (const m of longest) lines.push(`• ${m.senderName}: "${m.body.slice(0, 140)}${m.body.length > 140 ? '…' : ''}"`);
  }
  if (questions.length) {
    lines.push('Open questions:');
    for (const m of questions) lines.push(`• ${m.senderName}: "${m.body.slice(0, 120)}"`);
  }
  if (actions.length) {
    lines.push('Possible action items:');
    for (const m of actions) lines.push(`• ${m.senderName}: "${m.body.slice(0, 120)}"`);
  }
  lines.push('(Generated on this server by the built-in extractive summarizer — your messages were not sent to any external AI service.)');
  return lines.join('\n');
}

function replySuggestions(context) {
  const c = String(context || '').toLowerCase();
  if (/\?$/.test(c.trim())) return ['Yes, that works for me.', 'Let me check and get back to you.', 'Can you share more details?'];
  if (/thank/.test(c)) return ['You are welcome! 😊', 'Anytime!', 'Glad I could help.'];
  if (/meeting|call/.test(c)) return ['That time works for me.', 'Can we move it by 30 minutes?', 'Please share the agenda.'];
  if (/congrats|birthday|🎉/.test(c)) return ['Thank you so much! 🎉', 'Really appreciate it!', 'Means a lot, thanks!'];
  return ['Okay, noted. 👍', 'Sounds good to me.', 'Let me think about it and reply.'];
}

function assistantReply(message) {
  const t = String(message || '').trim();
  const low = t.toLowerCase();
  if (!t) return 'Ask me to write a message, translate a common phrase, or explain any ConnectX feature.';
  if (/^(hi|hello|hey|namaste|नमस्ते)\b/.test(low)) {
    return 'Hello! I am the built-in ConnectX assistant — I run locally on this server and never read your private chats. I can:\n• Write messages (try "write a leave application")\n• Translate common Hindi⇄English phrases (try "translate: good morning")\n• Suggest replies\n• Explain features (try "how do I create a group?")';
  }
  const tr = low.match(/^translate[:\s]+(.+)/);
  if (tr) {
    const phrase = tr[1].trim();
    const hasHindi = /[\u0900-\u097F]/.test(phrase);
    const r = translatePhrase(phrase, hasHindi ? 'hi-en' : 'en-hi');
    return r.matched ? `"${phrase}" → "${r.translation}"` : r.note;
  }
  if (/leave application|leave letter/.test(low)) return `Here is a template you can copy and fill in:\n\n${TEMPLATES.leave}`;
  if (/write.*meeting|meeting request/.test(low)) return `Here is a meeting-request draft:\n\n${TEMPLATES.meeting}`;
  if (/thank/.test(low) && /write|draft|message/.test(low)) return `Here is a thank-you draft:\n\n${TEMPLATES.thanks}`;
  if (/follow.?up/.test(low)) return `Here is a polite follow-up draft:\n\n${TEMPLATES.followup}`;
  if (/introduc/.test(low)) return `Here is an introduction draft:\n\n${TEMPLATES.introduction}`;
  if (/suggest.*repl|reply suggestion/.test(low)) {
    return 'Here are some quick reply ideas: ' + replySuggestions(t).join(' | ') +
      '\nTip: the assistant chat can suggest replies here; your private chats are never shared with me automatically.';
  }
  if (/create.*group|group.*create/.test(low)) return 'To create a group: open the Groups view → "New group" → pick members and a name. As creator you are the admin: only admins can rename the group or add/remove members. You can also set an invite link and an expiry time for temporary groups.';
  if (/schedule/.test(low)) return 'To schedule a message: open any chat, type your message, then use the clock (⏰) button next to Send and pick a date/time. The server delivers it at that time, even if you are offline.';
  if (/disappearing|disappear/.test(low)) return 'Disappearing messages: open a chat → chat settings → choose a timer (e.g. 1 hour). New messages in that chat then delete themselves automatically after the timer.';
  if (/call/.test(low)) return 'Calls: open a 1:1 chat and tap the phone/video icon. Voice and video calls are 1-to-1 in this version (WebRTC). Group calls are not available in this version.';
  if (/encrypt|privacy|secure/.test(low)) return 'Honest privacy facts: messages travel over HTTPS/WSS when the site is served securely and are stored on this server. End-to-end encryption is NOT implemented in this version — please do not treat chats as end-to-end encrypted. You control profile-photo and last-seen visibility under Settings → Privacy.';
  if (/summar/.test(low)) return 'To summarize a conversation, open that chat and tap "✨ Summarize this chat". The summary is generated on this server, only when you ask, from that conversation.';
  return 'I can help with writing messages (leave applications, meeting requests, follow-ups), translating common Hindi⇄English phrases ("translate: thank you"), reply suggestions, and explaining ConnectX features. For chat summaries, use the "✨ Summarize" button inside a conversation.';
}

/** Optional external provider — OFF unless AI_API_KEY is set. Untested with a live key. */
async function externalChat(message) {
  const key = process.env.AI_API_KEY;
  if (!key) return null;
  const url = process.env.AI_API_URL || 'https://api.openai.com/v1/chat/completions';
  const model = process.env.AI_MODEL || 'gpt-4o-mini';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You are the ConnectX AI assistant. Be concise and helpful.' },
        { role: 'user', content: message },
      ],
    }),
  });
  if (!res.ok) throw new Error(`AI provider returned ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || null;
}

module.exports = { translatePhrase, summarizeMessages, replySuggestions, assistantReply, externalChat, TEMPLATES };
