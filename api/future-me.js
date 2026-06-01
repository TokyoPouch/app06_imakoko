import { GoogleGenAI } from '@google/genai';

// ============================================================
// Vercel Serverless Function — POST /api/future-me
// 環境変数: GEMINI_API_KEY
// ============================================================

export default async function handler(req, res) {
  // CORS headers（必要に応じて）
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

  const systemInstruction = `あなたは「Future Me」です。
ユーザーの過去ログをもとに、長年の知人のように短く問いかけます。
条件：日本語・1〜2文・最大50文字・具体的・やさしい・ポエム禁止・説教禁止・診断禁止・不安を煽らない・「あなたは〜ですね」と決めつけない。
必ず以下のJSON形式だけで返してください（他のテキストは一切不要）：
{"comment": "コメント本文"}`;

  // ── Gemini API 呼び出し ────────────────────────
  try {
    const ai = new GoogleGenAI({ apiKey });

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: userPrompt,
      config: {
        systemInstruction,
        maxOutputTokens: 100,
        temperature: 0.7,
      },
    });

    const raw = (response.text || '').trim();

    // JSONからcommentを抽出
    let comment = null;
    try {
      // まずregexで抽出（マークダウンコードブロック等に対応）
      const match = raw.match(/\{[\s\S]*?"comment"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (match) {
        comment = match[1];
      } else {
        // 直接パース
        const parsed = JSON.parse(raw);
        comment = parsed.comment;
      }
    } catch {
      // JSON解析失敗時はrawテキストをそのまま利用（アーティファクト除去）
      comment = raw
        .replace(/```json\s*/gi, '')
        .replace(/```/g, '')
        .replace(/[{}"\n]/g, '')
        .replace(/comment\s*:\s*/i, '')
        .trim();
    }

    if (!comment || comment.trim() === '') {
      throw new Error('Empty comment from Gemini');
    }

    return res.status(200).json({ comment: comment.trim() });

  } catch (err) {
    console.error('Gemini API error:', err.message || err);
    return res.status(500).json({ error: 'API call failed' });
  }
}
