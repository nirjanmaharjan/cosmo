// utils/aiCategorizer.js — AI-powered complaint categorization & sensitivity detection
'use strict';

// groq-sdk export style may differ between versions (default vs named export)
const { GoogleGenAI } = require('@google/genai');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const ai = GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: GEMINI_API_KEY })
  : null;


// Low-priority keywords (purely cosmetic/trivial suggestions)
const LOW_PRIORITY_KEYWORDS = [
  'suggestion', 'suggest', 'recommend', 'minor', 'cosmetic', 'paint',
  'noisy', 'loud', 'small', 'trivial',
  'aesthetic', 'decor', 'appearance', 'noise', 'timing', 'schedule',
];

// High-priority keywords (urgent/health/safety)
const HIGH_PRIORITY_KEYWORDS = [
  'emergency', 'urgent', 'immediately', 'asap', 'critical',
  'safety', 'unsafe', 'hazard', 'danger', 'dangerous',
  'health', 'injury', 'bleeding', 'accident', 'fire', 'gas leak',
  'exposed wiring', 'short circuit', 'electrical', 'flood', 'water leak',
  'harass', 'abuse', 'threat', 'attack', 'violen', 'assault',
  'discrim', 'sexual', 'bully', 'bulli', 'ragging', 'ragged',
  'suicid', 'depress', 'crisis', 'drug', 'alcohol', 'poison',
  'broken bone', 'fracture', 'medical', 'hospital', 'ambulance',
  'mold', 'pest', 'infest', 'contamin', 'toxic', 'sewage',
  'stuck', 'trapped', 'locked', 'structural', 'collapse',
];

function classifyPriority(title, description) {
  const text = `${title} ${description}`.toLowerCase();
  if (HIGH_PRIORITY_KEYWORDS.some(kw => text.includes(kw))) return 'High';
  if (LOW_PRIORITY_KEYWORDS.some(kw => text.includes(kw))) return 'Low';
  return 'Medium';
}

const VALID_FACULTIES = ['Food', 'Library', 'Hostel', 'Infrastructure', 'Staff', 'IT', 'Transport', 'Administration', 'Others'];
const VALID_PRIORITIES = ['High', 'Medium', 'Low'];

/**
 * Local fallback scanner using sensitive keywords if AI API fails or is unavailable.
 */
function hasSensitiveKeywords(title, description) {
  const text = `${title} ${description}`.toLowerCase();
  const sensitiveKeywords = [
    'harass', 'abuse', 'discrim', 'threat', 'bulli', 'bully', 'assault',
    'ragging', 'ragged', 'haze', 'hazing', 'misbehav', 'bad character',
    'sex', 'sexual', 'mental', 'crisis', 'suicid', 'depress', 'anxiety',
    'violen', 'fight', 'drug', 'substance', 'alcohol', 'steal', 'theft',
    'weapon', 'bribe', 'corruption', 'unsafe', 'unsanitary', 'mold', 'pest',
    'physical', 'verbal', 'misconduct', 'predator', 'stalk',
    'intimidat', 'extort', 'blackmail', 'coercion', 'unsolicited',
    'inappropriate', 'touching', 'grop', 'explicit', 'pornograph',
    'nude', 'naked', 'private parts', 'filthy', 'hazard', 'danger', 'emergency', 'injury',
    'bleeding', 'attack', 'hostile', 'toxic', 'poison', 'contamin',
  ];
  return sensitiveKeywords.some(keyword => text.includes(keyword));
}

// Secondary guard: always run keyword check regardless of AI result
function isSensitiveContent(title, description, aiResult) {
  if (aiResult && aiResult.is_sensitive === true) return true;
  return hasSensitiveKeywords(title, description);
}

/**
 * Categorize a complaint using Gemini API
 * Returns { is_sensitive, faculty, priority }
 */
async function categorizeComplaint(title, description) {
  if (!ai) {
    // Gemini not configured; fall back to keyword-based detection.
    console.warn('[aiCategorizer] GEMINI_API_KEY not set; using fallback categorization.');
    return { is_sensitive: isSensitiveContent(title, description), faculty: 'Others', priority: classifyPriority(title, description) };
  }

  try {
    const prompt = `Analyze this college complaint and categorize it.

Title: "${title}"
Description: "${description}"

Guidelines:
- is_sensitive: true if complaint contains: harassment, sexual harassment, discrimination, abuse, safety threats, mental health crisis, sexual misconduct, substance abuse, health violations, bullying, violence, assault, or any concerning personal issues
- faculty: categorize based on department (Food for dining, Library for library services, Hostel for hostel issues, Infrastructure for building/facilities, Staff for staff-related issues, IT for computer/network/tech issues, Transport for bus/parking/transportation, Administration for paperwork/fees/admin offices, Others as default)
- priority: Low only for purely cosmetic or trivial suggestions with no impact on daily work (e.g. repaint walls, rearrange furniture, add plants). Medium for broken equipment affecting student work (broken board, projector not working, broken screen, not working devices), unclean facilities (dirty toilets, dirty classrooms), service delays, poor food quality, internet issues, and other issues that make daily student life harder. High for urgent/health/safety issues, harassment, abuse, discrimination, security threats, violence, health hazards, emergency repairs (e.g. exposed wiring, gas leak)`;

    const candidateModels = [
      process.env.GEMINI_MODEL,
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
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
      return { is_sensitive: isSensitiveContent(title, description), faculty: 'Others', priority: classifyPriority(title, description) };
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
      return { is_sensitive: isSensitiveContent(title, description), faculty: 'Others', priority: classifyPriority(title, description) };
    }


    // Validate and sanitize response
    const is_sensitive = typeof result.is_sensitive === 'boolean' ? result.is_sensitive : false;
    const faculty = VALID_FACULTIES.includes(result.faculty) ? result.faculty : 'Others';
    const priority = VALID_PRIORITIES.includes(result.priority) ? result.priority : classifyPriority(title, description);

    // Secondary guard: keyword check overrides AI if it misses sensitive content
    const finalSensitive = isSensitiveContent(title, description, { is_sensitive });
    return { is_sensitive: finalSensitive, faculty, priority };
  } catch (err) {
    console.error('AI categorization error:', err);
    return { is_sensitive: isSensitiveContent(title, description), faculty: 'Others', priority: classifyPriority(title, description) };
  }
}

module.exports = { categorizeComplaint, hasSensitiveKeywords, classifyPriority };
