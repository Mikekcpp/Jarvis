// ============================================================
// Вебхук для навыка Яндекс.Алисы.
// Принимает POST от Яндекс.Диалогов, отвечает через OpenRouter,
// при необходимости подтягивает свежие данные через Serper.
// ============================================================

const fetchFn = globalThis.fetch || (await import('node-fetch')).default;

// --- Конфигурация из переменных окружения ---
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL =
  process.env.OPENROUTER_MODEL || 'qwen/qwen3.8-27b:free';
const SERPER_API_KEY = process.env.SERPER_API_KEY;

const MAX_HISTORY = 10;
const VERSION = '1.0'; // Обязательное поле для Яндекс.Диалогов

const SYSTEM_PROMPT = `Ты — полезный голосовой ассистент Алисы.
Отвечай кратко, дружелюбно и по делу. Не используй markdown-разметку,
списки и ссылки — твой ответ будет озвучен вслух.
Отвечай ТОЛЬКО на русском языке, коротко, в 1-2 предложения.
Если в блоке "Результаты поиска" есть актуальные данные — опирайся на них.
Если данных нет — честно скажи, что не знаешь.`;

// ============================================================
// Определяем, нужен ли веб-поиск.
// ============================================================
function needsWebSearch(text) {
  if (!text) return false;
  const q = text.toLowerCase();
  const triggers = [
    'новост', 'погод', 'курс', 'сегодня', 'вчера', 'завтра',
    'сейчас', 'текущ', 'последн', 'свеж', 'недавн', '2024', '2025', '2026',
    'кто выиграл', 'что случилось', 'сколько стоит', 'цена', 'котировк',
    'произошл', 'обновлен', 'релиз', 'запуск', 'матч', 'чемпионат'
  ];
  return triggers.some((t) => q.includes(t));
}

// ============================================================
// Поиск через Serper API.
// ============================================================
async function searchWeb(query) {
  if (!SERPER_API_KEY) return '';
  try {
    const res = await fetchFn('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': SERPER_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ q: query, num: 3, gl: 'ru', hl: 'ru' })
    });

    if (!res.ok) {
      console.error('Serper HTTP error:', res.status, await res.text());
      return '';
    }

    const data = await res.json();
    const organic = (data.organic || []).slice(0, 3);
    if (organic.length === 0) return '';

    return organic
      .map((r, i) => `${i + 1}. ${r.title}\n${r.snippet || ''}`)
      .join('\n\n');
  } catch (err) {
    console.error('Serper request failed:', err);
    return '';
  }
}

// ============================================================
// Срезаем reasoning-мусор, если модель начала «думать вслух».
// ============================================================
function stripReasoning(text) {
  if (!text) return '';
  let t = text;

  // 1. Явные маркеры финального ответа.
  const finalMarkers = [
    /(?:^|\n)\s*final answer[:\s]*/i,
    /(?:^|\n)\s*финальный ответ[:\s]*/i,
    /(?:^|\n)\s*ответ пользователю[:\s]*/i,
    /(?:^|\n)\s*answer[:\s]*/i
  ];
  for (const re of finalMarkers) {
    const m = t.match(re);
    if (m && m.index !== undefined) {
      t = t.slice(m.index + m[0].length);
      break;
    }
  }

  // 2. Блок "Here's a thinking process".
  if (/here'?s (a )?thinking process/i.test(t)) {
    const drafts = [...t.matchAll(/draft[:\s]+([^\n]+(?:\n[^\n]+)*)/gi)];
    if (drafts.length > 0) {
      t = drafts[drafts.length - 1][1];
    } else {
      // Берём последний непустой абзац.
      const paragraphs = t.split(/\n\s*\n/).filter((p) => p.trim());
      t = paragraphs.length > 0 ? paragraphs[paragraphs.length - 1] : '';
    }
  }

  // 3. Убираем префиксы.
  t = t.replace(/^(draft|ответ|answer)[:\s]+/i, '').trim();

  // 4. Схлопываем пробелы.
  t = t.replace(/\s+/g, ' ').trim();

  // 5. Убираем markdown.
  t = t.replace(/[*_`#>]/g, '').trim();

  return t;
}

// ============================================================
// Запрос к OpenRouter.
// ============================================================
async function askOpenRouter(messages) {
  if (!OPENROUTER_API_KEY) {
    console.error('OPENROUTER_API_KEY is not set');
    return null;
  }
  try {
    const res = await fetchFn(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://alice-skill.vercel.app',
          'X-Title': 'Alice Skill'
        },
        body: JSON.stringify({
          model: OPENROUTER_MODEL,
          messages,
          temperature: 0.6,
          max_tokens: 250,
          reasoning: { enabled: false }
        })
      }
    );

    if (!res.ok) {
      console.error('OpenRouter HTTP error:', res.status, await res.text());
      return null;
    }

    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content || '';
    const clean = stripReasoning(raw);
    return clean.length > 0 ? clean : null;
  } catch (err) {
    console.error('OpenRouter request failed:', err);
    return null;
  }
}

// ============================================================
// Обрезаем историю.
// ============================================================
function trimHistory(history) {
  if (!Array.isArray(history)) return [];
  return history.slice(-MAX_HISTORY);
}

// ============================================================
// Ответ Алисе — с обязательным полем version.
// ============================================================
function aliceResponse(text, history, endSession = false, userState = null) {
  return {
    response: {
      text,
      end_session: endSession,
      tts: text // дублируем для озвучки — Алиса так делает корректнее
    },
    session_state: { history: trimHistory(history) },
    user_state: userState ?? { history: trimHistory(history) },
    application_state: {},
    version: VERSION // ← ГЛАВНОЕ ИСПРАВЛЕНИЕ
  };
}

// ============================================================
// Основной обработчик Vercel-функции.
// ============================================================
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

  try {
    const request = body?.request || {};
    const session = body?.session || {};
    const state = body?.state || {};

    const userText = (request.command || request.original_utterance || '').trim();

    // Приветствие при запуске навыка.
    if (!userText && session.new) {
      return res.status(200).json(
        aliceResponse(
          'Привет! Я Джарвис. Спроси меня о чём угодно — я поищу в интернете, если нужно.',
          []
        )
      );
    }

    // Восстанавливаем историю.
    const sessionHistory = state.session?.history;
    const userHistory = state.user?.history;
    let history = Array.isArray(sessionHistory)
      ? sessionHistory
      : Array.isArray(userHistory)
        ? userHistory
        : [];

    // Веб-поиск при необходимости.
    let searchContext = '';
    if (needsWebSearch(userText)) {
      searchContext = await searchWeb(userText);
    }

    // Собираем сообщения.
    const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
    for (const m of trimHistory(history)) {
      if (m && m.role && m.content) messages.push(m);
    }

    const userContent = searchContext
      ? `${userText}\n\n--- Результаты поиска в интернете ---\n${searchContext}`
      : userText;

    messages.push({ role: 'user', content: userContent });

    // Запрос к OpenRouter.
    const answer = await askOpenRouter(messages);

    const replyText =
      answer ||
      'Извини, сейчас не могу ответить. Попробуй переформулировать вопрос.';

    // Обновляем историю.
    history.push({ role: 'user', content: userText });
    history.push({ role: 'assistant', content: replyText });

    return res.status(200).json(aliceResponse(replyText, history));
  } catch (err) {
    console.error('Webhook handler error:', err);
    return res.status(200).json(
      aliceResponse('Что-то пошло не так. Попробуй ещё раз.', [])
    );
  }
}