import { Tiktoken } from "@dqbd/tiktoken";
import cl100k_base from "@dqbd/tiktoken/encoders/cl100k_base.json";
import { neon } from "@neondatabase/serverless";
import dotenv from "dotenv";
import fs from "fs/promises";
import OpenAI from "openai";
import path from "path";
dotenv.config();

const databaseUrl = process.env.DATABASE_URL;
const openaiKey = process.env.OPENAI_KEY;

if (!databaseUrl || !openaiKey) {
  throw new Error("DATABASE_URL and OPENAI_KEY must be set");
}

const openai = new OpenAI({
  apiKey: openaiKey,
});

const sql = neon(databaseUrl);

const encoding = new Tiktoken(
  cl100k_base.bpe_ranks,
  cl100k_base.special_tokens,
  cl100k_base.pat_str
);

// 1. Save all our scraped files in an array containing the filename and its content.
// 2. Transform each file into tokens to be able to split them.
// 3. Split the text into segments using the number of tokens.
// 4. Get the "embedding" via OpenAI API for each segment.
// 5. Save everything in our database.

// -----------
// Step 1
// -----------

type TextFile = {
  filePath: string;
  text: string;
};

async function processFiles(folder: string): Promise<TextFile[]> {
  // This function processes all files in a specific folder and returns their content
  // Parameter: folder - the name of the subfolder in the ./data/ directory
  // Returns: an array of TextFile objects containing the path and content of each file

  // Initialize an empty array to store file information
  const files: TextFile[] = [];

  // Build the complete path to the folder to process
  const folderPath = `./data/${folder}`;

  // Read the folder contents with withFileTypes option to get information about each entry
  const entries = await fs.readdir(folderPath, { withFileTypes: true });

  // Loop through each folder entry
  for (const entry of entries) {
    // Build the complete path to the file or folder
    const fullPath = path.join(folderPath, entry.name);

    // Skip subdirectories, only process files
    if (entry.isDirectory()) {
      continue;
    }

    // Read the file content in UTF-8
    const text = await fs.readFile(fullPath, "utf-8");

    // Add file information to the array
    files.push({
      filePath: entry.name, // Store only the filename, not the complete path
      text, // Store the text content of the file
    });
  }

  return files;
}

// -----------
// Step 2
// -----------

type TextFileToken = TextFile & {
  token: Uint32Array;
};

const tiktokenizer = async (files: TextFile[]): Promise<TextFileToken[]> => {
  const textFileTokens: TextFileToken[] = [];

  for (const file of files) {
    const token = encoding.encode(file.text);

    textFileTokens.push({
      ...file,
      token,
    });
  }

  return textFileTokens;
};

// -----------
// Step 3
// -----------

const MAX_TOKENS = 500;

async function splitTextToMany(text: TextFileToken): Promise<TextFile[]> {
  const sentences = text.text
    .split(". ")
    .map((sentence) => ({
      text: sentence + ". ",
      numberTokens: encoding.encode(sentence).length,
    }))
    .reduce((acc, sentence) => {
      // if the sentence is too long, split it by \n
      if (sentence.numberTokens > MAX_TOKENS) {
        const sentences = sentence.text.split("\n").map((sentence) => ({
          text: sentence + "\n",
          numberTokens: encoding.encode(sentence).length,
        }));

        // check if new sentences is too long, if it's the case, cut every space
        const sentencesTooLong = sentences.filter(
          (sentence) => sentence.numberTokens > MAX_TOKENS
        );

        if (sentencesTooLong.length > 0) {
          const word = sentence.text.split(" ").map((sentence) => ({
            text: sentence + " ",
            numberTokens: encoding.encode(sentence).length,
          }));

          return [...acc, ...word];
        }

        return [...acc, ...sentences];
      }
      return [...acc, sentence];
    }, [] as { text: string; numberTokens: number }[]);

  const chunks: TextFile[] = [];

  let tokensSoFar = 0;
  let currentChunks: TextFileToken[] = [];

  for (const sentence of sentences) {
    const numberToken = sentence.numberTokens;

    if (tokensSoFar + numberToken > MAX_TOKENS) {
      const chunkText = currentChunks.map((c) => c.text).join("");
      chunks.push({
        filePath: text.filePath,
        text: chunkText,
      });

      currentChunks = [];
      tokensSoFar = 0;
    }

    currentChunks.push({
      filePath: text.filePath,
      text: sentence.text,
      token: new Uint32Array(),
    });

    tokensSoFar += numberToken;
  }

  if (currentChunks.length > 0) {
    const chunkText = currentChunks.map((c) => c.text).join("");
    if (chunkText.length > 100) {
      chunks.push({
        filePath: text.filePath,
        text: chunkText,
      });
    }
  }

  return chunks;
}

async function splitTexts(texts: TextFileToken[]): Promise<TextFile[]> {
  const shortened: TextFile[] = [];

  for (const file of texts) {
    if (file.token.length > MAX_TOKENS) {
      const chunks = await splitTextToMany(file);
      shortened.push(...chunks);
    } else {
      shortened.push(file);
    }
  }

  return shortened;
}

// -----------
// Step 4
// -----------

type TextFileTokenEmbedding = TextFile & {
  embedding: number[];
};

async function processEmbeddings(
  texts: TextFile[]
): Promise<TextFileTokenEmbedding[]> {
  const embededs: TextFileTokenEmbedding[] = [];
  let i = 0;

  for await (const file of texts) {
    const result = await openai.embeddings.create({
      model: "text-embedding-ada-002",
      input: file.text,
      encoding_format: "float",
    });

    const embeddings = result.data[0].embedding;

    embededs.push({
      ...file,
      embedding: embeddings,
    });

    i++;

    console.log(
      "⛏️ Finished embedding: ",
      file.filePath,
      `${i}/${texts.length}`
    );
  }

  return embededs;
}

// -----------
// Step 5
// -----------

async function saveToDatabase(texts: TextFileTokenEmbedding[]) {
  let totalSaved = 0;
  let totalSkip = 0;

  for await (const row of texts) {
    let { embedding, filePath, text } = row;

    if (text.length < 100) {
      totalSkip++;
      console.log("🚫 Skipping: ", text, `Total: ${totalSkip}`);
      continue;
    }

    totalSaved++;

    const vectorSize = 1536;

    const vectorPadded = new Array(vectorSize).fill(0);
    vectorPadded.splice(0, embedding.length, ...embedding);

    //const insertQuery = `INSERT INTO documents (text, n_tokens, file_path, embeddings) values ($1, $2, $3, $4);`;

    const tokens = encoding.encode(text);
    const tokensLength = tokens.length;

    try {
      await sql`
        INSERT INTO documents (text, n_tokens, file_path, embeddings)
        VALUES (${text}, ${tokensLength}, ${filePath}, ${JSON.stringify(
        vectorPadded
      )})
      `;

      console.log(
        "🎈 Saved to database :",
        filePath,
        `(${totalSaved}/${texts.length})`
      );
    } catch (error) {
      console.error("❌ Error saving to database:", error);
    }
  }
}

// -----------
// Embedding
// -----------

async function embedding() {
  const FOLDER = "nextjs";

  const texts = await cache_withFile(
    () => processFiles(FOLDER),
    "processed/texts.json"
  );

  const textsTokens = await tiktokenizer(texts);

  const textsTokensShortened = await cache_withFile(
    () => splitTexts(textsTokens),
    "processed/textsTokensShortened.json"
  );

  const textsTokensEmbeddings = await cache_withFile(
    () => processEmbeddings(textsTokensShortened),
    "processed/textsTokensEmbeddings.json"
  );

  await saveToDatabase(textsTokensEmbeddings);
}

embedding();

async function cache_withFile<T>(
  func: () => Promise<T>,
  filePath: string
): Promise<T> {
  console.log("Running function: ", func.toString());
  console.log("Cache file: ", filePath);

  try {
    await fs.access(filePath);

    const fileData = await fs.readFile(filePath, "utf-8");

    console.log("🛟 Using cache file");
    return JSON.parse(fileData);
  } catch {
    const data = await func();

    console.log("📦 Writing cache file");
    await fs.writeFile(filePath, JSON.stringify(data));

    return data;
  }
}
