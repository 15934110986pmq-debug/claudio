const { spawn } = require('child_process');

// Invokes claude -p --output json, parses NDJSON and extracts the result line.
// The prompt must ask Claude to respond with JSON only: {say, play[], reason, segue}
class ClaudeBrain {
    async generateResponse(prompt) {
        return new Promise((resolve, reject) => {
            const proc = spawn('claude', ['--print', '--output', 'json', '--no-ansi'], {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env }
            });

            let stdout = '';
            let stderr = '';

            proc.stdout.on('data', (d) => { stdout += d.toString(); });
            proc.stderr.on('data', (d) => { stderr += d.toString(); });

            proc.stdin.write(prompt);
            proc.stdin.end();

            proc.on('close', (code) => {
                if (code !== 0 && !stdout) {
                    console.error('[Claude] stderr:', stderr);
                    return resolve(this._fallback(`exit code ${code}`));
                }

                // NDJSON: find the {type:"result"} line
                const lines = stdout.trim().split('\n');
                for (let i = lines.length - 1; i >= 0; i--) {
                    try {
                        const obj = JSON.parse(lines[i]);
                        if (obj.type === 'result' && obj.result) {
                            // Strip markdown code fences if present
                            const raw = obj.result.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
                            try {
                                return resolve(JSON.parse(raw));
                            } catch {
                                // result isn't JSON — fallback
                                return resolve(this._fallback('result not JSON: ' + obj.result.slice(0, 80)));
                            }
                        }
                    } catch {}
                }

                console.error('[Claude] Could not find result in output:', stdout.slice(0, 200));
                resolve(this._fallback('no result line found'));
            });

            proc.on('error', (err) => {
                console.error('[Claude] spawn error:', err.message);
                resolve(this._fallback(err.message));
            });
        });
    }

    _fallback(reason) {
        console.warn('[Claude] fallback triggered:', reason);
        return {
            say: '我的思路刚才断了一下，不过音乐还在。',
            play: [],
            reason: reason,
            segue: 'direct'
        };
    }
}

module.exports = new ClaudeBrain();
