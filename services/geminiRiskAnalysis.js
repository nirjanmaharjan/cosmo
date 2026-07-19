'use strict';

const { GoogleGenAI } = require('@google/genai');
const db = require('../db');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ai = GEMINI_API_KEY && GEMINI_API_KEY !== 'your_gemini_api_key_here'
  ? new GoogleGenAI({ apiKey: GEMINI_API_KEY })
  : null;

const CACHE_TTL = 30 * 60 * 1000;
let analysisCache = null;
let cacheTimestamp = null;

function promisifyAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function getCached(key) {
  if (analysisCache && cacheTimestamp && (Date.now() - cacheTimestamp) < CACHE_TTL) {
    return analysisCache;
  }
  return null;
}

function setCache(data) {
  analysisCache = data;
  cacheTimestamp = Date.now();
}

function clearCache() {
  analysisCache = null;
  cacheTimestamp = null;
}

async function fetchAllComplaints() {
  return promisifyAll(`SELECT id, title, description, status, category, faculty, priority, is_sensitive, department, votes, progress, submitter_id, created_at, updated_at FROM complaints ORDER BY created_at DESC`);
}

async function fetchAllUsers() {
  return promisifyAll(`SELECT id, name, email, roll_number, class_name, section, degree_faculty, role FROM users`);
}

function computeStats(complaints, users) {
  const total = complaints.length;
  const resolved = complaints.filter(c => c.status === 'Resolved').length;
  const pending = complaints.filter(c => c.status === 'Pending').length;
  const underReview = complaints.filter(c => c.status === 'Under Review').length;
  const sensitive = complaints.filter(c => c.is_sensitive).length;

  const categoryDist = {};
  const facultyDist = {};
  const priorityDist = { High: 0, Medium: 0, Low: 0 };
  const monthlyTrend = {};
  const weeklyTrend = {};
  const departmentRisks = {};
  const locationRisks = {};

  complaints.forEach(c => {
    const cat = c.category || 'Unspecified';
    categoryDist[cat] = (categoryDist[cat] || 0) + 1;

    const fac = c.faculty || 'Unspecified';
    facultyDist[fac] = (facultyDist[fac] || 0) + 1;

    const pri = c.priority || 'Medium';
    if (priorityDist[pri] !== undefined) priorityDist[pri]++;

    const d = c.faculty || 'Unspecified';
    if (!departmentRisks[d]) departmentRisks[d] = { count: 0, high: 0, pending: 0, resolved: 0, sensitive: 0 };
    departmentRisks[d].count++;
    if (c.priority === 'High') departmentRisks[d].high++;
    if (c.status === 'Pending' || c.status === 'Under Review') departmentRisks[d].pending++;
    if (c.status === 'Resolved') departmentRisks[d].resolved++;
    if (c.is_sensitive) departmentRisks[d].sensitive++;

    const loc = c.faculty || 'Unspecified';
    if (!locationRisks[loc]) locationRisks[loc] = { count: 0, high: 0, pending: 0, resolved: 0, sensitive: 0 };
    locationRisks[loc].count++;
    if (c.priority === 'High') locationRisks[loc].high++;
    if (c.status === 'Pending' || c.status === 'Under Review') locationRisks[loc].pending++;
    if (c.status === 'Resolved') locationRisks[loc].resolved++;
    if (c.is_sensitive) locationRisks[loc].sensitive++;

    if (c.created_at) {
      const month = c.created_at.slice(0, 7);
      monthlyTrend[month] = (monthlyTrend[month] || 0) + 1;

      let day;
      try {
        day = new Date(c.created_at).toISOString().slice(0, 10);
      } catch {
        day = c.created_at.slice(0, 10);
      }
      weeklyTrend[day] = (weeklyTrend[day] || 0) + 1;
    }
  });

  const sortedMonths = Object.keys(monthlyTrend).sort();
  const sortedWeeks = Object.keys(weeklyTrend).sort();

  return {
    total,
    resolved,
    pending,
    underReview,
    sensitive,
    resolutionRate: total > 0 ? Math.round((resolved / total) * 100) : 0,
    categoryDist,
    facultyDist,
    priorityDist,
    monthlyTrend: sortedMonths.map(m => ({ month: m, count: monthlyTrend[m] })),
    weeklyTrend: sortedWeeks.slice(-90).map(d => ({ date: d, count: weeklyTrend[d] })),
    departmentRisks,
    locationRisks,
  };
}

function findRepeatComplaints(complaints) {
  const titleMap = {};
  complaints.forEach(c => {
    const key = c.title.toLowerCase().replace(/[^a-z0-9]/g, '').trim();
    if (key.length > 5) {
      if (!titleMap[key]) titleMap[key] = [];
      titleMap[key].push({ id: c.id, title: c.title, created_at: c.created_at, faculty: c.faculty, department: c.department });
    }
  });
  return Object.values(titleMap).filter(g => g.length > 1);
}

function buildAnonymizedPayload(complaints, users, stats, repeats) {
  const studentMap = {};
  users.forEach(u => {
    if (u.role === 'student') {
      studentMap[u.id] = { dept: u.degree_faculty || 'Unknown', section: u.section || 'Unknown', class: u.class_name || 'Unknown' };
    }
  });

  const anonymized = complaints.map(c => ({
    id: c.id,
    category: c.category,
    faculty: c.faculty,
    priority: c.priority,
    department: c.department,
    status: c.status,
    is_sensitive: !!c.is_sensitive,
    votes: c.votes,
    month: c.created_at ? c.created_at.slice(0, 7) : 'unknown',
    title_simhash: c.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30),
  }));

  return {
    summary: {
      total_complaints: stats.total,
      resolved: stats.resolved,
      pending: stats.pending,
      sensitive: stats.sensitive,
      resolution_rate: stats.resolutionRate + '%',
    },
    category_breakdown: stats.categoryDist,
    faculty_breakdown: stats.facultyDist,
    priority_breakdown: stats.priorityDist,
    monthly_trend: stats.monthlyTrend,
    repeat_complaint_groups: repeats.map(g => ({
      count: g.length,
      departments: [...new Set(g.map(r => r.department || r.faculty))],
      first_reported: g[0].created_at,
      latest_reported: g[g.length - 1].created_at,
    })),
    anonymized_complaints: anonymized.slice(0, 200),
  };
}

async function callGeminiAnalysis(payload) {
  if (!ai) {
    console.warn('[geminiRiskAnalysis] GEMINI_API_KEY not configured; skipping AI analysis.');
    return null;
  }

  const prompt = `You are a campus safety risk analysis AI. Analyze the following complaint data from a college and produce a structured risk assessment.

DATA:
${JSON.stringify(payload, null, 2)}

Return a JSON object with exactly these fields:
{
  "overallRiskScore": number 0-100,
  "overallRiskLevel": "Low"|"Medium"|"High"|"Critical",
  "riskSummary": string (1-2 sentences),
  "departmentRisks": [{ "department": string, "riskLevel": "Low"|"Medium"|"High"|"Critical", "riskScore": number 0-100, "factors": [string], "trend": "increasing"|"decreasing"|"stable" }],
  "locationRisks": [{ "location": string, "riskLevel": "Low"|"Medium"|"High"|"Critical", "riskScore": number 0-100, "factors": [string] }],
  "insights": [{ "title": string, "description": string, "severity": "Low"|"Medium"|"High"|"Critical", "change": string (e.g. "+43%"), "recommendedAction": string }],
  "predictedTrends": [{ "category": string, "prediction": "increasing"|"decreasing"|"stable", "confidence": number 0-100, "detail": string }],
  "recommendations": [{ "area": string, "priority": "Low"|"Medium"|"High"|"Critical", "action": string, "reason": string }],
  "heatmapData": [{ "location": string, "riskScore": number 0-100, "color": "green"|"yellow"|"orange"|"red", "complaintCount": number }],
  "repeatOffenderInsights": string | null,
  "bullyingRiskAssessment": string | null
}

IMPORTANT: Only return valid JSON. No markdown, no code fences.`;

  const candidateModels = [
    process.env.GEMINI_MODEL,
    'gemini-2.5-pro',
    'gemini-2.0-flash',
    'gemini-1.5-flash',
  ].filter(Boolean);

  let lastErr;
  let response = null;

  for (const model of candidateModels) {
    try {
      response = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          temperature: 0.2,
          maxOutputTokens: 4096,
        },
      });
      break;
    } catch (err) {
      lastErr = err;
    }
  }

  if (!response) {
    console.error('[geminiRiskAnalysis] All Gemini models failed:', lastErr?.message);
    return null;
  }

  try {
    const text = response.text || '';
    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1) {
      console.error('[geminiRiskAnalysis] No JSON found in Gemini response');
      return null;
    }
    const jsonStr = text.slice(jsonStart, jsonEnd + 1);
    return JSON.parse(jsonStr);
  } catch (err) {
    console.error('[geminiRiskAnalysis] Parse error:', err.message);
    return null;
  }
}

async function getRiskDashboard() {
  const cached = getCached();
  if (cached) return cached;

  try {
    const [complaints, users] = await Promise.all([fetchAllComplaints(), fetchAllUsers()]);
    const stats = computeStats(complaints, users);
    const repeats = findRepeatComplaints(complaints);

    let aiResult = null;
    try {
      const payload = buildAnonymizedPayload(complaints, users, stats, repeats);
      aiResult = await callGeminiAnalysis(payload);
    } catch (aiErr) {
      console.error('[geminiRiskAnalysis] AI analysis error:', aiErr.message);
    }

    const result = {
      computedAt: new Date().toISOString(),
      stats,
      repeatComplaints: repeats,
      ai: aiResult,
    };

    setCache(result);
    return result;
  } catch (err) {
    console.error('[geminiRiskAnalysis] Error:', err.message);
    throw err;
  }
}

async function generateAiReport() {
  const dashboard = await getRiskDashboard();

  if (!ai) {
    return { ...dashboard, report: null };
  }

  const stats = dashboard.stats;
  const payload = {
    summary: {
      total_complaints: stats.total,
      resolved: stats.resolved,
      pending: stats.pending,
      sensitive: stats.sensitive,
      resolution_rate: stats.resolutionRate + '%',
    },
    category_breakdown: stats.categoryDist,
    faculty_breakdown: stats.facultyDist,
    priority_breakdown: stats.priorityDist,
    monthly_trend: stats.monthlyTrend,
    department_risks: stats.departmentRisks,
  };

  const reportPrompt = `You are a campus safety report generator. Based on the following complaint data, produce a concise executive report.

DATA:
${JSON.stringify(payload, null, 2)}

Return a JSON object with exactly these fields:
{
  "executiveSummary": string (2-3 sentences summarizing overall campus safety),
  "topRisks": [{ "risk": string, "severity": "Low"|"Medium"|"High"|"Critical" }],
  "keyMetrics": { "totalComplaints": number, "resolutionRate": string, "criticalDepartments": [string] },
  "recommendedPriorities": [string]
}

IMPORTANT: Only return valid JSON. No markdown, no code fences.`;

  try {
    const reportModels = [
      process.env.GEMINI_MODEL,
      'gemini-2.5-pro',
      'gemini-2.0-flash',
      'gemini-1.5-flash',
    ].filter(Boolean);

    let reportResponse = null;
    let reportErr = null;
    for (const model of reportModels) {
      try {
        reportResponse = await ai.models.generateContent({
          model,
          contents: reportPrompt,
          config: { temperature: 0.3, maxOutputTokens: 2048 },
        });
        break;
      } catch (err) {
        reportErr = err;
      }
    }

    if (!reportResponse) {
      console.error('[geminiRiskAnalysis] Report: all models failed:', reportErr?.message);
      return { ...dashboard, report: null };
    }

    const text = reportResponse.text || '';
    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    if (jsonStart !== -1 && jsonEnd !== -1) {
      const report = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
      return { ...dashboard, report };
    }

    return { ...dashboard, report: null };
  } catch (err) {
    console.error('[geminiRiskAnalysis] Report generation error:', err.message);
    return { ...dashboard, report: null };
  }
}

module.exports = { getRiskDashboard, generateAiReport, clearCache };