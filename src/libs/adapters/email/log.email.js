import { logger } from '../../../utils/logger.js';

/**
 * The development driver: it writes the message to the log instead of sending it.
 *
 * It exists so the verification and reset flows are exercisable on a machine
 * with no mail credentials — the same reason the storage port has a `local`
 * driver. It prints the body verbatim, verification link and reset code
 * included, which is the whole point and also why it must never run in
 * production. `index.js` refuses that combination out loud rather than trusting
 * the deployer to notice.
 */
export const create = () => ({
  name: 'log',

  send: async ({ to, subject, text }) => {
    logger.info(
      [
        '[email:log] message NOT sent — EMAIL_DRIVER=log',
        `  to:      ${to}`,
        `  subject: ${subject}`,
        ...String(text).split('\n').map((line) => `  | ${line}`),
      ].join('\n')
    );
    return { ok: true, kind: 'logged' };
  },

  verify: async () => ({ ok: true, kind: 'logged' }),
});

export default { create };
