import UnsubscribeService from '../../services/unsubscribe.service.js';
import { escapeHtml } from '../../utils/html.js';
import { ok } from '../../utils/respond.js';

/**
 * The only endpoint in this API that can answer in HTML.
 *
 * Every other route serves a client that asked for JSON. This one is opened by a
 * human pressing a button in a mail client, in a browser, and there is no
 * frontend to redirect them to — so a JSON body would be the entire user
 * experience of unsubscribing. It answers JSON to anything that asks for JSON,
 * so it stays a normal API endpoint for a client that wants one.
 */
const wantsHtml = (req) => req.accepts(['json', 'html']) === 'html';

const page = ({ title, body, action = null }) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · TenderIQ</title></head>
<body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:480px;margin:48px auto;background:#fff;border-radius:8px;padding:32px">
<h1 style="margin:0 0 16px;font-size:18px;font-weight:600">${escapeHtml(title)}</h1>
<p style="margin:0 0 20px;font-size:14px;line-height:1.5">${escapeHtml(body)}</p>
${action ?? ''}
<p style="margin:24px 0 0;font-size:12px;color:#6b7280">TenderIQ — Armenian public procurement intelligence</p>
</div></body></html>`;

export default class UnsubscribeController {
  /**
   * Show what this link would switch off. Changes nothing.
   *
   * Corporate mail security scanners open every URL in every message before the
   * recipient ever sees it. A GET that unsubscribed on sight would silently
   * switch alerts off for exactly the customers whose employers scan hardest,
   * and they would never know why the alerts stopped. So the confirmation is
   * the GET and the act is the POST — which is also what RFC 8058 one-click
   * requires, so the safe design and the standard one are the same design.
   */
  static async preview(req, res) {
    const token = String(req.query.token ?? '');
    const result = await UnsubscribeService.preview(token);

    if (!wantsHtml(req)) return ok(res, result);

    const label =
      result.channel === 'email'
        ? `tender alerts to ${result.address}`
        : 'tender alerts to your linked Telegram chat';

    if (!result.active) {
      return res
        .status(200)
        .type('html')
        .send(page({ title: 'Already unsubscribed', body: `TenderIQ is no longer sending ${label}.` }));
    }

    return res.status(200).type('html').send(
      page({
        title: 'Turn off tender alerts?',
        body: `This will stop ${label}. You can switch them back on any time from TenderIQ.`,
        action: `<form method="post" action="/api/v1/unsubscribe?token=${escapeHtml(token)}">
<button type="submit" style="background:#b42318;color:#fff;border:0;border-radius:6px;padding:10px 20px;font-size:14px;cursor:pointer">Turn off alerts</button>
</form>`,
      })
    );
  }

  /**
   * Switch it off.
   *
   * The token is read from the query string, never from the body, because a
   * one-click unsubscribe does not send the body we would want: Gmail and Yahoo
   * POST `List-Unsubscribe=One-Click` as the entire payload and expect the URL
   * itself to carry the identity.
   */
  static async confirm(req, res) {
    const token = String(req.query.token ?? req.body?.token ?? '');
    const result = await UnsubscribeService.revoke(token);

    if (!wantsHtml(req)) return ok(res, result);

    const label =
      result.channel === 'email'
        ? `Tender alerts to ${result.address} have been turned off.`
        : 'Tender alerts to your linked Telegram chat have been turned off.';

    return res
      .status(200)
      .type('html')
      .send(
        page({
          title: 'Alerts turned off',
          body: `${label} Sign in to TenderIQ to turn them back on.`,
        })
      );
  }
}
