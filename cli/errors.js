'use strict';

class HubError extends Error {
  constructor(code, message) {
    super(message);
    this.exitCode = code;
  }
}

function hubError(code, message) {
  return new HubError(code, message);
}

module.exports = { HubError, hubError };
