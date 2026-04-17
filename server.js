const express = require('express');
const fetch = require('node-fetch');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const CONFIG = {
  emailTo: process.env.EMAIL_TO || 'woodtami@gmail.com',
  emailFrom: process.env.EMAIL_FROM,
  emailPass: process.env.EMAIL_PASS,
  institutionCode: process.env.INSTITUTION_CODE || '413856',
  webtopToken: process.env.WEBTOP_TOKEN,
  childId: process.env.CHILD_ID || '',
  classCode: process.env.CLASS_CODE || '',
  classNum: process.env.CLASS_NUM || '',
};

const BASE = 'https://webtopserver.smartschool.co.il/server/api';

function getCookies() {
  if (!CONFIG.webtopToken) throw new Error('WEBTOP_TOKEN not set');
  return `webToken=${decodeURIComponent(CONFIG.webtopToken)}`;
}

async function safeJson(resp) {
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch(e) {
    throw new Error(`Server returned non-JSON (status ${resp.status}): ${text.substring(0, 200)}`);
  }
}

async function getInitData(cookieStr) {
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const resp = await fetch(`${BASE}/WeeklyScedule/InitData`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': 'https://webtop.smartschool.co.il',
      'Referer': 'https://webtop.smartschool.co.il/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Cookie': cookieStr
    },
    body: JSON.stringify({
      ChildId: null, ClassCode: null, ClassNum: null,
      InstitutionCode: null,
      SelectedDate: today.toISOString(),
      View: 'weekly', item: '', language: 'he', spaceId: 0, year: today.getFullYear()
    })
  });
  return await safeJson(resp);
}

async function getEvents(cookieStr, initData, dateOffset = 0) {
  const base = new Date();
  base.setDate(base.getDate() + dateOffset * 7);
  base.setHours(12, 0, 0, 0);
  const resp = await fetch(`${BASE}/WeeklyScedule/GetEvents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': 'https://webtop.smartschool.co.il',
      'Referer': 'https://webtop.smartschool.co.il/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Cookie': cookieStr
    },
    body: JSON.stringify({
      ChildId: initData.childId || CONFIG.childId || null,
      ClassCode: initData.classCode || CONFIG.classCode || null,
      ClassNum: initData.classNum || CONFIG.classNum || null,
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
  return await safeJson(resp);
}

async function fetchTimetable(dateOffset = 0) {
  const cookies = getCookies();
  const initData = await getInitData(cookies);
  console.log('InitData result:', JSON.stringify(initData).substring(0, 300));
  const events = await getEvents(cookies, initData, dateOffset);
  return Array.isArray(events) ? events : (events.events || events.data || []);
}

function getTodayEvents(events) {
  const today = new Date();
  const todayStr = today.toISOString().substring(0, 10);
  return events.filter(e => e.date && e.date.startsWith(todayStr));
}

function formatEventsHtml(events) {
  const dayEvents = getTodayEvents(events);
  if (dayEvents.length === 0) return '<p>No lessons found for today.</p>';
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

app.get('/api/timetable', async (req, res) => {
  try {
    const offset = parseInt(req.query.offset) || 0;
    const events = await fetchTimetable(offset);
    res.json({ success: true, events });
  } catch (e) {
    console.error('Timetable error:', e.message);
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

// Daily email 7:00am Israel time (UTC+3 = 04:00 UTC), Sun-Fri
cron.schedule('0 4 * * 0-5', async () => {
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
