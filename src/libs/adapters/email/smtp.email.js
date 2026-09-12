import nodemailer from 'nodemailer';
import config from '../../../configs/variables.config.js';

const { EMAIL } = config;

/**
 * The SMTP driver — the only file in the codebase that speaks to a mail server.
 *
 * Transport only, and the same contract as the Telegram adapter: it takes an
 * address and a body, and reports what happened. It never throws for a provider
 * failure, because a mail server being down must not take a registration with
 * it — the caller decides whether the send was the point of the request.
 */

/**
 * How a failure should be treated, which is the only thing the caller needs.
 *
 *   permanent — the address does not exist or the server refused the recipient
 *               outright (5xx). Retrying sends the same message to the same
 *               dead address.
 *   throttled — 421/450/451 and the rest of the 4xx greylisting family. The
 *               server is asking for later, not saying no.
 *   transient — connection resets, timeouts, DNS. Worth another attempt.
 *   auth      — bad credentials. Every send will fail identically until a human
 *               fixes the config, so it is called out separately rather than
 *               being retried forever as a transient.
 */
const classify = (error) => {
  const code = error?.responseCode ?? 0;
  if (error?.code === 'EAUTH') return 'auth';
  if (code >= 500) return 'permanent';
  if (code >= 400) return 'throttled';
  return 'transient';
};

let transport = null;

const getTransport = () => {
  if (transport) return transport;
  transport = nodemailer.createTransport({
    host: EMAIL.SMTP.HOST,
    port: EMAIL.SMTP.PORT,
    // Implicit TLS on 465 only. On 587 the connection starts in clear and is
    // upgraded, so `requireTLS` is what makes that upgrade mandatory: without
    // it nodemailer will happily continue unencrypted if the server does not
    // advertise STARTTLS, and the SMTP password goes out in the clear.
    secure: EMAIL.SMTP.SECURE,
    requireTLS: !EMAIL.SMTP.SECURE,
    auth: EMAIL.SMTP.USER ? { user: EMAIL.SMTP.USER, pass: EMAIL.SMTP.PASSWORD } : undefined,
    // A hung mail server must not pin the request thread behind it. These are
    // well under the API's own patience.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return transport;
};

export const create = () => ({
  name: 'smtp',

  send: async ({ to, subject, text, html, headers }) => {
    try {
      const info = await getTransport().sendMail({
        from: EMAIL.FROM,
        replyTo: EMAIL.REPLY_TO,
        to,
        subject,
        text,
        html,
        headers,
      });
      return { ok: true, kind: 'sent', messageId: info.messageId };
    } catch (error) {
      return { ok: false, kind: classify(error), detail: error.message };
    }
  },

  /** Used by the boot check, so a bad SMTP config surfaces before a user hits it. */
  verify: async () => {
    try {
      await getTransport().verify();
      return { ok: true, kind: 'sent' };
    } catch (error) {
      return { ok: false, kind: classify(error), detail: error.message };
    }
  },
});

export default { create };
