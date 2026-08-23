const axios = require("axios");

const TRANSLATION_URL =
    `${process.env.LIBRETRANSLATE_URL}/translate`;

async function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function translateTranscript(text) {
    if (!text || !text.trim()) {
        return "";
    }

    const payload = {
        q: text,
        source: "auto",
        target: "en",
        format: "text",
    };

    const MAX_ATTEMPTS = 4;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            console.log(
                ` Translation attempt ${attempt}/${MAX_ATTEMPTS}`
            );

            const response = await axios.post(
                TRANSLATION_URL,
                payload,
                {
                    timeout: 15000,
                    headers: {
                        "Content-Type": "application/json",
                    },
                }
            );

            const translated =
                response.data?.translatedText;

            if (!translated) {
                throw new Error(
                    "Translation service returned empty translatedText"
                );
            }

            console.log(
                " Translation successful:",
                translated
            );

            return translated;

        } catch (error) {
            console.error(
                ` Translation attempt ${attempt} failed:`,
                error.message
            );

            if (attempt < MAX_ATTEMPTS) {
               
                await sleep(2000);
            }
        }
    }

    console.error(
        " Translation failed after all attempts"
    );

   
    return "";
}

module.exports = {
    translateTranscript,
};