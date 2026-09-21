import { GoogleGenAI, Type } from '@google/genai';
import { z } from 'zod';

const ParsedSearchQuerySchema = z.object({
  location: z
    .string()
    .nullable()
    .describe('The city, locality, or state mentioned. e.g. Gachibowli, Hyderabad'),
  propertyType: z
    .enum([
      'APARTMENT',
      'VILLA',
      'INDEPENDENT_HOUSE',
      'PLOT',
      'COMMERCIAL',
      'OFFICE',
      'RETAIL',
      'WAREHOUSE',
    ])
    .nullable()
    .describe('The type of property if mentioned.'),
  bedrooms: z
    .string()
    .nullable()
    .describe(
      'The BHK format, e.g. "2" or "3" or "4" for 2BHK/3BHK/4BHK. For commercial, skip this.',
    ),
  minBudget: z.number().nullable().describe('Minimum budget in INR if specified.'),
  maxBudget: z
    .number()
    .nullable()
    .describe('Maximum budget in INR if specified. e.g., 2 crores = 20000000.'),
  possessionStatus: z
    .enum(['READY_TO_MOVE', 'UNDER_CONSTRUCTION'])
    .nullable()
    .describe('Possession status if mentioned.'),
});
export type ParsedSearchQuery = z.infer<typeof ParsedSearchQuerySchema>;

let client: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  if (!client) {
    client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return client;
}

export async function parseNaturalLanguageQuery(query: string): Promise<ParsedSearchQuery> {
  if (!process.env.GEMINI_API_KEY) {
    throw {
      status: 503,
      message: 'AI search is currently disabled (GEMINI_API_KEY not configured).',
    };
  }

  try {
    const response = await getClient().models.generateContent({
      model: 'gemini-3.5-flash-lite',
      contents: query,
      config: {
        systemInstruction:
          "You are an intelligent real estate search parser. Extract structured search criteria from the user's natural language query.",
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            location: { type: Type.STRING, nullable: true },
            propertyType: {
              type: Type.STRING,
              enum: [
                'APARTMENT',
                'VILLA',
                'INDEPENDENT_HOUSE',
                'PLOT',
                'COMMERCIAL',
                'OFFICE',
                'RETAIL',
                'WAREHOUSE',
              ],
              nullable: true,
            },
            bedrooms: { type: Type.STRING, nullable: true },
            minBudget: { type: Type.NUMBER, nullable: true },
            maxBudget: { type: Type.NUMBER, nullable: true },
            possessionStatus: {
              type: Type.STRING,
              enum: ['READY_TO_MOVE', 'UNDER_CONSTRUCTION'],
              nullable: true,
            },
          },
        },
      },
    });

    if (!response.text) throw new Error('No text returned from Gemini');
    return JSON.parse(response.text) as ParsedSearchQuery;
  } catch (apiError: any) {
    throw { status: 502, message: apiError?.message || 'AI search provider error' };
  }
}
