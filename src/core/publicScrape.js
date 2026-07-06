const LOGIN_WALL_PATTERNS = [
  /log in to continue/i,
  /sign up to continue/i,
  /create an account to/i,
  /you must be logged in/i,
  /please log in/i,
  /join .+ to view/i,
  /sign in to view/i,
  /this content is not available/i,
];

function isLoginWallContent(markdown) {
  if (!markdown?.trim()) return true;
  const words = markdown.split(/\s+/).filter(Boolean).length;
  const sample = markdown.slice(0, 2500);
  const hit = LOGIN_WALL_PATTERNS.some((p) => p.test(sample));
  return hit && words < 180;
}

const CAPTCHA_WALL_PATTERNS = [
  /google\.com\/recaptcha/i,
  /g-recaptcha/i,
  /hcaptcha\.com/i,
  /h-captcha/i,
  /cf-turnstile/i,
  /challenges\.cloudflare\.com/i,
  /cdn-cgi\/challenge-platform/i,
  /attention required/i,
  /just a moment/i,
  /verify you are human/i,
];

function isCaptchaWallContent(text) {
  if (!text?.trim()) return false;
  const sample = text.slice(0, 12000);
  return CAPTCHA_WALL_PATTERNS.some((p) => p.test(sample));
}

function isUsableScrapeResult(result, minWords = 25) {
  if (!result || result.error) return false;
  if (isCaptchaWallContent(result.markdown)) return false;
  const words = result.word_count ?? 0;
  if (words < minWords) return false;
  if (isLoginWallContent(result.markdown)) return false;
  return true;
}

/**
 * Rewrites URLs to public endpoints when a known no-login mirror exists.
 */
function toPublicUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');

    if (host === 'reddit.com' || host === 'redd.it') {
      parsed.hostname = 'old.reddit.com';
      return parsed.href;
    }

    if (host === 'instagram.com') {
      return url;
    }
  } catch {
    return url;
  }
  return url;
}

module.exports = {
  isLoginWallContent,
  isCaptchaWallContent,
  isUsableScrapeResult,
  toPublicUrl,
};
