function ok(res, data, status = 200) {
  return res.status(status).json({ ok: true, data });
}

function setDeprecationHeaders(res, replacementPath) {
  res.setHeader('Deprecation', 'true');
  res.setHeader('Sunset', 'Wed, 31 Dec 2026 23:59:59 GMT');
  if (replacementPath) {
    res.setHeader('Link', `<${replacementPath}>; rel="successor-version"`);
    res.setHeader('Deprecation-Warning', `This endpoint is deprecated. Use ${replacementPath}`);
  }
}

module.exports = {
  ok,
  setDeprecationHeaders,
};
