import { GoogleGenAI } from '@google/genai';

// ============================================================
// Vercel Serverless Function — POST /api/future-me
// 環境変数: GEMINI_API_KEY
// ============================================================

// ── サーバーサイドフォールバック ──────────────────────────────
// Gemini APIが失敗した場合に、記録内容から具体的なコメントを生成する。
// 汎用文は禁止。メモ・URLに言及した問いかけを返す。
function buildLocalComment(currentEntry) {
  const memo = (currentEntry.memo || '').trim();
  const url  = (currentEntry.url  || '').trim();
  const date = (currentEntry.date || '');

  // URLからサービス名のヒントを抽出
  let urlHint = '';
  if (url) {
    try {
      const hostname = new URL(url).hostname.replace(/^www\./, '');
      const service = hostname.split('.')[0].toLowerCase();
      const serviceMap = {
        makuake:    'Makuake',
        campfire:   'CAMPFIRE',
        youtube:    'YouTube',
        twitter:    'X(Twitter)',
        instagram:  'Instagram',
        note:       'note',
        facebook:   'Facebook',
        amazon:     'Amazon',
        base:       'BASE',
        stores:     'STORES',
      };
      urlHint = serviceMap[service] || hostname;
    } catch {
      // URL解析失敗は無視
    }
  }

  // ── メモがある場合：メモ内容に言及 ──
  if (memo) {
    const s = memo;   // 元のメモ
    const short = s.length > 22 ? s.slice(0, 22) + '…' : s;

    // パターン①：年数・継続系
    if (/(\d+)\s*年/.test(s)) {
      const m = s.match(/(\d+)\s*年/);
      const yr = m ? m[1] : '';
      return urlHint
        ? `${urlHint}を${yr}年続けているんですね。今も育てたいテーマですか？`
        : `「${short}」今も続いていますか？`;
    }

    // パターン②：クラファン・挑戦系
    if (/挑戦|クラファン|makuake|campfire/i.test(s) || urlHint === 'Makuake' || urlHint === 'CAMPFIRE') {
      return `${urlHint ? urlHint + 'の' : ''}挑戦、その後どうなりましたか？`;
    }

    // パターン③：販売・ビジネス系
    if (/販売|売|ショップ|店|商品|launch|リリース/i.test(s)) {
      return `「${short}」その後、どんな反応がありましたか？`;
    }

    // パターン④：学習・勉強系
    if (/勉強|学習|講義|セミナー|資格|試験|研究/i.test(s)) {
      return `「${short}」今も学び続けていますか？`;
    }

    // パターン⑤：イベント・人との出会い系
    if (/イベント|出会|話|会|集|ミートアップ/i.test(s)) {
      return `「${short}」あの時会った人と、今もつながっていますか？`;
    }

    // パターン⑥：アイデア・構想系
    if (/アイデア|構想|考え|プラン|企画/i.test(s)) {
      return `「${short}」そのアイデア、今も温めていますか？`;
    }

    // デフォルト：メモをそのまま引用して問いかけ
    return `「${short}」今また振り返ると、どう感じますか？`;
  }

  // ── メモなし・URLのみ ──
  if (urlHint) {
    return `${urlHint}に保存していましたね。今も参考にしていますか？`;
  }
  if (url) {
    return 'このURL、今見ても気になりますか？';
  }

  // ── 日付のみ（写真のみなど）：季節から生成 ──
  const month = parseInt(date.slice(5, 7), 10);
  if (month >= 3  && month <= 5)  return 'この春の記録、今見ると何を思い出しますか？';
  if (month >= 6  && month <= 8)  return 'この夏の記録、当時何を考えていましたか？';
  if (month >= 9  && month <= 11) return 'この秋の記録、あの頃と今で変わりましたか？';
  return 'この記録、今また振り返るとどう感じますか？';
}

// ============================================================
// HANDLER
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
    console.error('[future-me] GEMINI_API_KEY is not set → local fallback');
    return res.status(200).json({ comment: buildLocalComment(currentEntry) });
  }

  // ── プロンプト構築 ─────────────────────────────
  const currentText = [
    '現在の記録：',
    `日付: ${currentEntry.date || 'なし'}`,
    `メモ: ${currentEntry.memo || 'なし'}`,
    `URL: ${currentEntry.url  || 'なし'}`,
  ].join('\n');

  const safeRecent = Array.isArray(recentEntries) ? recentEntries.slice(0, 5) : [];
  const recentText = safeRecent.length > 0
    ? '\n\n最近の記録：\n' +
      safeRecent.map((e, i) =>
        `${i + 1}. ${e.date || '?'} / ${e.memo || 'なし'} / ${e.url || 'URLなし'}`
      ).join('\n')
    : '';

  const userPrompt = currentText + recentText;

  const systemInstruction = `あなたは「Future Me」です。
ユーザーの過去の記録をもとに、長年の知人のように短く問いかけます。
記録の内容（メモやURL）に必ず言及してください。汎用的な返答は禁止です。
条件：日本語・1〜2文・最大60文字・具体的・やさしい・ポエム禁止・説教禁止・診断禁止・不安を煽らない。`;

  // ── Gemini API 呼び出し ────────────────────────
  try {
    const ai = new GoogleGenAI({ apiKey });

    console.log('[future-me] prompt:', userPrompt);

    const response = await ai.models.generateContent({
      model: 'gemini-1.5-flash',   // 無料枠・安定性を優先
      contents: userPrompt,
      config: {
        systemInstruction,
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

    console.log('[future-me] response.text:', response.text);

    const raw = (response.text || '').trim();

    // response.text が空の場合 candidates から直接取得を試みる
    let effectiveRaw = raw;
    if (!effectiveRaw) {
      try {
        const parts = response?.candidates?.[0]?.content?.parts;
        if (parts && parts.length > 0) {
          effectiveRaw = parts.map(p => p.text || '').join('').trim();
          console.log('[future-me] candidates fallback:', effectiveRaw);
        }
      } catch (e) {
        console.warn('[future-me] candidates access failed:', e.message);
      }
    }

    if (!effectiveRaw) {
      console.error('[future-me] empty response. Full:', JSON.stringify(response, null, 2));
      throw new Error('Empty response from Gemini');
    }

    // JSONからcommentを抽出
    let comment = null;
    try {
      const parsed = JSON.parse(effectiveRaw);
      comment = parsed.comment;
      console.log('[future-me] parsed comment:', comment);
    } catch {
      console.warn('[future-me] JSON.parse failed, trying regex. raw:', effectiveRaw);
      const match = effectiveRaw.match(/"comment"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (match) {
        comment = match[1];
        console.log('[future-me] regex comment:', comment);
      }
    }

    if (!comment || comment.trim() === '') {
      console.error('[future-me] comment is empty. raw was:', effectiveRaw);
      throw new Error('Empty comment from Gemini');
    }

    return res.status(200).json({ comment: comment.trim() });

  } catch (err) {
    // 429 / 500 / タイムアウト / 空レスポンス → ローカルフォールバック
    const isQuotaError = /429|RESOURCE_EXHAUSTED|quota/i.test(err.message || '');
    console.warn(
      isQuotaError
        ? '[future-me] 429 quota exceeded → local fallback'
        : '[future-me] API error → local fallback:',
      err.message || err
    );

    // クライアントには常に200で返す（フォールバックコメントを使用）
    const fallbackComment = buildLocalComment(currentEntry);
    console.log('[future-me] local fallback comment:', fallbackComment);
    return res.status(200).json({ comment: fallbackComment });
  }
}
