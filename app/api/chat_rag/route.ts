import PROMPT_LIST from "@/app/api/chat_rag/prompts";




import { NextRequest, NextResponse } from "next/server";

import fs from "fs";
import path from "path";
import { OpenAI } from "openai";

// Log current directory contents
console.log("FILES IN DIRECTORY:", fs.readdirSync(__dirname).join(", "));

// Log absolute path
console.log("ABSOLUTE PATH:", path.resolve(__dirname, "prompts.ts"));


const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export const runtime = "nodejs";


const BUFFER_SIZE = 8;

let conversationHistory: { role: string; content: string }[] = [];
let currentIndex = 0;

// ---------------------------------------------------------------------------------
// Define validation instructions (only once)
// ---------------------------------------------------------------------------------
const defaultValidationInstruction = `
  You are a validation assistant.
  Your task is to assess if the user's input answers the question.

  if the user chooses an option, it is VALID. If user choose an option, it is INVALID.
  Current prompt: '{CURRENT_PROMPT}'
  User input: '{USER_INPUT}'

  Respond with only one word: "VALID" if the user chooses an option,
  or "INVALID" if the user doesn't choose an option.
  Do not provide any additional explanation or description.
`;

const customValidationInstructionForList = `
  You are a validation assistant.
  Your task is to assess if the user has answered 'red'. 
  As long as the user has answered 'red', it is VALID. 
  If not, it is INVALID.
  Current prompt: '{CURRENT_PROMPT}'
  User input: '{USER_INPUT}'

  Respond with only one word: "VALID" if the user has answered 'red',
  or "INVALID" if they have not.
  Do not provide any additional explanation or description.
`;

// Load your embeddings.json once
const embeddingsData = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "data", "embeddings.json"), "utf-8")
);

// Cosine similarity
function cosineSimilarity(vecA: number[], vecB: number[]) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] ** 2;
    normB += vecB[i] ** 2;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Convert user query to embedding
async function getQueryEmbedding(query: string) {
  // Make sure your OPENAI_API_KEY is set
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Missing OPENAI_API_KEY for retrieval");
  }
  const response = await openai.embeddings.create({
    model: "text-embedding-ada-002",
    input: query,
  });
  return response.data[0].embedding;
}

// Retrieve best chunk
async function retrieveBestChunk(query: string) {
  const queryEmbedding = await getQueryEmbedding(query);

  let bestMatch = null;
  let bestScore = -Infinity;

  for (const item of embeddingsData) {
    const score = cosineSimilarity(queryEmbedding, item.embedding);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = item;
    }
  }
  return bestMatch; // { id, text, embedding }
}


// ---------------------------------------------------------------------------------
// 1) MINIMAL VALIDATION CALL (MODIFIED TO ACCEPT A CUSTOM VALIDATION INSTRUCTION)
// ---------------------------------------------------------------------------------
async function validateInput(
  userInput: string,
  currentPrompt: string,
  customValidation?: string
) {
  if (!process.env.GROQ_API_KEY) {
    console.warn("[WARNING] Missing GROQ API key. Prompting user for input.");
    return "Please enter your GROQ API key.";
  }

  let finalInstruction: string;
  if (customValidation) {
    finalInstruction = customValidation
      .replace("{CURRENT_PROMPT}", currentPrompt)
      .replace("{USER_INPUT}", userInput);
  } else {
    finalInstruction = defaultValidationInstruction
      .replace("{CURRENT_PROMPT}", currentPrompt)
      .replace("{USER_INPUT}", userInput);
  }

  console.log("\n[DEBUG] Validation Payload (Minimal):", { userInput, currentPrompt });

  const payload = {
    model: "llama-3.3-70b-versatile",
    temperature: 0,
    messages: [{ role: "system", content: finalInstruction }],
  };

  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.error("[ERROR] Validation API call failed. Returning fallback message.");
      return "There was an issue validating your input. Please try again.";
    }

    const responseData = await response.json();
    const validationResult = responseData.choices?.[0]?.message?.content?.trim() || "INVALID";
    console.log("[DEBUG] Validation Result:", validationResult);

    return validationResult === "VALID";
  } catch (error: any) {
    console.error("[ERROR] Failed to validate input:", error.message);
    return "An error occurred while validating input. Please try again.";
  }
}


// ---------------------------------------------------------------------------------
// 2) RETRY MESSAGE GENERATOR IF INVALID (DO NOT MODIFY THIS SECTION)
// ---------------------------------------------------------------------------------
async function generateRetryMessage(
  userInput: string,
  currentPrompt: string
): Promise<string> {
  console.log("\n[DEBUG] Generating Retry Message for invalid input:", userInput);

  if (!process.env.GROQ_API_KEY) {
    console.warn("[WARNING] Missing GROQ API key. Prompting user for input.");
    return "Please enter your GROQ API key.";
  }

  const payload = {
    model: "llama-3.3-70b-versatile",
    temperature: 0,
    messages: [
      { role: "system", content: currentPrompt },
      ...conversationHistory.filter((entry) => entry.role !== "system"),
    ],
  };

  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.error("[ERROR] Retry API call failed. Returning fallback retry message.");
      return "I didn't quite get that. Can you try rephrasing your answer?";
    }

    const responseData = await response.json();
    const retryContent = responseData.choices?.[0]?.message?.content?.trim();

    if (!retryContent) {
      console.warn("[WARNING] No retry content returned. Using fallback message.");
      return "Hmm, I still didn't understand. Can you clarify?";
    }

    console.log("[DEBUG] Retry Message Generated:\n", retryContent);
    return retryContent;
  } catch (error: any) {
    console.error("[ERROR] Failed to generate retry message:", error.message);
    return "Something went wrong. Please try again.";
  }
}

// ---------------------------------------------------------------------------------
// 3) BASIC FETCH TO THE API (UNTOUCHED)
// ---------------------------------------------------------------------------------
async function fetchApiResponse(payload: any): Promise<string | null> {
  console.log(
    "\n[DEBUG] Basic fetchApiResponse call with payload:\n",
    JSON.stringify(payload, null, 2)
  );

  if (!process.env.GROQ_API_KEY) {
    console.warn("[WARNING] Missing GROQ API key. Prompting user for input.");
    return "Please enter your GROQ API key.";
  }

  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[ERROR] fetchApiResponse call failed:\n", errorText);
      return "There was an issue with the API request. Please check your API key.";
    }

    const responseData = await response.json();
    const responseContent = responseData.choices?.[0]?.message?.content?.trim();

    if (!responseContent) {
      console.warn("[WARNING] API response returned no content.");
      return "I didn't get a response from the API. Please try again.";
    }

    return responseContent;
  } catch (error: any) {
    console.error("[ERROR] in fetchApiResponse:\n", error.message);
    return "An error occurred while fetching the response. Please try again.";
  }
}


// ---------------------------------------------------------------------------------
// Helper: Fetch API Response with Retry Logic
// ---------------------------------------------------------------------------------
async function fetchApiResponseWithRetry(
  payload: any,
  retries = 2,
  delayMs = 500
): Promise<string | null> {
  if (!process.env.GROQ_API_KEY) {
    console.warn("[WARNING] Missing GROQ API key. Prompting user for input.");
    return "Please enter your GROQ API key.";
  }

  let attempt = 0;
  while (attempt < retries) {
    attempt++;
    console.log(`[DEBUG] Retry Attempt: ${attempt}/${retries}`);

    const response = await fetchApiResponse(payload);
    if (response) return response;

    console.warn(`[WARN] Attempt ${attempt} failed. Retrying in ${delayMs}ms...`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  return "The request failed after multiple attempts. Please try again later.";
}

// ---------------------------------------------------------------------------------
// 4) chainIfNeeded LOGIC (UPDATED TO UPDATE THE SYSTEM PROMPT)
// ---------------------------------------------------------------------------------
async function chainIfNeeded(assistantContent: string): Promise<string | null> {
  if (!process.env.GROQ_API_KEY) {
    console.warn("[WARNING] Missing GROQ API key. Prompting user for input.");
    return "Please enter your GROQ API key.";
  }

  let chainResponse = assistantContent;

  while (
    currentIndex < PROMPT_LIST.length &&
    PROMPT_LIST[currentIndex]?.chaining
  ) {
    const nextPrompt = PROMPT_LIST[currentIndex].prompt_text;

    if (conversationHistory[0]?.content === nextPrompt) {
      console.log("[CHAIN DEBUG] Skipping duplicate chaining prompt:\n", nextPrompt);
      currentIndex++;
      continue;
    }

    conversationHistory = conversationHistory.filter(
      (entry) => entry.role !== "system"
    );
    conversationHistory.unshift({ role: "system", content: nextPrompt });
    console.log("[CHAIN DEBUG] Updated system message for chaining:\n", nextPrompt);

    // Append the last assistant output (the chainResponse) as a user message.
    conversationHistory.push({ role: "user", content: chainResponse });

    // Remove duplicate assistant responses
    conversationHistory = conversationHistory.filter((entry, index, self) => {
      if (entry.role !== "assistant") return true;
      if (index < self.length - 1 && self[index + 1]?.role === "user") {
        return self[index + 1].content !== entry.content;
      }
      return true;
    });

    console.log(
      "[CHAIN DEBUG] conversationHistory AFTER removing duplicates:\n",
      JSON.stringify(conversationHistory, null, 2)
    );

    const tempHistory = [...conversationHistory];
    console.log(
      "[CHAIN DEBUG] Next chaining payload to LLM:\n",
      JSON.stringify(tempHistory, null, 2)
    );

    currentIndex++;

    try {
      const chainResp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          temperature: 0,
          messages: tempHistory,
        }),
      });

      if (!chainResp.ok) {
        const errorText = await chainResp.text();
        console.error("[CHAIN DEBUG] Chaining request failed:\n", errorText);
        return chainResponse; // fallback to previous response
      }

      const chainData = await chainResp.json();
      const newContent = chainData.choices?.[0]?.message?.content;

      if (!newContent) {
        console.warn("[CHAIN DEBUG] No content returned from chain. Stopping chaining.");
        return chainResponse;
      }

      console.log("[CHAIN DEBUG] newAssistantContent from chain:", newContent);

      conversationHistory.push({ role: "assistant", content: newContent });
      chainResponse = newContent;
    } catch (error: any) {
      console.error("[ERROR] in chainIfNeeded:\n", error.message);
      return "An error occurred while processing the chaining request. Please try again.";
    }
  }

  console.log("[CHAIN DEBUG] Next prompt is NOT chaining. Stopping chain here.");
  return chainResponse;
}


// ---------------------------------------------------------------------------------
// 5) Auto-TransitionHidden Helper Function (Encapsulated)
// ---------------------------------------------------------------------------------
async function handleAutoTransitionHidden(
  convHistory: { role: string; content: string }[],
  idx: number
): Promise<{
  conversationHistory: { role: string; content: string }[];
  response: string | null;
  updatedIndex: number;
}> {
  console.log("[AUTO-HIDDEN] Starting auto-transition hidden process...");

  // Check if the API key is available
  if (!process.env.GROQ_API_KEY) {
    console.warn("[WARNING] Missing GROQ API key. Prompting user for input.");
    return {
      conversationHistory: convHistory,
      response: "Please enter your GROQ API key.",
      updatedIndex: idx,
    };
  }

  // Append a silent acknowledgment from the user
  convHistory.push({ role: "user", content: "OK" });
  console.log("[AUTO-HIDDEN] user 'OK' appended, but it won’t be shown to the user.");

  idx++;
  const nextPrompt = PROMPT_LIST[idx]?.prompt_text || "No further prompts.";
  console.log("[AUTO-HIDDEN] Next prompt text:", nextPrompt);

  // Update system message
  convHistory = [
    { role: "system", content: nextPrompt },
    ...convHistory.filter((e) => e.role !== "system"),
  ];

  // Construct API request payload
  const payload = {
    model: "llama-3.3-70b-versatile",
    messages: convHistory,
  };

  // Fetch API response with retry logic
  const autoResponse = await fetchApiResponseWithRetry(payload, 2, 500);

  if (!autoResponse) {
    console.warn("[AUTO-HIDDEN] Second LLM call returned no content.");
    return { conversationHistory: convHistory, response: null, updatedIndex: idx };
  }

  // Append assistant's response
  convHistory.push({ role: "assistant", content: autoResponse });

  // **Debugging: Check if the prompt requires memory retention**
  console.log(
    "[AUTO-HIDDEN DEBUG] Checking if this prompt requires important memory:",
    PROMPT_LIST[idx]?.important_memory
  );

  if (PROMPT_LIST[idx]?.important_memory) {
    console.log("[AUTO-HIDDEN DEBUG] This prompt is marked as important. Inserting into memory.");
    
    insertImportantMemory(autoResponse); // Store important response in memory

    console.log("[DEBUG] Important memory successfully inserted for this transition.");
  }

  return { conversationHistory: convHistory, response: autoResponse, updatedIndex: idx };
}



// ---------------------------------------------------------------------------------
// 5b) Auto-TransitionVisible Helper Function (Encapsulated)
// ---------------------------------------------------------------------------------
async function handleAutoTransitionVisible(
  convHistory: { role: string; content: string }[],
  idx: number
): Promise<{
  conversationHistory: { role: string; content: string }[];
  response: string | null;
  updatedIndex: number;
}> {
  console.log("[AUTO-VISIBLE] Starting auto-transition visible process...");

  // Ensure API key exists before making a request
  if (!process.env.GROQ_API_KEY) {
    console.warn("[WARNING] Missing GROQ API Key. Request cannot proceed.");
    return {
      conversationHistory: convHistory,
      response: "Please enter your Groq API Key to continue.",
      updatedIndex: idx,
    };
  }

  // Append user confirmation (visible transition)
  convHistory.push({ role: "user", content: "OK" });
  console.log("[AUTO-VISIBLE] User 'OK' appended (visible).");

  // Move to the next prompt
  idx++;
  const nextPrompt = PROMPT_LIST[idx]?.prompt_text || "No further prompts.";
  console.log("[AUTO-VISIBLE] Next prompt text:", nextPrompt);

  // Update conversation history with new system prompt
  convHistory = [
    { role: "system", content: nextPrompt },
    ...convHistory.filter((e) => e.role !== "system"),
  ];

  // Prepare payload for the API request
  const payload2 = {
    model: "llama-3.3-70b-versatile",
    messages: convHistory,
  };

  // Fetch API response with retry logic
  const autoResponse = await fetchApiResponseWithRetry(payload2, 2, 500);

  // Handle cases where the API fails to return content
  if (!autoResponse) {
    console.warn("[AUTO-VISIBLE] Second LLM call returned no content.");
    return { conversationHistory: convHistory, response: null, updatedIndex: idx };
  }

  // Append assistant response to the conversation
  convHistory.push({ role: "assistant", content: autoResponse });

  // **Check for important memory**
  console.log(
    "[AUTO-VISIBLE DEBUG] Checking if this prompt requires important memory:",
    PROMPT_LIST[idx]?.important_memory
  );

  if (PROMPT_LIST[idx]?.important_memory) {
    console.log("[AUTO-VISIBLE DEBUG] This prompt is marked as important. Inserting into memory.");
    
    // Insert important memory
    insertImportantMemory(autoResponse);

    console.log("[DEBUG] Important_memory successfully inserted for this transition.");
  }

  return { conversationHistory: convHistory, response: autoResponse, updatedIndex: idx };
}

// ---------------------------------------------------------------------------------
// 6) MAIN POST HANDLER (WITH OPTIONAL VALIDATION CHECK + BUFFER MANAGEMENT + AUTO-TRANSITION)
// ---------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------
// 6) MAIN POST HANDLER (WITH OPTIONAL VALIDATION CHECK + BUFFER MANAGEMENT + AUTO-TRANSITION)
// ---------------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  // Check if body.stream is set
  let body: any;
  try {
    body = await req.json();

    // NEW: Debug logs + storing the API Key in the environment
    console.log("✅ Backend received API Key:", body.apiKey);
    console.log("📥 Received Payload:", JSON.stringify(body, null, 2));

    // Set the API key on the server side (if needed globally)
    process.env.GROQ_API_KEY = body.apiKey || process.env.GROQ_API_KEY;
  } catch (err) {
    return new Response("No input received. Please try again.", { status: 400 });
  }

  // If stream === true, do SSE streaming
  if (body.stream === true) {
    return handleStreamingFlow(body.message);
  } else {
    // Else, do the existing "non-streaming" logic (original logic)
    return handleNonStreamingFlow(body.message);
  }
}





/**
 * ---------------------------------------------------------------------------------
 *  Handle the normal (non-streaming) flow EXACTLY as before
 *  (all original code is here, unmodified except we moved it into a function).
 * ---------------------------------------------------------------------------------
 */
/******************************************
 * handleNonStreamingFlow (With Added Debugs)
 ******************************************/
async function handleNonStreamingFlow(incomingMessage: string): Promise<Response> {
  try {
    const userMessage = incomingMessage?.trim();

    console.log("\n[INFO] Received User Input:", userMessage || "[No Input Provided]");
    if (!userMessage) {
      console.log("[WARN] No User Input Received. Returning Error.");
      return new Response("No input received. Please try again.", { status: 400 });
    }

    // Capture the current prompt (do not capture the flag here)
    const currentPrompt = PROMPT_LIST[currentIndex]?.prompt_text;
    if (!currentPrompt) {
      const finalMessage = "Thank you for your responses! Goodbye.";
      conversationHistory.push({ role: "assistant", content: finalMessage });
      console.log("[INFO] Conversation Complete. Final Message Sent.");
      return new Response(finalMessage, { status: 200 });
    }

    // Figure out if the current prompt actually requires validation
    const promptValidation = PROMPT_LIST[currentIndex]?.validation;
    const promptValidationNeeded =
      (typeof promptValidation === "boolean" && promptValidation === true) ||
      (typeof promptValidation === "string");

    const isAutoTransitionHidden = PROMPT_LIST[currentIndex]?.autoTransitionHidden || false;
    const isAutoTransitionVisible = PROMPT_LIST[currentIndex]?.autoTransitionVisible || false;

    console.log("\n[DEBUG] Current Prompt:\n", currentPrompt);
    console.log("[DEBUG] Checking prompt validation property:", promptValidation);
    console.log("[DEBUG] Validation needed?", promptValidationNeeded);
    console.log("[DEBUG] AutoTransitionHidden Status:", isAutoTransitionHidden);
    console.log("[DEBUG] AutoTransitionVisible Status:", isAutoTransitionVisible);

    // 1) Insert the system prompt
    conversationHistory = [
      { role: "system", content: currentPrompt },
      ...conversationHistory.filter((entry) => entry.role !== "system"),
    ];





    console.log(
      "[DEBUG] Updated Conversation History (System Prompt First):\n",
      JSON.stringify(conversationHistory, null, 2)
    );

    // 2) Add user message
    conversationHistory.push({ role: "user", content: userMessage });
    console.log("[DEBUG] Adding User Input to Conversation History.");

    // 3) Manage buffer
    conversationHistory = manageBuffer(conversationHistory);

    // 4) If validation is needed, do it
    if (promptValidationNeeded) {
      console.log("[INFO] This prompt has validation: Checking user input now...");

      // If it's a string => custom instructions
      const customValidation =
        typeof promptValidation === "string" ? promptValidation : undefined;

      const isValid = await validateInput(userMessage, currentPrompt, customValidation);
      if (!isValid) {
        console.log("[INFO] Validation Failed. Retrying the Same Prompt.");
        const retryMsg = await generateRetryMessage(userMessage, currentPrompt);
        conversationHistory.push({ role: "assistant", content: retryMsg });
        conversationHistory = manageBuffer(conversationHistory);
        return new Response(retryMsg, { status: 200 });
      }
      console.log("[INFO] Validation Succeeded. Now incrementing currentIndex...");
      currentIndex++; // Increment after successful validation
    } else {
      console.log("[INFO] No validation property found. Skipping validation. Incrementing currentIndex...");
      currentIndex++;
    }

    // 5) Overwrite system with the new prompt
   // 5) Overwrite system with the new prompt
const newPrompt = PROMPT_LIST[currentIndex]?.prompt_text || "No further prompts.";
console.log("[DEBUG] Next Prompt is now:", newPrompt);

conversationHistory = [
  { role: "system", content: newPrompt },
  ...conversationHistory.filter((entry) => entry.role !== "system"),
];

// [RAG START] -----------------------------------------------------------
// 1) Combine previous assistant response (if available) with the user's message
const previousAssistant = conversationHistory
  .filter(msg => msg.role === "assistant")
  .slice(-1)[0]?.content || "";
const combinedQuery = `${previousAssistant} ${userMessage}`.trim();

console.log("[RAG] Retrieving best chunk for combined query:", combinedQuery);

let bestChunkText = "";
try {
  const bestChunk = await retrieveBestChunk(combinedQuery);
  if (bestChunk) {
    bestChunkText = bestChunk.text;
    console.log("[RAG] Best chunk found:", bestChunk.id);
  } else {
    console.log("[RAG] No best chunk found (embeddingsData might be empty).");
  }
} catch (err) {
  console.error("[RAG] Error retrieving chunk:", err);
}

// 2) Append chunk text to the system prompt as "Context"
conversationHistory[0].content =
  conversationHistory[0].content + "\n\nContext:\n" + bestChunkText;
// [RAG END] ------------------------------------------------------------


// 6) Build LLM payload
const mainPayload = {
  model: "llama-3.3-70b-versatile",
  temperature: 0,
  messages: conversationHistory,
};
console.log("[DEBUG] Main Payload to LLM:\n", JSON.stringify(mainPayload, null, 2));

// (Then your existing code that fetches from Groq, processes response, etc.)

    const mainResp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify(mainPayload),
    });
    if (!mainResp.ok) {
      const errorText = await mainResp.text();
      console.error("[ERROR] LLM call failed:\n", errorText);
      return new Response("I'm sorry, I couldn't process that. Please try again.", { status: 200 });
    }

    const mainData = await mainResp.json();
    const assistantContent1 = mainData.choices?.[0]?.message?.content;
    if (!assistantContent1) {
      return new Response("No content returned from the LLM. Please try again.", { status: 200 });
    }

    /*********************************************
     * ADDED DEBUG: Log the raw assistant response
     *********************************************/
    console.log("[DEBUG] assistantContent1 from LLM:", assistantContent1);

    // 7) Add new assistant content to conversation history
    conversationHistory.push({ role: "assistant", content: assistantContent1 });
    console.log("[DEBUG] First API Response Added to Conversation History.");

    // ***** START ADDED CODE *****
    // Use the rule: if the prompt we just completed (currentIndex - 2) is marked as important_memory, insert important memory.
    if (currentIndex - 0 >= 0 && PROMPT_LIST[currentIndex - 0]?.important_memory) {
      insertImportantMemory(assistantContent1);
    }
    // ***** END ADDED CODE *****

    // 8) Manage buffer again
    conversationHistory = manageBuffer(conversationHistory);

    // 9) Possibly chain
    let finalChained: string | null = null;
    if (PROMPT_LIST[currentIndex]?.chaining) {
      finalChained = await chainIfNeeded(assistantContent1);
    }

    // 10) Auto-Transition Hidden
    if (PROMPT_LIST[currentIndex]?.autoTransitionHidden) {
      console.log("[DEBUG - AUTO-HIDDEN] autoTransitionHidden = true. Entering loop...");

      // Create an array to collect auto-transition hidden responses.
      let autoResponses: string[] = [];

      // Loop through all consecutive hidden prompts.
      while (
        currentIndex < PROMPT_LIST.length &&
        PROMPT_LIST[currentIndex]?.autoTransitionHidden
      ) {
        console.log("[DEBUG - AUTO-HIDDEN] Next prompt also autoTransitionHidden, continuing...");
        const { conversationHistory: updatedConv, response: autoResponse, updatedIndex } =
          await handleAutoTransitionHidden(conversationHistory, currentIndex);

        conversationHistory = updatedConv;
        currentIndex = updatedIndex;

        // Append the fetched auto-response (which is still in the payload) to our array.
        autoResponses.push(autoResponse);
      }

      // Determine the final visible text:
      // Use the last auto-response as the text to show to the user.
      const finalVisible = autoResponses[autoResponses.length - 1] || (finalChained || assistantContent1);

      // Log the hidden responses (all but the last one) so you know they were fetched.
      for (let i = 0; i < autoResponses.length - 1; i++) {
        console.log("[DEBUG] Hidden text NOT returned to user:", autoResponses[i]);
      }

      // Log the final text that will be returned to the user.
      console.log("[DEBUG] Final text returned to user:", finalVisible);
      return new Response(finalVisible, { status: 200 });
    }

    // 11) Auto-Transition Visible
    if (PROMPT_LIST[currentIndex]?.autoTransitionVisible) {
      console.log("[DEBUG - AUTO-VISIBLE] autoTransitionVisible = true. Entering loop...");

      let combinedVisible = finalChained || assistantContent1;

      while (
        currentIndex < PROMPT_LIST.length &&
        PROMPT_LIST[currentIndex]?.autoTransitionVisible
      ) {
        console.log("[DEBUG - AUTO-VISIBLE] Next prompt also autoTransitionVisible, continuing...");
        const { conversationHistory: updatedConv, response: autoResponse, updatedIndex } =
          await handleAutoTransitionVisible(conversationHistory, currentIndex);

        conversationHistory = updatedConv;
        currentIndex = updatedIndex;

        if (!autoResponse) {
          console.log("[DEBUG] Final text returned to user:", combinedVisible);
          return new Response(combinedVisible, { status: 200 });
        }
        combinedVisible += "\n\n" + autoResponse;
      }

      console.log("[DEBUG] Final text returned to user:", combinedVisible);
      return new Response(combinedVisible, { status: 200 });
    }

    // 12) If no auto-transition, just return final
    console.log("[DEBUG] Final text returned to user:", finalChained || assistantContent1);
    return new Response(finalChained || assistantContent1, { status: 200 });

  } catch (error: any) {
    console.error("[ERROR] in POST handler:\n", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}


/******************************************
 * handleStreamingFlow (No Changes)
 ******************************************/
async function handleStreamingFlow(incomingMessage: string): Promise<Response> {
  console.log("[INFO] [STREAM MODE] Received request for streaming.");

  if (!incomingMessage?.trim()) {
    console.log("[WARN] No User Input Received. Returning Error.");
    return new Response("No input received. Please try again.", { status: 400 });
  }

  // We'll do a *very simple* streaming approach:
  // 1) Insert user message into conversation
  // 2) Build a payload with `stream: true`
  // 3) Return SSE with partial tokens

  // If you want to incorporate EXACT chaining/validation logic in streaming mode,
  // you can replicate the steps from handleNonStreamingFlow. For brevity, we just do a single streamed response.

  conversationHistory.push({ role: "user", content: incomingMessage });
  conversationHistory = manageBuffer(conversationHistory);

  // Use the last system prompt or a fallback
  const currentPrompt = PROMPT_LIST[currentIndex]?.prompt_text || "No further prompts.";
  conversationHistory.unshift({ role: "system", content: currentPrompt });

  // Build streaming payload
  const payload = {
    model: "llama-3.3-70b-versatile",
    temperature: 0,
    stream: true, // <--- important
    messages: conversationHistory,
  };

  // Make streaming call
  const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok || !resp.body) {
    const errorText = await resp.text();
    console.error("[ERROR] streaming request failed:\n", errorText);
    return new Response("Error calling streaming LLM API.", { status: 500 });
  }

  // We'll convert the OpenAI-style SSE from GROQ into a similar SSE for the client
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const transformStream = new TransformStream();
  const writable = transformStream.writable.getWriter();

  (async () => {
    try {
      for await (const chunk of streamAsyncIterable(resp.body)) {
        const data = decoder.decode(chunk);

        // The OpenAI SSE data lines often look like: 
        // data: {...}\n
        // data: {...}\n
        // data: [DONE]\n
        //
        // We'll just pass them along as-is to the client in an SSE format.
        const lines = data.split("\n");
        for (const line of lines) {
          if (!line.trim()) continue;
          if (line.startsWith("data: [DONE]")) {
            // End of stream
            await writable.write(encoder.encode(`data: [DONE]\n\n`));
            await writable.close();
            return;
          }
          // Otherwise, pass the chunk along
          await writable.write(encoder.encode(`${line}\n`));
        }
      }
    } catch (e) {
      console.error("[ERROR] in SSE streaming:", e);
      await writable.close();
    }
  })();

  // Return the readable end of the TransformStream as our SSE
  return new Response(transformStream.readable, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}


/**
 * Helper to turn a ReadableStream into an async iterable
 */
async function* streamAsyncIterable(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        yield value;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------------
// 1) Helper Function: Insert Important Memory (Place Before POST)
// ---------------------------------------------------------------------------------
function insertImportantMemory(content: string) {
  const systemIndex = conversationHistory.findIndex((msg) => msg.role === "system");
  let insertIndex = systemIndex + 1;

  // Ensure important memory lines are stored in order
  while (
    insertIndex < conversationHistory.length &&
    conversationHistory[insertIndex].role === "assistant" &&
    conversationHistory[insertIndex].content.trim().startsWith("Important_memory:")
  ) {
    insertIndex++;
  }

  // Insert the important memory entry
  conversationHistory.splice(insertIndex, 0, {
    role: "assistant",
    content: `Important_memory: ${content}`
  });

  console.log("[DEBUG] Important_memory inserted at index:", insertIndex);
}



/**
 * ---------------------------------------------------------------------------------
 * DO NOT TOUCH: BUFFER MANAGEMENT SECTION
 * ---------------------------------------------------------------------------------
 */
function manageBuffer(conversationHistory: { role: string; content: string }[]) {
  console.log(`[DEBUG] Current Conversation History Length: ${conversationHistory.length}`);

  const systemMessage = conversationHistory.find((entry) => entry.role === "system");

  const importantMemoryLines = conversationHistory.filter(
    (entry) =>
      entry.role === "assistant" &&
      entry.content.trim().startsWith("Important_memory:")
  );

  const otherMessages = conversationHistory.filter(
    (entry) => entry !== systemMessage && !importantMemoryLines.includes(entry)
  );

  if (otherMessages.length > BUFFER_SIZE) {
    const excessCount = otherMessages.length - BUFFER_SIZE;
    console.log(`[DEBUG] Trimming ${excessCount} oldest non-system, non-important messages.`);

    const trimmed = otherMessages.slice(excessCount);

    const finalHistory = [systemMessage, ...importantMemoryLines, ...trimmed].filter(Boolean);

    console.log(
      "[DEBUG] Trimmed Conversation History (with Important Memory Kept):",
      JSON.stringify(finalHistory, null, 2)
    );
    return finalHistory;
  }
  return conversationHistory;
}
