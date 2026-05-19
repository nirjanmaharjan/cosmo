// utils/aiCategorizer.js — AI-powered complaint categorization
'use strict';

const OpenAI = require('openai').default;

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const VALID_CATEGORIES = ['Food Services', 'Facilities', 'Library', 'Hostel', 'Security'];
const VALID_PRIORITIES = ['High', 'Medium', 'Low'];

/**
 * Categorize a complaint using OpenAI's GPT
 * Returns { category, priority }
 */
async function categorizeComplaint(title, description) {
  try {
    const prompt = `Analyze this college complaint and categorize it.

Title: "${title}"
Description: "${description}"

You MUST respond with ONLY a JSON object (no markdown, no code blocks, just raw JSON):
{
  "category": "one of: Food Services, Facilities, Library, Hostel, Security",
  "priority": "one of: High, Medium, Low"
}

Reasoning:
- Categorize based on which department handles it (Food Services, Facilities, Library, Hostel, or Security)
- High priority: urgent safety/health issues, widespread impact
- Medium priority: standard complaints with moderate impact
- Low priority: minor inconveniences, single person affected

Respond with ONLY the JSON object.`;

    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
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
      // Fallback if JSON parsing fails
      console.warn('Failed to parse AI response:', text);
      return { category: 'Facilities', priority: 'Medium' };
    }

    // Validate and sanitize response
    const category = VALID_CATEGORIES.includes(result.category) ? result.category : 'Facilities';
    const priority = VALID_PRIORITIES.includes(result.priority) ? result.priority : 'Medium';

    return { category, priority };
  } catch (err) {
    console.error('AI categorization error:', err);
    return { category: 'Facilities', priority: 'Medium' };
  }
}

module.exports = { categorizeComplaint };
