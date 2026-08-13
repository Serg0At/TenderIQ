import * as cheerio from 'cheerio';

const AM_UTC_OFFSET = '+04:00';

const TIMESTAMP = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/g;

const toDate = (value) => {
	const date = new Date(`${value.replace(' ', 'T')}${AM_UTC_OFFSET}`);
	return Number.isNaN(date.getTime()) ? null : date;

};

const parseWindow = (text) => {
	const found = String(text).match(TIMESTAMP) || [];
	return {
        publishedAt: found[0] ? toDate(found[0]) : null,
        deadlineAt: found[1] ? toDate(found[1]) : null,
	};
};

export const parseDetail = (html, { baseUrl } = {}) => {
	const $ = cheerio.load(html);

	// Title heuristics
	let title = $('h1').first().text().trim();
	if (!title) title = $('.tender_title .cont_text a').first().text().trim();
	if (!title) title = $('title').text().trim();

	// Description / main body
	const description = (
	    $('.tender_description').first().text() || $('.tender_content').first().text() || $('body').text() || ''
	).trim();

	// Time window: reuse listing-style timestamps when present
	const timeText = $('.tender_time').first().text() || $('body').text();
	const { publishedAt, deadlineAt } = parseWindow(timeText);

	// Attachments: common document extensions
	const exts = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.zip'];
	const attachments = [];
	$('a[href]').each((_, a) => {
	const href = $(a).attr('href');
	if (!href) return;
	const lower = href.toLowerCase();
	if (exts.some((e) => lower.endsWith(e))) {
	let url = href;
	try {
	    if (baseUrl) url = new URL(href, baseUrl).toString();
	} catch (e) {
	// leave as-is
	}
	attachments.push({ url, title: $(a).text().trim() || null });
	}
	});

	return {
        title: title || null,
        description: description || null,
        publishedAt,
        deadlineAt,
        attachments,
	};
};

export default { parseDetail };
