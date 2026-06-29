// Brain provider router. Picks once at boot based on env:
//   ANTHROPIC_API_KEY set → SDK (fast, ~1-3s)
//   else                  → CLI fallback (slow ~7-30s, but works without API key)
//
// Single contract: generateResponse(prompt) → {say, play[], reason, segue}.
const useSdk = !!process.env.ANTHROPIC_API_KEY;
const provider = useSdk
    ? require('./claude-sdk')
    : require('./claude-cli');

console.log(`[Brain] provider=${useSdk ? 'sdk' : 'cli'} model=${process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001'} streaming=${useSdk}`);

module.exports = provider;
module.exports.supportsStreaming = useSdk;
