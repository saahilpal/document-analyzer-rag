const { toErrorObject } = require('../utils/errors');

function ok(res, data, status = 200) {
  return res.status(status).json({ ok: true, data });
}

function fail(res, error, status = 400) {
  return res.status(status).json({
    ok: false,
    error: toErrorObject(error, status),
  });
}

module.exports = {
  ok,
  fail,
};
