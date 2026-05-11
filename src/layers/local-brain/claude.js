const { spawn } = require('child_process');

// Invokes claude --print --output json, parses NDJSON and extracts the result line.
// The prompt must ask Claude to respond with JSON only: {say, play[], reason, segue}.
// On any failure (spawn error, non-zero exit without stdout, missing result line,
// result not parseable as JSON) this method rejects so the caller can fall back.
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
                    return reject(new Error(`claude exit ${code}: ${stderr.slice(0, 200)}`));
                }

                const lines = stdout.trim().split('\n');
                for (let i = lines.length - 1; i >= 0; i--) {
                    try {
                        const obj = JSON.parse(lines[i]);
                        if (obj.type === 'result' && obj.result) {
                            const raw = obj.result.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
                            try {
                                return resolve(JSON.parse(raw));
                            } catch {
                                return reject(new Error('claude result not JSON: ' + obj.result.slice(0, 80)));
                            }
                        }
                    } catch {}
                }

                reject(new Error('claude: no result line in output: ' + stdout.slice(0, 200)));
            });

            proc.on('error', (err) => {
                reject(new Error(`claude spawn error: ${err.message}`));
            });
        });
    }
}

module.exports = new ClaudeBrain();
