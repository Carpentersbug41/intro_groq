import { NextRequest, NextResponse } from "next/server";
export const runtime = "edge";
import PROMPT_LIST from "./prompts"; // Correct path



// Reuse your existing conversationHistory, currentIndex, etc.
let conversationHistory: { role: string; content: string }[] = [];
let currentIndex = 0;

const BUFFER_SIZE = 6; // Maximum number of messages to retain (3 exchanges: 3 user + 3 assistant)

/**
 * Trims conversation history to retain the most recent BUFFER_SIZE messages.
 */
function manageBuffer(conversationHistory) {
  console.log(`[DEBUG] Current Conversation History Length: ${conversationHistory.length}`);

  const systemMessage = conversationHistory.find((entry) => entry.role === "system");
  // Lines that start with "Important_memory:" must be preserved
  const importantMemoryLines = conversationHistory.filter(
    (entry) =>
      entry.role === "assistant" &&
      entry.content.trim().startsWith("Important_memory:")
  );

  // All other lines
  const otherMessages = conversationHistory.filter(
    (entry) =>
      entry !== systemMessage && !importantMemoryLines.includes(entry)
  );

  if (otherMessages.length > BUFFER_SIZE) {
    const excessCount = otherMessages.length - BUFFER_SIZE;
    console.log(`[DEBUG] Trimming ${excessCount} oldest non-system, non-important messages.`);

    // Trim only the 'other' messages
    const trimmed = otherMessages.slice(excessCount);
    // Reconstruct final array: system message + importantMemory + trimmed
    const finalHistory = [systemMessage, ...importantMemoryLines, ...trimmed].filter(Boolean);

    console.log("[DEBUG] Trimmed Conversation History (with Important Memory Kept):",
      JSON.stringify(finalHistory, null, 2)
    );
    return finalHistory;
  }

  // If not exceeding buffer, just return as is
  return conversationHistory;
}

/**
 * Basic fetch to the API.
 */
async function fetchApiResponse(payload: any): Promise<string | null> {
  console.log("\n[DEBUG] Sending Payload to API:\n", JSON.stringify(payload, null, 2));

  const startTime = Date.now();
  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });

    const latency = Date.now() - startTime;
    console.log(`[DEBUG] API Call Latency: ${latency}ms`);

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[ERROR] API call failed:\n", errorText);
      throw new Error(`API error: ${response.statusText}`);
    }

    const responseData = await response.json();
    const assistantContent = responseData.choices?.[0]?.message?.content;

    if (!assistantContent) {
      console.warn("[WARN] API returned no content. Raw response:\n", JSON.stringify(responseData, null, 2));
      return null;
    }

    console.log("[DEBUG] API Response Content:\n", assistantContent);
    return assistantContent;
  } catch (error: any) {
    console.error("[ERROR] Failed to fetch API response:\n", error.message);
    return null;
  }
}

/**
 * A second fetch call with basic retry logic, to demonstrate
 * how you might re-try if there's a transient error.
 */
async function fetchApiResponseWithRetry(payload: any, retries = 2, delayMs = 500): Promise<string | null> {
  let attempt = 0;
  while (attempt < retries) {
    attempt++;
    console.log(`[DEBUG] Retry Attempt: ${attempt}/${retries}`);
    const response = await fetchApiResponse(payload);
    if (response) return response;

    console.warn(`[WARN] Attempt ${attempt} failed. Retrying in ${delayMs}ms...`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
}

/**
 * Minimal validation call: returns true if "VALID", else false.
 */
async function validateInput(userInput: string, currentPrompt: string): Promise<boolean> {
  const validationInstruction = `
    You are a validation assistant.
    Your task is to assess if the user's input is loosely related to the prompt requirements.  Don't be too strict with this.  As long as the user answered it loosely it is valid.  If the answer is completely unrelated it isn't valid.
    Current prompt: '${currentPrompt}'
    User input: '${userInput}'
    
    Respond with only one word: "VALID" if the input matches the prompt's requirement,
    or "INVALID" if it does not.
    Do not provide any additional explanation or description.
  `;

  const payload = {
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "system", content: validationInstruction }],
    max_tokens: 512,
    temperature: 0,
    top_p: 1,
    n: 1,
    stream: false,
  };

  console.log("[DEBUG] Validation Payload:\n", JSON.stringify(payload, null, 2));
  const response = await fetchApiResponse(payload);
  console.log(`[DEBUG] Validation Result: ${response}`);
  return response === "VALID";
}

/**
 * Generates a dynamic retry message if the user’s input is invalid.
 */
async function generateRetryMessage(userInput: string, currentPrompt: string): Promise<string> {
  const payload = {
    model: "llama-3.3-70b-versatile",
    messages: [
      { role: "system", content: currentPrompt },
      ...conversationHistory.filter((entry) => entry.role !== "system"),
    ],
    max_tokens: 512,
    temperature: 0,
    top_p: 1,
    n: 1,
    stream: false,
  };

  console.log("[DEBUG] Retry Message Payload:\n", JSON.stringify(payload, null, 2));
  return (await fetchApiResponse(payload)) || "I'm sorry, I couldn't process that. Can you try again?";
}

/**
 * CHAINING LOGIC START:
 * After we get the assistant's response for the current prompt,
 * if `chaining` is true, we feed that assistant's response as user input to the next prompt automatically.
 */
async function chainIfNeeded(assistantContent: string): Promise<string | null> {
  let chainResponse = assistantContent;

  // We'll keep chaining as long as the next prompt has chaining = true.
  while (true) {
    // 1) Check if we've run out of prompts
    if (currentIndex >= PROMPT_LIST.length) {
      console.log("[CHAIN DEBUG] No more prompts to chain.");
      return chainResponse;
    }

    // 2) If the next prompt is NOT chaining, stop
    if (!PROMPT_LIST[currentIndex]?.chaining) {
      console.log("[CHAIN DEBUG] Next prompt is not chaining. Stopping chain.");
      return chainResponse;
    }

    console.log("[CHAIN DEBUG] Next prompt has chaining = true. We'll feed the last assistant output as user input.");

    // 3) Use the last assistant content as user input
    conversationHistory.push({ role: "user", content: chainResponse });
    console.log("[CHAIN DEBUG] Adding assistant's content as user input for next prompt.\n", chainResponse);

    // 4) Prepare the next system prompt
    const systemPrompt = PROMPT_LIST[currentIndex]?.prompt_text || "No further prompts.";
    console.log("[CHAIN DEBUG] Next System Prompt:\n", systemPrompt);

    conversationHistory = [
      { role: "system", content: systemPrompt },
      ...conversationHistory.filter((entry) => entry.role !== "system"),
    ];

    // 5) Build the payload for the next chaining request
    const chainPayload = {
      model: "llama3-8b-8192",
      messages: conversationHistory,
    };

    console.log("[CHAIN DEBUG] Next Chaining Payload:\n", JSON.stringify(chainPayload, null, 2));

    // 6) Increment currentIndex so we move on
    currentIndex++;

    // 7) Call the Groq API again
    const chainResp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify(chainPayload),
    });

    if (!chainResp.ok) {
      const errorText = await chainResp.text();
      console.error("[CHAIN DEBUG] Chaining API call failed:\n", errorText);
      // We stop chaining, returning last known content
      return chainResponse;
    }

    const chainData = await chainResp.json();
    const newAssistantContent = chainData.choices?.[0]?.message?.content;

    if (!newAssistantContent) {
      console.warn("[CHAIN DEBUG] No new content from chaining. Stopping chain.");
      return chainResponse;
    }

    // 8) Store the chain response
    conversationHistory.push({ role: "assistant", content: newAssistantContent });
    console.log("[CHAIN DEBUG] Chaining Assistant Response:\n", newAssistantContent);

    // update for the next loop iteration
    chainResponse = newAssistantContent;
  }
}
/**
 * CHAINING LOGIC END
 */

/**
 * Main request handler.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const userMessage = body.message?.trim();

    console.log("\n[INFO] Received User Input:", userMessage || "[No Input Provided]");

    if (!userMessage) {
      console.log("[WARN] No User Input Received. Returning Error.");
      return new Response("No input received. Please try again.", { status: 400 });
    }

    const currentPrompt = PROMPT_LIST[currentIndex]?.prompt_text;
    const isAutoTransition = PROMPT_LIST[currentIndex]?.autoTransition || false;

    console.log("\n[DEBUG] Current Prompt:\n", currentPrompt);
    console.log("[DEBUG] AutoTransition Status:", isAutoTransition);

    if (!currentPrompt) {
      const finalMessage = "Thank you for your responses! Goodbye.";
      conversationHistory.push({ role: "assistant", content: finalMessage });
      console.log("[INFO] Conversation Complete. Final Message Sent.");
      return new Response(finalMessage, { status: 200 });
    }

    // Existing logic: add system message
    conversationHistory = [
      { role: "system", content: currentPrompt },
      ...conversationHistory.filter((entry) => entry.role !== "system"),
    ];
    console.log("[DEBUG] Updated Conversation History (System Prompt First):\n", JSON.stringify(conversationHistory, null, 2));

    // Add user input
    conversationHistory.push({ role: "user", content: userMessage });
    console.log("[DEBUG] Adding User Input to Conversation History.");

    // Manage buffer
    conversationHistory = manageBuffer(conversationHistory);

    console.log("[INFO] Validating User Input with prompt:", currentPrompt);
    const isValid = await validateInput(userMessage, currentPrompt);

    if (!isValid) {
      // If invalid, generate a retry message
      console.log("[INFO] Validation Failed. Retrying the Same Prompt.");
      const retryMessage = await generateRetryMessage(userMessage, currentPrompt);
      conversationHistory.push({ role: "assistant", content: retryMessage });
      console.log("[DEBUG] Retry Message Added to Conversation History.");
      conversationHistory = manageBuffer(conversationHistory); // Trim buffer after retry
      return new Response(retryMessage, { status: 200 });
    }

    console.log("[INFO] User Input Validated Successfully.");
    currentIndex++;
    console.log("[DEBUG] Updated Current Index:", currentIndex);

    // Next prompt
    const nextPrompt = PROMPT_LIST[currentIndex]?.prompt_text || "No further prompts.";
    console.log("[DEBUG] Next Prompt to Be Processed:", nextPrompt);

    // Insert new system message
    conversationHistory = [
      { role: "system", content: nextPrompt },
      ...conversationHistory.filter((entry) => entry.role !== "system"),
    ];
    console.log("[DEBUG] Updated Conversation History for Next Prompt (System Prompt First):\n", JSON.stringify(conversationHistory, null, 2));

    // Manage buffer again
    conversationHistory = manageBuffer(conversationHistory);

    // Prepare payload for main call
    const payload1 = {
      model: "llama-3.3-70b-versatile",
      messages: conversationHistory,
      max_tokens: 512,
      temperature: 0,
      top_p: 1,
      n: 1,
      stream: false,
    };

    console.log("[DEBUG] Token Count for First Call Payload:", payload1.messages.length);
    const assistantContent1 = await fetchApiResponse(payload1);

    if (!assistantContent1) {
      console.warn("[WARN] First API call returned no content. Skipping second call.");
      return new Response("I'm sorry, I couldn't process your response. Please try again.", { status: 200 });
    }

    conversationHistory.push({ role: "assistant", content: assistantContent1 });
    console.log("[DEBUG] First API Response Added to Conversation History.");

    // If the previous prompt had 'important_memory' we store the memory
    if (PROMPT_LIST[currentIndex - 1]?.important_memory) {
      conversationHistory.push({
        role: "assistant",
        content: `Important_memory: ${assistantContent1}`,
      });
      console.log("[DEBUG] Important Memory Added to Conversation History in chronological order.");
    }

    // Manage buffer again after response
    conversationHistory = manageBuffer(conversationHistory);

    // *** Auto Transition existing logic ***
    if (isAutoTransition) {
      // same logic from your original code
      const autoResponses: string[] = [];
      autoResponses.push(assistantContent1);

      while (true) {
        conversationHistory.push({ role: "user", content: "OK" });
        console.log("[DEBUG] Bogus User Input 'OK' Added to Conversation History.");

        currentIndex++;
        if (currentIndex >= PROMPT_LIST.length) {
          console.log("[DEBUG] No further prompts after auto-transition. Breaking loop.");
          break;
        }

        const newPromptObj = PROMPT_LIST[currentIndex];
        const newPromptText = newPromptObj?.prompt_text || "No further prompts.";
        const newIsAutoTransition = newPromptObj?.autoTransition || false;

        console.log("[DEBUG] Next Prompt for Another Auto-Transition:", newPromptText);

        conversationHistory = [
          { role: "system", content: newPromptText },
          ...conversationHistory.filter((entry) => entry.role !== "system"),
        ];
        console.log("[DEBUG] Updated Conversation History for Next Auto-Transition:\n", JSON.stringify(conversationHistory, null, 2));

        conversationHistory = manageBuffer(conversationHistory);

        const payload2 = {
          model: "llama-3.3-70b-versatile",
          messages: conversationHistory,
          max_tokens: 512,
          temperature: 0,
          top_p: 1,
          n: 1,
          stream: false,
        };

        console.log("[DEBUG] Token Count for Payload2:", payload2.messages.length);
        const assistantContent2 = await fetchApiResponseWithRetry(payload2, 2, 500);

        if (!assistantContent2) {
          console.warn("[WARN] Second API call failed. Returning everything we have so far.");
          const partialCombined = autoResponses.join("\n\n");
          return new Response(partialCombined, { status: 200, headers: { "Content-Type": "text/plain" } });
        }

        conversationHistory.push({ role: "assistant", content: assistantContent2 });
        console.log("[DEBUG] Another AutoTransition Response Added to Conversation History.");

        if (PROMPT_LIST[currentIndex - 1]?.important_memory) {
          conversationHistory.push({
            role: "assistant",
            content: `Important_memory: ${assistantContent2}`,
          });
          console.log("[DEBUG] Important Memory Added in correct (chronological) order.");
        }

        console.log("[DEBUG] Another Response in AutoTransition chain:\n", assistantContent2);
        autoResponses.push(assistantContent2);

        conversationHistory = manageBuffer(conversationHistory);

        if (currentIndex + 1 >= PROMPT_LIST.length) {
          console.log("[DEBUG] No further prompts in PROMPT_LIST. Breaking loop.");
          break;
        }
        if (!PROMPT_LIST[currentIndex + 1].autoTransition) {
          console.log("[DEBUG] Next prompt is NOT autoTransition. Breaking loop.");
          break;
        }

        console.log("[DEBUG] Next prompt IS autoTransition. Looping again...");
      }

      const finalCombined = autoResponses.join("\n\n");
      console.log("[DEBUG] Final Combined Auto-Transition Responses:\n", finalCombined);
      return new Response(finalCombined, { status: 200, headers: { "Content-Type": "text/plain" } });
    }

    // *** CHAINING LOGIC from the new code***
    // This is the actual numeric chaining we appended
    const finalChainedOutput = await chainIfNeeded(assistantContent1);

    // Return the final chain response (if any) or the assistant’s first response
    const outputToReturn = finalChainedOutput || assistantContent1;
    return new Response(outputToReturn, { status: 200 });
  } catch (error: any) {
    console.error("[ERROR] in POST handler:\n", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
