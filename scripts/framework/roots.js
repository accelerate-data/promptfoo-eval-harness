const path = require('node:path');

const FRAMEWORK_ROOT = path.resolve(__dirname);
const EVAL_ROOT = process.env.AD_EVALS_ROOT
  ? path.resolve(process.env.AD_EVALS_ROOT)
  : path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(EVAL_ROOT, '..', '..');

module.exports = { EVAL_ROOT, FRAMEWORK_ROOT, REPO_ROOT };
