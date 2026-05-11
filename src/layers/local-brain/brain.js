const claude = require('./claude');
const gemini = require('./gemini');

// Orchestrates the LLM brains for Claudio:
//   1. Try Claude CLI (primary)
//   2. On failure, try Gemini REST (fallback)
//   3. On both failing, return a safe canned response so the radio keeps spinning.
//
// Order can be overridden with BRAIN_ORDER, e.g. "gemini,claude" to flip it.
const SAFE_FALLBACK = Object.freeze({
    say: '我的思路刚才断了一下，不过音乐还在。',
    play: [],
    reason: 'all brains failed',
    segue: 'direct'
});

const REGISTRY = { claude, gemini };

function resolveOrder() {
    const raw = process.env.BRAIN_ORDER || 'claude,gemini';
    const order = raw.split(',').map((s) => s.trim()).filter((s) => REGISTRY[s]);
    return order.length ? order : ['claude', 'gemini'];
}

class Brain {
    async generateResponse(prompt) {
        const order = resolveOrder();
        for (const name of order) {
            try {
                const result = await REGISTRY[name].generateResponse(prompt);
                if (result && typeof result === 'object') return result;
                throw new Error(`${name}: non-object response`);
            } catch (err) {
                console.warn(`[Brain] ${name} 失败：${err.message}`);
            }
        }
        console.error('[Brain] 全部大脑失败，使用 SAFE_FALLBACK');
        return { ...SAFE_FALLBACK };
    }
}

module.exports = new Brain();
