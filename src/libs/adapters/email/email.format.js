import config from '../../../configs/variables.config.js';
import { escapeHtml } from '../../../utils/html.js';

const { APP, AUTH } = config;

/**
 * The wording of every message this system sends by email. Pure — no I/O, no
 * clock, no database.
 *
 * Kept apart from the transport for the same reason the Telegram formatter is:
 * the copy is the part that gets edited, and it should be readable without
 * opening an SMTP client. Every message is built as plain text AND HTML,
 * because a text/plain-only auth mail is the shape spam filters like least.
 */

/**
 * Wrap body lines in a minimal HTML document.
 *
 * Deliberately inline-styled and table-free: mail clients strip <style> blocks,
 * and this is a five-line transactional message, not a newsletter.
 *
 * Exported because alert mail uses the same shell. One layout is the whole
 * point: a verification mail and a tender alert that look like they came from
 * different companies is how a real message gets read as a phishing attempt.
 */
export const layout = (title, lines) => `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:8px;padding:32px">
<h1 style="margin:0 0 16px;font-size:18px;font-weight:600">${escapeHtml(title)}</h1>
${lines.join('\n')}
<p style="margin:24px 0 0;font-size:12px;color:#6b7280">Tendra — Armenian public procurement intelligence</p>
</div></body></html>`;

export const paragraph = (text) =>
  `<p style="margin:0 0 12px;font-size:14px;line-height:1.5">${escapeHtml(text)}</p>`;

/**
 * The verification link.
 *
 * `APP.BASE_URL` is unset until a frontend exists, and there is no honest
 * fallback for this one — an alert can link to the source board instead of the
 * product, but a verification link can only point at the thing that holds the
 * token. So an unset base URL yields the bare token with an instruction, which
 * is at least actionable by a human with curl, rather than a link into nothing.
 */
const verifyUrl = (token) =>
  APP.BASE_URL ? `${APP.BASE_URL.replace(/\/+$/, '')}/auth/verify-email?token=${token}` : null;

export const verificationEmail = ({ token }) => {
  const url = verifyUrl(token);
  const hours = AUTH.EMAIL_VERIFY_TTL_HOURS;

  const body = url
    ? [`Confirm your address to finish setting up your Tendra account:`, '', url]
    : [
        'Confirm your address to finish setting up your Tendra account.',
        '',
        'Your verification token:',
        token,
      ];

  return {
    subject: 'Confirm your Tendra email address',
    text: [...body, '', `This link expires in ${hours} hours.`, '', "If you did not create a Tendra account, ignore this message."].join('\n'),
    html: layout('Confirm your email address', [
      paragraph('Confirm your address to finish setting up your Tendra account.'),
      url
        ? `<p style="margin:0 0 20px"><a href="${escapeHtml(url)}" style="display:inline-block;background:#1a56db;color:#ffffff;text-decoration:none;padding:10px 20px;border-radius:6px;font-size:14px">Confirm email address</a></p>`
        : `<p style="margin:0 0 20px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:16px;background:#f3f4f6;padding:12px;border-radius:6px">${escapeHtml(token)}</p>`,
      paragraph(`This link expires in ${hours} hours.`),
      paragraph('If you did not create a Tendra account, ignore this message.'),
    ]),
  };
};

/**
 * The password-reset code.
 *
 * A six-digit code rather than a link, because the client asks for it back on
 * a screen the user is already looking at — and because a code that is read
 * and typed cannot be followed by a mail scanner prefetching every URL in the
 * message, which is a real way link-based resets get burned before the user
 * sees them.
 */
export const resetCodeEmail = ({ code }) => {
  const minutes = AUTH.RESET_CODE_TTL_MINUTES;

  return {
    subject: 'Your Tendra password reset code',
    text: [
      'Use this code to reset your Tendra password:',
      '',
      code,
      '',
      `The code expires in ${minutes} minutes and can be used once.`,
      '',
      'If you did not ask to reset your password, ignore this message — your password has not changed.',
    ].join('\n'),
    html: layout('Reset your password', [
      paragraph('Use this code to reset your Tendra password:'),
      `<p style="margin:0 0 20px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:28px;letter-spacing:6px;font-weight:600;background:#f3f4f6;padding:16px;border-radius:6px;text-align:center">${escapeHtml(code)}</p>`,
      paragraph(`The code expires in ${minutes} minutes and can be used once.`),
      paragraph('If you did not ask to reset your password, ignore this message — your password has not changed.'),
    ]),
  };
};

/**
 * Sent after a successful reset, to the address that was reset.
 *
 * Not a courtesy: it is the only signal the real owner gets if someone else
 * completed a reset on their account, and it arrives after every session has
 * already been revoked.
 */
export const passwordChangedEmail = () => ({
  subject: 'Your Tendra password was changed',
  text: [
    'Your Tendra password has just been changed, and every signed-in session was signed out.',
    '',
    'If this was you, nothing further is needed.',
    'If it was not, reset your password immediately and contact support.',
  ].join('\n'),
  html: layout('Your password was changed', [
    paragraph('Your Tendra password has just been changed, and every signed-in session was signed out.'),
    paragraph('If this was you, nothing further is needed.'),
    paragraph('If it was not, reset your password immediately and contact support.'),
  ]),
});

export default { verificationEmail, resetCodeEmail, passwordChangedEmail, layout, paragraph };
