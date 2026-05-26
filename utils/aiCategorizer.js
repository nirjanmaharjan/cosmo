// utils/aiCategorizer.js — AI-powered complaint categorization & sensitivity detection
'use strict';

const Groq = require('groq-sdk').default;

const client = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

const VALID_FACULTIES = ['Food', 'Library', 'Hostel', 'Infrastructure', 'Staff', 'Others'];
const VALID_PRIORITIES = ['High', 'Medium', 'Low'];

/**
 * Categorize a complaint using Groq API
 * Returns { is_sensitive, faculty, priority }
 */
async function categorizeComplaint(title, description) {
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

    const response = await client.chat.completions.create({
      model: 'mixtral-8x7b-32768',
      max_tokens: 100,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    });

    const text = response.choices[0].message.content;
    let result;
    
    try {
      result = JSON.parse(text);
    } catch (e) {
      console.warn('Failed to parse AI response:', text);
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
