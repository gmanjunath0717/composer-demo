'use strict';

// A composer turns a request into a file at outPath:
//   proof(req, outPath)  -> writes a PNG
//   render(req, outPath) -> writes a print PDF
// It throws TooLongError({ field }) when text cannot fit.

class TooLongError extends Error {
  constructor(field) {
    super(`text too long for field "${field}"`);
    this.name = 'TooLongError';
    this.field = field;
  }
}

class UnknownTemplateError extends Error {
  constructor(templateId, version) {
    super(`unknown template "${templateId}" version "${version}"`);
    this.name = 'UnknownTemplateError';
  }
}

function createComposer(config) {
  if (config.composer === 'stub') return require('./stub').createStubComposer(config);
  if (config.composer === 'html') return require('./html').createHtmlComposer(config);
  throw new Error(`Unknown COMPOSER "${config.composer}" (use "stub" or "html")`);
}

module.exports = { createComposer, TooLongError, UnknownTemplateError };
