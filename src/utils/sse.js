function initSse(res) {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
    }
}

function writeSseEvent(res, event, payload) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    if (typeof res.flush === 'function') {
        res.flush();
    }
}

function shouldStreamChat(req) {
    const queryFlag = String(req.query.stream || '').toLowerCase() === 'true';
    const acceptHeader = String(req.headers.accept || '').toLowerCase();
    return queryFlag || acceptHeader.includes('text/event-stream');
}

module.exports = {
    initSse,
    writeSseEvent,
    shouldStreamChat,
};
