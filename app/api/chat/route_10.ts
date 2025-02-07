import { NextRequest, NextResponse } from "next/server";
export const runtime = "edge";
import PROMPT_LIST from "./prompts"; // Correct path

// ----------------------------------
// Keep your existing conversationHistory, currentIndex, etc.
// ----------------------------------
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
 * A second fetch call with basic retry logic.
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
    Your task is to assess if the user's input is loosely related to the prompt requirements.  Don't be too strict with this.  
    As long as the user answered it loosely it is valid.  If the answer is completely unrelated it isn't valid.
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
 * (A) NEW HELPER:
 * Build a minimal array of messages for the next chaining step.
 * This ensures the payload looks exactly like user asked for.
 */
function buildMinimalChainMessages(
  systemPrompt: string,
  chainEntries: { role: string; content: string }[]
) {
  // We skip 'system' lines except for the new systemPrompt.
  // We keep the user + assistant lines in the order we want.
  const minimal: { role: string; content: string }[] = [];
  // push system
  minimal.push({ role: "system", content: systemPrompt });

  for (const entry of chainEntries) {
    if (entry.role === "assistant" || entry.role === "user") {
      minimal.push({
        role: entry.role,
        content: entry.content,
      });
    }
  }
  return minimal;
}

/**
 * (B) CLEANUP function: remove "fake user" lines that match the old assistant output
 */
function cleanupChainedEntries(previousAssistantOutput: string) {
  console.log("[CLEANUP DEBUG] Removing user lines that match the assistant's last output...");
  const originalLength = conversationHistory.length;

  conversationHistory = conversationHistory.filter((entry) => {
    if (entry.role === "user" && entry.content === previousAssistantOutput) {
      console.log("[CLEANUP DEBUG] Removing duplicated user entry:", entry.content);
      return false;
    }
    return true;
  });

  console.log("[CLEANUP DEBUG] Original length:", originalLength, "New length:", conversationHistory.length);
}

/**
 * (C) CHAINING LOGIC:
 * We feed that assistant's response as user input to the next prompt automatically,
 * but we build a minimal payload to produce your requested structure.
 */
/**
 * (C) CHAINING LOGIC:
 * We feed the assistant's response as user input to the next prompt automatically,
 * but in the final payload we convert that old assistant content back to assistant role.
 */
async function chainIfNeeded(assistantContent: string): Promise<string | null> {
  let chainResponse = assistantContent;

  while (true) {
    // If there are no more prompts or next prompt isn't chaining, stop.
    if (currentIndex >= PROMPT_LIST.length) {
      console.log("[CHAIN DEBUG] No more prompts to chain.");
      return chainResponse;
    }
    if (!PROMPT_LIST[currentIndex]?.chaining) {
      console.log("[CHAIN DEBUG] Next prompt is not chaining. Stopping chain.");
      return chainResponse;
    }

    console.log("[CHAIN DEBUG] Preparing to chain. Assistant output will become user input.");

    // The next system prompt
    const systemPrompt = PROMPT_LIST[currentIndex]?.prompt_text || "No further prompts.";

    // 1) Temporarily store the assistant's last answer as a user message
    conversationHistory.push({ role: "user", content: chainResponse });
    console.log("[CHAIN DEBUG] Fake user input added for chaining:\n", chainResponse);

    // 2) Filter out any direct duplicates (assistant => user with the same content)
    //    so we don't carry them forward.
    conversationHistory = conversationHistory.filter((entry, index, self) => {
      return !(
        entry.role === "assistant" &&
        self[index + 1]?.role === "user" &&
        self[index + 1]?.content === entry.content
      );
    });
    console.log("[CHAIN DEBUG] conversationHistory AFTER filtering duplicates:\n", JSON.stringify(conversationHistory, null, 2));

    // 3) Build the payload to the LLM:
    //    - Insert this systemPrompt at the top.
    //    - Convert user entries that match any old assistant output
    //      back into assistant roles in the final payload.
    const tempHistory = [
      { role: "system", content: systemPrompt },
      ...conversationHistory.map((entry) => {
        const wasAssistantBefore = conversationHistory.some(
          (msg) => msg.role === "assistant" && msg.content === entry.content
        );
        // If it's "user" but was originally assistant content, re-label it:
        if (entry.role === "user" && wasAssistantBefore) {
          return { role: "assistant", content: entry.content };
        }
        return entry; // otherwise keep the same
      }),
    ];

    console.log("[CHAIN DEBUG] tempHistory used for chainPayload:\n", JSON.stringify(tempHistory, null, 2));

    const chainPayload = {
      model: "llama3-8b-8192",
      messages: tempHistory,
    };

    console.log("[CHAIN DEBUG] Sending chaining payload to LLM:\n", JSON.stringify(chainPayload, null, 2));

    // 4) Advance currentIndex to the next system prompt
    currentIndex++;

    // 5) Make the chain request to the LLM
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
      console.error("[CHAIN DEBUG] Chaining call failed:\n", errorText);
      // Return the existing chainResponse rather than losing everything
      return chainResponse;
    }

    const chainData = await chainResp.json();
    const newAssistantContent = chainData.choices?.[0]?.message?.content;
    if (!newAssistantContent) {
      console.warn("[CHAIN DEBUG] No new content returned from chain. Stopping chain.");
      return chainResponse;
    }

    console.log("[CHAIN DEBUG] newAssistantContent:", newAssistantContent);

    // 6) Append the new LLM output as an assistant message
    conversationHistory.push({ role: "assistant", content: newAssistantContent });

    // 7) chainResponse updated for next iteration
    chainResponse = newAssistantContent;
  }
}


/**
 * Main request handler. (No lines removed from your original code!)
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

    // Prepare payload
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

    // If the previous prompt had 'important_memory' we store that
    if (PROMPT_LIST[currentIndex - 1]?.important_memory) {
      conversationHistory.push({
        role: "assistant",
        content: `Important_memory: ${assistantContent1}`,
      });
      console.log("[DEBUG] Important Memory Added to Conversation History in chronological order.");
    }

    // Manage buffer again
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
          return new Response(partialCombined, {
            status: 200,
            headers: { "Content-Type": "text/plain" },
          });
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
      return new Response(finalCombined, {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }

    // *** CHAINING LOGIC from the new code***
    const finalChainedOutput = await chainIfNeeded(assistantContent1);

    // Return final chain response or first response
    const outputToReturn = finalChainedOutput || assistantContent1;
    return new Response(outputToReturn, { status: 200 });
  } catch (error: any) {
    console.error("[ERROR] in POST handler:\n", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
