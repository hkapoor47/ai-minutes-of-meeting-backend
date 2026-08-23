const axios = require("axios");

const TRANSLATION_URL =
    `${process.env.LIBRETRANSLATE_URL}/translate`;

const translationClient = axios.create({
    timeout: 60000,
    headers: {
        "Content-Type": "application/json",
    },
});

// Process translations one at a time.
// This prevents multiple Hindi sentences from hitting
// the Render LibreTranslate service simultaneously.
let translationQueue = Promise.resolve();

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isHindi(text) {
    return /[\u0900-\u097F]/.test(text);
}

function runTranslation(text, sourceLanguage) {
    translationQueue = translationQueue
        .catch(() => {})
        .then(async () => {

            const payload = {
                q: text,
                source: sourceLanguage || "auto",
                target: "en",
                format: "text",
            };

            const MAX_ATTEMPTS = 2;

            for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {

                try {
                    console.log(
                        `Translation attempt ${attempt}/${MAX_ATTEMPTS}`,
                        {
                            text,
                            source: sourceLanguage,
                        }
                    );

                    const response = await translationClient.post(
                        TRANSLATION_URL,
                        payload
                    );

                    const translated =
                        response.data?.translatedText?.trim();

                    if (!translated) {
                        throw new Error(
                            "LibreTranslate returned empty translatedText"
                        );
                    }

                    // Hindi input should not come back unchanged.
                    if (
                        sourceLanguage === "hi" &&
                        translated === text.trim()
                    ) {
                        throw new Error(
                            "LibreTranslate returned the original Hindi text"
                        );
                    }

                    console.log(
                        "Translation successful:",
                        translated
                    );

                    return translated;

                } catch (error) {

                    console.error(
                        `Translation attempt ${attempt} failed:`,
                        error.response?.status || error.message
                    );

                    if (attempt < MAX_ATTEMPTS) {
                        await sleep(3000);
                    }
                }
            }

            console.error(
                "Translation failed after all attempts:",
                text
            );

            return "";
        });

    return translationQueue;
}

async function translateTranscript(text, sourceLanguage = "auto") {

    if (!text || !text.trim()) {
        return "";
    }

    const cleanText = text.trim();

    // English does not need translation.
    if (
        sourceLanguage === "en" ||
        (!sourceLanguage && !isHindi(cleanText))
    ) {
        return cleanText;
    }

    return runTranslation(
        cleanText,
        sourceLanguage
    );
}

module.exports = {
    translateTranscript,
};