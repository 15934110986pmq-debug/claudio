const fs = require('fs-extra');
const path = require('path');

class ContextAggregator {
    async assemble(userInput, environment = {}) {
        const paths = {
            persona: path.join(__dirname, '../../../prompts/dj-persona.md'),
            taste: path.join(__dirname, '../../../user/taste.md'),
            routines: path.join(__dirname, '../../../user/routines.md'),
            mood: path.join(__dirname, '../../../user/mood-rules.md')
        };

        const [persona, taste, routines, mood] = await Promise.all([
            fs.readFile(paths.persona, 'utf8').catch(() => ""),
            fs.readFile(paths.taste, 'utf8').catch(() => ""),
            fs.readFile(paths.routines, 'utf8').catch(() => ""),
            fs.readFile(paths.mood, 'utf8').catch(() => "")
        ]);

        return `
            SYSTEM: ${persona}
            USER TASTE: ${taste}
            DAILY ROUTINES: ${routines}
            MOOD RULES: ${mood}
            
            ENVIRONMENT: ${JSON.stringify(environment)}
            CURRENT TIME: ${new Date().toISOString()}
            
            USER INPUT: ${userInput}
            
            Please respond in the following JSON format ONLY:
            {
                "say": "string (what the DJ says)",
                "play": [{"id": "string", "name": "string", "artist": "string", "reason": "string"}],
                "reason": "string (internal logic)",
                "segue": "string (transition style)"
            }
        `;
    }
}

module.exports = new ContextAggregator();
