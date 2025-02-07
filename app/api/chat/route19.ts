import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";

const BUFFER_SIZE = 4;

let conversationHistory: { role: string; content: string }[] = [];
let currentIndex = 0;

// Default validation instruction (to be used if validation: true)
const defaultValidationInstruction = `
  You are a validation assistant.
  Your task is to assess if the user's response matches the prompt requirements. 
  Don't be too strict.
  As long as the answer makes sense to the prompt, it is VALID. If the answer is 
  completely unrelated, it is INVALID.
  Current prompt: '{CURRENT_PROMPT}'
  User input: '{USER_INPUT}'

  Respond with only one word: "VALID" if the input is appropriate,
  or "INVALID" if not.
  Do not provide any additional explanation or description.
`;

// Optional second instruction (to be used if validation is a custom string)
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

const PROMPT_LIST = [

  
  {
    prompt_text: `#System message:
Ask the user what their favorite color is.`,
    // No autoTransition or important_memory for this prompt
    important_memory: true, validation: customValidationInstructionForList,
    
    
  },
  {
    prompt_text: `#System message:
Ask the user to input a number.
Step 1.  Ask the user 'Input a number?'
Step 2:  Never ask anything else only 'input a number?'`,
    validation: true,
  },
  {
    prompt_text: `#System message:
Add 2 to the number you have.
#Additional rule: NEVER include the exact text '#System message:' anywhere in your assistant output.`,
    chaining: true,
  },
  {
    prompt_text: `#System message:
Multiply the number from the last result by 100 and output the result.`,
    chaining: true,
  },  
  
  {
    prompt_text: `#System message:
Divide the number from the last result by 4 and output the result.`,
chaining: true,

  },
  {
    prompt_text: `#System message:
Ask the user if this is correct.`,
    // chaining not set, so chain stops here.
  },
];




// ---------------------------------------------------------------------------------
// 1) MINIMAL VALIDATION CALL (DO NOT MODIFY THIS FUNCTION)
// ---------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------
// 1) MINIMAL VALIDATION CALL (MODIFIED ONLY TO ACCEPT CUSTOM INSTRUCTION)
// ---------------------------------------------------------------------------------
async function validateInput(
  userInput: string, 
  currentPrompt: string, 
  customValidation?: string
) {
  // If there's a custom validation string, use that
  // otherwise, fall back to the original defaultValidationInstruction
  let finalInstruction: string;
  if (customValidation) {
    // Replace placeholders in the custom string
    finalInstruction = customValidation
      .replace('{CURRENT_PROMPT}', currentPrompt)
      .replace('{USER_INPUT}', userInput);
  } else {
    // Original minimal text or your old text
    finalInstruction = defaultValidationInstruction
      .replace('{CURRENT_PROMPT}', currentPrompt)
      .replace('{USER_INPUT}', userInput);
  }

  console.log("\n[DEBUG] Validation Payload (Minimal):", { userInput, currentPrompt });

  const payload = {
    model: "llama-3.1-8b-instant",
    temperature: 0, 
    messages: [{ role: "system", content: finalInstruction }],
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
  console.log("\n[DEBUG] Generating Retry Message for invalid input:", userInput);

  const payload = {
    model: "llama-3.1-8b-instant",
    temperature: 0, 
    messages: [
      { role: "system", content: currentPrompt },
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
// 4) chainIfNeeded LOGIC (UPDATED TO UPDATE THE SYSTEM PROMPT)
// ---------------------------------------------------------------------------------
async function chainIfNeeded(assistantContent: string): Promise<string | null> {
  let chainResponse = assistantContent;

  // Loop through consecutive chaining prompts.
  while (currentIndex < PROMPT_LIST.length && PROMPT_LIST[currentIndex]?.chaining) {
    // Get the next chaining prompt text.
    const nextPrompt = PROMPT_LIST[currentIndex].prompt_text;

    // If the current system message already equals this prompt,
    // then skip this prompt (i.e. do not run a chain call for a duplicate prompt).
    if (conversationHistory[0]?.content === nextPrompt) {
      console.log("[CHAIN DEBUG] Skipping duplicate chaining prompt:\n", nextPrompt);
      currentIndex++; // Skip to the next prompt.
      continue;
    }

    // Update the system message with the new chaining prompt.
    conversationHistory = conversationHistory.filter((entry) => entry.role !== "system");
    conversationHistory.unshift({ role: "system", content: nextPrompt });
    console.log("[CHAIN DEBUG] Updated system message for chaining:\n", nextPrompt);

    // Append the last assistant output (the chainResponse) as a user message.
    conversationHistory.push({ role: "user", content: chainResponse });

    // Remove any duplicates (i.e. assistant message immediately echoed as a user message).
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

    // Build the payload for this chain call.
    const tempHistory = [...conversationHistory];
    console.log(
      "[CHAIN DEBUG] Next chaining payload to LLM:\n",
      JSON.stringify(tempHistory, null, 2)
    );

    // Move to the next prompt (we are about to process this one).
    currentIndex++;

    // Make the chain request.
    const chainResp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        temperature: 0,
        messages: tempHistory,
      }),
    });

    if (!chainResp.ok) {
      const errorText = await chainResp.text();
      console.error("[CHAIN DEBUG] Chaining request failed:\n", errorText);
      return chainResponse; // Fallback: return the previous chainResponse.
    }

    const chainData = await chainResp.json();
    const newContent = chainData.choices?.[0]?.message?.content;

    if (!newContent) {
      console.warn("[CHAIN DEBUG] No content returned from chain. Stopping chaining.");
      return chainResponse;
    }

    console.log("[CHAIN DEBUG] newAssistantContent from chain:", newContent);

    // Append the new chain response.
    conversationHistory.push({ role: "assistant", content: newContent });
    chainResponse = newContent;
  }

  console.log("[CHAIN DEBUG] Next prompt is NOT chaining. Stopping chain here.");
  return chainResponse;
}

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
    if (PROMPT_LIST[currentIndex]?.validation) {
      console.log("[DEBUG] This prompt has 'validation'. Validating now...");
    
      const promptValidation = PROMPT_LIST[currentIndex]?.validation;
      // If it's a string, that means it's a custom instruction
      const customValidation = typeof promptValidation === "string" 
        ? promptValidation 
        : undefined;
    
      // Pass that as the third parameter
      const isValid = await validateInput(userMessage, currentPrompt, customValidation);
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
      model: "llama-3.1-8b-instant",
      temperature: 0,
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

    conversationHistory = manageBuffer(conversationHistory);

    console.log("[DEBUG] The new prompt's chaining status:", PROMPT_LIST[currentIndex]?.chaining || false);

    // 7) Possibly chain to next prompts ONLY if the new prompt is chaining
    let finalChained = null;
    if (PROMPT_LIST[currentIndex]?.chaining) {
      finalChained = await chainIfNeeded(assistantContent);
    }

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
