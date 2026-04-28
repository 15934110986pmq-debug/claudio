const axios = require('axios');
require('dotenv').config();

// Fetches current weather from OpenWeatherMap and returns a human-readable string.
async function getCurrentWeather() {
    const apiKey = process.env.OPENWEATHER_KEY;
    const city = process.env.WEATHER_CITY || 'Beijing';

    if (!apiKey) {
        return '天气未知（未配置 OPENWEATHER_KEY）';
    }

    try {
        const { data } = await axios.get('https://api.openweathermap.org/data/2.5/weather', {
            params: { q: city, appid: apiKey, units: 'metric', lang: 'zh_cn' },
            timeout: 5000
        });
        const desc = data.weather[0].description;
        const temp = Math.round(data.main.temp);
        const feels = Math.round(data.main.feels_like);
        return `${city} ${desc}，${temp}°C（体感${feels}°C）`;
    } catch (err) {
        console.error('[Weather] fetch error:', err.message);
        return '天气获取失败';
    }
}

module.exports = { getCurrentWeather };
