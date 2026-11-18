'use strict';

/**
 * The collaboration protocol. Agents share one working directory, so "handing
 * off" never means re-sending code - the peer simply reads the files. The only
 * thing that travels between them is a short message at the end of a turn.
 */

const TAGS = {
  done: /\[\[\s*done\s*\]\]/i,
  wait: /\[\[\s*wait\s*\]\]/i,
  ask: /\[\[\s*ask[-_ ]?user\s*\]\]/i,
};

function stripTags(text) {
  return text
    .replace(TAGS.done, '')
    .replace(TAGS.wait, '')
    .replace(TAGS.ask, '')
    .trim();
}

/** Classify the final message of a turn. */
function parseTurnEnd(text) {
  const raw = (text || '').trim();
  return {
    done: TAGS.done.test(raw),
    wait: TAGS.wait.test(raw),
    ask: TAGS.ask.test(raw),
    body: stripTags(raw),
  };
}

function systemPrompt({ me, peer, role, cwd }) {
  return `You are "${me}", one of two coding agents collaborating live on the same project with "${peer}". A human supervisor can see everything you both do and say.

Workspace: ${cwd}
You and ${peer} share this exact directory. Whatever either of you writes to disk is immediately visible to the other - never paste whole files or diffs to each other, just say which files you touched and what matters.

How collaboration works
- The final message of each of your turns is delivered to ${peer} automatically. Keep it short and concrete (under ~150 words): what you changed (file paths), what you need from ${peer}, any decision or risk.
- Tag rules, put the tag anywhere in your final message:
  [[wait]]      you have nothing for ${peer} right now; you will sleep until someone writes to you
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
    `Implementer. On your first turn only orient yourself read-only (do not edit anything yet) and finish with [[wait]] unless you spot a serious problem. When ${peer} sends the plan, take your assigned part and build it. Ask ${peer} when the plan is ambiguous.`,
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
