// Taste auto-evolution. For each opted-in user with recent activity, asks the
// LLM to propose an updated taste profile based on the last week's loves +
// skips. Snapshots the prior state into history; if the LLM output is invalid,
// silently skips (logged) — never corrupts user data.

const state = require('./state');
const claude = require('./claude');

async function runForUser(userId) {
    const current = await state.getUserTaste(userId);
    if (!current) return { ok: false, reason: 'no taste profile' };

    const [loves, dislikes] = await Promise.all([
        state.getRecentLoves(15, userId),
        state.getRecentDislikes(15, userId),
    ]);

    if (loves.length === 0 && dislikes.length === 0) {
        return { ok: false, reason: 'no recent signal' };
    }

    const prompt = buildEvolverPrompt(current, loves, dislikes);
    let proposed;
    try {
        proposed = await claude.generateResponse(prompt);
    } catch (e) {
        return { ok: false, reason: 'llm error: ' + e.message };
    }

    // Validate the LLM output. Expect {artistsLove, artistsAvoid, moodSeeds, timePrefs}.
    // If any are missing, keep the current value for that field.
    if (!proposed || typeof proposed !== 'object') {
        return { ok: false, reason: 'invalid llm output (not an object)' };
    }

    const next = {
        artistsLove:  Array.isArray(proposed.artistsLove)  ? clean(proposed.artistsLove, 200) : current.artistsLove,
        artistsAvoid: Array.isArray(proposed.artistsAvoid) ? clean(proposed.artistsAvoid, 50) : current.artistsAvoid,
        moodSeeds:    Array.isArray(proposed.moodSeeds)    ? clean(proposed.moodSeeds, 10)    : current.moodSeeds,
        timePrefs:    (proposed.timePrefs && typeof proposed.timePrefs === 'object') ? proposed.timePrefs : current.timePrefs,
        weatherCity:  current.weatherCity,  // never change this automatically
        persona:      current.persona,       // never change this automatically
        __source:     'auto'
    };

    // Sanity check: refuse if the proposal would drop >50% of prior loved artists.
    // Likely the LLM hallucinated a fresh list rather than refining the existing one.
    const priorLove = new Set((current.artistsLove || []).map(s => s.toLowerCase().trim()));
    const proposedLove = new Set(next.artistsLove.map(s => s.toLowerCase().trim()));
    const kept = [...priorLove].filter(a => proposedLove.has(a)).length;
    if (priorLove.size > 4 && kept / priorLove.size < 0.5) {
        return {
            ok: false,
            reason: `sanity guard: too many prior loves dropped (kept ${kept}/${priorLove.size})`
        };
    }

    await state.saveUserTaste(userId, next);
    return { ok: true, kept, added: next.artistsLove.length - kept };
}

function buildEvolverPrompt(current, loves, dislikes) {
    return `You are refining a music listener's taste profile based on a week of behavioral signal. Output ONLY a JSON object — no preamble, no markdown fence.

## Current profile

\`\`\`json
${JSON.stringify({
    artistsLove:  current.artistsLove  || [],
    artistsAvoid: current.artistsAvoid || [],
    moodSeeds:    current.moodSeeds    || [],
    timePrefs:    current.timePrefs    || {}
}, null, 2)}
\`\`\`

## Recent loves (positive signal)

${loves.map(l => `- ${l.song_name} — ${l.artist}`).join('\n') || '(none)'}

## Recent skips / dislikes (negative signal — early skips < 0.3 position_pct are strongest)

${dislikes.map(d => `- ${d.song_name} — ${d.artist} (${d.type}${d.position_pct != null ? ` at ${(d.position_pct * 100).toFixed(0)}%` : ''})`).join('\n') || '(none)'}

## Your job

Propose a REFINED taste profile. Hard rules:

1. **Don't erase the existing loves wholesale** — at minimum keep 60% of \`artistsLove\` intact unless there's strong contrary signal.
2. **Add artists that align with recent loves** — extrapolate from the loved songs to other artists in the same neighbourhood.
3. **Add to \`artistsAvoid\` if you see ≥2 early skips of the same artist or genre cluster.**
4. **Update \`moodSeeds\` if a clear new vibe pattern emerges from the loves.**
5. **\`timePrefs\` only changes if there's signal — otherwise return existing values unchanged.**
6. **Output schema** (return ALL keys, even if unchanged):

\`\`\`json
{
  "artistsLove":   ["Name", "Name", ...],
  "artistsAvoid":  ["Name", "Name", ...],
  "moodSeeds":     ["phrase", "phrase", ...],
  "timePrefs":     { "morning": "...", "afternoon": "...", "evening": "...", "night": "..." }
}
\`\`\`

Return ONLY the JSON. Be conservative — small refinements beat dramatic rewrites.`;
}

function clean(arr, cap) {
    return [...new Set(arr.map(s => String(s).trim()).filter(Boolean))].slice(0, cap);
}

async function runForAll() {
    const candidates = await state.getEvolverCandidates(7, 5);
    const results = [];
    for (const c of candidates) {
        try {
            const r = await runForUser(c.id);
            results.push({ user: c.email, ...r });
        } catch (e) {
            results.push({ user: c.email, ok: false, reason: 'crash: ' + e.message });
        }
    }
    return results;
}

module.exports = { runForUser, runForAll };
