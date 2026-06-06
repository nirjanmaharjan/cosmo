// utils/aiCategorizer.js — AI-powered complaint categorization & sensitivity detection
'use strict';

// groq-sdk export style may differ between versions (default vs named export)
const GroqImport = require('groq-sdk');
const Groq = GroqImport?.default || GroqImport;

const GROQ_API_KEY = process.env.GROQ_API_KEY;

const client = GROQ_API_KEY
  ? new Groq({ apiKey: GROQ_API_KEY })
  : null;


const VALID_FACULTIES = ['Food', 'Library', 'Hostel', 'Infrastructure', 'Staff', 'Others'];
const VALID_PRIORITIES = ['High', 'Medium', 'Low'];

/**
 * Categorize a complaint using Groq API
 * Returns { is_sensitive, faculty, priority }
 */
async function categorizeComplaint(title, description) {
  if (!client) {
    // Groq not configured; fall back to safe defaults.
    // Keep this explicit so you notice missing env/config during development.
    console.warn('[aiCategorizer] GROQ_API_KEY not set; using fallback categorization.');
    return { is_sensitive: false, faculty: 'Others', priority: 'Medium' };
  }


  try {
    const prompt = `Analyze this college complaint and categorize it.

Title: "${title}"
Description: "${description}"

You MUST respond with ONLY a JSON object (no markdown, no code blocks, just raw JSON):
{
  "is_sensitive": true or false,
  "faculty": "one of: Food, Library, Hostel, Infrastructure, Staff, Others",
  "priority": "one of: High, Medium, Low"
}

Guidelines:
- is_sensitive: true if complaint contains: harassment, sexual harassment, discrimination, abuse, safety threats, mental health crisis, sexual misconduct, substance abuse, health violations, bullying, violence, assault, or any concerning personal issues
- faculty: categorize based on department (Food for dining, Library for library services, Hostel for hostel issues, Infrastructure for building/facilities, Staff for staff-related issues, Others as default)
- priority: High for urgent/health/safety issues, sexual harassment, harassment, abuse, discrimination, security threats; Medium for standard complaints; Low for minor issues

Respond with ONLY the JSON object.`;

    // Try a small list of candidate models because Groq frequently deprecates models.
    const candidateModels = [
      process.env.GROQ_MODEL,
      'llama-3.1-70b-versatile',
      'llama3-70b-8192',
      'llama3-8b-8192',
      'mixtral-8x7b-32768',
      'gemma2-9b-it',
      'llama2-70b-4096',
    ].filter(Boolean);

    let lastErr;
    let response = null;

    for (const model of candidateModels) {
      try {
        response = await client.chat.completions.create({
          model,
          temperature: 0,
          max_completion_tokens: 200,
          max_tokens: 200,
          messages: [
            {
              role: 'user',
              content: prompt,
            },
          ],
        });
        break;
      } catch (err) {
        lastErr = err;
      }
    }

    if (!response) {
      console.error('[aiCategorizer] Groq call failed for all candidate models:', {
        message: lastErr?.message,
      });
      return { is_sensitive: false, faculty: 'Others', priority: 'Medium' };
    }

    const text =
      response?.choices?.[0]?.message?.content ??
      response?.choices?.[0]?.delta?.content ??
      '';


    // Robust JSON extraction: grab the first {...} block.
    const match = String(text).match(/\{[\s\S]*\}/);
    const jsonText = match ? match[0] : text;

    let result;
    try {
      result = JSON.parse(jsonText);
    } catch (e) {
      console.warn('Failed to parse AI response JSON.', {
        raw: String(text).slice(0, 500),
        error: e?.message,
      });
      return { is_sensitive: false, faculty: 'Others', priority: 'Medium' };
    }


    // Validate and sanitize response
    const is_sensitive = typeof result.is_sensitive === 'boolean' ? result.is_sensitive : false;
    const faculty = VALID_FACULTIES.includes(result.faculty) ? result.faculty : 'Others';
    const priority = VALID_PRIORITIES.includes(result.priority) ? result.priority : 'Medium';

    return { is_sensitive, faculty, priority };
  } catch (err) {
    console.error('AI categorization error:', err);
    return { is_sensitive: false, faculty: 'Others', priority: 'Medium' };
  }
}

module.exports = { categorizeComplaint };
