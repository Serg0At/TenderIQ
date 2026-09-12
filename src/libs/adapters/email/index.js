import config from '../../../configs/variables.config.js';
import { logger } from '../../../utils/logger.js';

const { EMAIL, NODE_ENV } = config;

/**
 * The email port — the one way anything in this codebase sends mail.
 *
 * Same shape as the storage port: the driver is chosen lazily from
 * `EMAIL.DRIVER` and nothing above this file knows which one it got. A service
 * asks for a message to be delivered and reads back a classified result; it
 * never learns whether that meant SMTP or a line in the log.
 */

let instance = null;

export const isConfigured = () => EMAIL.DRIVER !== 'smtp' || Boolean(EMAIL.SMTP.HOST);

const getDriver = async () => {
  if (instance) return instance;

  if (EMAIL.DRIVER === 'smtp' && !EMAIL.SMTP.HOST) {
    // Falling back to the log driver here would be the wrong kindness: the
    // deployer asked for SMTP, and silently printing password-reset codes to
    // the log instead is a worse outcome than a failed send they can see.
    logger.error('[email] EMAIL_DRIVER=smtp but SMTP_HOST is unset — no mail will be sent');
    return null;
  }

  const module =
    EMAIL.DRIVER === 'smtp' ? await import('./smtp.email.js') : await import('./log.email.js');
  instance = module.create();
  return instance;
};

/**
 * Send one message.
 *
 * Never throws. A dead mail server is a routine operational event, and the
 * caller is in the middle of a registration or a reset that has already written
 * to the database — an exception here would abort work that succeeded.
 *
 * `headers` carries the few RFC headers a caller genuinely needs to set, and in
 * practice that is `List-Unsubscribe` on alert mail. It is per-message rather
 * than global because it must NOT appear on a verification or reset message: a
 * one-click unsubscribe on the mail that carries a password-reset code invites
 * a mail client to prefetch it, and there is nothing there to unsubscribe from.
 */
export const send = async ({ to, subject, text, html, headers }) => {
  const driver = await getDriver();
  if (!driver) return { ok: false, kind: 'unconfigured', detail: 'No usable email driver' };

  const result = await driver.send({ to, subject, text, html, headers });

  // The address is logged, the body never is: these messages carry
  // verification tokens and reset codes, and a log file is not the place for
  // either. (The `log` driver prints the body on purpose — that is what it is
  // for, and why it is refused in production.)
  if (!result.ok) {
    logger.error(`[email] send to ${to} failed (${result.kind}): ${result.detail ?? 'no detail'}`);
  }
  return result;
};

/**
 * Boot-time sanity check, called from the API entry point.
 *
 * Refuses production with the log driver: that combination prints every reset
 * code to the log and sends nothing, which looks like a working auth system
 * right up until a real user needs their password back.
 */
export const assertUsable = async () => {
  if (NODE_ENV === 'production' && EMAIL.DRIVER === 'log') {
    throw new Error('[email] EMAIL_DRIVER=log is a development setting and must not run in production');
  }
  if (EMAIL.DRIVER === 'log') {
    logger.warn('[email] EMAIL_DRIVER=log — messages are written to the log, not delivered');
  }
};

export default { send, isConfigured, assertUsable };
