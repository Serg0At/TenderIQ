/**
 * HTML escaping, in one place.
 *
 * Three callers need it and they need it for different reasons, which is
 * exactly why it must not be three copies: Telegram's `parse_mode: HTML`
 * rejects a message with a stray `<`, an alert email renders scraped Armenian
 * procurement titles into a document, and the auth mail interpolates a token
 * into an `href`. A divergence between those copies is a 400 on one channel or
 * an injection on another.
 *
 * `&` must be replaced first or it would double-escape the entities the later
 * replacements produce.
 *
 * The quote is escaped even though neither Telegram's text mode nor an HTML
 * text node requires it: the same helper is used inside `href="…"`, where an
 * unescaped quote closes the attribute early and lets scraped text write its
 * own. Escaping it always is cheaper than remembering which call site is an
 * attribute.
 *
 * Scraped source text reaches this function directly, so treating it as data
 * rather than markup is a safety property here, not a formatting preference.
 */
export const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export default { escapeHtml };
