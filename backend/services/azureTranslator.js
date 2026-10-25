const createClient = require("@azure-rest/ai-translation-text").default;
const { isUnexpected } = require("@azure-rest/ai-translation-text");

const endpoint = process.env.AZURE_TRANSLATOR_ENDPOINT;
const key = process.env.AZURE_TRANSLATOR_KEY;
const region = process.env.AZURE_TRANSLATOR_REGION;

const client = createClient(endpoint, {
  key: key,
  region: region,
});

async function translateToEnglish(text, from = "hi") {
  try {
    const response = await client.path("/translate").post({
      body: {
        inputs: [
          {
            text: text,
            language: from,
            targets: ["en"],
          },
        ],
      },
    });

    if (isUnexpected(response)) {
      console.error("Azure Translation Error:", response.body);
      throw new Error("Azure translation failed");
    }

    return response.body.value[0].translations[0].text;
  } catch (error) {
    console.error("Translation error:", error);
    throw error;
  }
}

module.exports = {
  translateToEnglish,
};