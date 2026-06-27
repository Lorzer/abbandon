/**
 * colla_gemma - generic Gemma 4 caller (Supabase edge function).
 *
 * Gemma 4 is served by Google's Generative Language API (same GEMINI_API_KEY as
 * Gemini) with a different model id and a few quirks: no system role (the
 * caller folds instructions onto the user turn), thinking via
 * thinkingConfig.thinkingLevel, and no native JSON mode. Keys live in Supabase
 * secrets (GEMINI_API_KEY, GEMINI_API_KEY_2) and rotate on HTTP 429.
 *
 * Request body: { systemPrompt?, userPrompt, temperature?, maxOutputTokens?, thinkingLevel? }
 * Response:     { text, input, output }
 */

const MODEL = Deno.env.get('GEMMA_MODEL') ?? 'gemma-4-31b-it';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function geminiKeys(): string[] {
  return [Deno.env.get('GEMINI_API_KEY'), Deno.env.get('GEMINI_API_KEY_2')].filter(
    (k): k is string => !!k
  );
}

async function callGemma(opts: {
  systemPrompt?: string;
  userPrompt: string;
  temperature?: number;
  maxOutputTokens?: number;
  thinkingLevel?: 'low' | 'medium' | 'high' | null;
}): Promise<{ text: string; input: number; output: number }> {
  const keys = geminiKeys();
  if (keys.length === 0) throw new Error('No Gemini API keys configured');

  // Gemma has no system role -> fold instructions onto the user turn.
  const text = opts.systemPrompt ? `${opts.systemPrompt}\n\n${opts.userPrompt}` : opts.userPrompt;

  const generationConfig: Record<string, unknown> = {
    temperature: opts.temperature ?? 0.4,
    maxOutputTokens: opts.maxOutputTokens ?? 2048,
  };
  // Gemma 4 thinking uses a level, not a token budget.
  const level = opts.thinkingLevel === undefined ? 'high' : opts.thinkingLevel;
  generationConfig.thinkingConfig = level === null ? { thinkingBudget: 0 } : { thinkingLevel: level };

  let lastErr = '';
  for (let i = 0; i < keys.length; i++) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${keys[i]}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text }] }],
          generationConfig,
          safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' },
          ],
        }),
      }
    );

    if (res.status === 429 && i < keys.length - 1) {
      lastErr = `429 ${await res.text()}`;
      continue; // rotate to the next key on quota errors
    }
    if (!res.ok) throw new Error(`Gemini API error ${res.status}: ${await res.text()}`);

    const data = await res.json();
    const parts = (data.candidates?.[0]?.content?.parts ?? []) as { text?: string; thought?: boolean }[];
    const out = parts
      .filter((p) => !p.thought)
      .map((p) => p.text ?? '')
      .join('')
      .trim();
    return {
      text: out,
      input: data.usageMetadata?.promptTokenCount ?? 0,
      output: data.usageMetadata?.candidatesTokenCount ?? 0,
    };
  }
  throw new Error(`Gemini API error: ${lastErr || 'all keys exhausted'}`);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  try {
    const { systemPrompt, userPrompt, temperature, maxOutputTokens, thinkingLevel } = await req.json();
    if (!userPrompt) throw new Error('userPrompt is required');
    const result = await callGemma({ systemPrompt, userPrompt, temperature, maxOutputTokens, thinkingLevel });
    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
