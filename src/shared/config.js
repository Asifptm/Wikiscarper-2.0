const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');

function deepMerge(target, source) {
  const out = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === 'object'
    ) {
      out[key] = deepMerge(target[key], source[key]);
    } else {
      out[key] = source[key];
    }
  }
  return out;
}

function loadConfig() {
  const defaultPath = path.join(ROOT, 'config/default.json');
  const localPath = path.join(ROOT, 'config/local.json');
  const captchaPath = path.join(ROOT, 'config/captcha.json');

  let config = JSON.parse(fs.readFileSync(defaultPath, 'utf8'));

  if (fs.existsSync(localPath)) {
    config = deepMerge(config, JSON.parse(fs.readFileSync(localPath, 'utf8')));
  }

  if (fs.existsSync(captchaPath)) {
    const captcha = JSON.parse(fs.readFileSync(captchaPath, 'utf8'));
    config.captcha = deepMerge(config.captcha, captcha);
  }

  return config;
}

function resolvePath(relativePath) {
  return path.resolve(ROOT, relativePath);
}

module.exports = { loadConfig, resolvePath, ROOT };
