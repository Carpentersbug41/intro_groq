import PROMPT_LIST from "./prompts"; // Correct path
import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";

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

    conversationHistory = [
      { role: "system", content: currentPrompt },
      ...conversationHistory.filter((entry) => entry.role !== "system"),
    ];
    console.log("[DEBUG] Updated Conversation History (System Prompt First):\n", JSON.stringify(conversationHistory, null, 2));

    conversationHistory.push({ role: "user", content: userMessage });
    console.log("[DEBUG] Adding User Input to Conversation History.");

    // Apply buffer management here
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

    // NEW DEBUG LOG: After we increment currentIndex, let's see what prompt is next
    console.log(
      "[DEBUG - NEW] Next Prompt after increment:",
      PROMPT_LIST[currentIndex]?.prompt_text,
      "| autoTransition?:",
      PROMPT_LIST[currentIndex]?.autoTransition
    );

    const nextPrompt = PROMPT_LIST[currentIndex]?.prompt_text || "No further prompts.";
    console.log("[DEBUG] Next Prompt to Be Processed:", nextPrompt);

    conversationHistory = [
      { role: "system", content: nextPrompt },
      ...conversationHistory.filter((entry) => entry.role !== "system"),
    ];
    console.log("[DEBUG] Updated Conversation History for Next Prompt (System Prompt First):\n", JSON.stringify(conversationHistory, null, 2));

    // Apply buffer management here before the payload is prepared
    conversationHistory = manageBuffer(conversationHistory);

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

    // If the previous prompt is marked as important_memory, add an Important Memory line
    if (PROMPT_LIST[currentIndex - 1]?.important_memory) {
      conversationHistory.push({
        role: "assistant",
        content: `Important_memory: ${assistantContent1}`,
      });
      console.log("[DEBUG] Important Memory Added to Conversation History in chronological order.");
    }

    // Apply buffer management here after adding assistant response
    conversationHistory = manageBuffer(conversationHistory);

    /***********************************************************************************
     * Only the auto-transition block is changed. Everything else in your code remains the same.
     ***********************************************************************************/
    if (isAutoTransition) {
      // NEW DEBUG LOG: We confirm we are entering auto-transition logic
      console.log("[DEBUG - NEW] Entering autoTransition block because isAutoTransition = true for index:", currentIndex);

      // We keep track of *all* consecutive responses in here.
      const autoResponses: string[] = [];
      autoResponses.push(assistantContent1);

      // We'll keep chaining as long as the next prompt is also autoTransition: true.
      while (true) {
        // 1) "Simulate" user input
        conversationHistory.push({ role: "user", content: "OK" });
        console.log("[DEBUG] Bogus User Input 'OK' Added to Conversation History.");

        // 2) Advance the currentIndex by 1
        currentIndex++;

        // NEW DEBUG LOG:
        console.log("[DEBUG - NEW] currentIndex after increment in autoTransition loop:", currentIndex);

        // ------------------------------------------------------------------------
        // FIX: If the new prompt is NOT autoTransition, break immediately BEFORE calling the model
        if (currentIndex >= PROMPT_LIST.length) {
          console.log("[DEBUG] No further prompts after auto-transition. Breaking loop.");
          break;
        }
        const newPromptObj = PROMPT_LIST[currentIndex];
        const newPromptText = newPromptObj?.prompt_text || "No further prompts.";
        const newIsAutoTransition = newPromptObj?.autoTransition || false;

        if (!newIsAutoTransition) {
          console.log("[DEBUG - FIX] Next prompt is NOT autoTransition. Breaking BEFORE calling the model...");
          break;
        }
        // ------------------------------------------------------------------------

        // We continue only if newIsAutoTransition is true
        console.log(
          "[DEBUG - NEW] Checking next prompt (index:",
          currentIndex,
          ") => prompt_text:",
          newPromptText,
          "| autoTransition:",
          newIsAutoTransition
        );
        console.log("[DEBUG] Next Prompt for Another Auto-Transition:", newPromptText);

        // 4) Insert the system message for the *new* prompt
        conversationHistory = [
          { role: "system", content: newPromptText },
          ...conversationHistory.filter((entry) => entry.role !== "system"),
        ];
        console.log("[DEBUG] Updated Conversation History for Next Auto-Transition:\n", JSON.stringify(conversationHistory, null, 2));

        // 5) Manage buffer, then call the model
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

        // 6) Push the new assistant response
        conversationHistory.push({ role: "assistant", content: assistantContent2 });
        console.log("[DEBUG] Another AutoTransition Response Added to Conversation History.");

        // 7) If the new prompt is important_memory, append the new memory at the bottom
        if (PROMPT_LIST[currentIndex - 1]?.important_memory) {
          conversationHistory.push({
            role: "assistant",
            content: `Important_memory: ${assistantContent2}`,
          });
          console.log("[DEBUG] Important Memory Added in correct (chronological) order.");
        }

        console.log("[DEBUG] Another Response in AutoTransition chain:\n", assistantContent2);
        autoResponses.push(assistantContent2);

        // 8) Manage buffer again
        conversationHistory = manageBuffer(conversationHistory);

        // 9) Check next prompt
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

      // Return all auto-transitions combined
      const finalCombined = autoResponses.join("\n\n");
      console.log("[DEBUG] Final Combined Auto-Transition Responses:\n", finalCombined);
      return new Response(finalCombined, {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }

    // If no auto-transition triggered:
    return new Response(assistantContent1, { status: 200 });
  } catch (error: any) {
    console.error("[ERROR] in POST handler:\n", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
