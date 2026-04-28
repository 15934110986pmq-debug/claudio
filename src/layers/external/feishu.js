const axios = require('axios');
require('dotenv').config();

// Fetches today's calendar events from Feishu (Lark) Open API.
// Requires: FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_USER_ACCESS_TOKEN (or set via OAuth flow)
// Returns an array of event title strings.

let _tenantToken = null;
let _tokenExpiry = 0;

async function getTenantAccessToken() {
    if (_tenantToken && Date.now() < _tokenExpiry) return _tenantToken;

    const { data } = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        app_id: process.env.FEISHU_APP_ID,
        app_secret: process.env.FEISHU_APP_SECRET
    });

    _tenantToken = data.tenant_access_token;
    _tokenExpiry = Date.now() + (data.expire - 60) * 1000;
    return _tenantToken;
}

async function getTodayEvents() {
    const appId = process.env.FEISHU_APP_ID;
    const appSecret = process.env.FEISHU_APP_SECRET;
    const userToken = process.env.FEISHU_USER_ACCESS_TOKEN;

    if (!appId || !appSecret) {
        return ['日程未配置（未设置 FEISHU_APP_ID/FEISHU_APP_SECRET）'];
    }

    try {
        const now = new Date();
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
        const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);

        const token = userToken || await getTenantAccessToken();
        const calendarId = process.env.FEISHU_CALENDAR_ID || 'primary';

        const { data } = await axios.get(
            `https://open.feishu.cn/open-apis/calendar/v4/calendars/${calendarId}/events`,
            {
                headers: { Authorization: `Bearer ${token}` },
                params: {
                    start_time: Math.floor(startOfDay.getTime() / 1000).toString(),
                    end_time: Math.floor(endOfDay.getTime() / 1000).toString()
                },
                timeout: 5000
            }
        );

        const events = data.data?.items || [];
        if (events.length === 0) return ['今天没有日程'];

        return events.map((e) => {
            const start = e.start_time?.timestamp
                ? new Date(e.start_time.timestamp * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
                : '';
            return start ? `${start} ${e.summary}` : e.summary;
        });
    } catch (err) {
        console.error('[Feishu] calendar error:', err.response?.data || err.message);
        return ['日程获取失败'];
    }
}

module.exports = { getTodayEvents };
