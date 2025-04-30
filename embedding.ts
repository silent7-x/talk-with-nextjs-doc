import { neon } from "@neondatabase/serverless";
import OpenAI from "openai";

const databaseUrl = process.env.DATABASE_URL;
const openaiKey = process.env.OPENAI_KEY;

if (!databaseUrl || !openaiKey) {
  throw new Error("DATABASE_URL and OPENAI_KEY must be set");
}

const openai = new OpenAI({
  apiKey: openaiKey,
});

const sql = neon(databaseUrl);

async function embedding() {}

embedding();
