// rag.ts

/**
 * This file implements a basic RAG (Retrieval-Augmented Generation) module.
 * It connects to a ChromaDB collection that stores transcript chunks (each 100-300 words,
 * with ~30% overlap) and returns the top relevant chunks for a given user query.
 *
 * The two main functions are:
 *  1. getEmbedding(text): Converts text into an embedding vector.
 *  2. retrieveTranscriptChunks(query, limit): Uses the query embedding to perform a
 *     similarity search in ChromaDB and returns up to `limit` matching transcript chunks.
 *
 * In this example, we use OpenAI's text-embedding API for embeddings and assume that
 * your ChromaDB instance exposes a REST API endpoint for querying.
 */

const CHROMA_API_URL = process.env.CHROMA_API_URL || "http://localhost:8000"; 
// Set this in your environment to your ChromaDB server’s URL.
const CHROMA_COLLECTION_NAME = process.env.CHROMA_COLLECTION_NAME || "youtube_transcript";
// This collection should have your pre-chunked transcript data.

// This function gets an embedding for a given text string.
// In production, you could replace this with any embedding service.
export async function getEmbedding(text: string): Promise<number[]> {
  // Example using OpenAI's embedding API:
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}` // make sure this is set
    },
    body: JSON.stringify({
      model: "text-embedding-ada-002",
      input: text
    })
  });
  if (!response.ok) {
    throw new Error(`Embedding API call failed with status ${response.status}`);
  }
  const data = await response.json();
  // Assumes the response contains an embedding vector in data.data[0].embedding
  return data.data[0].embedding;
}

// This function performs a similarity search against your ChromaDB transcript collection.
// It converts the query into an embedding, then sends that embedding as part of a POST request
// to your ChromaDB REST API endpoint to retrieve the most relevant transcript chunks.
export async function retrieveTranscriptChunks(query: string, limit = 3): Promise<string[]> {
  // 1. Get the embedding for the query
  const embedding = await getEmbedding(query);

  // 2. Prepare the payload for the ChromaDB query.
  // The payload includes the embedding (your query vector) and the desired number of results.
  const payload = {
    query: embedding,
    n_results: limit
  };

  // 3. Send the query to ChromaDB. The endpoint URL and structure may vary
  // depending on your ChromaDB setup. Adjust the URL/path as needed.
  const response = await fetch(`${CHROMA_API_URL}/collections/${CHROMA_COLLECTION_NAME}/query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  
  if (!response.ok) {
    throw new Error(`ChromaDB query failed with status ${response.status}`);
  }

  const data = await response.json();

  // 4. Process the response.
  // Here we assume that the returned JSON has a property (e.g., "results") which is an array
  // of objects where each object has a "text" property containing a transcript chunk.
  // Adjust the mapping if your ChromaDB response has a different schema.
  const chunks: string[] = data.results.map((result: any) => result.text);
  return chunks;
}
