const express = require('express');
const fetch = require('node-fetch');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const CONFIG = {
  username: process.env.WEBTOP_USERNAME,
  password: process.env.WEBTOP_PASSWORD,
  emailTo: process.env.EMAIL_TO || 'woodtami@gmail.com',
  emailFrom: process.env.EMAIL_FROM,
  emailPass: process.env.EMAIL_PASS,
  institutionCode: process.env.INSTITUTION_CODE || '413856',
};

const BASE = 'https://webtopserver.smartschool.co.il/server/api';

async function login() {
  const resp = await fetch(`${BASE}/user/LoginByUserNameAndPassword`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': 'https://webtop.smartschool.co.il' },
    body: JSON.stringify({
      UserName: CONFIG.username,
      Password: CONFIG.password,
      RememberMe: true,
      BiometricLogin: '',
      Data: '',
      UniqueId: '',
      captcha: '',
      deviceDataJson: '{"isMobile":false,"isTablet":false,"isDesktop":true}'
    })
  });
  const cookies = resp.headers.raw()['set-cookie'];
  if (!cookies) throw new Error('Login failed - no cookies returned');
  return cookies.map(c => c.split(';')[0]).join('; ');
}

async function getInitData(cookieStr) {
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const resp = await fetch(`${BASE}/WeeklyScedule/InitData`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': 'https://webtop.smartschool.co.il', 'Cookie': cookieStr },
    body: JSON.stringify({
      ChildId: null, ClassCode: null, ClassNum: null,
      InstitutionCode: null,
      SelectedDate: today.toISOString(),
      View: 'weekly', item: '', language: 'he', spaceId: 0, year: today.getFullYear()
    })
  });
  return await resp.json();
}

async function getEvents(cookieStr, initData, dateOffset = 0) {
  const base = new Date();
  base.setDate(base.getDate() + dateOffset * 7);
  base.setHours(12, 0, 0, 0);
  const resp = await fetch(`${BASE}/WeeklyScedule/GetEvents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': 'https://webtop.smartschool.co.il', 'Cookie': cookieStr },
    body: JSON.stringify({
      ChildId: initData.childId || null,
      ClassCode: initData.classCode || null,
      ClassNum: initData.classNum || null,
      InstitutionCode: initData.institutionCode || CONFIG.institutionCode,
      SelectedDate: base.toISOString(),
      View: 'weekly',
      getBySendDate: true,
      language: 'he',
      readFromMaster: true,
      year: base.getFullYear(),
      SpaceId: 0
    })
  });
  return await resp.json();
}

async function fetchTimetable(dateOffset = 0) {
  const cookies = await login();
  const initData = await getInitData(cookies);
  const events = await getEvents(cookies, initData, dateOffset);
  return Array.isArray(events) ? events : (events.events || events.data || []);
}

function getTodayEvents(events) {
  const today = new Date();
  const todayStr = today.toISOString().substring(0, 10);
  return events.filter(e => e.date && e.date.startsWith(todayStr));
}

function formatEventsHtml(events, title) {
  const dayEvents = getTodayEvents(events);
  if (dayEvents.length === 0) return `<p>No lessons found for today.</p>`;
  const sorted = dayEvents.sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
  const rows = sorted.map(e => {
    const period = e.startTime && e.startTime !== 1 ? `<td style="color:#888;font-size:12px;padding:6px 12px 6px 0">שיעור ${e.startTime}</td>` : '<td></td>';
    const desc = e.description ? `<div style="font-size:12px;color:#888;margin-top:3px">${e.description.replace(/\\n/g, ' ').substring(0, 100)}</div>` : '';
    return `<tr><td style="padding:10px 0;border-bottom:1px solid #f0f0f0">${period}<strong>${e.title || ''}</strong>${desc}</td></tr>`;
  }).join('');
  return `<table style="width:100%;border-collapse:collapse">${rows}</table>`;
}

async function sendEmail(events) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: CONFIG.emailFrom, pass: CONFIG.emailPass }
  });
  const today = new Date();
  const dateStr = today.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' });
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto">
      <div style="background:#185FA5;color:white;padding:20px;border-radius:8px 8px 0 0">
        <h2 style="margin:0;font-size:18px">📚 Timetable for ${dateStr}</h2>
      </div>
      <div style="background:#fff;padding:20px;border:1px solid #e0e0e0;border-radius:0 0 8px 8px">
        ${formatEventsHtml(events)}
      </div>
      <p style="font-size:11px;color:#aaa;text-align:center;margin-top:12px">
        Sent automatically from your Webtop timetable checker
      </p>
    </div>`;
  await transporter.sendMail({
    from: CONFIG.emailFrom,
    to: CONFIG.emailTo,
    subject: `📚 Today's timetable — ${dateStr}`,
    html
  });
  console.log('Email sent successfully');
}

// API routes
app.get('/api/timetable', async (req, res) => {
  try {
    const offset = parseInt(req.query.offset) || 0;
    const events = await fetchTimetable(offset);
    res.json({ success: true, events });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/send-email', async (req, res) => {
  try {
    const events = await fetchTimetable(0);
    await sendEmail(events);
    res.json({ success: true, message: 'Email sent!' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Daily cron — 6:30am Israel time (UTC+3 = 03:30 UTC)
cron.schedule('30 3 * * 0-4', async () => {
  console.log('Running scheduled timetable email...');
  try {
    const events = await fetchTimetable(0);
    await sendEmail(events);
  } catch (e) {
    console.error('Scheduled email failed:', e.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
