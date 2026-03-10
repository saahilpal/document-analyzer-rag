const { z } = require('zod');

const createSessionBodySchema = z.object({
    title: z.string().trim().min(1).max(160).optional().default('NewChat'),
});

const renameSessionBodySchema = z.object({
    title: z.string().trim().min(1).max(60),
});

const sessionSearchQuerySchema = z.object({
    q: z.string().max(160).optional(),
});

module.exports = {
    createSessionBodySchema,
    renameSessionBodySchema,
    sessionSearchQuerySchema
};
