const {
  getGenAI,
  getGenerationModelCandidates,
  getGeminiErrorDetails,
  isGeminiNotFoundError,
} = require('../config/gemini');
const { generateEmbedding } = require('./embeddingService');
const { similaritySearch, getChunkCountBySession } = require('./vectorService');
const { logError } = require('../utils/logger');

const DEFAULT_TOP_K = Number(process.env.RAG_TOP_K) || 5;
const DEFAULT_CANDIDATE_PAGE_SIZE = Number(process.env.RAG_CANDIDATE_PAGE_SIZE) || 400;
const DEFAULT_HISTORY_LIMIT = Number(process.env.RAG_HISTORY_LIMIT) || 12;
const FALLBACK_ANSWER = "I don't know - please provide more context.";
const DEFAULT_RESPONSE_STYLE = String(process.env.RAG_RESPONSE_STYLE || 'structured').toLowerCase();
const RESPONSE_STYLES = new Set(['plain', 'structured']);

function createGenerationError(message, details) {
  const error = new Error(message);
  error.statusCode = 500;
  error.gemini = details || null;
  return error;
}

function normalizeResponseStyle(value) {
  const candidate = String(value || DEFAULT_RESPONSE_STYLE || 'structured').toLowerCase();
  if (RESPONSE_STYLES.has(candidate)) {
    return candidate;
  }
  return 'structured';
}

function formatHistory(history = []) {
  return history
    .slice(-DEFAULT_HISTORY_LIMIT)
    .map((entry) => `${entry.role}: ${entry.text}`)
    .join('\n');
}

function buildPrompt({ message, history, candidates, responseStyle }) {
  const context = candidates
    .map((chunk, index) => `Chunk ${index + 1} (pdfId=${chunk.pdfId}, score=${chunk.score.toFixed(4)}):\n${chunk.text}`)
    .join('\n\n');

  const structuredInstructions = normalizeResponseStyle(responseStyle) === 'structured'
    ? '\n\nResponse format (strict plain text):\nAnswer: <direct answer in 1-3 sentences>\n\nKey Points:\n- <point>\n- <point>\n\nEvidence:\n- Chunk <n>: <short evidence>\n\nFollow-up:\n- <next question>\n\nRules:\n- Use plain text only.\n- Do not use markdown markers like **, __, #, or backticks.\n- Keep one blank line between sections.\n- If answer is not in context, set Answer to: I don\'t know - please provide more context.'
    : '';

  return `You are a PDF analysis assistant.\nUse ONLY the provided context chunks and chat history.\nIf the answer is not found in context, reply exactly: I don't know - please provide more context.${structuredInstructions}\n\nRecent chat history:\n${formatHistory(history)}\n\nUser message:\n${message}\n\nContext:\n${context}`;
}

function buildStructuredFallbackAnswer() {
  return `Answer:\n${FALLBACK_ANSWER}\n\nKey Points:\n- Not enough evidence was found in indexed documents.\n\nEvidence:\n- None.\n\nFollow-up:\n- Upload or index relevant PDFs and ask again.`;
}

function normalizeSectionTitle(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z\s-]/g, '');
  if (!normalized) {
    return null;
  }
  if (normalized === 'answer') {
    return 'Answer';
  }
  if (normalized === 'key points' || normalized === 'key point' || normalized === 'highlights') {
    return 'Key Points';
  }
  if (normalized === 'evidence' || normalized === 'sources' || normalized === 'citations') {
    return 'Evidence';
  }
  if (normalized === 'follow-up' || normalized === 'follow up' || normalized === 'next steps') {
    return 'Follow-up';
  }
  return null;
}

function stripMarkdownFormatting(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^(\s*)[*•]\s+/gm, '$1- ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseStructuredSections(text) {
  const normalized = stripMarkdownFormatting(text);
  if (!normalized) {
    return {
      format: 'structured_sections',
      sections: [],
    };
  }

  const sections = [];
  let current = null;

  function pushCurrentSection() {
    if (!current) {
      return;
    }
    const content = current.lines.join('\n').trim();
    if (!content && current.title === 'Body') {
      current = null;
      return;
    }
    sections.push({
      title: current.title,
      content,
    });
    current = null;
  }

  function startSection(title, firstLine = '') {
    pushCurrentSection();
    current = {
      title,
      lines: [],
    };
    if (firstLine) {
      current.lines.push(firstLine);
    }
  }

  for (const line of normalized.split('\n')) {
    const headingMatch = line.match(/^##\s+(.+?)\s*$/);
    if (headingMatch) {
      const canonical = normalizeSectionTitle(headingMatch[1]) || headingMatch[1].trim();
      startSection(canonical);
      continue;
    }

    const labelWithContentMatch = line.match(/^([A-Za-z][A-Za-z -]{1,30})\s*:\s*(.*)$/);
    if (labelWithContentMatch) {
      const canonical = normalizeSectionTitle(labelWithContentMatch[1]);
      if (canonical) {
        startSection(canonical, labelWithContentMatch[2].trim());
        continue;
      }
    }

    const labelOnlyMatch = line.match(/^([A-Za-z][A-Za-z -]{1,30})\s*:?\s*$/);
    if (labelOnlyMatch) {
      const canonical = normalizeSectionTitle(labelOnlyMatch[1]);
      if (canonical) {
        startSection(canonical);
        continue;
      }
    }

    if (!current) {
      current = {
        title: 'Body',
        lines: [],
      };
    }
    current.lines.push(line);
  }

  pushCurrentSection();
  return {
    format: 'structured_sections',
    sections,
  };
}

function getSectionContent(schema, title) {
  if (!schema || !Array.isArray(schema.sections)) {
    return '';
  }
  const section = schema.sections.find((entry) => String(entry.title || '').toLowerCase() === title.toLowerCase());
  return section ? String(section.content || '').trim() : '';
}

function ensureBulletList(content, fallbackLine) {
  const lines = String(content || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^[-*•]\s*/, '').trim());

  if (!lines.length) {
    return `- ${fallbackLine}`;
  }

  return lines.map((line) => `- ${line}`).join('\n');
}

function formatStructuredAnswer(schema) {
  const answer = getSectionContent(schema, 'Answer')
    || getSectionContent(schema, 'Body')
    || FALLBACK_ANSWER;
  const keyPoints = ensureBulletList(
    getSectionContent(schema, 'Key Points'),
    'Not enough evidence was found in indexed documents.'
  );
  const evidence = ensureBulletList(
    getSectionContent(schema, 'Evidence'),
    'None.'
  );
  const followUp = ensureBulletList(
    getSectionContent(schema, 'Follow-up'),
    'Upload or index relevant PDFs and ask again.'
  );

  const sections = [
    { title: 'Answer', content: answer },
    { title: 'Key Points', content: keyPoints },
    { title: 'Evidence', content: evidence },
    { title: 'Follow-up', content: followUp },
  ];

  const formattedAnswer = sections
    .map((section) => `${section.title}:\n${section.content}`)
    .join('\n\n')
    .trim();

  return {
    format: 'structured_sections',
    sections,
    formattedAnswer,
  };
}

function getAnswerFromStructuredSchema(schema) {
  const answer = getSectionContent(schema, 'Answer');
  if (answer) {
    return answer
      .replace(/^\s*[-*]\s*/gm, '')
      .trim();
  }

  const fallbackSection = Array.isArray(schema?.sections)
    ? schema.sections.find((section) => String(section.content || '').trim().length > 0)
    : null;
  if (!fallbackSection) {
    return '';
  }
  return String(fallbackSection.content || '')
    .replace(/^\s*[-*]\s*/gm, '')
    .trim();
}

function normalizeAnswerPayload({ rawText, responseStyle }) {
  const normalizedResponseStyle = normalizeResponseStyle(responseStyle);
  const trimmedRaw = stripMarkdownFormatting(rawText);

  if (normalizedResponseStyle === 'plain') {
    const text = trimmedRaw || FALLBACK_ANSWER;
    return {
      answer: text,
      formattedAnswer: text,
      responseSchema: null,
      responseStyle: normalizedResponseStyle,
    };
  }

  const parsed = parseStructuredSections(trimmedRaw || buildStructuredFallbackAnswer());
  const normalizedStructured = formatStructuredAnswer(parsed);
  const formattedAnswer = normalizedStructured.formattedAnswer;
  const responseSchema = {
    format: normalizedStructured.format,
    sections: normalizedStructured.sections,
  };
  const answer = getAnswerFromStructuredSchema(responseSchema) || FALLBACK_ANSWER;
  return {
    answer,
    formattedAnswer,
    responseSchema,
    responseStyle: normalizedResponseStyle,
  };
}

async function generateTextWithFallback({ prompt, generationConfig }) {
  const ai = getGenAI();
  const models = getGenerationModelCandidates();
  let lastError = null;

  for (let i = 0; i < models.length; i += 1) {
    const model = models[i];
    try {
      const response = await Promise.race([
        ai.models.generateContent({
          model,
          contents: prompt,
          config: generationConfig,
        }),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Gemini request timeout.')), 25_000);
        }),
      ]);

      return response?.text || '';
    } catch (error) {
      lastError = error;
      const details = getGeminiErrorDetails(error);
      const hasNext = i < models.length - 1;
      if (isGeminiNotFoundError(error) && hasNext) {
        continue;
      }

      throw createGenerationError(
        isGeminiNotFoundError(error)
          ? `Generation model "${model}" is unavailable.`
          : 'Gemini generation request failed.',
        details
      );
    }
  }

  throw createGenerationError('Gemini generation failed for all configured models.', getGeminiErrorDetails(lastError));
}

async function generateTextStreamWithFallback({ prompt, generationConfig, onToken }) {
  const ai = getGenAI();
  const models = getGenerationModelCandidates();
  let lastError = null;

  for (let i = 0; i < models.length; i += 1) {
    const model = models[i];
    try {
      const stream = await Promise.race([
        ai.models.generateContentStream({
          model,
          contents: prompt,
          config: generationConfig,
        }),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Gemini request timeout.')), 25_000);
        }),
      ]);

      let fullText = '';
      for await (const chunk of stream) {
        const token = String(chunk?.text || '');
        if (!token) {
          continue;
        }
        fullText += token;
        if (typeof onToken === 'function') {
          onToken(token);
        }
      }

      return fullText;
    } catch (error) {
      lastError = error;
      const hasNext = i < models.length - 1;
      if (isGeminiNotFoundError(error) && hasNext) {
        continue;
      }

      throw createGenerationError(
        isGeminiNotFoundError(error)
          ? `Generation model "${model}" is unavailable.`
          : 'Gemini generation request failed.',
        getGeminiErrorDetails(error)
      );
    }
  }

  throw createGenerationError('Gemini generation failed for all configured models.', getGeminiErrorDetails(lastError));
}

async function retrieveCandidates({ sessionId, message, topK, onProgress }) {
  if (onProgress) {
    onProgress({ stage: 'retrieving', progress: 10 });
  }

  const queryEmbedding = await generateEmbedding(message);
  const normalizedTopK = Math.max(1, Math.min(5, Number(topK) || DEFAULT_TOP_K));
  const candidates = await similaritySearch({
    sessionId,
    queryEmbedding,
    topK: normalizedTopK,
    pageSize: DEFAULT_CANDIDATE_PAGE_SIZE,
    onProgress: ({ processed, total }) => {
      if (!onProgress) {
        return;
      }
      const ratio = total > 0 ? processed / total : 1;
      onProgress({
        stage: 'retrieving',
        progress: 10 + Math.round(ratio * 50),
      });
    },
  });

  return candidates;
}

async function runChatQuery(
  { sessionId, message, history = [], topK = DEFAULT_TOP_K, responseStyle },
  options = {}
) {
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const normalizedResponseStyle = normalizeResponseStyle(options.responseStyle || responseStyle);

  const candidates = await retrieveCandidates({
    sessionId,
    message,
    topK,
    onProgress,
  });

  if (candidates.length === 0) {
    if (onProgress) {
      onProgress({ stage: 'generating', progress: 100 });
    }
    return {
      ...normalizeAnswerPayload({ rawText: '', responseStyle: normalizedResponseStyle }),
      sources: [],
      usedChunksCount: 0,
    };
  }

  const prompt = buildPrompt({
    message,
    history,
    candidates,
    responseStyle: normalizedResponseStyle,
  });

  let rawAnswer = '';
  try {
    if (onProgress) {
      onProgress({ stage: 'generating', progress: 70 });
    }
    rawAnswer = await generateTextWithFallback({ prompt });
    if (onProgress) {
      onProgress({ stage: 'generating', progress: 100 });
    }
  } catch (error) {
    logError('ERROR_QUEUE', error, {
      service: 'ragService',
      stage: 'runChatQueryGeneration',
      sessionId,
    });
  }

  return {
    ...normalizeAnswerPayload({ rawText: rawAnswer, responseStyle: normalizedResponseStyle }),
    sources: candidates.map((chunk) => ({
      pdfId: chunk.pdfId,
      chunkId: chunk.chunkId,
      score: chunk.score,
    })),
    usedChunksCount: candidates.length,
  };
}

async function runChatQueryStream(
  { sessionId, message, history = [], topK = DEFAULT_TOP_K, responseStyle },
  options = {}
) {
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const onToken = typeof options.onToken === 'function' ? options.onToken : null;
  const normalizedResponseStyle = normalizeResponseStyle(options.responseStyle || responseStyle);

  const candidates = await retrieveCandidates({
    sessionId,
    message,
    topK,
    onProgress,
  });

  if (candidates.length === 0) {
    const fallback = normalizeAnswerPayload({
      rawText: '',
      responseStyle: normalizedResponseStyle,
    });
    if (onProgress) {
      onProgress({ stage: 'generating', progress: 100 });
    }
    if (onToken) {
      onToken(fallback.formattedAnswer);
    }
    return {
      ...fallback,
      sources: [],
      usedChunksCount: 0,
    };
  }

  const prompt = buildPrompt({
    message,
    history,
    candidates,
    responseStyle: normalizedResponseStyle,
  });
  if (onProgress) {
    onProgress({ stage: 'generating', progress: 70 });
  }
  const streamedAnswer = await generateTextStreamWithFallback({
    prompt,
    onToken,
  });
  const normalized = normalizeAnswerPayload({
    rawText: streamedAnswer,
    responseStyle: normalizedResponseStyle,
  });
  if (onProgress) {
    onProgress({ stage: 'generating', progress: 100 });
  }

  return {
    ...normalized,
    sources: candidates.map((chunk) => ({
      pdfId: chunk.pdfId,
      chunkId: chunk.chunkId,
      score: chunk.score,
    })),
    usedChunksCount: candidates.length,
  };
}

function shouldRunAsyncChat({ sessionId, history = [] }) {
  const chunkCount = getChunkCountBySession(sessionId);
  return chunkCount > 1200 || history.length > 20;
}

async function generateSessionTitle(message, firstPdfTitle = null) {
  const prompt = `Generate a short, human-readable title (4 to 6 words, max 60 characters) for a chat session based on this first message: "${message}". ${firstPdfTitle ? `The primary document is called "${firstPdfTitle}". ` : ''}Reply with ONLY the title itself, no quotes, no markdown, no other text.`;

  try {
    const ai = getGenAI();
    const model = getGenerationModelCandidates()[0];
    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: { temperature: 0.7 }
    });

    let title = String(response?.text || '').trim();
    // Strip possible quotes the LLM might still stubbornly add
    title = title.replace(/^["']|["']$/g, '');
    if (title.length > 60) {
      title = title.substring(0, 57) + '...';
    }
    return title;
  } catch (err) {
    logError('ERROR_TITLE_GEN', err, { service: 'ragService' });
    return null;
  }
}

module.exports = {
  normalizeResponseStyle,
  runChatQuery,
  runChatQueryStream,
  shouldRunAsyncChat,
  generateSessionTitle,
};
