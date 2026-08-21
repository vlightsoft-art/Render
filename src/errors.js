class ApiError extends Error {
  constructor(status, code, message, field = undefined, extra = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.field = field;
    this.extra = extra;
  }
}

const INTERNAL_MESSAGE = 'Unable to save right now. Your information was not lost. Please retry.';

function apiError(status, code, message, field, extra) {
  return new ApiError(status, code, message, field, extra);
}

function sendApiError(res, err) {
  if (err && err.code === 121) {
    return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Check the information and try again.' } });
  }
  if (err instanceof ApiError) {
    const body = { success: false, error: { code: err.code, message: err.message } };
    if (err.field) body.error.field = err.field;
    if (err.extra?.remote) body.remote = err.extra.remote;
    return res.status(err.status).json(body);
  }
  console.error(err);
  return res.status(500).json({
    success: false,
    error: { code: 'INTERNAL_ERROR', message: INTERNAL_MESSAGE }
  });
}

function sendAuthError(res, status, code, message) {
  return res.status(status).json({ code, message });
}

module.exports = { ApiError, apiError, sendApiError, sendAuthError, INTERNAL_MESSAGE };
