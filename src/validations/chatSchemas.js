const { z } = require('zod');

const chatBodySchema = z.object({
    sessionId: z.union([z.string(), z.number()]).optional(),
    message: z.string().min(1).max(10_000),
    history: z.array(z.object({
        role: z.enum(['user', 'assistant']),
        text: z.string(),
    })).max(100).optional(),
    responseStyle: z.enum(['structured', 'plain']).optional(),
});

const historyQuerySchema = z.object({
    limit: z
        .string()
        .regex(/^\d+$/)
        .optional(),
    offset: z
        .string()
        .regex(/^\d+$/)
        .optional(),
});

module.exports = {
    chatBodySchema,
    historyQuerySchema
};
