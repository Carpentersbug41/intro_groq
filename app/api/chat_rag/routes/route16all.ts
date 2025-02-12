import { NextRequest, NextResponse } from "next/server";

// ********************************************************************************
// *****      IMPORTANT: DO NOT REMOVE OR MODIFY THE CHAINING, VALIDATION, OR BUFFER CODE    *****
// ***** These sections are critical for the prompt-chaining flow and validation.  *****
// ********************************************************************************

export const runtime = "edge";

// ----------------------------
// You can tweak the number of messages to retain
// ----------------------------
const BUFFER_SIZE = 2; // e.g., 3 user + 3 assistant exchanges max

// ---------------------------------------------------------------------------------
// ***** DO NOT TOUCH: Variables for Conversation History and Prompt Index *****
// ---------------------------------------------------------------------------------
let conversationHistory: { role: string; content: string }[] = [];
let currentIndex = 0;

// ---------------------------------------------------------------------------------
// Prompt List for Demonstration
// (Optionally set `validation: true` or `important_memory: true` if desired.)
// ---------------------------------------------------------------------------------
const PROMPT_LIST = [
  {
    prompt_text: "#System message:\n Ask the user their favourite colour.",
    validation: true,
    important_memory: true,
  },
  {
    prompt_text: "#System message:\n Ask the user their favourite animal.",
    validation: true,
    autoTransition: true
    
  },
  {
    prompt_text: "#System message:\n Ask the user their favourite book.",
    chaining: false,
    important_memory: true,
    // You can optionally add: autoTransition: true
  },
  {
    prompt_text: "#System message:\n Ask the user to input a number",
    // chaining: true,
    // validation: true,
    // autoTransition: true,
  },
  {
    prompt_text: "#System message:\n  add 2 to the number you have.",
    chaining: true,
    // validation: true,
  },
  {
    prompt_text: "#System message:\n Take the result of the last operation and multiply it by 3",
    chaining: true,
    // validation: true,
  },
  {
    prompt_text: "#System message:\n Convert the last result into cats. For example 'There are 5 cats.'",
    chaining: true,
    // validation: true,
  },
  {
    prompt_text: "#System message:\n Add a colour to the cats. Give them all the same colour. For example 'There are 5 red cats.'",
    chaining: true,
    // validation: true,
  },
  {
    prompt_text: "#System message:\n Ask the user their favourite animal.",
    chaining: false,
    // validation: true,
    // autoTransition: true,
  },
];

// ---------------------------------------------------------------------------------
// 1) MINIMAL VALIDATION CALL (DO NOT MODIFY THIS FUNCTION)
// ---------------------------------------------------------------------------------
async function validateInput(userInput: string, currentPrompt: string) {
  // ***** CRITICAL VALIDATION SECTION: DO NOT EDIT OR REMOVE *****
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

  console.log("\n[DEBUG] Validation Payload (Minimal):", { userInput, currentPrompt });

  const payload = {
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "system", content: validationInstruction }],
  };

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
    console.error("[ERROR] Validation API call failed:\n", errorText);
    throw new Error(`Validation API error: ${response.statusText}`);
  }

  const responseData = await response.json();
  const validationResult = responseData.choices?.[0]?.message?.content?.trim() || "INVALID";
  console.log("[DEBUG] Validation Result:", validationResult);

  return validationResult === "VALID";
}

// ---------------------------------------------------------------------------------
// 2) RETRY MESSAGE GENERATOR IF INVALID (DO NOT MODIFY THIS SECTION)
// ---------------------------------------------------------------------------------
async function generateRetryMessage(userInput: string, currentPrompt: string) {
  // ***** CRITICAL VALIDATION SECTION: DO NOT EDIT OR REMOVE *****
  console.log("\n[DEBUG] Generating Retry Message for invalid input:", userInput);

  const payload = {
    model: "llama-3.3-70b-versatile",
    messages: [
      { role: "system", content: currentPrompt },
      // We re-use conversation history minus the system message
      ...conversationHistory.filter((entry) => entry.role !== "system"),
    ],
  };

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
    console.error("[ERROR] Retry API call failed:\n", errorText);
    throw new Error(`Retry API error: ${response.statusText}`);
  }

  const responseData = await response.json();
  const retryContent = responseData.choices?.[0]?.message?.content;

  if (!retryContent) {
    throw new Error("Invalid retry response: No content.");
  }

  console.log("[DEBUG] Retry Message Generated:\n", retryContent);
  return retryContent;
}

// ---------------------------------------------------------------------------------
// 3) BASIC FETCH TO THE API (UNTOUCHED)
// ---------------------------------------------------------------------------------
async function fetchApiResponse(payload: any): Promise<string | null> {
  // This function is used for normal / direct API fetches
  console.log("\n[DEBUG] Basic fetchApiResponse call with payload:\n", JSON.stringify(payload, null, 2));
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
      return null;
    }

    const responseData = await response.json();
    return responseData.choices?.[0]?.message?.content || null;
  } catch (error: any) {
    console.error("[ERROR] in fetchApiResponse:\n", error.message);
    return null;
  }
}

// ---------------------------------------------------------------------------------
// 4) chainIfNeeded LOGIC (DO NOT MODIFY ANYTHING INSIDE THIS FUNCTION)
// ---------------------------------------------------------------------------------
async function chainIfNeeded(assistantContent: string): Promise<string | null> {
  // ***** CRITICAL CHAINING SECTION: DO NOT EDIT OR REMOVE *****
  let chainResponse = assistantContent;

  while (true) {
    if (currentIndex >= PROMPT_LIST.length) {
      console.log("[CHAIN DEBUG] No more prompts to chain.");
      return chainResponse;
    }
    if (!PROMPT_LIST[currentIndex]?.chaining) {
      console.log("[CHAIN DEBUG] Next prompt is NOT chaining. Stopping chain here.");
      return chainResponse;
    }

    console.log("[CHAIN DEBUG] The next prompt is chaining=true, so we feed the last assistant output as user input.");

    // Grab next system prompt
    const systemPrompt = PROMPT_LIST[currentIndex]?.prompt_text || "No further prompts.";

    // 1) Mark assistant's last output as a 'user' message for chaining
    conversationHistory.push({ role: "user", content: chainResponse });

    // 2) Remove duplicates if there's an "assistant => user" with the same content
    conversationHistory = conversationHistory.filter((entry, index, self) => {
      return !(
        entry.role === "assistant" &&
        self[index + 1]?.role === "user" &&
        self[index + 1]?.content === entry.content
      );
    });

    console.log("[CHAIN DEBUG] conversationHistory AFTER removing duplicates:\n", JSON.stringify(conversationHistory, null, 2));

    // 3) Build the chain payload
    const tempHistory = [
      { role: "system", content: systemPrompt },
      ...conversationHistory.map((entry) => entry),
    ];

    console.log("[CHAIN DEBUG] Next chaining payload to LLM:\n", JSON.stringify(tempHistory, null, 2));

    currentIndex++;

    // 4) Make the chain request
    const chainResp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: tempHistory,
      }),
    });

    if (!chainResp.ok) {
      const errorText = await chainResp.text();
      console.error("[CHAIN DEBUG] Chaining request failed:\n", errorText);
      return chainResponse; // fallback
    }

    const chainData = await chainResp.json();
    const newContent = chainData.choices?.[0]?.message?.content;

    if (!newContent) {
      console.warn("[CHAIN DEBUG] No content returned from chain. Stopping chaining.");
      return chainResponse;
    }

    console.log("[CHAIN DEBUG] newAssistantContent from chain:", newContent);

    // 5) Append the new chain response
    conversationHistory.push({ role: "assistant", content: newContent });

    // 6) Update chainResponse for next iteration
    chainResponse = newContent;
  }
}

// ---------------------------------------------------------------------------------
// ****************** START OF ADDED CODE FOR IMPORTANT MEMORY *********************
// ---------------------------------------------------------------------------------
/**
 * If a prompt is marked `important_memory: true`, we insert a line:
 *    Important_memory: ...
 * into the conversation, preserving chronological order.
 */
function insertImportantMemory(assistantContent: string) {
  const systemIndex = conversationHistory.findIndex((msg) => msg.role === "system");
  let insertIndex = systemIndex + 1;

  // Skip over any existing Important_memory lines so each new one appends chronologically
  while (
    insertIndex < conversationHistory.length &&
    conversationHistory[insertIndex].role === "assistant" &&
    conversationHistory[insertIndex].content.trim().startsWith("Important_memory:")
  ) {
    insertIndex++;
  }

  conversationHistory.splice(insertIndex, 0, {
    role: "assistant",
    content: `Important_memory: ${assistantContent}`,
  });

  console.log("[DEBUG] Important_memory inserted at index:", insertIndex);
}
// ---------------------------------------------------------------------------------
// ****************** END OF ADDED CODE FOR IMPORTANT MEMORY ***********************
// ---------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------
// 5) MAIN POST HANDLER (WITH OPTIONAL VALIDATION CHECK + BUFFER MANAGEMENT)
// ---------------------------------------------------------------------------------
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const userMessage = body.message?.trim();

    console.log("[INFO] Received User Input:", userMessage || "[No Input Provided]");
    if (!userMessage) {
      console.log("[WARN] No User Input Received. Returning Error 400.");
      return new Response("No input received. Please try again.", { status: 400 });
    }

    // 1) If no more prompts, we end
    const currentPrompt = PROMPT_LIST[currentIndex]?.prompt_text;
    const promptValidationNeeded = PROMPT_LIST[currentIndex]?.validation || false;

    if (!currentPrompt) {
      const finalMsg = "Thank you for your responses! Goodbye.";
      conversationHistory.push({ role: "assistant", content: finalMsg });
      console.log("[INFO] Conversation ended (no more prompts).");
      return new Response(finalMsg, { status: 200 });
    }

    console.log("\n[DEBUG] Current Prompt:\n", currentPrompt);

    // 2) Validate FIRST, if needed
    console.log("[DEBUG] Pushing user message to conversationHistory...");
    conversationHistory.push({ role: "user", content: userMessage });

    if (promptValidationNeeded) {
      console.log("[DEBUG] This prompt has 'validation: true'. Validating now...");
      const isValid = await validateInput(userMessage, currentPrompt);

      if (!isValid) {
        console.log("[DEBUG] Validation FAILED. Generating retry message for the same prompt...");
        const retryMsg = await generateRetryMessage(userMessage, currentPrompt);
        conversationHistory.push({ role: "assistant", content: retryMsg });
        return new Response(retryMsg, { status: 200 });
      }

      console.log("[DEBUG] Validation SUCCEEDED. Now we increment currentIndex to next prompt.");
      currentIndex++;
    } else {
      console.log("[DEBUG] This prompt does NOT require validation. Skipping validation. Now increment index...");
      currentIndex++;
    }

    // 3) Now that we've advanced currentIndex, set the system message to the *new* prompt
    const newPrompt = PROMPT_LIST[currentIndex]?.prompt_text || "No further prompts.";
    console.log("[DEBUG] Next Prompt is now:\n", newPrompt);

    conversationHistory = [
      { role: "system", content: newPrompt },
      ...conversationHistory.filter((entry) => entry.role !== "system"),
    ];

    // 4) Build the final payload with the *NEW* prompt as system message
    const mainPayload = {
      model: "llama-3.3-70b-versatile",
      messages: conversationHistory,
    };

    console.log("[DEBUG] Main Payload to LLM:\n", JSON.stringify(mainPayload, null, 2));

    // 5) Make the LLM call
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
    const assistantContent = mainData.choices?.[0]?.message?.content;

    if (!assistantContent) {
      return new Response("No content returned from the LLM. Please try again.", { status: 200 });
    }

    // 6) Store the LLM response
    conversationHistory.push({ role: "assistant", content: assistantContent });
    console.log("[DEBUG] Assistant's response appended. Updated Conversation:\n", JSON.stringify(conversationHistory, null, 2));

    // ****************** START: IMPORTANT MEMORY INSERTION ********************
    // If the PREVIOUS prompt had important_memory: true, we add an "Important_memory" line.
    if (PROMPT_LIST[currentIndex - 1]?.important_memory) {
      insertImportantMemory(assistantContent);
    }
    conversationHistory = manageBuffer(conversationHistory);
    // ****************** END: IMPORTANT MEMORY INSERTION **********************

    console.log("[DEBUG] The new prompt's chaining status:", PROMPT_LIST[currentIndex]?.chaining || false);

    // 7) Possibly chain to next prompts ONLY if the new prompt is chaining
    let finalChained = null;
    if (PROMPT_LIST[currentIndex]?.chaining) {
      finalChained = await chainIfNeeded(assistantContent);
    }

    // ************************ START ADDED CODE FOR AUTOTRANSITION ********************
    // Check if the new prompt has autoTransition: true
    const isAutoTransition = PROMPT_LIST[currentIndex]?.autoTransition || false;
    if (isAutoTransition) {
      console.log("[DEBUG] autoTransition is set to TRUE for the current prompt. Calling handleAutoTransition...");
      const { conversationHistory: updatedConv, response, updatedIndex } =
        await handleAutoTransition(conversationHistory, currentIndex);

      // Update the global conversation and index
      conversationHistory = updatedConv;
      currentIndex = updatedIndex;

      if (!response) {
        // If there's no second response, fallback to finalChained or assistantContent
        return new Response(finalChained || assistantContent, { status: 200 });
      }
      // Combine the finalChained (or assistantContent) with second response
      const combined = (finalChained || assistantContent) + "\n\n" + response;
      return new Response(combined, { status: 200 });
    }
    // ************************ END ADDED CODE FOR AUTOTRANSITION **********************

    return new Response(finalChained || assistantContent, { status: 200 });
  } catch (error: any) {
    console.error("[ERROR] in POST handler:\n", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * ---------------------------------------------------------------------------------
 * DO NOT TOUCH: BUFFER MANAGEMENT SECTION
 * ---------------------------------------------------------------------------------
 * This function ensures only the most recent messages remain in history,
 * while preserving lines that start with "Important_memory:"
 * and the current system message.
 */
function manageBuffer(conversationHistory: { role: string; content: string }[]) {
  console.log(`[DEBUG] Current Conversation History Length: ${conversationHistory.length}`);

  // 1) Identify the system message (must be preserved)
  const systemMessage = conversationHistory.find((entry) => entry.role === "system");

  // 2) Lines that start with "Important_memory:" must also be preserved
  const importantMemoryLines = conversationHistory.filter(
    (entry) =>
      entry.role === "assistant" &&
      entry.content.trim().startsWith("Important_memory:")
  );

  // 3) All other lines
  const otherMessages = conversationHistory.filter(
    (entry) => entry !== systemMessage && !importantMemoryLines.includes(entry)
  );

  // 4) If the total "other" lines exceed BUFFER_SIZE, trim from the oldest
  if (otherMessages.length > BUFFER_SIZE) {
    const excessCount = otherMessages.length - BUFFER_SIZE;
    console.log(`[DEBUG] Trimming ${excessCount} oldest non-system, non-important messages.`);

    // Retain only the newest BUFFER_SIZE from 'other'
    const trimmed = otherMessages.slice(excessCount);

    // Reconstruct final array
    const finalHistory = [systemMessage, ...importantMemoryLines, ...trimmed].filter(Boolean);

    console.log(
      "[DEBUG] Trimmed Conversation History (with Important Memory Kept):",
      JSON.stringify(finalHistory, null, 2)
    );
    return finalHistory;
  }

  // 5) If under limit, do nothing
  return conversationHistory;
}

// **************************** AUTO-TRANSITION HELPER FUNCTIONS ****************************

/**
 * Basic fetch with retry logic, used by handleAutoTransition to make a second LLM call if needed.
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
 * Encapsulated function that performs an "auto-transition" to the next prompt
 * by simulating a user message "OK" and making a second LLM call.
 */
async function handleAutoTransition(
  convHistory: { role: string; content: string }[],
  idx: number
): Promise<{
  conversationHistory: { role: string; content: string }[];
  response: string | null;
  updatedIndex: number;
}> {
  console.log("[AUTO] Handling auto transition for prompt index:", idx);

  // 1) Add a bogus user message "OK"
  convHistory.push({ role: "user", content: "OK" });

  // 2) Move to next prompt
  idx++;
  const secondPrompt = PROMPT_LIST[idx]?.prompt_text || "No further prompts.";
  console.log("[AUTO] Next Prompt is:", secondPrompt);

  // 3) Overwrite system prompt
  convHistory = [
    { role: "system", content: secondPrompt },
    ...convHistory.filter((entry) => entry.role !== "system"),
  ];

  // 4) Build the second payload
  const payload2 = {
    model: "llama-3.3-70b-versatile",
    messages: convHistory,
  };

  // 5) Make the second call with retry
  const assistantContent2 = await fetchApiResponseWithRetry(payload2, 2, 500);

  if (!assistantContent2) {
    console.warn("[AUTO] Second LLM call failed or returned null.");
    return { conversationHistory: convHistory, response: null, updatedIndex: idx };
  }

  // 6) Append second response
  convHistory.push({ role: "assistant", content: assistantContent2 });

  // Return updated conversation and new index
  return { conversationHistory: convHistory, response: assistantContent2, updatedIndex: idx };
}
