import { GoogleGenAI } from '@google/genai';

// ============================================================
// Vercel Serverless Function — POST /api/future-me
// 環境変数: GEMINI_API_KEY
// ============================================================

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { currentEntry, recentEntries = [] } = req.body || {};

  if (!currentEntry) {
    return res.status(400).json({ error: 'currentEntry is required' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY is not set');
    return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });
  }

  // ── プロンプト構築 ─────────────────────────────
  const currentText = [
    '現在の記録：',
    `日付: ${currentEntry.date || 'なし'}`,
    `メモ: ${currentEntry.memo || 'なし'}`,
    `URL: ${currentEntry.url || 'なし'}`,
  ].join('\n');

  const safeRecent = Array.isArray(recentEntries)
    ? recentEntries.slice(0, 5)
    : [];

  const recentText =
    safeRecent.length > 0
      ? '\n\n最近の記録：\n' +
        safeRecent
          .map(
            (e, i) =>
              `${i + 1}. ${e.date || '?'} / ${e.memo || 'なし'} / ${
                e.url ? e.url : 'URLなし'
              }`
          )
          .join('\n')
      : '';

  const userPrompt = currentText + recentText;

  // ─── システムインストラクション（JSONを確実に返すよう指示）─────────
  const systemInstruction = `あなたは「Future Me」です。
ユーザーの過去の記録をもとに、長年の知人のように短く問いかけます。
記録の内容（メモやURL）に必ず言及してください。汎用的な返答は禁止です。
条件：日本語・1〜2文・最大60文字・具体的・やさしい・ポエム禁止・説教禁止・診断禁止・不安を煽らない。`;

  // ── Gemini API 呼び出し ────────────────────────
  try {
    const ai = new GoogleGenAI({ apiKey });

    console.log('[future-me] prompt:', userPrompt);

    const response = await ai.models.generateContent({
      model: 'gemini-2.0-flash',   // 安定版に変更（2.5-flashより確実）
      contents: userPrompt,
      config: {
        systemInstruction,
        // responseMimeType で JSON を強制 → response.text が確実にJSONになる
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'object',
          properties: {
            comment: { type: 'string' }
          },
          required: ['comment']
        },
        maxOutputTokens: 150,
        temperature: 0.8,
      },
    });

    // デバッグ: レスポンス全体をログ出力
    console.log('[future-me] response.text:', response.text);

    const raw = (response.text || '').trim();

    if (!raw) {
      // response.text が空の場合、candidates から直接取得を試みる
      let fallbackText = '';
      try {
        const parts = response?.candidates?.[0]?.content?.parts;
        if (parts && parts.length > 0) {
          fallbackText = parts.map(p => p.text || '').join('');
          console.log('[future-me] fallback from candidates:', fallbackText);
        }
      } catch (e) {
        console.warn('[future-me] candidates access failed:', e.message);
      }

      if (!fallbackText) {
        console.error('[future-me] response is completely empty. Full response:', JSON.stringify(response, null, 2));
        throw new Error('Empty response from Gemini');
      }

      // fallbackTextから抽出
      const parsed = JSON.parse(fallbackText);
      const comment = parsed.comment;
      if (!comment) throw new Error('No comment in fallback response');
      return res.status(200).json({ comment: comment.trim() });
    }

    // responseMimeType: 'application/json' のとき、response.text は有効なJSONのはず
    let comment = null;
    try {
      const parsed = JSON.parse(raw);
      comment = parsed.comment;
      console.log('[future-me] parsed comment:', comment);
    } catch (parseErr) {
      console.warn('[future-me] JSON.parse failed, trying regex. raw:', raw);
      // fallback: regexで抽出
      const match = raw.match(/\"comment\"\s*:\s*\"((?:[^\"\\]|\\.)*)\"/);
      if (match) {
        comment = match[1];
        console.log('[future-me] regex extracted comment:', comment);
      }
    }

    if (!comment || comment.trim() === '') {
      console.error('[future-me] comment is empty. raw was:', raw);
      throw new Error('Empty comment from Gemini');
    }

    return res.status(200).json({ comment: comment.trim() });

  } catch (err) {
    console.error('[future-me] Gemini API error:', err.message || err);
    return res.status(500).json({ error: 'API call failed' });
  }
}
