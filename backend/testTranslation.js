require("dotenv").config();

const {
  translateToEnglish,
} = require("./services/azureTranslator");

async function test() {
  const result = await translateToEnglish(
    "Kal client ke saath meeting schedule kar dena.",
    "hi"
  );

  console.log("Translation:", result);
}

test();