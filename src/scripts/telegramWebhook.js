import config from '../configs/variables.config.js';
import telegram from '../libs/adapters/channel/telegram.js';

const { TELEGRAM } = config;

/**
 * Register, inspect or clear the Telegram webhook.
 *
 * A deploy step, like `npm run scheduler`: Telegram stores the webhook URL
 * against the bot, so it is set once per environment rather than on every boot.
 * Without this, `TELEGRAM_MODE=webhook` is a mode with no way to enter it —
 * the route would exist and Telegram would never call it.
 *
 *   npm run telegram:webhook -- --set https://api.example.com/api/v1/integrations/telegram/webhook
 *   npm run telegram:webhook -- --info
 *   npm run telegram:webhook -- --delete
 */
const usage = () => {
  console.log(
    'usage: telegram:webhook -- --set <https-url> | --info | --delete\n' +
      '  --set requires TELEGRAM_WEBHOOK_SECRET to be configured.'
  );
};

const run = async () => {
  if (!telegram.isConfigured()) {
    console.error('TELEGRAM_BOT_TOKEN is not set.');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const flag = args.find((a) => a.startsWith('--'));

  if (flag === '--info') {
    const info = await telegram.getMe();
    console.log(info.ok ? `bot: @${info.result.username} (id ${info.result.id})` : `error: ${info.detail}`);
    console.log(`configured mode: ${TELEGRAM.MODE}`);
    return;
  }

  if (flag === '--delete') {
    const result = await telegram.deleteWebhook();
    console.log(result.ok ? 'webhook cleared' : `error: ${result.detail}`);
    return;
  }

  if (flag === '--set') {
    const url = args[args.indexOf('--set') + 1];
    if (!url || !url.startsWith('https://')) {
      // Telegram refuses plain HTTP outright; failing here gives a readable
      // reason instead of an opaque API rejection.
      console.error('--set needs an https:// URL that Telegram can reach.');
      process.exit(1);
    }
    if (!TELEGRAM.WEBHOOK_SECRET) {
      // Without the secret the route rejects every update, so registering the
      // URL would produce a webhook that is live and permanently 404ing.
      console.error('TELEGRAM_WEBHOOK_SECRET must be set before registering a webhook.');
      process.exit(1);
    }
    const result = await telegram.setWebhook({ url, secret: TELEGRAM.WEBHOOK_SECRET });
    console.log(result.ok ? `webhook set to ${url}` : `error: ${result.detail}`);
    if (TELEGRAM.MODE !== 'webhook') {
      console.warn(`note: TELEGRAM_MODE is "${TELEGRAM.MODE}" — set it to "webhook" so the worker stops polling.`);
    }
    return;
  }

  usage();
  process.exit(1);
};

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
