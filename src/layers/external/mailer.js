// Outbound email adapter. Reads from env, supports 3 providers:
//   - Resend         (RESEND_API_KEY)
//   - SMTP / Gmail   (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS)
//   - Console (dev)  (no env — logs magic links to stdout instead of sending)
//
// Caller doesn't care which is configured; sendMagicLink(email, token) just
// resolves to { delivered, channel } on accept, or throws on real
// configured-but-failing send.

const PUBLIC_URL = process.env.PUBLIC_URL || 'http://localhost:8080';

function isConfigured() {
    return !!(process.env.RESEND_API_KEY || (process.env.SMTP_HOST && process.env.SMTP_USER));
}

async function sendViaResend(email, link) {
    const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            from: process.env.MAIL_FROM || 'Claudio <noreply@resend.dev>',
            to: email,
            subject: 'Your Claudio sign-in link',
            html: `<p>Tap to sign in to Claudio. This link expires in 15 minutes:</p><p><a href="${link}">${link}</a></p>`,
            text: `Sign in to Claudio: ${link}\n\nExpires in 15 minutes.`
        })
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text().then(t => t.slice(0, 200))}`);
}

async function sendViaSmtp(email, link) {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '465', 10),
        secure: (process.env.SMTP_SECURE ?? 'true') === 'true',
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
    await transporter.sendMail({
        from: process.env.MAIL_FROM || process.env.SMTP_USER,
        to: email,
        subject: 'Your Claudio sign-in link',
        text: `Sign in to Claudio: ${link}\n\nExpires in 15 minutes.`,
        html: `<p>Tap to sign in to Claudio. This link expires in 15 minutes:</p><p><a href="${link}">${link}</a></p>`
    });
}

async function sendMagicLink(email, token) {
    const link = `${PUBLIC_URL}/api/auth/verify?token=${encodeURIComponent(token)}`;
    if (process.env.RESEND_API_KEY) {
        await sendViaResend(email, link);
        return { delivered: true, channel: 'resend' };
    }
    if (process.env.SMTP_HOST) {
        await sendViaSmtp(email, link);
        return { delivered: true, channel: 'smtp' };
    }
    // Dev / unconfigured: print the link so the user can click it manually.
    console.log(`[Mailer] (UNCONFIGURED) magic link for ${email}: ${link}`);
    return { delivered: false, channel: 'console', link };
}

module.exports = { sendMagicLink, isConfigured };
