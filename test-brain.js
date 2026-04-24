require('dotenv').config();
const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// 👇 ------- 核心：强制 Node.js 底层网络走代理 ------- 👇
const { ProxyAgent, setGlobalDispatcher } = require('undici');
const proxyUrl = "http://192.168.247.1:7890"; // 刚才 curl 测试成功的地址
const proxyAgent = new ProxyAgent(proxyUrl);
setGlobalDispatcher(proxyAgent);
// 👆 ------------------------------------------------ 👆

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function testBrain() {
    console.log("🧠 正在唤醒 Claudio 大脑...");

    let userTaste = "";
    try {
        userTaste = fs.readFileSync('./user/taste.md', 'utf-8');
        console.log("✅ 成功读取用户品味...");
    } catch (e) {
        userTaste = "喜欢轻松的爵士乐和 R&B。";
    }

    const systemInstruction = `
        You are Claudio, a personal AI Radio DJ. 
        User's musical taste: ${userTaste}
        Current context: It's morning. The user just woke up.
        
        Task: Recommend exactly 1 song to start the user's day based on their taste.
        
        CRITICAL INSTRUCTION: You must respond ONLY with a valid JSON object. Do not include markdown formatting like \`\`\`json. 
        Use this exact schema:
        {
            "say": "The DJ's friendly spoken script greeting the user and introducing the song",
            "play": [
                {
                    "id": "12345", 
                    "name": "Song Title", 
                    "artist": "Artist Name", 
                    "reason": "Brief reason for this song"
                }
            ],
            "reason": "Your internal thought process for this segment",
            "segue": "direct"
        }
    `;

    try {
        const model = genAI.getGenerativeModel({
            model: "gemini-3-flash-preview",
            generationConfig: { responseMimeType: "application/json" }
        });

        console.log("📡 已强制代理，正在向 Gemini 发送脑电波...\n");
        const result = await model.generateContent(systemInstruction);
        const responseText = result.response.text();

        const jsonObj = JSON.parse(responseText);
        console.log("🎉 ============ 唤醒成功！============");
        console.log("🎙️ Claudio 准备说的话：\n", `"${jsonObj.say}"`);
        console.log("🎵 准备播放的歌曲：\n", `${jsonObj.play[0].name} - ${jsonObj.play[0].artist}`);
        console.log("=====================================\n");

    } catch (error) {
        console.error("❌ 依然失败：", error.message);
    }
}

testBrain();