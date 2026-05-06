// Apify SDK - toolkit for building Apify Actors (https://docs.apify.com/sdk/js/)
import { Actor } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';

// Initialize Actor runtime
await Actor.init();

// Input defined in .actor/input_schema.json
const {
    startUrls = ['https://www.glassdoor.com/Interview/index.htm'],
    companies = [],
    roles = [],
    maxRequestsPerCrawl = 200
} = (await Actor.getInput()) ?? {};

// Proxy configuration (recommended for production)
const proxyConfiguration = await Actor.createProxyConfiguration();

// NOTE: Glassdoor content is frequently client-rendered and access-controlled.
// This CheerioCrawler is suitable only for pages with server-rendered HTML or accessible static fragments.
// If target pages require JS rendering or authentication, use PlaywrightCrawler and provide credentials/session handling.

const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxRequestsPerCrawl,
    async requestHandler({ enqueueLinks, request, $, log }) {
        log.info('Processing', { url: request.loadedUrl });

        // Enqueue likely internal links: company interview pages and detail pages
        try {
            await enqueueLinks({
                globs: [
                    '**/Interview/**',
                    '**/Interview/*',
                    '**/emp/*/Interview/*',
                    '**/Job/*',
                    '**/company/*/interview'
                ]
            });
        } catch (err) {
            log.warning('enqueueLinks failed', { error: err.message });
        }

        // Heuristic extraction: find interview question blocks.
        // These selectors are examples and must be adapted to actual site markup.
        const results = [];

        // Attempt to parse common "Q&A" blocks. Look for containers that resemble interview reviews.
        $('.interviewReview, .interviewCard, .article, .gdReview').each((i, el) => {
            try {
                const $el = $(el);
                // Company and role context fallbacks
                const company = companies.length ? companies.join(', ') : $('meta[property="og:site_name"]').attr('content') || $('.empName, .companyName, .employerName').first().text().trim() || null;
                const role = roles.length ? roles.join(', ') : $el.find('.jobTitle, .role, .title').first().text().trim() || null;

                // Try to extract question nodes within the block
                $el.find('.interviewQuestions .question, .interview-question, .q-and-a, .question-item').each((j, qn) => {
                    try {
                        const $qn = $(qn);
                        const question = $qn.find('.questionText, .q').first().text().trim() || $qn.find('h3, h4, strong').first().text().trim() || null;
                        // Answers / sample answers may be in following sibling or within the same container
                        const answer = $qn.find('.answerText, .a, .response').first().text().trim() || $qn.next('p').text().trim() || null;
                        const dateText = $el.find('.date, .interviewDate, .timePosted').first().text().trim() || null;
                        const url = request.loadedUrl;

                        if (question) {
                            results.push({
                                company,
                                role,
                                question,
                                answer: answer || null,
                                dateText: dateText || null,
                                source: 'Glassdoor',
                                url,
                                fetchedAt: new Date().toISOString()
                            });
                        }
                    } catch (e) {
                        // continue parsing other question nodes
                    }
                });

                // If no nested question nodes, try to find inline Q/A patterns inside this container
                if (results.length === 0) {
                    const text = $el.text();
                    const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
                    for (let k = 0; k < Math.min(lines.length, 200); k++) {
                        const line = lines[k];
                        // naive pattern: "Q: ..." or "Question: ..." followed by "A: ..." or "Answer: ..."
                        if (/^\s*(Q:|Question[:]?)/i.test(line)) {
                            const q = line.replace(/^\s*(Q:|Question[:]?)/i, '').trim();
                            let a = null;
                            if (k + 1 < lines.length && /^\s*(A:|Answer[:]?)/i.test(lines[k + 1])) {
                                a = lines[k + 1].replace(/^\s*(A:|Answer[:]?)/i, '').trim();
                            }
                            results.push({
                                company,
                                role,
                                question: q,
                                answer: a,
                                dateText: null,
                                source: 'Glassdoor',
                                url: request.loadedUrl,
                                fetchedAt: new Date().toISOString()
                            });
                        }
                    }
                }
            } catch (e) {
                // ignore per-block parse errors
            }
        });

        // Additional fallback: if page looks like a single interview detail page
        if (results.length === 0) {
            const questionNodes = $('.question, .interview-question, .q-and-a, .interviewQuestions');
            if (questionNodes.length) {
                questionNodes.each((j, qn) => {
                    try {
                        const question = $(qn).find('.questionText, h3, strong').first().text().trim() || $(qn).text().trim();
                        const answer = $(qn).find('.answerText, .a, p').first().text().trim() || null;
                        if (question) {
                            results.push({
                                company: $('meta[property="og:site_name"]').attr('content') || null,
                                role: $('h1, .jobTitle, .role').first().text().trim() || null,
                                question,
                                answer,
                                dateText: $('.date, .interviewDate').first().text().trim() || null,
                                source: 'Glassdoor',
                                url: request.loadedUrl,
                                fetchedAt: new Date().toISOString()
                            });
                        }
                    } catch (e) {
                        // continue
                    }
                });
            }
        }

        // Save parsed items
        for (const item of results) {
            log.info('Saving interview Q&A', { company: item.company, role: item.role, question: item.question });
            await Dataset.pushData(item);
        }
    },
    // You can add failedRequestHandler and other retry strategies here for production.
});

await crawler.run(startUrls);

await Actor.exit();