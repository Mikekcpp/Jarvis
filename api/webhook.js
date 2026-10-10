// ============================================================
// Вебхук для навыка Яндекс.Алисы.
// Принимает POST от Яндекс.Диалогов, отвечает через OpenRouter,
// при необходимости подтягивает свежие данные через Serper.
// ============================================================

// Node 18+ содержит глобальный fetch. Для более старых версий — полифилл.
const fetchFn = globalThis.fetch || (await import('node-fetch')).default;

// --- Конфигурация из переменных окружения ---
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL =
  process.env.OPENROUTER_MODEL || 'deepseek/deepseek-r1:free';
const SERPER_API_KEY = process.env.SERPER_API_KEY;

// Максимум сообщений в истории (user+assistant считаются вместе).
const MAX_HISTORY = 10;

// --- Системный промпт для модели ---
const SYSTEM_PROMPT = `Ты — полезный голосовой ассистент Алисы.
Отвечай кратко, дружелюбно и по делу. Не используй markdown-разметку,
списки и ссылки — твой ответ будет озвучен вслух.
Если в блоке "Результаты поиска" есть актуальные данные — опирайся на них.
Если данных нет — честно скажи, что не знаешь.`;

// ============================================================
// Определяем, нужен ли веб-поиск.
// Триггерим Serper на «свежие» темы: новости, погода, курсы, события и т.п.
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
// Поиск через Serper API. Возвращает строку с топ-3 результатами
// или пустую строку при ошибке/отсутствии ключа.
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
// Запрос к OpenRouter. Возвращает текст ответа или null при ошибке.
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
          // Опциональные заголовки OpenRouter (для аналитики):
          'HTTP-Referer': 'https://alice-skill.vercel.app',
          'X-Title': 'Alice Skill'
        },
        body: JSON.stringify({
          model: OPENROUTER_MODEL,
          messages,
          temperature: 0.7,
          max_tokens: 600
        })
      }
    );

    if (!res.ok) {
      console.error('OpenRouter HTTP error:', res.status, await res.text());
      return null;
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    return text || null;
  } catch (err) {
    console.error('OpenRouter request failed:', err);
    return null;
  }
}

// ============================================================
// Утилита: обрезаем историю до последних N сообщений.
// ============================================================
function trimHistory(history) {
  if (!Array.isArray(history)) return [];
  return history.slice(-MAX_HISTORY);
}

// ============================================================
// Основной обработчик Vercel-функции.
// ============================================================
export default async function handler(req, res) {
  // Яндекс.Диалоги присылают только POST.
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Vercel парсит JSON автоматически, но на всякий случай:
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

  try {
    const request = body?.request || {};
    const session = body?.session || {};
    const state = body?.state || {};

    // Текст пользователя: command приоритетнее, иначе original_utterance.
    const userText = (request.command || request.original_utterance || '').trim();

    // Приветствие при запуске навыка.
    if (request.type === 'SimpleUtterance' && !userText && session.new) {
      return res.status(200).json({
        response: {
          text: 'Привет! Спроси меня о чём угодно — я поищу в интернете, если нужно.',
          end_session: false
        },
        session_state: { history: [] },
        user_state: state.user || { history: [] },
        application_state: {}
      });
    }

    // Восстанавливаем историю: session_state важнее user_state (короче срок жизни).
    const sessionHistory = state.session?.history;
    const userHistory = state.user?.history;
    let history = Array.isArray(sessionHistory)
      ? sessionHistory
      : Array.isArray(userHistory)
        ? userHistory
        : [];

    // --- 1. Возможно, нужен веб-поиск ---
    let searchContext = '';
    if (needsWebSearch(userText)) {
      searchContext = await searchWeb(userText);
    }

    // --- 2. Собираем сообщения для OpenRouter ---
    const messages = [{ role: 'system', content: SYSTEM_PROMPT }];

    // Добавляем историю диалога (уже обрезанную).
    for (const m of trimHistory(history)) {
      if (m && m.role && m.content) messages.push(m);
    }

    // Подмешиваем результаты поиска в контекст пользовательского сообщения.
    const userContent = searchContext
      ? `${userText}\n\n--- Результаты поиска в интернете ---\n${searchContext}`
      : userText;

    messages.push({ role: 'user', content: userContent });

    // --- 3. Запрос к OpenRouter ---
    const answer = await askOpenRouter(messages);

    // --- 4. Fallback при ошибке ---
    const replyText =
      answer ||
      'Извини, сейчас не могу получить ответ. Попробуй переформулировать вопрос или повтори чуть позже.';

    // --- 5. Обновляем историю (пишем "чистый" текст пользователя без блока поиска) ---
    history.push({ role: 'user', content: userText });
    history.push({ role: 'assistant', content: replyText });
    history = trimHistory(history);

    // --- 6. Отдаём ответ Яндекс.Диалогам ---
    return res.status(200).json({
      response: {
        text: replyText,
        end_session: false
      },
      session_state: { history },
      user_state: { history },
      application_state: {}
    });
  } catch (err) {
    console.error('Webhook handler error:', err);
    // Никогда не отдаём Алисе 500 — иначе она скажет "навык не отвечает".
    return res.status(200).json({
      response: {
        text: 'Что-то пошло не так. Попробуй ещё раз.',
        end_session: false
      },
      session_state: {},
      user_state: {},
      application_state: {}
    });
  }
}