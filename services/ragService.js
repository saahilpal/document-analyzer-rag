const {
  getGenAI,
  getGenerationModelCandidates,
  getGeminiErrorDetails,
  isGeminiNotFoundError,
} = require('../config/gemini');
const { generateEmbedding } = require('./embeddingService');
const { similaritySearch, getChunkCountBySession } = require('./vectorService');

const DEFAULT_TOP_K = Number(process.env.RAG_TOP_K) || 5;
const DEFAULT_CANDIDATE_LIMIT = Number(process.env.RAG_CANDIDATE_LIMIT) || 300;
const DEFAULT_HISTORY_LIMIT = Number(process.env.RAG_HISTORY_LIMIT) || 12;

function createGenerationError(message, details) {
  const error = new Error(message);
  error.statusCode = 500;
  error.gemini = details || null;
  return error;
}

function formatHistory(history = []) {
  return history
    .slice(-DEFAULT_HISTORY_LIMIT)
    .map((entry) => `${entry.role}: ${entry.text}`)
    .join('\n');
}

async function generateTextWithFallback({ prompt, generationConfig }) {
  const ai = getGenAI();
  const models = getGenerationModelCandidates();
  let lastError = null;

  for (let i = 0; i < models.length; i += 1) {
    const model = models[i];
    try {
      const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config: generationConfig,
      });

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

async function runChatQuery({ sessionId, message, history = [], topK = DEFAULT_TOP_K }) {
  const queryEmbedding = await generateEmbedding(message);
  const candidates = similaritySearch({
    sessionId,
    queryEmbedding,
    topK,
    limit: DEFAULT_CANDIDATE_LIMIT,
    offset: 0,
  });

  if (candidates.length === 0) {
    return {
      answer: "I don't know - please provide more context.",
      sources: [],
      usedChunksCount: 0,
    };
  }

  const context = candidates
    .map((chunk, index) => `Chunk ${index + 1} (pdfId=${chunk.pdfId}, score=${chunk.score.toFixed(4)}):\n${chunk.text}`)
    .join('\n\n');

  const prompt = `You are a PDF analysis assistant.\nUse ONLY the provided context chunks and chat history.\nIf the answer is not found in context, reply exactly: I don't know - please provide more context.\n\nRecent chat history:\n${formatHistory(history)}\n\nUser message:\n${message}\n\nContext:\n${context}`;

  const answer = (await generateTextWithFallback({ prompt })) || "I don't know - please provide more context.";

  return {
    answer,
    sources: candidates.map((chunk) => ({
      pdfId: chunk.pdfId,
      page: null,
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

async function generateSessionQuiz({ sessionTitle, contextText, difficulty = 'medium', count = 5 }) {
  const prompt = `Create a multiple-choice quiz as strict JSON.\nSchema:\n{\n  "title": "string",\n  "questions": [\n    {\n      "question": "string",\n      "options": ["A", "B", "C", "D"],\n      "answer": "exact option text",\n      "explanation": "string"\n    }\n  ]\n}\n\nRules:\n- Session: ${sessionTitle}\n- Difficulty: ${difficulty}\n- Generate exactly ${count} questions.\n- Use only provided context.\n- Do not include markdown.\n\nContext:\n${contextText || 'No context available.'}`;

  const raw = await generateTextWithFallback({
    prompt,
    generationConfig: {
      responseMimeType: 'application/json',
    },
  });

  try {
    return JSON.parse(raw);
  } catch {
    throw createGenerationError('Gemini returned invalid JSON for quiz generation.');
  }
}

module.exports = {
  runChatQuery,
  shouldRunAsyncChat,
  generateSessionQuiz,
};
