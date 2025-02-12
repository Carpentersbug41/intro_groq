import fs from "fs";
import path from "path";
import { OpenAI } from "openai";
import 'dotenv/config';


// 1) Initialize OpenAI (requires OPENAI_API_KEY in environment)
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 2) Paths to transcript input & embeddings output
const TRANSCRIPT_PATH = path.join(process.cwd(), "data", "transcript.txt");
const EMBEDDINGS_PATH = path.join(process.cwd(), "data", "embeddings.json");

// 3) Decide how many sentences per chunk
const MAX_SENTENCES_PER_CHUNK = 3; // set to 2, 3, or 4, etc.

// 4) Clean up transcript text (remove [Music], extra newlines, etc.)
function cleanText(text: string): string {
  return text
    .replace(/\[Music\]/gi, "") // remove [Music] tags if any
    .replace(/\n+/g, " ")       // replace newlines with spaces
    .trim();
}

// 5) Split the text into sentences using a simple regex
function splitIntoSentences(text: string): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+/g);
  return sentences ? sentences.map(s => s.trim()) : [];
}

// 6) Group sentences into chunks of size = MAX_SENTENCES_PER_CHUNK
function groupSentences(sentences: string[], maxSentences: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < sentences.length; i += maxSentences) {
    const chunk = sentences.slice(i, i + maxSentences).join(" ");
    chunks.push(chunk);
  }
  return chunks;
}

// 7) Generate an embedding for a given text chunk
async function getEmbedding(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: "text-embedding-ada-002",
    input: text,
  });
  return response.data[0].embedding;
}

// 8) Main function: read transcript, chunk it, embed each chunk, save to JSON
async function processTranscript() {
  // 8a) Read and clean transcript
  if (!fs.existsSync(TRANSCRIPT_PATH)) {
    console.error(`Transcript file not found at ${TRANSCRIPT_PATH}`);
    process.exit(1);
  }
  const rawText = fs.readFileSync(TRANSCRIPT_PATH, "utf-8");
  const cleanedText = cleanText(rawText);

  // 8b) Split into sentences and group them
  const sentences = splitIntoSentences(cleanedText);
  const chunks = groupSentences(sentences, MAX_SENTENCES_PER_CHUNK);

  console.log(`Total sentences found: ${sentences.length}`);
  console.log(`Total chunks: ${chunks.length}`);

  // 8c) For each chunk, get embeddings
  const embeddingsArray = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    console.log(`Processing chunk ${i+1}/${chunks.length}: ${chunk.substring(0, 50)}...`);

    try {
      const embedding = await getEmbedding(chunk);
      embeddingsArray.push({
        id: `chunk_${i}`,
        text: chunk,
        embedding,
      });
    } catch (error) {
      console.error(`Error embedding chunk ${i}:`, error);
    }
  }

  // 8d) Write the embeddings to embeddings.json
  fs.writeFileSync(EMBEDDINGS_PATH, JSON.stringify(embeddingsArray, null, 2));
  console.log(`✅ Embeddings saved to ${EMBEDDINGS_PATH}`);
}

// 9) Run the script
processTranscript().catch((err) => {
  console.error("Fatal error in processTranscript:", err);
  process.exit(1);
});
