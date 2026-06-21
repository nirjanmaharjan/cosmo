// utils/aiCategorizer.js — AI-powered complaint categorization & sensitivity detection
'use strict';

// groq-sdk export style may differ between versions (default vs named export)
const { GoogleGenAI } = require('@google/genai');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const ai = GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: GEMINI_API_KEY })
  : null;


const VALID_FACULTIES = ['Food', 'Library', 'Hostel', 'Infrastructure', 'Staff', 'Others'];
const VALID_PRIORITIES = ['High', 'Medium', 'Low'];

/**
 * Local fallback scanner using sensitive keywords if AI API fails or is unavailable.
 */
function hasSensitiveKeywords(title, description) {
  const text = `${title} ${description}`.toLowerCase();
  const sensitiveKeywords = [
    'harass', 'abuse', 'discrim', 'threat', 'bully', 'assault', 'sex', 
    'mental', 'crisis', 'suicid', 'depress', 'violen', 'fight', 'drug',
    'substance', 'alcohol', 'steal', 'theft', 'weapon', 'bribe', 'corruption'
  ];
  return sensitiveKeywords.some(keyword => text.includes(keyword));
}

/**
 * Categorize a complaint using Gemini API
 * Returns { is_sensitive, faculty, priority }
 */
async function categorizeComplaint(title, description) {
  if (!ai) {
    // Gemini not configured; fall back to keyword-based detection.
    console.warn('[aiCategorizer] GEMINI_API_KEY not set; using fallback categorization.');
    return { is_sensitive: hasSensitiveKeywords(title, description), faculty: 'Others', priority: 'Medium' };
  }


  try {
    const prompt = `Analyze this college complaint and categorize it.

Title: "${title}"
Description: "${description}"

Guidelines:
- is_sensitive: true if complaint contains: harassment, sexual harassment, discrimination, abuse, safety threats, mental health crisis, sexual misconduct, substance abuse, health violations, bullying, violence, assault, or any concerning personal issues
- faculty: categorize based on department (Food for dining, Library for library services, Hostel for hostel issues, Infrastructure for building/facilities, Staff for staff-related issues, Others as default)
- priority: High for urgent/health/safety issues, sexual harassment, harassment, abuse, discrimination, security threats; Medium for standard complaints; Low for minor issues`;

    const candidateModels = [
      process.env.GEMINI_MODEL,
      'gemini-2.5-flash',
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
            responseMimeType: 'application/json',
            responseSchema: {
              type: 'OBJECT',
              properties: {
                is_sensitive: { type: 'BOOLEAN' },
                faculty: { type: 'STRING', enum: VALID_FACULTIES },
                priority: { type: 'STRING', enum: VALID_PRIORITIES }
              },
              required: ['is_sensitive', 'faculty', 'priority']
            },
            temperature: 0,
          }
        });
        break;
      } catch (err) {
        lastErr = err;
      }
    }

    if (!response) {
      console.error('[aiCategorizer] Gemini call failed for all candidate models:', {
        message: lastErr?.message,
      });
      return { is_sensitive: hasSensitiveKeywords(title, description), faculty: 'Others', priority: 'Medium' };
    }

    const text = response.text || '';

    let result;
    try {
      result = JSON.parse(text);
    } catch (e) {
      console.warn('Failed to parse AI response JSON.', {
        raw: String(text).slice(0, 500),
        error: e?.message,
      });
      return { is_sensitive: hasSensitiveKeywords(title, description), faculty: 'Others', priority: 'Medium' };
    }


    // Validate and sanitize response
    const is_sensitive = typeof result.is_sensitive === 'boolean' ? result.is_sensitive : false;
    const faculty = VALID_FACULTIES.includes(result.faculty) ? result.faculty : 'Others';
    const priority = VALID_PRIORITIES.includes(result.priority) ? result.priority : 'Medium';

    return { is_sensitive, faculty, priority };
  } catch (err) {
    console.error('AI categorization error:', err);
    return { is_sensitive: hasSensitiveKeywords(title, description), faculty: 'Others', priority: 'Medium' };
  }
}

module.exports = { categorizeComplaint };
