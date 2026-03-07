"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.scrapeURLWithPlaywright = scrapeURLWithPlaywright;
exports.playwrightMaxReasonableTime = playwrightMaxReasonableTime;
const zod_1 = require("zod");
const config_1 = require("../../../../config");
const fetch_1 = require("../../lib/fetch");
const firecrawl_rs_1 = require("@mendable/firecrawl-rs");
async function scrapeURLWithPlaywright(meta) {
    // Determine if screenshot is requested via feature flags
    const wantScreenshot = meta.featureFlags.has("screenshot") || meta.featureFlags.has("screenshot@fullScreen");
    const wantFullPage = meta.featureFlags.has("screenshot@fullScreen");
    // --- Actions support (self-host patch) ---
    const hasActions = meta.options.actions && meta.options.actions.length > 0;
    const response = await (0, fetch_1.robustFetch)({
        url: config_1.config.PLAYWRIGHT_MICROSERVICE_URL,
        headers: {
            "Content-Type": "application/json",
        },
        body: {
            url: meta.rewrittenUrl ?? meta.url,
            wait_after_load: meta.options.waitFor,
            timeout: meta.abort.scrapeTimeout(),
            headers: meta.options.headers,
            skip_tls_verification: meta.options.skipTlsVerification,
            // --- Screenshot support (self-host patch) ---
            screenshot: wantScreenshot,
            screenshot_full_page: wantFullPage,
            // --- Actions support (self-host patch) ---
            ...(hasActions ? { actions: meta.options.actions } : {}),
        },
        method: "POST",
        logger: meta.logger.child("scrapeURLWithPlaywright/robustFetch"),
        schema: zod_1.z.object({
            content: zod_1.z.string(),
            pageStatusCode: zod_1.z.number(),
            pageError: zod_1.z.string().optional(),
            contentType: zod_1.z.string().optional(),
            // --- Screenshot support (self-host patch) ---
            screenshot: zod_1.z.string().optional(),
            // --- Actions support (self-host patch) ---
            actionScreenshots: zod_1.z.array(zod_1.z.string()).optional(),
        }),
        mock: meta.mock,
        abort: meta.abort.asSignal(),
    });
    if (response.contentType?.includes("application/json")) {
        response.content = await (0, firecrawl_rs_1.getInnerJson)(response.content);
    }
    return {
        url: meta.rewrittenUrl ?? meta.url,
        html: response.content,
        statusCode: response.pageStatusCode,
        error: response.pageError,
        contentType: response.contentType,
        proxyUsed: "basic",
        // --- Screenshot support (self-host patch) ---
        screenshot: response.screenshot,
        // --- Actions support (self-host patch) ---
        ...(hasActions ? {
            actions: {
                screenshots: response.actionScreenshots || [],
                scrapes: [],
            },
        } : {}),
    };
}
function playwrightMaxReasonableTime(meta) {
    // Add extra time for screenshot capture and actions
    const screenshotExtra = (meta.featureFlags.has("screenshot") || meta.featureFlags.has("screenshot@fullScreen")) ? 5000 : 0;
    const actionsExtra = (meta.options.actions?.reduce((a, x) => (x.type === "wait" ? (x.milliseconds ?? 1000) + a : 500 + a), 0) ?? 0);
    return (meta.options.waitFor ?? 0) + 30000 + screenshotExtra + actionsExtra;
}
