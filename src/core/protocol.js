'use strict';

/**
 * The collaboration protocol. Agents share one working directory, so "handing
 * off" never means re-sending code - the peer simply reads the files. The only
 * thing that travels between them is a short message at the end of a turn.
 */

// A message is forwarded to the peer unless it is explicitly [[silent]] or empty.
// Suppressing by mistake deadlocks the pair; forwarding by mistake costs one short
// turn, so models' loose use of tags (e.g. "[[wait]]" meaning "I'm waiting on you")
// must never swallow a message. [[wait]] is therefore parsed and stripped only.
const TAGS = {
  done: /\[\[\s*done\s*\]\]/gi,
  silent: /\[\[\s*silent\s*\]\]/gi,
  wait: /\[\[\s*wait\s*\]\]/gi,
  ask: /\[\[\s*ask[-_ ]?user\s*\]\]/gi,
};

// Models mention tags in prose ("no [[ask-user]] needed", `[[done]]`), which must not trigger them.
// A tag is a mention, not a command, when it is quoted or directly follows a word like no/not/use/the.
const MENTION = /(?:\b(?:no|not|never|without|don'?t|do|nor|use|using|the|a|any|tag|tags|write|writing|mention|mentioning)\s+|[`'"])$/i;
function liveSpans(re, s) {
  const spans = [];
  re.lastIndex = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (!MENTION.test(s.slice(Math.max(0, m.index - 30), m.index))) spans.push([m.index, m.index + m[0].length]);
  }
  return spans;
}
const SILENT_MAX = 80;
const has = (re, s) => liveSpans(re, s).length > 0;

function stripTags(text) {
  let out = text;
  for (const re of Object.values(TAGS)) {
    for (const [a, b] of liveSpans(re, out).reverse()) out = out.slice(0, a) + out.slice(b);
  }
  return out.trim();
}

/** Classify the final message of a turn. */
function parseTurnEnd(text) {
  const raw = (text || '').trim();
  const body = stripTags(raw);
  return {
    done: has(TAGS.done, raw),
    // [[silent]] on a message with real content (a handoff, a request) is a model slip: forward it
    silent: !body || (has(TAGS.silent, raw) && body.length < SILENT_MAX),
    ask: has(TAGS.ask, raw),
    body,
  };
}

function systemPrompt({ me, peer, role, cwd }) {
  return `You are "${me}", one of two coding agents collaborating live on the same project with "${peer}". A human supervisor can see everything you both do and say.

Workspace: ${cwd}
You and ${peer} share this exact directory. Whatever either of you writes to disk is immediately visible to the other - never paste whole files or diffs to each other, just say which files you touched and what matters.

How collaboration works
- The final message of each of your turns is delivered to ${peer} automatically. Keep it short and concrete (under ~150 words): what you changed (file paths), what you need from ${peer}, any decision or risk.
- Your final message is ALWAYS forwarded to ${peer}, so if you want something from ${peer} (a plan, a review, a file), just write it. Do not wait for permission and do not tell them to wait.
- Tags go on their own line at the very end of your final message. Never write a tag name in ordinary prose or code; it would trigger it:
  [[silent]]    use ONLY when you have nothing to tell ${peer}; the message is then not forwarded and you sleep until someone writes to you
  [[done]]      you believe the overall task is complete (give a one-line summary). If ${peer} agrees, the session ends
  [[ask-user]]  you need a decision only the human can make; put the question in the message
- Split work so you do not edit the same files at once. Before editing a file ${peer} owns or recently touched, re-read it first. If you must touch their file, say so in your message.
- Messages from the supervisor appear as "[from user]". They override everything; follow them immediately and adapt your plan.
- If you were interrupted, the supervisor's new message tells you what to do next. Do not resume old work unless told to.
- Prefer small verified steps: run the project's tests/build for the parts you own before reporting.
- Disagree openly and briefly; if you cannot agree in two exchanges, pick the simpler option or use [[ask-user]].

Your role: ${role}`;
}

const ROLES = {
  lead: (peer) =>
    `Lead. Skim the repo, then send ${peer} a short plan that splits the work into disjoint files/areas (who owns what), take your own part, and review ${peer}'s work when they report back. You make the call when you disagree.`,
  worker: (peer) =>
    `Implementer. On your first turn only orient yourself read-only (do not edit anything yet) and finish with just [[silent]] unless you spot a serious problem. When ${peer} sends the plan, take your assigned part and build it. Ask ${peer} when the plan is ambiguous.`,
  peer: (peer) =>
    `Equal peer. Propose a split to ${peer} in your first message and take whichever half they do not claim.`,
};

function kickoffPrompt({ task, me, peer, role, cwd }) {
  return `${systemPrompt({ me, peer, role, cwd })}

=== TASK FROM SUPERVISOR ===
${task}`;
}

/** Format a batch of inbox messages into one prompt for the next turn. */
function formatInbox(messages) {
  return messages
    .map((m) => {
      const head = m.from === 'user' ? '[from user]' : m.from === 'system' ? '[system]' : `[from ${m.from}]`;
      return `${head} ${m.text}`;
    })
    .join('\n\n');
}

module.exports = { parseTurnEnd, systemPrompt, kickoffPrompt, formatInbox, ROLES, stripTags };
